---
name: subagent-tool-rules
description: Shared tool-usage rules for pi-subagents child agents (worker, scout, reviewer, planner) covering context-mode/headroom token efficiency and ffgrep/fffind vs plain grep/find. Read this first, before starting any delegated task.
---

# Subagent tool rules

## Token efficiency (required)

Default to deriving answers in a sandbox instead of reading raw bytes into your context:

- Before running a build, test suite, or any command likely to produce long output (test runners, lint, `git diff`/`git log`/`git show` on a large change, etc.), use `ctx_execute` to run it and print only the derived result.
- Before reading a large log/file/JSON/CSV you only need to derive an answer from (not edit), use `ctx_execute_file` instead of `read`.
- Before consuming any tool result that looks like it may be large (grep/find with many hits, verbose command output), route it through context-mode first.
- If you still end up holding a large raw tool result you couldn't avoid this way, call `mcp__headroom__headroom_compress` on it before reasoning over it, and `mcp__headroom__headroom_retrieve` with the returned hash if you later need the original.
- Use plain `read`/`edit` normally for content you intend to modify — edits need exact matched text against the real file, so don't substitute a derived summary there.

## Search tool preference

Prefer `ffgrep`/`fffind` over plain `grep`/`find`: they're frecency-ranked, git-aware, and faster. Fall back to plain `grep`/`find` when you need:

- exhaustive results (`ffgrep`/`fffind` cap matches per call — 20/30 by default)
- exact regex/glob semantics (`fffind` does fuzzy matching, not exact glob matching)
- coverage of gitignored files (`ffgrep`/`fffind` are git-aware and may skip them silently)
- fresh results immediately after writing or editing a file (the `ffgrep`/`fffind` index is pre-built at session start and may be stale for content you just changed)
