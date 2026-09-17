/**
 * Evidence Gate — catches the article's "Phantom Verification" failure mode:
 * claiming tests pass without having run them this prompt.
 *
 * pi has no blocking stop event (`agent_end` has no documented return value), so this
 * cannot refuse to stop the way a Claude Code Stop hook does. Instead:
 *   UI attached  -> notify the human, who is already the gate. Zero tokens.
 *   no UI (-p)   -> inject one corrective turn, since nobody is watching.
 *
 * Self-check: bun ~/.pi/agent/extensions/evidence_gate.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Assertions ABOUT CORRECTNESS, not mere completion. "Fixed the typo" is a change
 * report and must not trip the gate; "tests pass" is a verifiable claim.
 */
const CLAIM =
	/\b(?:(?:all |the )?(?:tests?|specs?|checks?|suite)\s+(?:now\s+)?(?:pass|passes|passed|passing|are green)|verified|type-?checks? (?:pass|clean)|builds? (?:clean|successfully)|no (?:errors|failures|regressions)|lint (?:passes|is clean))\b/i;

/** A command that actually exercises the code. */
const VERIFY_CMD =
	/\b(?:bun test|npm (?:t|test|run test)|yarn test|pnpm test|jest|vitest|mocha|pytest|python -m (?:pytest|unittest)|go test|cargo (?:test|check)|mvn (?:test|verify)|gradle test|make (?:test|check)|tsc|mypy|ruff|eslint|biome|golangci-lint|pre-commit)\b/;

/** Tools that verify without a shell. */
const VERIFY_TOOLS = new Set(["lens_diagnostics", "lsp_diagnostics"]);

type Content = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};
type Message = { role?: string; content?: string | Content[] };

const parts = (m: Message): Content[] =>
	Array.isArray(m?.content) ? m.content : [];

/** Text of the last assistant message — where a completion claim would appear. */
export function finalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role !== "assistant") continue;
		return parts(messages[i])
			.flatMap((c) =>
				c?.type === "text" && typeof c.text === "string" ? [c.text] : [],
			)
			.join("\n");
	}
	return "";
}

/** Did this prompt actually run something that would fail if the code were broken? */
export function ranVerification(messages: Message[]): boolean {
	for (const m of messages) {
		if (m?.role !== "assistant") continue;
		for (const c of parts(m)) {
			if (c?.type !== "toolCall") continue;
			if (c.name && VERIFY_TOOLS.has(c.name)) return true;
			const a = (c.arguments ?? {}) as Record<string, unknown>;
			const nested = Array.isArray(a.commands)
				? (a.commands as Array<{ command?: unknown }>)
				: [];
			const text = [a.command, a.code, ...nested.map((n) => n?.command)]
				.filter((t): t is string => typeof t === "string")
				.join("\n");
			if (VERIFY_CMD.test(text)) return true;
		}
	}
	return false;
}

/** The gate: an unbacked correctness claim. */
export function isPhantomVerification(messages: Message[]): boolean {
	return CLAIM.test(finalAssistantText(messages)) && !ranVerification(messages);
}

const NUDGE =
	"[evidence-gate] You asserted that verification passed, but no test, build, or " +
	"diagnostic command ran during this turn. Either run it now and report the real " +
	"output, or restate what you actually checked and what you did not.";

export default function evidenceGate(pi: ExtensionAPI) {
	// ponytail: one nudge per real user prompt. Prevents nudge -> agent_end -> nudge looping.
	let nudged = false;

	pi.on("input", (event) => {
		if (event.source !== "extension") nudged = false;
		return undefined;
	});

	pi.on("agent_end", (event, ctx) => {
		if (nudged) return undefined;
		if (!isPhantomVerification((event.messages ?? []) as Message[]))
			return undefined;
		nudged = true;

		if (ctx.hasUI) {
			ctx.ui.notify(
				"evidence-gate: completion claimed with no test/build run this turn",
				"warning",
			);
			return undefined;
		}
		// sendUserMessage lives on ExtensionAPI (the pi object) and returns void; it is NOT on
		// the handler ctx. agent_end also fires while the agent still counts as processing, so
		// an unqueued send throws — followUp queues the nudge as the next turn.
		pi.sendUserMessage(NUDGE, { deliverAs: "followUp" });
		return undefined;
	});
}

if (import.meta.main) {
	const { strict: assert } = await import("node:assert");

	const say = (text: string): Message => ({
		role: "assistant",
		content: [{ type: "text", text }],
	});
	const run = (command: string): Message => ({
		role: "assistant",
		content: [{ type: "toolCall", name: "bash", arguments: { command } }],
	});
	const call = (name: string): Message => ({
		role: "assistant",
		content: [{ type: "toolCall", name, arguments: {} }],
	});

	// fires: claim with nothing backing it
	assert.equal(isPhantomVerification([say("All tests pass.")]), true);
	assert.equal(isPhantomVerification([say("Verified the fix works.")]), true);
	assert.equal(
		isPhantomVerification([run("ls -la"), say("Tests are green.")]),
		true,
		"ls is not verification",
	);

	// silent: the claim is backed
	assert.equal(
		isPhantomVerification([run("bun test"), say("All tests pass.")]),
		false,
	);
	assert.equal(
		isPhantomVerification([run("uv run pytest -q"), say("tests pass")]),
		false,
	);
	assert.equal(
		isPhantomVerification([call("lens_diagnostics"), say("No errors.")]),
		false,
	);
	assert.equal(
		isPhantomVerification([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						name: "ctx_execute",
						arguments: { code: "npm test" },
					},
				],
			},
			say("Tests pass."),
		]),
		false,
		"verification inside ctx_execute counts",
	);

	// silent: change reports are not correctness claims (the main false-positive risk)
	assert.equal(
		isPhantomVerification([say("Fixed the typo in utils.ts.")]),
		false,
		"'fixed' alone must not fire",
	);
	assert.equal(
		isPhantomVerification([say("Done — renamed the function across 4 files.")]),
		false,
		"'done' alone",
	);
	assert.equal(
		isPhantomVerification([say("Implementation complete.")]),
		false,
		"'complete' alone",
	);
	assert.equal(isPhantomVerification([]), false, "empty prompt");
	assert.equal(
		isPhantomVerification([say("I could not verify this; tests did not run.")]),
		false,
		"explicit non-claim",
	);

	// last assistant message is the one that matters
	assert.equal(finalAssistantText([say("first"), say("second")]), "second");

	// loop guard: nudges at most once until a real user turn arrives
	let sent = 0;
	let lastOpts: unknown;
	const handlers: Record<
		string,
		(e: unknown, c: unknown) => Promise<unknown> | unknown
	> = {};
	// Stub mirrors the real API split: sendUserMessage is on the pi object, never on the
	// handler ctx. An earlier stub put it on ctx, so this suite passed while the live run threw.
	evidenceGate({
		on: (n: string, f: never) => (handlers[n] = f),
		sendUserMessage: (_c: unknown, o: unknown) => {
			sent++;
			lastOpts = o;
		},
	} as never);
	const noUi = { hasUI: false };
	const claimed = { messages: [say("All tests pass.")] };

	await handlers.agent_end(claimed, noUi);
	await handlers.agent_end(claimed, noUi);
	assert.equal(sent, 1, "must not re-nudge without an intervening user prompt");
	assert.deepEqual(
		lastOpts,
		{ deliverAs: "followUp" },
		"agent_end fires mid-processing; unqueued send throws",
	);

	handlers.input({ source: "extension" }, noUi);
	await handlers.agent_end(claimed, noUi);
	assert.equal(sent, 1, "its own injected message must not rearm the gate");

	handlers.input({ source: "interactive" }, noUi);
	await handlers.agent_end(claimed, noUi);
	assert.equal(sent, 2, "a real user prompt rearms the gate");

	// UI mode notifies instead of spending a turn
	let notified = 0;
	const ui = { hasUI: true, ui: { notify: () => notified++ } };
	handlers.input({ source: "interactive" }, ui);
	await handlers.agent_end(claimed, ui);
	assert.equal(notified, 1);
	assert.equal(sent, 2, "UI mode must not inject a turn");

	process.stderr.write("evidence-gate self-check: ok\n");
}
