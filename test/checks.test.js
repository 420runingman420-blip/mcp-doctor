import { test } from "node:test";
import assert from "node:assert";
import { diagnoseConfig, diagnoseTools } from "../src/checks.js";

test("valid stdio config passes", () => {
  const r = diagnoseConfig({ mcpServers: { a: { command: "node", args: ["x.js"] } } });
  assert.equal(r.summary.errors, 0);
});

test("valid http config passes", () => {
  const r = diagnoseConfig({ mcpServers: { a: { type: "http", url: "https://example.com/mcp" } } });
  assert.equal(r.summary.errors, 0);
});

test("catches mcpServers typo and still diagnoses", () => {
  const r = diagnoseConfig({ mcpServerz: { a: { command: "npx", args: [] } } });
  assert.ok(r.summary.errors >= 2);
  assert.ok(r.findings.some(f => f.code === "missing-mcpservers"));
  assert.ok(r.findings.some(f => f.code === "npx-no-pkg"));
});

test("catches invalid json string", () => {
  const r = diagnoseConfig("{ nope }");
  assert.equal(r.summary.errors, 1);
  assert.equal(r.findings[0].code, "invalid-json");
});

test("catches bad type with suggestion", () => {
  const r = diagnoseConfig({ mcpServers: { a: { type: "stdion", command: "node", args: [] } } });
  assert.ok(r.findings.some(f => f.code === "bad-type" && f.fix.includes("stdio")));
});

test("catches 0.0.0.0 dial address", () => {
  const r = diagnoseConfig({ mcpServers: { a: { url: "http://0.0.0.0:8080/mcp" } } });
  assert.ok(r.findings.some(f => f.code === "url-any"));
});

test("catches required-not-in-properties on tools", () => {
  const r = diagnoseTools({ tools: [{ name: "x", description: "d", inputSchema: { type: "object", required: ["nope"] } }] });
  assert.ok(r.findings.some(f => f.code === "tool-required-missing"));
});

test("catches duplicate tool names", () => {
  const r = diagnoseTools([{ name: "x", description: "d" }, { name: "x", description: "d" }]);
  assert.ok(r.findings.some(f => f.code === "tool-dup"));
});

test("flags unset env interpolation", () => {
  const r = diagnoseConfig({ mcpServers: { a: { command: "node", args: [], env: { K: "${DEFINELY_UNSET_VAR_XYZ_123}" } } } });
  assert.ok(r.findings.some(f => f.code === "env-unset"));
});

test("unknown key typo suggestion", () => {
  const r = diagnoseConfig({ mcpServers: { a: { url: "https://example.com", headees: {} } } });
  assert.ok(r.findings.some(f => f.code === "unknown-key" && f.fix && f.fix.includes("headers")));
});

test("args as string is an error", () => {
  const r = diagnoseConfig({ mcpServers: { a: { command: "node", args: "x" } } });
  assert.ok(r.findings.some(f => f.code === "args-string"));
});

test("localhost warns", () => {
  const r = diagnoseConfig({ mcpServers: { a: { url: "http://localhost:8080/mcp" } } });
  assert.ok(r.findings.some(f => f.code === "url-localhost"));
});

test("npx with -y before package name is valid", () => {
  const r = diagnoseConfig({ mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/x"] } } });
  assert.equal(r.findings.find(f => f.code === "npx-no-pkg"), undefined);
});
