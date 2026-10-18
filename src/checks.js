/**
 * mcp-doctor — diagnostic engine for Model Context Protocol (MCP) server configs.
 *
 * Pure, dependency-free, works in Node and in the browser.
 * Severity: error (will not connect), warn (may fail / fragile), info (style / risk).
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_TYPES = new Set(["stdio", "sse", "http", "streamable-http", "websocket", "ws"]);
const KNOWN_CMDS = new Set([
  "node", "npx", "pnpm", "yarn", "bun", "deno", "uv", "uvx", "python", "python3",
  "pip", "docker", "podman", "npm", "uvx", "go", "cargo", "ruby", "perl", "sh", "bash",
]);

export function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(
        m[i - 1][j] + 1,
        m[i][j - 1] + 1,
        m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
  return m[a.length][b.length];
}

function closest(word, vocab, maxDist = 2) {
  let best = null, bestD = maxDist + 1;
  for (const v of vocab) {
    const d = levenshtein(word.toLowerCase(), v.toLowerCase());
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

function finding(severity, server, code, message, fix) {
  return { severity, server, code, message, fix: fix || null };
}

/**
 * Diagnose a parsed MCP config object (or a JSON string).
 * Returns { findings: [...], summary: {...} }
 */
export function diagnoseConfig(input, opts = {}) {
  const findings = [];
  const env = (typeof process !== "undefined" && process.env) ? process.env : {};
  let cfg = input;
  if (typeof cfg === "string") {
    let parsed;
    try { parsed = JSON.parse(cfg); }
    catch (e) {
      return {
        findings: [finding("error", "(config)", "invalid-json", `Config is not valid JSON: ${e.message}`,
          "Fix the JSON syntax and re-run. Common culprits: trailing commas, single quotes, unquoted keys, comments (// is not allowed in JSON).")],
        summary: { errors: 1, warns: 0, infos: 0, servers: 0 },
      };
    }
    cfg = parsed;
  }
  if (typeof cfg !== "object" || cfg === null) {
    return { findings: [finding("error", "(config)", "not-object", "Top-level config must be a JSON object.", null)],
             summary: { errors: 1, warns: 0, infos: 0, servers: 0 } };
  }

  // Locate the server map: {"mcpServers": {...}} or flat {"name": {...}}
  let servers = null, wrapper = null;
  if (cfg.mcpServers && typeof cfg.mcpServers === "object") { servers = cfg.mcpServers; wrapper = "mcpServers"; }
  else {
    const vals = Object.values(cfg).filter(v => v && typeof v === "object");
    if (vals.length && vals.every(v => v.command || v.url || v.type)) { servers = cfg; wrapper = "(flat)"; }
    else {
      const near = closest("mcpServers", Object.keys(cfg), 3);
      if (near && cfg[near] && typeof cfg[near] === "object" && !Array.isArray(cfg[near])) {
        // near-miss typo: diagnose the map anyway so we report real errors too
        findings.push(finding("error", "(config)", "missing-mcpservers",
          `Top-level key should be "mcpServers", found "${near}".`,
          `Rename "${near}" to "mcpServers". (diagnosed the map anyway)`));
        servers = cfg[near]; wrapper = near;
      } else {
        findings.push(finding("error", "(config)", "missing-mcpservers",
          `No server map found. Expected a top-level "mcpServers" object.`,
          near ? `"${near}" looks like a typo of "mcpServers" — rename the key.` :
          "Wrap your servers in { \"mcpServers\": { ... } }."));
        return finish(findings, 0);
      }
    }
  }

  if (!Object.keys(servers).length) {
    findings.push(finding("warn", "(config)", "empty", `"${wrapper}" is empty — no servers defined.`, null));
    return finish(findings, 0);
  }

  const seenNames = new Map();
  let serverCount = 0;

  for (const [name, def] of Object.entries(servers)) {
    serverCount++;
    if (seenNames.has(name)) findings.push(finding("warn", name, "dup-name",
      `Duplicate server name "${name}" — clients keep only one.`, "Rename one of the duplicates."));
    seenNames.set(name, true);

    if (!name || !NAME_RE.test(name)) {
      findings.push(finding("error", name || "(unnamed)", "bad-name",
        `Server name "${name}" has characters clients may reject.`,
        "Use 1–64 chars: letters, digits, '_', '-', '.'; must start with a letter or digit."));
    }

    if (!def || typeof def !== "object") {
      findings.push(finding("error", name, "not-object", "Server definition must be an object.", null));
      continue;
    }

    // --- transport detection ------------------------------------------------
    const hasCmd = typeof def.command === "string" && def.command.trim();
    const hasUrl = typeof def.url === "string" && def.url.trim();
    const declared = typeof def.type === "string" ? def.type.toLowerCase() : null;
    if (declared && !VALID_TYPES.has(declared)) {
      const near = closest(declared, [...VALID_TYPES]);
      findings.push(finding("error", name, "bad-type",
        `type "${declared}" is not a recognized MCP transport.`,
        near ? `Did you mean "${near}"?` : `Valid: ${[...VALID_TYPES].join(", ")}.`));
    }
    if (hasCmd && hasUrl) {
      findings.push(finding("warn", name, "both-cmd-url",
        "Server has both command and url. Clients resolve transport by which key is present — having both is ambiguous.",
        "Keep only the key matching your transport: command (stdio) or url (sse/http)."));
    }
    if (!hasCmd && !hasUrl) {
      findings.push(finding("error", name, "no-transport",
        "Server has neither command (stdio) nor url (sse/http) — it cannot start.",
        "Add \"command\": \"...\" for stdio, or \"url\": \"...\" for http/sse."));
      continue;
    }
    const isStdio = hasCmd && (!hasUrl || (declared === "stdio"));
    const isHttp = (hasUrl && !hasCmd) || declared === "http" || declared === "sse" || declared === "streamable-http";

    if (isStdio) checkStdio(name, def, findings, env);
    if (isHttp) checkHttp(name, def, findings);

    // type vs fields cross-check
    if (declared === "stdio" && hasUrl && !hasCmd)
      findings.push(finding("error", name, "type-mismatch", "type is stdio but only url is present.", "Add command+args, or change type to http/sse."));
    if (declared === "http" && hasCmd && !hasUrl)
      findings.push(finding("error", name, "type-mismatch", "type is http but only command is present.", "Add url, or change type to stdio."));
    if (declared === "sse" && hasCmd && !hasUrl)
      findings.push(finding("error", name, "type-mismatch", "type is sse but only command is present.", "Add url, or change type to stdio."));

    // --- generic field checks ---------------------------------------------
    checkCommon(name, def, findings, env);
  }

  return finish(findings, serverCount);
}

function checkStdio(name, def, findings, env) {
  const cmd = def.command;
  const bin = cmd.split(/\s+/)[0].replace(/^["']|["']$/g, "");

  if (/\s/.test(cmd)) findings.push(finding("warn", name, "cmd-spaces",
    `command "${cmd}" contains spaces. Most clients run it via a shell, some split on whitespace — both behaviors exist.`,
    "Put the executable in \"command\" and flags in \"args\", or set a \"shell\": true style wrapper if your client supports it."));

  if (/\.(js|mjs|cjs|ts)$/.test(bin) && !["node", "npx", "bun", "deno", "pnpm", "yarn"].includes(bin)) {
    findings.push(finding("warn", name, "js-as-cmd",
      `command "${cmd}" ends in a .js/.mjs/.ts file. On Linux this needs a shebang AND execute permission; on Windows it usually fails outright.`,
      `Set command to the runtime, e.g. { "command": "node", "args": ["${cmd}", ...] }.`));
  }

  if (bin === "npx" && !(Array.isArray(def.args) && def.args.length && !def.args[0].startsWith("-"))) {
    findings.push(finding("error", name, "npx-no-pkg",
      `npx with no package name will prompt or fail.`,
      `Provide the package as args[0], e.g. { "command": "npx", "args": ["-y", "some-mcp-server", ...] }.`));
  }
  if (bin === "npx" && !(Array.isArray(def.args) && def.args.includes("-y"))) {
    findings.push(finding("info", name, "npx-interactive",
      `npx may prompt to install the package on first run (or on updates), which hangs stdio clients.`,
      `Add "-y" to args, or pin the server: npm i -g the package and call its bin directly.`));
  }

  if (bin === "python" && typeof process !== "undefined" && process.platform === "linux") {
    findings.push(finding("warn", name, "python-alias",
      `"python" is often missing on Linux/macOS (only python3 is installed).`,
      `Use "python3" on Unix, or "py" / a venv path for portability.`));
  }

  if (bin === "docker" && !(Array.isArray(def.args) && def.args.length >= 1 && !def.args[0].startsWith("-"))) {
    findings.push(finding("warn", name, "docker-no-image",
      "docker without an image name will not start a container.", "docker args must be [-v flags] <image> [cmd...]."));
  }

  if (typeof def.args === "string") {
    findings.push(finding("error", name, "args-string",
      "args is a string — clients expect an array.", `Use an array: ["${def.args}"]`));
  } else if (def.args !== undefined && !(Array.isArray(def.args) && def.args.every(a => typeof a === "string"))) {
    findings.push(finding("error", name, "args-bad", "args must be an array of strings.", null));
  }

  if (def.env !== undefined) {
    if (typeof def.env !== "object" || def.env === null || Array.isArray(def.env)) {
      findings.push(finding("error", name, "env-bad", "env must be an object of string values.", null));
    } else {
      for (const [k, v] of Object.entries(def.env)) {
        if (typeof v !== "string") findings.push(finding("error", name, "env-nonstring",
          `env.${k} must be a string, got ${typeof v}.`, `JSON-encode it: "${JSON.stringify(v)}"`));
        if (typeof v === "string") {
          const refs = [...v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g)];
          for (const m of refs) {
            const varName = m[1] || m[2];
            if (!env[varName]) findings.push(finding("warn", name, "env-unset",
              `env.${k} references \${${varName}} but ${varName} is not set in this environment. Some clients leave it as the literal string.`,
              `Export ${varName} before starting the client, or hardcode a fallback value.`));
          }
        }
      }
    }
  }
}

function checkHttp(name, def, findings) {
  const url = def.url;
  let u;
  try { u = new URL(url); } catch {
    findings.push(finding("error", name, "url-invalid", `url "${url}" is not a valid absolute URL.`, 'Use e.g. "https://example.com/mcp" (scheme required).'));
    return;
  }
  if (!["http:", "https:"].includes(u.protocol)) {
    findings.push(finding("error", name, "url-scheme", `url scheme "${u.protocol}" is not http/https.`, null));
  }
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]") {
    findings.push(finding("warn", name, "url-localhost",
      "url points at localhost — the MCP server must be running on the same machine as the client (and often as the same user, e.g. desktop apps).",
      "Keep it local + run the server, or use a reachable host/port."));
  }
  if (/0\.0\.0\.0/.test(u.hostname)) {
    findings.push(finding("error", name, "url-any",
      "url host 0.0.0.0 is a bind address, not a dial address — connecting to it will usually fail.",
      "Use http://localhost:... for local dev."));
  }
  if (u.hostname === "") findings.push(finding("error", name, "url-nohost", "url has no host.", null));
  if (def.type === "sse" && /\/sse(\?.*)?$/.test(u.pathname)) {
    findings.push(finding("info", name, "sse-endpoint",
      "Looks like an SSE endpoint. Note: newer clients (Claude Desktop 1.x, Claude Code, Cursor) default to Streamable HTTP; some servers now prefer POST-based /mcp endpoints.",
      "If initialize fails with 405/400, try the same host's streamable-http endpoint (commonly /mcp)."));
  }
  if (def.headers !== undefined && (typeof def.headers !== "object" || def.headers === null || Array.isArray(def.headers))) {
    findings.push(finding("error", name, "headers-bad", "headers must be an object of strings.", null));
  }
  if (def.headers && def.headers.Authorization) {
    const a = String(def.headers.Authorization);
    if (!/^Bearer\s+\S+/i.test(a) && !/^Basic\s+\S+/i.test(a)) {
      findings.push(finding("warn", name, "auth-format",
        `Authorization header "${a.slice(0, 20)}…" does not start with Bearer/Basic — many MCP servers reject bare tokens.`,
        `Use "Authorization": "Bearer <token>".`));
    }
    findings.push(finding("info", name, "token-in-config",
      "A plaintext credential is stored in config. Fine locally; avoid committing this file (add to .gitignore).",
      "Use env interpolation or a secrets manager if the config is shared."));
  }
}

function checkCommon(name, def, findings) {
  const known = ["command", "args", "env", "type", "url", "headers", "cwd", "timeout", "disabled"];
  for (const k of Object.keys(def)) {
    if (known.includes(k)) continue;
    const near = closest(k, known, 2);
    findings.push(finding(near ? "warn" : "info", name, "unknown-key",
      `Unknown key "${k}" — this client may ignore it.` + (near ? ` Did you mean "${near}"?` : ""),
      near ? `Rename "${k}" to "${near}".` : null));
  }
}

/**
 * Diagnose tools/list output (or a full result envelope).
 */
export function diagnoseTools(input) {
  const findings = [];
  let tools = Array.isArray(input) ? input : (Array.isArray(input?.tools) ? input.tools : null);
  if (!tools) {
    return { findings: [finding("error", "(tools)", "no-tools", "No tool list found — expected an array of tools or { tools: [...] }.", null)],
             summary: { errors: 1, warns: 0, infos: 0, servers: 1 } };
  }
  if (!tools.length) {
    findings.push(finding("info", "(tools)", "zero-tools", "Server exposes 0 tools. That is legal, but clients will see an empty server — check the server logs for startup errors.", null));
  }
  const names = new Set();
  for (const t of tools) {
    const tname = t?.name || "(unnamed)";
    if (!tname.match) {} // noop
    if (!TOOL_NAME_RE.test(String(tname))) {
      findings.push(finding("warn", tname, "tool-name",
        `Tool name "${tname}" — clients recommend ^[a-zA-Z0-9_-]{1,64}$. Some clients reject dots/camelCase in tool names.`, null));
    }
    if (names.has(String(tname))) findings.push(finding("error", tname, "tool-dup", `Duplicate tool name "${tname}".`, null));
    names.add(String(tname));
    if (!t.description || !String(t.description).trim()) {
      findings.push(finding("warn", tname, "tool-nodesc",
        "Tool has no description — LLMs pick tools by description; empty descriptions measurably hurt tool-call quality.",
        "Add a 1–3 sentence description of when to use the tool and what it returns."));
    }
    const schema = t.inputSchema;
    if (schema === undefined || schema === null) {
      findings.push(finding("info", tname, "tool-noschema", "inputSchema missing — treated as {} by some clients. Legal, but non-standard for tools with parameters.", null));
    } else {
      if (typeof schema !== "object" || Array.isArray(schema)) {
        findings.push(finding("error", tname, "tool-schema-type", "inputSchema must be an object (JSON Schema).", null));
      } else {
        if (schema.type && schema.type !== "object") {
          findings.push(finding("warn", tname, "tool-schema-type",
            `inputSchema.type is "${schema.type}" — MCP expects a top-level object schema for tool arguments.`, null));
        }
        const props = schema.properties || {};
        if (Array.isArray(schema.required)) {
          for (const r of schema.required) {
            if (!(r in props)) findings.push(finding("error", tname, "tool-required-missing",
              `inputSchema.required lists "${r}" but properties has no such key — strict validators reject the schema.`,
              `Either define properties["${r}"] or remove "${r}" from required.`));
          }
        }
      }
    }
  }
  return finish(findings, 1, tools.length);
}

function finish(findings, servers, toolCount) {
  const errors = findings.filter(f => f.severity === "error").length;
  const warns = findings.filter(f => f.severity === "warn").length;
  const infos = findings.filter(f => f.severity === "info").length;
  return {
    findings,
    summary: {
      errors, warns, infos, servers,
      status: errors ? "FAIL" : warns ? "PASS (with warnings)" : "PASS",
      toolCount,
    },
  };
}

/** Render findings as a human-readable text report. */
export function renderReport(result, { configPath } = {}) {
  const icon = { error: "✗", warn: "!", info: "i" };
  const s = result.summary;
  const lines = [];
  lines.push(`mcp-doctor report${configPath ? ` — ${configPath}` : ""}`);
  lines.push(`status: ${s.status}  (${s.errors} errors, ${s.warns} warnings, ${s.infos} notes)`);
  lines.push("");
  const order = { error: 0, warn: 1, info: 2 };
  for (const f of [...result.findings].sort((a, b) => order[a.severity] - order[b.severity])) {
    lines.push(`${icon[f.severity]} [${f.severity.toUpperCase()}] ${f.server} :: ${f.message}`);
    if (f.fix) lines.push(`    fix: ${f.fix}`);
  }
  if (!result.findings.length) lines.push("✓ no problems found");
  return lines.join("\n");
}

export default { diagnoseConfig, diagnoseTools, renderReport, levenshtein };
