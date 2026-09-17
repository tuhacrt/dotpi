# Global operating rules

Applies to every project. A project's own `AGENTS.md` overrides anything here.

## Definition of done

Done means verified, not written.

- Ran the project's own build/test command and saw it pass. No run means not done.
- State what was verified and what was not. Never imply a check that did not happen.
- No `TODO`/`FIXME` left in code just written, unless deferral was requested.
- Scratch files, debug output, and temp scripts removed.

Report shape: what changed, how it was verified, what remains.

## Escalate instead of working around

Stop and ask rather than route around these:

- A test fails for a reason unrelated to the current change.
- The fix needs a credential, network access, or permission that is unavailable.
- The obvious fix contradicts an explicit instruction.
- The same approach failed twice. Diagnose the cause instead of tweaking a third time.

Never disable, skip, or weaken a test to make a suite pass.

## Secrets

Never write a literal credential into a file or a command; reference an env var or the
secret store. `secret-gate` blocks this at the tool boundary, and a block is a real
finding rather than a false positive to route around. Do not echo credential values into
the transcript, including values read out of files.

`secret-gate` has a known blind spot: quoted JSON keys (`"clientSecret": "..."`) scan
clean. Do not treat its silence as proof a file is free of credentials.

## This environment

Facts that a repo's own files do not reveal:

- Git host is a self-hosted Gitea on an intranet (`git-ssh-intranet.polymerrisk.com`), not
  GitHub. CI lives in `.gitea/workflows/`; a `.github/` directory here holds Copilot config.
- No forge CLI is installed: no `gh`, `glab`, or `tea`. Do not script PR creation. Push a
  branch and hand back the URL.
- Only some directories under `~/i/praxis` are git repos (4 of 11). Git fails loudly there
  (`fatal: not a git repository`, exit 128), so a sweep written as
  `git -C "$d" ls-files 2>/dev/null || true` converts that failure into an empty file list
  and silently skips the directory. Check `git rev-parse --git-dir` per directory and report
  what was skipped, rather than suppressing git's error.
- Python: `uv` is available; `poetry` and a global `pytest` are not. Check the repo before
  assuming a runner.
- Build and test commands are per-repo. Read that repo's `package.json`, `requirements.txt`,
  or CI config instead of assuming a shared command.
- Some repos carry both `bun.lock` and `package-lock.json`. Ask before regenerating either.
- `~/.pi` is itself a git repo with a remote. Treat files there as publishable: never commit
  credentials, and check `git status` before assuming a change is local-only.

<!-- kiro-setup:token-efficiency -->
## Token efficiency (managed by kiro-setup)

This environment is wired for token-efficient agent runs via two tools.
Prefer them whenever a step is likely to produce a large payload — it keeps
the context window small and the cost down.

### rtk — command-output compaction

Prefix shell commands with `rtk` to run them through the token-reducer hook,
which strips noise from large command output (builds, test runs, logs, git,
package installs). Examples:

- `rtk git status` instead of `git status`
- `rtk test <cmd>` (e.g. `rtk test npm test`) instead of the bare test command
- `rtk build` instead of `build`

Use `rtk <cmd>` over the bare command whenever the output is likely to be long.

### headroom — MCP compression tools

The `headroom` MCP server exposes `headroom_compress` and `headroom_retrieve`.
They are opt-in — call them explicitly:

- Call `headroom_compress` on any large tool output, file dump, search result,
  or log **before** reasoning over it. It returns compacted text plus a `hash`.
- Call `headroom_retrieve` with that `hash` when you need the full original
  content back.

MCP tools do not fire automatically, so prompt yourself to use them on large
payloads.
<!-- /kiro-setup:token-efficiency -->
