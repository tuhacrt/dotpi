# Handoff: pi-mcp-adapter is pinned to 3.0.0

Opened 2026-09-30. Delete this file once the pin is lifted.

## Why the pin exists

`agent/npm/package.json` pins `"pi-mcp-adapter": "3.0.0"` exactly (no caret).

A subagent that lists `mcp:<server>` in its `tools:` only gets those tools when
pi-subagents' `computeMcpServerHash()` matches the `configHash` that pi-mcp-adapter
wrote to `agent/mcp-cache.json`. pi-mcp-adapter 3.1.0 added `inheritEnv`/`literalEnv`
to its `computeServerHash()` identity. pi-subagents 0.73.1 did not follow, so on
adapter 3.1.0+ every child launch fails with:

```text
Unresolved MCP direct-tool selectors: context-mode. ...
```

This affects planner, reviewer, scout, and worker, which all use
`mcp:context-mode, mcp:headroom`.

## When to lift it

Lift it only when a pi-subagents release hashes MCP server config the same way as
the pi-mcp-adapter version you want. Check for either of these:

- The pi-subagents changelog mentions `inheritEnv`, `literalEnv`, or matching the
  adapter's cache hash.
- The check below prints `true` for every server.

## Check

1. See what's out:

   ```sh
   cd ~/.pi/agent/npm
   npm view pi-mcp-adapter version
   npm view pi-subagents version
   ```

2. Unpack both candidates in a scratch dir and compare hashes against the real
   config. This installs nothing under `~/.pi`.

   ```sh
   cd "$(mktemp -d)"
   npm pack pi-mcp-adapter@latest pi-subagents@latest --silent
   mkdir a s && tar xzf pi-mcp-adapter-*.tgz -C a && tar xzf pi-subagents-*.tgz -C s
   ln -s ~/.pi/agent/npm/node_modules a/package/node_modules
   ln -s ~/.pi/agent/npm/node_modules s/package/node_modules
   cat > t.mjs <<'EOF'
   import fs from "node:fs";
   import os from "node:os";
   const { computeServerHash } = await import(process.cwd() + "/a/package/dist/metadata-cache.js");
   const { computeMcpServerHash } = await import(process.cwd() + "/s/package/src/runs/shared/mcp-direct-tool-allowlist.js");
   const cfg = JSON.parse(fs.readFileSync(os.homedir() + "/.pi/agent/mcp-adapter.json", "utf8"));
   for (const [name, def] of Object.entries(cfg.mcpServers))
     console.log(name, "hashes match:", computeServerHash(def) === computeMcpServerHash(def));
   EOF
   node t.mjs
   ```

   Any `false` means leave the pin in place.

3. If every line says `true`, upgrade both packages together, the way pi installs
   them:

   ```sh
   cd ~/.pi/agent/npm
   npm install pi-mcp-adapter@<ver> pi-subagents@<ver> --legacy-peer-deps --omit=dev --no-fund --no-audit
   ```

   Keep `--legacy-peer-deps`. Without it npm pulls in about 224 peer packages that pi
   doesn't use. Decide whether to keep an exact pin or go back to `^`.

4. Restart pi, then verify from a live session:
   - Use any context-mode tool once in the parent. context-mode starts lazily, so it
     has no cache entry until first use.
   - Launch `scout` async and have it call `ctx_execute` and `headroom_compress`, then
     `headroom_retrieve` on the returned hash.
   - Pass means all three calls return results. Fail means an
     `Unresolved MCP direct-tool selectors` error at launch.

## If a launch breaks after an upgrade

Roll back: `npm install pi-mcp-adapter@3.0.0 --save-exact --legacy-peer-deps --omit=dev`.
Move `agent/mcp-cache.json` aside, restart pi, and use context-mode once so the cache is
rewritten with 3.0.0 hashes.

## What the pin costs

Adapter fixes in 3.1.0 and 3.2.0 are not installed, including:

- OAuth callbacks default to `127.0.0.1` instead of `localhost`.
- Direct tools no longer drop out when another pi session rewrites the shared cache.
- `mcpScript` works in Bun-compiled pi builds.
- No false "project servers blocked" warning in trusted projects.
