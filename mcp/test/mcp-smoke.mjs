#!/usr/bin/env node
// CI smoke test: real MCP handshake with mcp/server.js over stdio.
// Zero dependencies — spawns the server, speaks newline-delimited JSON-RPC,
// asserts `initialize` answers and `tools/list` exposes the six x402 tools.
// No env vars and no network needed: this only exercises the handshake +
// tool listing, never tools/call (which would need a live x402 endpoint).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(root, "server.js");
const EXPECTED_TOOLS = [
  "fabler_scan_secrets",
  "fabler_audit_agent_config",
  "fabler_audit_diff_security",
  "fabler_audit_pre_deploy",
  "fabler_render_og",
  "fabler_list_products",
];
const TIMEOUT_MS = 10_000;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const child = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, X402_BASE_URL: "", X402_BUYER_PRIVATE_KEY: "" },
});

const timer = setTimeout(() => {
  child.kill();
  fail(`no complete handshake within ${TIMEOUT_MS}ms`);
}, TIMEOUT_MS);

const pending = new Map(); // id -> resolve
let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`server emitted non-JSON line: ${line.slice(0, 200)}`);
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function request(id, method, params = {}) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// 1. initialize
const init = await request(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "ci-smoke", version: "0.0.0" },
});
if (init.error) fail(`initialize returned error: ${JSON.stringify(init.error)}`);
if (!init.result?.serverInfo?.name) fail(`initialize result missing serverInfo: ${JSON.stringify(init.result)}`);
console.log(`ok: initialize -> serverInfo.name=${init.result.serverInfo.name}, protocolVersion=${init.result.protocolVersion}`);

// notifications/initialized (server should tolerate/ignore it)
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

// 2. tools/list
const list = await request(2, "tools/list");
if (list.error) fail(`tools/list returned error: ${JSON.stringify(list.error)}`);
const tools = list.result?.tools;
if (!Array.isArray(tools)) fail(`tools/list result has no tools array: ${JSON.stringify(list.result)}`);
const names = tools.map((t) => t.name);
for (const want of EXPECTED_TOOLS) {
  if (!names.includes(want)) fail(`missing tool "${want}" (got: ${names.join(", ")})`);
}
for (const t of tools) {
  if (!t.description || !t.inputSchema) fail(`tool ${t.name} missing description or inputSchema`);
}
console.log(`ok: tools/list -> ${names.join(", ")}`);

// 3. clean shutdown: close stdin (server drains stdin-EOF) and expect exit 0
clearTimeout(timer);
child.stdin.end();
const code = await new Promise((resolve) => child.on("exit", resolve));
if (code !== 0) fail(`server exited with code ${code} on stdin EOF`);
console.log("ok: clean exit on stdin EOF");
console.log("PASS: mcp-smoke");
