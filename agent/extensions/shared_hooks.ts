/**
 * Shared agent harness adapter.
 *
 * Reuses the canonical Python hooks in ~/.agents/hooks rather than maintaining
 * a second security implementation for pi. Pi events are translated to the
 * Kiro-compatible JSON event shape expected by those scripts.
 *
 * Deliberately not wired to spawn_budget.py: pi-subagents uses a different,
 * JavaScript workflow API than Kiro's structured InvokeSubagents event.
 *
 * stop_quality_gate.py is likewise skipped: evidence_gate.ts already covers that
 * niche in pi, with the same phantom-verification detection.
 *
 * Also bridges rpiv-ask-user-question's blocked event to notify_agent_question.py:
 * a questionnaire parks the turn on a human, which agent_settled never observes.
 *
 * Self-check: bun ~/.pi/agent/extensions/shared_hooks.ts
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type HookEvent = {
	tool_name: string;
	tool_input: Record<string, unknown>;
	cwd: string;
};

type HookResult = {
	exitCode: number;
	stderr: string;
};

const HOOK_DIR =
	process.env.AGENT_HOOK_DIR ?? join(homedir(), ".agents", "hooks");
const SHELL_HOOKS = [
	"block_secrets.py",
	"block_destructive.py",
	"block_commit_issues.py",
];
const WRITE_TOOLS = new Set(["write", "edit"]);
const NOTIFY_HOOK = "notify_agent_stop.py";
const QUESTION_HOOK = "notify_agent_question.py";
/** Kiro passes "Kiro CLI" here; a distinct label keeps the two harnesses apart. */
const NOTIFY_LABEL = "pi";

/**
 * Channel names published by @juicesharp/rpiv-ask-user-question. Inlined rather
 * than imported: that package is optional, and a static import of a missing
 * module takes this whole file offline — along with the secret and
 * destructive-command blocking it carries. The package's event contract pins
 * channel names as immutable (a breaking change ships a new `.v2` channel
 * instead), so literals are safe.
 */
const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";
const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";

/**
 * Namespaces the questionnaire's dedup slot away from the stop notifier's, and
 * away from every other questionnaire's. notify.py claims one alert slot per chat
 * id and writes "sent" into it on *successful* delivery, permanently silencing
 * that id — so a key shared with the stop notifier lets whichever delivered first
 * mute the other, and a key shared across questionnaires alerts only for the
 * first one. Each questionnaire therefore claims a fresh slot. Cost, accepted
 * deliberately: one empty lock file per question in the notify state dir, which
 * nothing currently prunes.
 *
 * The token carries wall-clock time as well as a counter, because the counter
 * alone restarts at 1 in a new process while a resumed session keeps its id —
 * `:ask-user:1` would then land on a slot already marked "sent" and stay silent.
 */
const QUESTION_DEDUP_SUFFIX = ":ask-user";
let questionAlertCount = 0;
function nextQuestionSlot(): string {
	questionAlertCount += 1;
	return `${QUESTION_DEDUP_SUFFIX}:${Date.now()}-${questionAlertCount}`;
}

/** Minimal shape the notifier payloads need; real ExtensionContext satisfies it. */
type NotifyContext = {
	cwd: string;
	sessionManager: { getSessionId(): string };
};

/**
 * The slice of pi's `EventBus` this file uses. Mirrors the real signature from
 * `@earendil-works/pi-coding-agent` (`on` returns an unsubscribe function); these
 * subscriptions live as long as the extension, so the handle is dropped.
 */
type EventSubscriber = {
	on(channel: string, handler: (data: unknown) => void): () => void;
};

function hookPath(name: string): string {
	return join(HOOK_DIR, name);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function canonicalToolName(toolName: string): string {
	if (toolName === "bash") return "shell";
	if (WRITE_TOOLS.has(toolName)) return "fs_write";
	return toolName;
}

function canonicalInput(
	toolName: string,
	input: Record<string, unknown>,
): Record<string, unknown> {
	if (toolName !== "edit") return input;

	const replacements = Array.isArray(input.edits) ? input.edits : [];
	const newStr = replacements
		.map((edit) =>
			edit && typeof edit === "object"
				? text((edit as { newText?: unknown }).newText)
				: "",
		)
		.filter(Boolean)
		.join("\n");

	return { ...input, newStr };
}

type HookOptions = {
	/** Extra argv appended after the script path. */
	args?: string[];
	/** Overlaid on process.env. */
	env?: Record<string, string>;
	/** Fire-and-forget: unref so a slow notifier never holds up pi. */
	detach?: boolean;
};

function runHook(
	name: string,
	payload: Record<string, unknown>,
	options: HookOptions = {},
): Promise<HookResult> {
	return new Promise((resolve) => {
		let stderr = "";
		const child = spawn("python3", [hookPath(name), ...(options.args ?? [])], {
			cwd: text(payload.cwd) || process.cwd(),
			env: options.env ? { ...process.env, ...options.env } : process.env,
			stdio: ["pipe", "ignore", options.detach ? "ignore" : "pipe"],
		});

		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
		});
		child.on("error", () => resolve({ exitCode: 0, stderr: "" }));
		child.on("close", (code) =>
			resolve({ exitCode: code ?? 0, stderr: stderr.trim() }),
		);
		child.stdin?.end(JSON.stringify(payload));
		if (options.detach) child.unref();
	});
}

async function blockedBy(
	hooks: string[],
	event: HookEvent,
): Promise<string | undefined> {
	for (const hook of hooks) {
		const result = await runHook(hook, event);
		if (result.exitCode === 2) {
			return result.stderr || `${hook} blocked the tool call`;
		}
	}
	return undefined;
}

function eventFor(
	toolName: string,
	input: Record<string, unknown>,
	ctx: ExtensionContext,
): HookEvent {
	return {
		tool_name: canonicalToolName(toolName),
		tool_input: canonicalInput(toolName, input),
		cwd: ctx.cwd,
	};
}

/**
 * Payload for the stop notifier. notify.py's chat_identifier reads `session_id`, and
 * that key is what makes its once-per-chat dedup work: claim_chat_alert("") is
 * *always* allowed, so an empty id would notify on every settle instead of once.
 */
export function stopPayload(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): Record<string, unknown> {
	return { cwd: ctx.cwd, session_id: ctx.sessionManager.getSessionId() };
}

/**
 * Payload for the questionnaire notifier. Not idempotent by design: every call
 * claims a fresh dedup slot, so each questionnaire alerts rather than only the
 * session's first (see QUESTION_DEDUP_SUFFIX).
 *
 * An unknown session id stays empty rather than becoming a bare suffix:
 * `claim_chat_alert("")` is always allowed and writes no lock file — the right
 * failure mode here — whereas a shared constant id would collapse every session
 * into one global slot and notify exactly once, ever.
 */
export function questionPayload(ctx: NotifyContext): Record<string, unknown> {
	const sessionId = ctx.sessionManager.getSessionId();
	return {
		cwd: ctx.cwd,
		session_id: sessionId ? `${sessionId}${nextQuestionSlot()}` : "",
	};
}

/**
 * Pull a one-line notification detail out of an `rpiv:ask-user:prompt` payload.
 * Defensive about shape: the event contract is append-only, so unknown fields
 * are expected and a malformed payload must degrade to "no detail", never throw
 * inside an event handler.
 */
export function questionDetail(data: unknown): string {
	const questions = (data as { questions?: unknown } | null | undefined)
		?.questions;
	if (!Array.isArray(questions) || questions.length === 0) return "";
	const first = text(
		(questions[0] as { question?: unknown } | null | undefined)?.question,
	);
	if (!first) return "";
	return questions.length > 1
		? `${first} (+${questions.length - 1} more)`
		: first;
}

export default function sharedHooks(pi: ExtensionAPI) {
	// The questionnaire's blocked event carries no ctx (pi.events handlers take
	// only a payload), so the last ctx pi handed us supplies cwd + session id.
	// `ask_user_question` is itself a tool call, so tool_call always fires just
	// ahead of the questionnaire and the fallback below stays theoretical.
	let latestCtx: NotifyContext | undefined;
	const notifyContext = (): NotifyContext =>
		latestCtx ?? {
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => process.env.PI_SESSION_ID ?? "" },
		};

	// `events` is a required field on current ExtensionAPI, but read defensively:
	// this file's primary duty is blocking secrets and destructive commands, and a
	// throw at registration would take those hooks offline with it. On a host
	// without the bus, only the questionnaire alert is skipped. Same reasoning as
	// the inlined channel names above.
	const bus = (pi as { events?: EventSubscriber }).events;
	if (bus) {
		// Emitted just before the blocked event, so the alert can name the question.
		let pendingDetail = "";
		bus.on(ASK_USER_PROMPT_EVENT, (data) => {
			pendingDetail = questionDetail(data);
		});

		// `{ active: true }` means the agent is parked on a human decision mid-turn;
		// agent_settled never fires for it, and the questionnaire's own terminal bell
		// is invisible once the user tabs away.
		bus.on(ASK_USER_BLOCKED_EVENT, (data) => {
			const active =
				(data as { active?: unknown } | null | undefined)?.active === true;
			if (!active) return;
			if (process.env.PI_SUBAGENT_CHILD === "1") return;
			const detail = pendingDetail;
			pendingDetail = "";
			void runHook(QUESTION_HOOK, questionPayload(notifyContext()), {
				args: detail ? [NOTIFY_LABEL, detail] : [NOTIFY_LABEL],
				detach: true,
			});
		});
	}

	pi.on("tool_call", async (event, ctx) => {
		latestCtx = ctx;
		const input = event.input as Record<string, unknown>;
		let hooks: string[] = [];
		if (event.toolName === "bash") {
			hooks = SHELL_HOOKS;
		} else if (WRITE_TOOLS.has(event.toolName)) {
			hooks = ["block_secrets.py"];
		}

		if (hooks.length === 0) return undefined;

		const reason = await blockedBy(hooks, eventFor(event.toolName, input, ctx));
		if (reason) return { block: true, reason };
		return undefined;
	});

	// Kiro runs this on its `stop` trigger. pi's analogue is agent_settled, not
	// agent_end: agent_end also fires ahead of an auto-retry, an auto-compaction, or a
	// queued follow-up, and "waiting for your next prompt" is only true once settled.
	pi.on("agent_settled", (_event, ctx) => {
		// Only the session a human is watching should ping. Without this, every
		// pi-subagents child notifies when it finishes.
		if (process.env.PI_SUBAGENT_CHILD === "1") return undefined;
		// notify.py derives its once-per-chat dedup key from session_id.
		void runHook(NOTIFY_HOOK, stopPayload(ctx), {
			args: [NOTIFY_LABEL],
			detach: true,
		});
		return undefined;
	});
}

if (import.meta.main) {
	const { strict: assert } = await import("node:assert");
	// Belt and braces: nothing in this self-check may raise a real desktop
	// notification or consume the live session's once-per-chat slot.
	process.env.KIRO_NOTIFY_BACKEND = "none";

	const allowed = await runHook("block_destructive.py", {
		tool_name: "shell",
		tool_input: { command: "printf hello" },
		cwd: process.cwd(),
	});
	if (allowed.exitCode !== 0) {
		throw new Error(
			`allowed-command smoke test failed: ${allowed.stderr || allowed.exitCode}`,
		);
	}

	const destructive = await runHook("block_destructive.py", {
		tool_name: "shell",
		tool_input: { command: "git reset --hard HEAD" },
		cwd: process.cwd(),
	});
	if (destructive.exitCode !== 2) {
		throw new Error(
			`destructive-command smoke test failed: ${destructive.exitCode}`,
		);
	}

	const secret = await runHook("block_secrets.py", {
		tool_name: "shell",
		tool_input: { command: "printf " + "AKIA" + "IOSFODNN7EXAMPLE" },
		cwd: process.cwd(),
	});
	if (secret.exitCode !== 2) {
		throw new Error(`secret-command smoke test failed: ${secret.exitCode}`);
	}

	// Proves the notifier resolves, imports its sibling notify module, and accepts the
	// label argv. backend=none returns before delivery, so this neither raises a desktop
	// notification nor consumes the real session's once-per-chat slot.
	const notified = await runHook(
		NOTIFY_HOOK,
		{ session_id: "shared-hooks-selftest" },
		{ args: [NOTIFY_LABEL], env: { KIRO_NOTIFY_BACKEND: "none" } },
	);
	if (notified.exitCode !== 0) {
		throw new Error(
			`notify smoke test failed: ${notified.stderr || notified.exitCode}`,
		);
	}

	// Same for the questionnaire notifier: proves the new script resolves and
	// accepts the optional question-detail argv alongside the label.
	const asked = await runHook(
		QUESTION_HOOK,
		{ session_id: "shared-hooks-selftest:ask-user" },
		{
			args: [NOTIFY_LABEL, "Which dedup key should the notifier use?"],
			env: { KIRO_NOTIFY_BACKEND: "none" },
		},
	);
	if (asked.exitCode !== 0) {
		throw new Error(
			`question notify smoke test failed: ${asked.stderr || asked.exitCode}`,
		);
	}

	// The dedup key must be present, or notify.py notifies on every settle.
	const payload = stopPayload({
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "sid-1" },
	} as never);
	assert.equal(payload.session_id, "sid-1", "session_id carries the dedup key");

	// notify.py burns an alert slot per chat id on successful delivery, so a
	// questionnaire must share a key with neither the stop notifier nor an earlier
	// questionnaire — either collision means a silently dropped alert.
	const askCtx = {
		cwd: "/tmp",
		sessionManager: { getSessionId: () => "sid-1" },
	};
	const asking = questionPayload(askCtx);
	const askingAgain = questionPayload(askCtx);
	assert.notEqual(
		asking.session_id,
		payload.session_id,
		"questionnaire does not share the stop notifier's dedup slot",
	);
	assert.notEqual(
		asking.session_id,
		askingAgain.session_id,
		"each questionnaire claims a fresh dedup slot",
	);
	for (const key of [asking.session_id, askingAgain.session_id]) {
		assert.ok(
			String(key).startsWith(`sid-1${QUESTION_DEDUP_SUFFIX}:`),
			"dedup slot stays namespaced under the session id",
		);
	}
	// An unknown session must stay empty: claim_chat_alert("") always allows, while a
	// bare shared suffix would collapse every session into one global slot.
	assert.equal(
		questionPayload({ cwd: "/tmp", sessionManager: { getSessionId: () => "" } })
			.session_id,
		"",
		"missing session id yields no dedup key, not a shared one",
	);

	// Detail extraction must survive an append-only contract and malformed payloads.
	assert.equal(
		questionDetail({ questions: [{ question: "Pick one?", extra: 1 }] }),
		"Pick one?",
		"single question passes through",
	);
	assert.equal(
		questionDetail({
			questions: [{ question: "First?" }, { question: "Second?" }],
		}),
		"First? (+1 more)",
		"multi-question detail notes the remainder",
	);
	for (const bad of [undefined, null, {}, { questions: [] }, { questions: 7 }]) {
		assert.equal(questionDetail(bad), "", "malformed payload degrades to empty");
	}

	// agent_settled must be the registered event, and subagent children must stay quiet.
	type Mock = {
		handlers: Record<string, (e: unknown, c: unknown) => unknown>;
		channels: Record<string, (data: unknown) => void>;
	};
	// `withBus: false` mimics a host whose ExtensionAPI carries no pi.events.
	function register(withBus: boolean): Mock {
		const mock: Mock = { handlers: {}, channels: {} };
		const events: EventSubscriber = {
			on: (c: string, f: (data: unknown) => void) => {
				mock.channels[c] = f;
				return () => delete mock.channels[c];
			},
		};
		sharedHooks({
			on: (n: string, f: never) => (mock.handlers[n] = f),
			...(withBus ? { events } : {}),
		} as never);
		return mock;
	}
	const { handlers, channels } = register(true);

	// A host with no event bus must not take secret/destructive blocking down with it.
	const busless = register(false);
	assert.ok(
		busless.handlers.tool_call && busless.handlers.agent_settled,
		"blocking hooks survive a host without pi.events",
	);
	assert.ok(
		handlers.agent_settled,
		"notifier runs on agent_settled, not agent_end",
	);
	assert.ok(
		!handlers.agent_end,
		"agent_end still fires before retries/compaction",
	);
	assert.ok(
		channels[ASK_USER_BLOCKED_EVENT] && channels[ASK_USER_PROMPT_EVENT],
		"questionnaire channels are subscribed",
	);

	// Only `{ active: true }` alerts: the clearing edge fires on every answer and
	// cancel, and a child's questionnaire is not the watched session's business.
	// Neither call below may spawn the notifier, so both stay synchronous.
	channels[ASK_USER_BLOCKED_EVENT]({ active: false });
	process.env.PI_SUBAGENT_CHILD = "1";
	channels[ASK_USER_BLOCKED_EVENT]({ active: true });
	delete process.env.PI_SUBAGENT_CHILD;

	const ctx = {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "sid-2" },
	};
	process.env.PI_SUBAGENT_CHILD = "1";
	assert.equal(handlers.agent_settled({}, ctx), undefined, "child stays silent");
	delete process.env.PI_SUBAGENT_CHILD;
	assert.equal(handlers.agent_settled({}, ctx), undefined, "root notifies");

	process.stderr.write("shared_hooks self-check: ok\n");
}
