#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bundle = fileURLToPath(new URL("../../dist/mcpb/mcp/server.js", import.meta.url));
const challenge = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://x402.fablerlabs.com/scan/secrets",
    description: "test fixture",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "5000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x2222222222222222222222222222222222222222",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
};

const bootstrap = `
const challenge = ${JSON.stringify(challenge)};
global.fetch = async (input, init = {}) => {
  const headers = input instanceof Request ? input.headers : new Headers(init.headers || {});
  if (!headers.has("payment-signature")) {
    return new Response("{}", {
      status: 402,
      headers: { "payment-required": Buffer.from(JSON.stringify(challenge)).toString("base64") },
    });
  }
  return new Response(JSON.stringify({ signedRetry: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
require(${JSON.stringify(bundle)});
`;

const child = spawn(process.execPath, ["-e", bootstrap], {
  env: {
    ...process.env,
    X402_BUYER_PRIVATE_KEY: "0x" + "11".repeat(32),
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", chunk => (stdout += chunk));
child.stderr.on("data", chunk => (stderr += chunk));

child.stdin.end(
  JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "fabler_scan_secrets", arguments: { text: "hello" } },
  }) + "\n",
);

const exitCode = await new Promise(resolve => child.on("close", resolve));
assert.equal(exitCode, 0, stderr);

const response = JSON.parse(stdout.trim());
assert.equal(response.result.isError, undefined);
const result = JSON.parse(response.result.content[0].text);
assert.equal(result.paid, true);
assert.equal(result.status, 200);
assert.deepEqual(result.data, { signedRetry: true });
console.log("PASS: bundled .mcpb server signs and retries a v2 payment challenge");
