/**
 * Orchestrator mode — the root session delegates; subagents do the work.
 *
 * Enforcement is by removal, not by prompt: while enabled, the root session's active
 * tool set is cut down to delegation + read-only inspection, and a tool_call guard
 * blocks anything else (other extensions can re-activate tools behind our back).
 *
 * Two failure modes this guards against:
 *  1. The orchestrator "flips" and spawns duplicates because it cannot see a child's
 *     state. A launch guard refuses a new `subagent` execution while an earlier async
 *     launch from this session has not reported back; status/steer/resume/stop stay
 *     open so the model can inspect or recover the existing run instead.
 *  2. Subagents break and the orchestrator can no longer fix anything. `/orchestrate off`
 *     restores the full tool set; a failed launch tells the human so.
 *
 * Children are untouched: pi-subagents sets PI_SUBAGENT_CHILD=1 in the runner process,
 * and this extension registers nothing there.
 *
 * Commands: /orchestrate [on|off|status|release]
 * Env:      PI_ORCHESTRATOR=off starts a session with enforcement disabled.
 *
 * Self-check: bun ~/.pi/agent/extensions/orchestrator_mode.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Tools the orchestrator keeps. Everything else is deactivated and blocked. */
export const ALLOWED_TOOLS = new Set([
	// delegation and child control
	"subagent",
	"subagent_supervisor",
	"bg_wait",
	// planning and the human channel
	"todo",
	"ask_user_question",
	// read-only inspection, for framing tasks and checking child claims
	"read",
	"grep",
	"find",
	"ls",
	"ffgrep",
	"fffind",
	"symbol_search",
	"project_report",
	"module_report",
	"read_symbol",
	"read_enclosing",
	"lens_diagnostics",
	"effective_config",
	"ctx_search",
	"ctx_stats",
	"mcp__headroom__headroom_compress",
	"mcp__headroom__headroom_retrieve",
	"mcp__headroom__headroom_stats",
]);

/** Without these the orchestrator cannot do anything, so enforcement stands down. */
const REQUIRED_TOOLS = ["subagent"];

/** pi-subagents event-bus channels (src/shared/types.js). */
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/** status.json states after which a run will not report back again. */
const TERMINAL_STATES = new Set(["complete", "failed", "stopped", "rejected"]);

const ENTRY_TYPE = "orchestrator-mode";
const STATUS_KEY = "orchestrator";

export type InFlight = { id: string; asyncDir?: string; startedAt: number };

/** A `subagent` call with no `action` launches work; anything with one is control. */
export function isLaunch(input: Record<string, unknown>): boolean {
	const action = input?.action;
	return typeof action !== "string" || action.trim() === "";
}

/** Reads a run's own status file; undefined when the run cannot be located. */
export function runState(asyncDir: string | undefined): string | undefined {
	if (!asyncDir) return undefined;
	const file = join(asyncDir, "status.json");
	if (!existsSync(file)) return undefined;
	try {
		const state = JSON.parse(readFileSync(file, "utf8"))?.state;
		return typeof state === "string" ? state : undefined;
	} catch {
		return undefined;
	}
}

/** Drops runs whose status file says they finished. Returns the ids dropped. */
export function reconcile(
	inFlight: Map<string, InFlight>,
	readState: (dir: string | undefined) => string | undefined = runState,
): string[] {
	const dropped: string[] = [];
	for (const [id, run] of inFlight) {
		const state = readState(run.asyncDir);
		if (state && TERMINAL_STATES.has(state)) {
			inFlight.delete(id);
			dropped.push(id);
		}
	}
	return dropped;
}

/** The allowed subset of `tools`, always including the required delegation tools. */
export function pinnedTools(tools: string[]): string[] {
	const keep = tools.filter((t) => ALLOWED_TOOLS.has(t));
	for (const t of REQUIRED_TOOLS) if (!keep.includes(t)) keep.push(t);
	return keep;
}

export function blockedLaunchReason(runs: InFlight[]): string {
	const ids = runs.map((r) => r.id).join(", ");
	return [
		`[orchestrator] Launch refused: subagent run(s) ${ids} from this session have not reported back.`,
		"Do not spawn a replacement. Pick one:",
		"- End your turn. The completion notice wakes this session natively.",
		`- Inspect: subagent({action:"status", id:"${runs[0]?.id ?? "<id>"}"}).`,
		"- Redirect: action steer or interrupt; recover a stopped/paused run with action resume.",
		"- If it is truly dead or unwanted: action stop, then launch again.",
		"Put parallel work inside ONE workflow call instead of several launches.",
	].join("\n");
}

export const CONTRACT = `You are the ORCHESTRATOR for this session. The operator enabled orchestrator mode, which is explicit, standing authorization to delegate every task through the subagent tool.

Your tools are limited on purpose: delegation (subagent, subagent_supervisor, bg_wait), planning and the human (todo, ask_user_question), and read-only inspection. You cannot write, edit, or run shell commands. Do not ask for those tools; delegate instead.

Contract with subagents:
- Recon goes to scout, planning to planner, implementation and any command execution (builds, tests, git) to worker, review to reviewer.
- Give each child a self-contained task: goal, exact paths, constraints, the definition of done, and the verification command it must run. Children do not see this conversation.
- Require every result to report: what changed (paths), the exact verification commands run with their pass/fail output, and anything left undone. A result without verification evidence is not done; send it back or delegate a reviewer.
- One launch at a time. For parallel or multi-step work, compose ONE async workflow call. While a launch is in flight, a new launch is refused: end your turn and wait for the completion notice, or use action status/steer/interrupt/resume/stop on the existing run. Never spawn a duplicate because a child seems slow or silent.
- Answer child questions from contact_supervisor promptly with subagent_supervisor reply; escalate to the human with ask_user_question when the decision is theirs.
- Spot-check child claims with read-only tools before reporting them to the human, and say what the child verified versus what you checked yourself.
- If a launch fails for infrastructure reasons (spawn error, extension or runner failure, missing agent), stop. Report the exact error and tell the human they can run /orchestrate off to fix it directly. Do not try to route around it.`;

export default function orchestratorMode(pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let enabled = process.env.PI_ORCHESTRATOR?.toLowerCase() !== "off";
	/** Tools we deactivated, so `off` can restore exactly those. */
	const removed = new Set<string>();
	const inFlight = new Map<string, InFlight>();
	/**
	 * Tool names already observed as registered. A newly registered allowed tool is
	 * activated once, mirroring pi's activate-on-registration rule that our pinned
	 * loadout would otherwise override.
	 */
	const seen = new Set<string>();

	/** Allowed, model-declarable tools registered since the last check. */
	function newlyRegisteredAllowed(): string[] {
		const fresh: string[] = [];
		for (const t of pi.getAllTools()) {
			if (seen.has(t.name)) continue;
			seen.add(t.name);
			const exposure = (t as { exposure?: string }).exposure ?? "direct";
			if (
				ALLOWED_TOOLS.has(t.name) &&
				(exposure === "direct" || exposure === "model-only")
			)
				fresh.push(t.name);
		}
		return fresh;
	}

	const registered = () => new Set(pi.getAllTools().map((t) => t.name));

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (!enabled) return ctx.ui.setStatus(STATUS_KEY, undefined);
		const n = inFlight.size;
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg("accent", `⛓ orchestrator${n ? ` · ${n} running` : ""}`),
		);
	}

	/** Narrow the active set. Returns false (and disables) when delegation is impossible. */
	function enforce(ctx: ExtensionContext): boolean {
		const names = registered();
		const missing = REQUIRED_TOOLS.filter((t) => !names.has(t));
		if (missing.length) {
			enabled = false;
			restore();
			if (ctx.hasUI)
				ctx.ui.notify(
					`orchestrator mode disabled: ${missing.join(", ")} not registered (is pi-subagents loaded?)`,
					"error",
				);
			updateStatus(ctx);
			return false;
		}
		const active = pi.getActiveTools();
		const keep = pinnedTools([...new Set([...active, ...newlyRegisteredAllowed()])]);
		for (const t of active) if (!ALLOWED_TOOLS.has(t)) removed.add(t);
		if (keep.length !== active.length || keep.some((t, i) => t !== active[i]))
			pi.setActiveTools(keep);
		return true;
	}

	function restore() {
		const names = registered();
		const back = [...removed].filter((t) => names.has(t));
		removed.clear();
		if (back.length)
			pi.setActiveTools([...new Set([...pi.getActiveTools(), ...back])]);
	}

	function setEnabled(next: boolean, ctx: ExtensionContext) {
		enabled = next;
		if (enabled) enforce(ctx);
		else restore();
		pi.appendEntry(ENTRY_TYPE, { enabled });
		updateStatus(ctx);
	}

	pi.registerCommand("orchestrate", {
		description:
			"Orchestrator mode: on | off | status | release (forget in-flight runs)",
		getArgumentCompletions: (prefix) =>
			["on", "off", "status", "release"]
				.filter((a) => a.startsWith(prefix.trim()))
				.map((a) => ({ value: a, label: a })),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				setEnabled(arg === "on", ctx);
				ctx.ui.notify(
					arg === "on"
						? "Orchestrator mode on: delegation and read-only tools only."
						: "Orchestrator mode off: full tool access restored.",
					"info",
				);
				return;
			}
			if (arg === "release") {
				const ids = [...inFlight.keys()];
				inFlight.clear();
				updateStatus(ctx);
				ctx.ui.notify(
					ids.length
						? `Released launch guard for: ${ids.join(", ")}`
						: "No in-flight runs tracked.",
					"info",
				);
				return;
			}
			if (arg === "" || arg === "status") {
				reconcile(inFlight);
				updateStatus(ctx);
				const runs = [...inFlight.keys()];
				ctx.ui.notify(
					`Orchestrator mode ${enabled ? "on" : "off"}. In flight: ${runs.length ? runs.join(", ") : "none"}.`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /orchestrate [on|off|status|release]", "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		inFlight.clear();
		removed.clear();
		seen.clear();
		// Startup state is pi's own decision; only later registrations are ours to mirror.
		for (const t of pi.getAllTools()) seen.add(t.name);
		const last = ctx.sessionManager
			.getBranch()
			.filter(
				(e) =>
					e.type === "custom" &&
					(e as { customType?: string }).customType === ENTRY_TYPE,
			)
			.pop() as { data?: { enabled?: boolean } } | undefined;
		if (typeof last?.data?.enabled === "boolean") enabled = last.data.enabled;
		if (enabled) enforce(ctx);
		updateStatus(ctx);
	});

	// Tools registered after session_start (MCP servers, lazy extensions) are
	// filtered here, before the model sees them.
	pi.on("before_agent_start", (event, ctx) => {
		if (!enabled || !enforce(ctx)) return undefined;
		const opts = event.systemPromptOptions;
		opts.sections.orchestrator = CONTRACT;
		// Extensions later in the chain (context-mode) register tools inside their own
		// before_agent_start, which activates them after enforce() ran. Pi applies an
		// edited selectedTools verbatim instead of re-reading the live active set, but it
		// detects an edit by length/order. The trailing duplicate guarantees detection;
		// the loadout dedupes it. Allowed names not registered yet are included so a tool
		// registered later in this chain is declared; the loadout drops unknown names.
		const names = registered();
		const pending = [...ALLOWED_TOOLS].filter((t) => !names.has(t));
		opts.selectedTools = [
			...pinnedTools(opts.selectedTools),
			...pending,
			REQUIRED_TOOLS[0],
		];
		return undefined;
	});

	// Some extensions (context-mode) register tools lazily inside their own
	// before_agent_start, and registering a direct tool activates it. turn_start runs
	// before every model request, after those registrations.
	pi.on("turn_start", (_event, ctx) => {
		if (enabled) enforce(ctx);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		if (!enabled) return undefined;
		// Nested calls come from a tool that already passed this guard.
		if ((event as { parentToolCallId?: string }).parentToolCallId)
			return undefined;

		if (!ALLOWED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `[orchestrator] ${event.toolName} is disabled in orchestrator mode. Delegate this to a subagent (worker for edits/commands, scout for recon). The human can run /orchestrate off to restore direct tools.`,
			};
		}

		if (event.toolName === "subagent") {
			const input = event.input as Record<string, unknown>;
			if (!isLaunch(input)) return undefined;
			reconcile(inFlight);
			updateStatus(ctx);
			if (inFlight.size > 0)
				return { block: true, reason: blockedLaunchReason([...inFlight.values()]) };
		}
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "subagent") return undefined;
		const input = event.input as Record<string, unknown>;
		const action = typeof input?.action === "string" ? input.action : "";
		const details = (event as { details?: Record<string, unknown> }).details;
		const asyncId =
			typeof details?.asyncId === "string" ? details.asyncId : undefined;
		const asyncDir =
			typeof details?.asyncDir === "string" ? details.asyncDir : undefined;

		if (event.isError) {
			if (enabled && isLaunch(input) && ctx.hasUI)
				ctx.ui.notify(
					"orchestrator: subagent launch failed. If delegation is broken, /orchestrate off restores direct tools.",
					"warning",
				);
			return undefined;
		}
		// A launch or resume that went async is now owed a completion notice.
		if (asyncId && (isLaunch(input) || action === "resume")) {
			inFlight.set(asyncId, { id: asyncId, asyncDir, startedAt: Date.now() });
			updateStatus(ctx);
		}
		return undefined;
	});

	let latestCtx: ExtensionContext | undefined;
	pi.on("agent_start", (_e, ctx) => {
		latestCtx = ctx;
	});
	// Optional-chained: a host without an event bus still gets tool enforcement.
	pi.events?.on(ASYNC_COMPLETE_EVENT, (data) => {
		const d = (data ?? {}) as { id?: unknown; runId?: unknown };
		for (const id of [d.id, d.runId])
			if (typeof id === "string") inFlight.delete(id);
		if (latestCtx) {
			try {
				updateStatus(latestCtx);
			} catch {
				// ctx may be stale after a session switch; the next event refreshes it.
			}
		}
	});
}

if (import.meta.main) {
	const { strict: assert } = await import("node:assert");
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");

	assert.equal(isLaunch({ agent: "worker", task: "x" }), true);
	assert.equal(isLaunch({ workflow: true }), true);
	assert.equal(isLaunch({ action: "status", id: "a" }), false);
	assert.equal(isLaunch({ action: "  " }), true, "blank action is a launch");

	for (const t of ["write", "edit", "bash", "ctx_execute", "pi_lens_activate_tools"])
		assert.ok(!ALLOWED_TOOLS.has(t), `${t} must not be allowed`);
	for (const t of ["subagent", "subagent_supervisor", "bg_wait", "read"])
		assert.ok(ALLOWED_TOOLS.has(t), `${t} must be allowed`);

	// reconcile drops only runs whose status file reports a terminal state
	const dir = mkdtempSync(join(tmpdir(), "orch-selftest-"));
	try {
		const done = join(dir, "done");
		const live = join(dir, "live");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(done);
		mkdirSync(live);
		writeFileSync(join(done, "status.json"), JSON.stringify({ state: "complete" }));
		writeFileSync(join(live, "status.json"), JSON.stringify({ state: "running" }));
		const m = new Map<string, InFlight>([
			["a", { id: "a", asyncDir: done, startedAt: 0 }],
			["b", { id: "b", asyncDir: live, startedAt: 0 }],
			["c", { id: "c", startedAt: 0 }],
		]);
		assert.deepEqual(reconcile(m), ["a"]);
		assert.deepEqual([...m.keys()], ["b", "c"], "unknown state stays guarded");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	// End-to-end against a mock ExtensionAPI.
	type H = (e: unknown, c: unknown) => unknown;
	const handlers: Record<string, H> = {};
	const channels: Record<string, (d: unknown) => void> = {};
	const all = ["read", "write", "edit", "bash", "subagent", "bg_wait", "todo"];
	let active = [...all];
	const entries: unknown[] = [];
	const mock = {
		on: (n: string, f: H) => (handlers[n] = f),
		registerCommand: () => {},
		getAllTools: () => all.map((name) => ({ name })),
		getActiveTools: () => [...active],
		setActiveTools: (t: string[]) => (active = [...t]),
		appendEntry: (_t: string, d: unknown) => entries.push(d),
		events: { on: (c: string, f: (d: unknown) => void) => (channels[c] = f) },
	};
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_ORCHESTRATOR;
	orchestratorMode(mock as never);
	const ctx = {
		hasUI: false,
		sessionManager: { getBranch: () => [] },
	};
	handlers.session_start({}, ctx);
	assert.deepEqual(active.sort(), ["bg_wait", "read", "subagent", "todo"]);

	const ev = {
		systemPromptOptions: {
			sections: {} as Record<string, string>,
			selectedTools: ["read", "subagent", "ctx_execute"],
		},
	};
	handlers.before_agent_start(ev, ctx);
	assert.equal(ev.systemPromptOptions.sections.orchestrator, CONTRACT);
	assert.deepEqual(
		ev.systemPromptOptions.selectedTools.filter((t) => all.includes(t)),
		["read", "subagent", "subagent"],
		"first request pinned; duplicate forces pi to treat it as an edit",
	);

	// a tool activated after session_start (lazy registration) is stripped per turn
	active.push("bash");
	handlers.turn_start({}, ctx);
	assert.ok(!active.includes("bash"), "late-activated tool removed on turn_start");

	// a newly registered allowed tool is activated once, a disallowed one is not
	all.push("ctx_search", "ctx_execute");
	handlers.turn_start({}, ctx);
	assert.ok(active.includes("ctx_search"), "late allowed tool activated");
	assert.ok(!active.includes("ctx_execute"), "late disallowed tool stays off");

	const call = (toolName: string, input: Record<string, unknown> = {}) =>
		handlers.tool_call({ toolName, input }, ctx) as { block?: boolean } | undefined;
	assert.equal(call("bash", { command: "ls" })?.block, true, "bash blocked");
	assert.equal(call("write")?.block, true, "write blocked");
	assert.equal(call("read"), undefined, "read allowed");
	assert.equal(
		(handlers.tool_call({ toolName: "bash", input: {}, parentToolCallId: "p" }, ctx)),
		undefined,
		"nested calls pass",
	);

	// launch -> in flight -> second launch refused, control actions allowed
	assert.equal(call("subagent", { agent: "worker", task: "t" }), undefined);
	handlers.tool_result(
		{ toolName: "subagent", input: { agent: "worker", task: "t" }, isError: false, details: { asyncId: "run-1" } },
		ctx,
	);
	assert.equal(call("subagent", { agent: "worker", task: "t2" })?.block, true, "duplicate refused");
	assert.equal(call("subagent", { action: "status", id: "run-1" }), undefined, "status allowed");
	channels[ASYNC_COMPLETE_EVENT]({ id: "run-1" });
	assert.equal(call("subagent", { agent: "worker", task: "t2" }), undefined, "released on completion");

	// a session that turned the mode off stays off on resume
	const offCtx = {
		hasUI: false,
		sessionManager: {
			getBranch: () => [{ type: "custom", customType: ENTRY_TYPE, data: { enabled: false } }],
		},
	};
	handlers.session_start({}, offCtx);
	assert.equal(call("bash")?.block, undefined, "disabled mode blocks nothing");

	// child processes register nothing
	const childHandlers: Record<string, H> = {};
	process.env.PI_SUBAGENT_CHILD = "1";
	orchestratorMode({ ...mock, on: (n: string, f: H) => (childHandlers[n] = f) } as never);
	delete process.env.PI_SUBAGENT_CHILD;
	assert.equal(Object.keys(childHandlers).length, 0, "inert in children");

	process.stderr.write("orchestrator_mode self-check: ok\n");
}
