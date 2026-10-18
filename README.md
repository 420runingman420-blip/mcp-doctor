# ⚕ mcp-doctor

**Find out why your MCP server won't connect. It tells you the bug, and the fix.**

You paste a config that says `{"command":"npx","args":[]}` into Claude Desktop, get "Connection closed", and spend an hour grepping the MCP spec. mcp-doctor reads your config, flags every thing that is wrong (and what is fragile), and gives you the exact corrected snippet.

```
$ mcp-doctor .mcp.json --live
mcp-doctor report — .mcp.json
status: FAIL  (2 errors, 1 warnings, 0 notes)

✗ [ERROR] search :: npx with no package name will prompt or fail.
    fix: Provide the package as args[0], e.g. { "command": "npx", "args": ["-y", "some-mcp-server", ...] }.
✗ [ERROR] search :: env.API_KEY references ${API_KEY} but API_KEY is not set in this environment.
    fix: Export API_KEY before starting the client, or hardcode a fallback value.
! [WARN] search :: npx may prompt to install the package on first run (or on updates), which hangs stdio clients.
    fix: Add "-y" to args, or pin the server: npm i -g the package and call its bin directly.

✓ [live] search: stdio handshake OK — server search v1.2.0, protocol 2025-03-26
```

## What it checks

**Config** (Claude Desktop / Claude Code / Cursor / any `mcpServers` JSON):
- `mcpServers` typos, empty maps, non-object values — *with closest-key suggestions*
- Server names: length/character rules clients enforce, duplicates
- Transport: `command` vs `url` ambiguity, `type` typos (`"stdion"` → *did you mean stdio?*), type/field mismatches
- stdio: `npx` without a package, `npx` without `-y` (interactive install hangs), `.js` files used as the executable, `python` vs `python3`, docker without an image, `args` as a string, non-string `env` values, `${VAR}` interpolation of unset variables, spaces in command
- http/sse: invalid URLs, `0.0.0.0` bind addresses, `localhost` reachability traps, SSE vs streamable-http endpoint hints, header shape, `Authorization` format, plaintext-token hygiene
- Unknown keys with typo suggestions (`headees` → `headers`)

**Live check (`--live`, CLI only)**: spawns the stdio server or hits the HTTP endpoint and performs a real JSON-RPC `initialize` handshake, then reports exactly where it breaks (ENOENT, early exit + stderr, timeout, 404/405, wrong endpoint family).

**Tools (`--tools`)**: diagnoses a `tools/list` response — duplicate names, name charset, missing descriptions (the #1 reason LLMs call the wrong tool), `required` entries not present in `properties` (strict validators reject these), wrong top-level schema types.

## Install

```bash
npm i -g mcp-diagnose
# or without installing:
npx mcp-diagnose .mcp.json --live
```

## Usage

```bash
mcp-doctor                      # auto-discovers .mcp.json / claude_desktop_config.json
mcp-doctor path/to/mcp.json     # explicit file
mcp-doctor --stdin < cfg.json   # from stdin
mcp-doctor --live               # + real initialize handshake against your server
mcp-doctor --json               # machine-readable (CI-friendly; exits 1 on errors)
echo '{"tools":[...]}' | mcp-doctor --tools --stdin
```

CI snippet:

```yaml
- name: MCP preflight
  run: npx -y mcp-doctor .mcp.json --json
```

## Web version

Paste a config or a `tools/list` payload, get the same report in your browser. Nothing is uploaded. (Hosted on GitHub Pages — see repo settings.)

## Exit codes

`0` no errors (warnings allowed) · `1` errors found · `2` usage/IO error — so you can gate deploys on it.

## Philosophy

MCP servers are mostly Node/Python scripts wrapped in JSON, and 90% of "it won't connect" reports are: wrong transport family, `npx` interactive prompt, unset env var, `0.0.0.0` in a client URL, or a config key typo. A doctor that checks the vitals is faster than reading the spec.

MIT licensed. Zero dependencies. Node ≥ 18.
