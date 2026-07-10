#!/usr/bin/env node
// Fabler x402 Tools MCP server — lets any MCP client (Claude Code, Claude
// Desktop, ...) call Fabler Labs' paid x402 tools (secret scanning, agent
// config audits, readable-page extraction, OG card rendering) plus the free product catalog.
// Zero required dependencies: speaks MCP's stdio transport (newline-delimited
// JSON-RPC) directly. Node 18+ (global fetch). Optional dependencies
// `@x402/fetch`, `@x402/evm`, and `viem` enable automatic on-chain payment —
// see README.md.
//
// Tool definitions + JSON-RPC handling live in ./tools.js.
//
// Env:
//   X402_BASE_URL           https://x402.fablerlabs.com (override for testing)
//   X402_BUYER_PRIVATE_KEY  YOUR OWN EVM wallet private key (never Fabler
//                            Labs') used only to auto-pay 402 challenges.
//                            Never logged. Omit to get the raw 402 challenge
//                            back instead of automatic payment.

const { dispatch } = require("./tools.js");

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const res = await dispatch(msg);
  if (res) send(res);
}

let buf = "";
let inflight = 0;
let ended = false;
// don't drop in-flight tool calls when stdin closes (e.g. piped one-shot use)
function maybeExit() {
  if (ended && inflight === 0) process.exit(0);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) {
      inflight++;
      handle(line).finally(() => {
        inflight--;
        maybeExit();
      });
    }
  }
});
process.stdin.on("end", () => {
  ended = true;
  maybeExit();
});
