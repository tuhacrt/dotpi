# Global operating rules

Applies to every project. A project's own `AGENTS.md` overrides anything here.

## Definition of done

Done means verified, not written.

- Ran the project's own build/test command and saw it pass. No run means not done. A change
  with no logic in it (docs, prose config) has nothing to run; say so rather than skipping
  silently.
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
secret store. The secret hook (`block_secrets.py`, run by `extensions/shared_hooks.ts`)
blocks this at the tool boundary, and a block is a real finding rather than a false
positive to route around. Do not echo credential values into
the transcript, including values read out of files.

The hook matches only a short list of known token formats and filenames, so most
credentials (a quoted JSON `"clientSecret": "..."`, for one) scan clean. Do not treat its
silence as proof a file is free of credentials.

## This environment

Facts that a repo's own files do not reveal:

- No forge CLI is installed: no `gh`, `glab`, or `tea`. Do not script PR creation. Push a
  branch and hand back the URL. Gitea's web UI is `https://git.polymerrisk.com`, not the
  `git-ssh-intranet` host in the remote.
- `~/i/praxis` is not a repo. Each top-level folder is either a clone or a container whose
  clone sits at `<name>/<name>`, often with sibling folders that are git worktrees of it
  (`polymer-praxis/{feat,fix,pfa}`). Git exits 128 on a container, so a sweep written as
  `git -C "$d" ls-files 2>/dev/null || true` silently skips it along with the repos inside.
  Descend one level, and report any folder that is still not a repo instead of suppressing
  git's error.
- `~/i/praxis/praxis-workspace` is a meta-repo with its own `AGENTS.md`. Its `repos/*` are
  separate clones of the same remotes, so a change in `~/i/praxis/<svc>/<svc>` does not
  appear there. Confirm which copy the task means before editing.
- Installed: `uv`, `pnpm`, `bun`, `npm`, `dotnet`. Not installed: `poetry`, a global
  `pytest`, `terraform`. Check the repo before assuming a runner.
- Build and test commands are per-repo. Read that repo's `package.json`, `requirements.txt`,
  or CI config instead of assuming a shared command.
- Some repos carry both `bun.lock` and `package-lock.json`. Ask before regenerating either.

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
- `rtk dotnet build`, `rtk tsc`, `rtk cargo build` instead of the bare build command

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
