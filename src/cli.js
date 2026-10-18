#!/usr/bin/env node
/**
 * mcp-doctor — find out why your MCP server won't connect.
 *
 * Usage:
 *   mcp-doctor                       # scan common config files in cwd
 *   mcp-doctor path/to/mcp.json      # diagnose one config file
 *   mcp-doctor --stdin               # read config JSON from stdin
 *   mcp-doctor --live                # also attempt a real initialize handshake
 *   mcp-doctor --json                # machine-readable output
 *   echo '{"name":...}' | mcp-doctor --tools --stdin   # diagnose a tools/list payload
 */
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { diagnoseConfig, diagnoseTools, renderReport } from "./checks.js";

const arg = process.argv.slice(2);
const flags = new Set(arg.filter(a => a.startsWith("--")));
const pos = arg.filter(a => !a.startsWith("--"));

function die(msg, code = 2) { console.error(msg); process.exit(code); }

let raw = null;
if (flags.has("--stdin")) {
  raw = readFileSync(0, "utf8");
} else if (pos[0]) {
  const p = resolve(pos[0]);
  if (!existsSync(p)) die(`file not found: ${p}`);
  raw = readFileSync(p, "utf8");
  global.__configPath = p;
} else {
  const candidates = [
    ".mcp.json", "mcp.json",
    "claude_desktop_config.json",
    "~/.claude/claude_desktop_config.json",
    "~/.cursor/mcp.json", "~/.config/Claude/claude_desktop_config.json",
  ].map(p => p.replace(/^~/, process.env.HOME));
  const found = candidates.filter(p => existsSync(p));
  if (!found.length) die("No config found. Pass a path, use --stdin, or create .mcp.json in the project.\nLooked in: " + candidates.join(", "));
  const p = found[0];
  raw = readFileSync(p, "utf8");
  global.__configPath = p;
  if (found.length > 1) console.error(`note: ${found.length} configs found, using ${p}`);
}

if (flags.has("--tools")) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { die(`not valid JSON: ${e.message}`); }
  const result = diagnoseTools(parsed);
  if (flags.has("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(renderReport(result, { configPath: "tools payload" }));
  process.exit(result.summary.errors ? 1 : 0);
}

const result = diagnoseConfig(raw);

// --- optional live check ---------------------------------------------------
async function liveCheck(rawJson) {
  const lines = [];
  let cfg;
  try { cfg = JSON.parse(rawJson); } catch { return lines; }
  const servers = cfg.mcpServers ?? cfg;
  for (const [name, def] of Object.entries(servers)) {
    if (!def || typeof def !== "object") continue;
    const t0 = Date.now();
    try {
      if (def.command) {
        lines.push(await liveStdio(name, def));
      } else if (def.url) {
        lines.push(await liveHttp(name, def));
      }
    } catch (e) {
      lines.push(`! [live] ${name}: ${e.message}`);
    }
  }
  return lines;
}

function liveStdio(name, def, timeoutMs = 8000) {
  return new Promise((res) => {
    const child = spawn(def.command, def.args || [], {
      env: { ...process.env, ...(def.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let done = false;
    const finish = (msg) => { if (!done) { done = true; child.kill(); res(msg); } };
    const timer = setTimeout(() => finish(`✗ [live] ${name}: timed out after ${timeoutMs}ms waiting for initialize response (server started? check its stderr)`), timeoutMs);
    let stderrBuf = "";
    child.stderr.on("data", d => { stderrBuf += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); finish(`✗ [live] ${name}: could not spawn "${def.command}": ${e.message}`); });
    const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mcp-doctor", version: "1.0.0" },
    } });
    child.stdout.on("data", (d) => {
      const text = d.toString();
      for (const line of text.split("\n")) {
        const l = line.trim();
        if (!l.startsWith("{")) continue;
        try {
          const j = JSON.parse(l);
          if (j.id === 1) {
            clearTimeout(timer);
            const si = j.result?.serverInfo;
            const v = j.result?.protocolVersion;
            finish(`✓ [live] ${name}: stdio handshake OK — server ${si?.name ?? "?"} v${si?.version ?? "?"}, protocol ${v}${j.error ? ` (rpc error: ${j.error.message})` : ""}`);
          }
          if (j.error) { clearTimeout(timer); finish(`✗ [live] ${name}: initialize rpc error — ${j.error.message}`); }
        } catch {}
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(`✗ [live] ${name}: process exited early (code ${code})${stderrBuf ? " — " + stderrBuf.slice(-200) : ""}`);
    });
    child.stdin.write(req + "\n");
  });
}

async function liveHttp(name, def, timeoutMs = 8000) {
  const url = def.url;
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mcp-doctor", version: "1.0.0" },
  } };
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(def.headers || {}) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Streamable HTTP first, then SSE fallback.
    for (const [mode, h] of [["streamable-http", headers], ["sse", { ...headers, Accept: "text/event-stream" }]]) {
      let target = url;
      if (mode === "sse" && !/\/sse(\?.*)?$/.test(url)) target = url.replace(/\/?$/, "/sse");
      const r = await fetch(target, { method: "POST", headers: h, body: JSON.stringify(init), signal: controller.signal });
      const text = await r.text();
      if (r.ok || r.status === 405 || r.status === 404 || r.status === 400) {
        if (r.ok) {
          let info = "";
          try {
            const body = text.startsWith("event:") || !text.startsWith("{")
              ? (text.match(/\{.*\}/s)?.[0])
              : text;
            const j = body ? JSON.parse(body) : null;
            if (j?.result?.serverInfo) info = ` — server ${j.result.serverInfo.name} v${j.result.serverInfo.version}`;
            if (j?.error) info = ` — rpc error: ${j.error.message}`;
          } catch {}
          return `✓ [live] ${name}: ${mode} handshake OK (${r.status})${info}`;
        }
        if (mode === "streamable-http" && [404, 405, 400].includes(r.status)) continue; // try sse
        const snippet = text.slice(0, 120).replace(/\n/g, " ");
        return `✗ [live] ${name}: HTTP ${r.status} on ${mode}${snippet ? ` — ${snippet}` : ""}`;
      }
    }
    return `✗ [live] ${name}: no successful handshake (tried streamable-http and sse)`;
  } catch (e) {
    return `✗ [live] ${name}: ${e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message} (server running? reachable from this machine?)`;
  } finally { clearTimeout(timer); }
}

if (flags.has("--live")) {
  const extra = await liveCheck(raw);
  if (extra.length) {
    console.log(renderReport(result, { configPath: global.__configPath }));
    console.log("");
    console.log(extra.join("\n"));
  } else {
    console.log(renderReport(result, { configPath: global.__configPath }));
  }
} else if (flags.has("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(renderReport(result, { configPath: global.__configPath }));
}

process.exit(result.summary.errors ? 1 : 0);
