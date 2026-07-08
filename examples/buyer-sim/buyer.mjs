#!/usr/bin/env node
// buyer.mjs — x402 buyer-simulation e2e harness / worked example.
//
// Plays a BUYING agent against a Fabler x402 worker: request a paid route,
// receive a 402 challenge, construct a payment, retry, verify delivery.
// Covers every paid route (the per-call tools + /buy/:sku for three catalog
// SKUs) plus the free catalog route. Useful both as CI coverage for this repo
// and as a worked reference for the 402-challenge -> pay -> retry loop.
//
// Modes:
//   --mock                Fully offline. Drives an in-process worker module
//                          directly (default: ./fixture-worker.mjs, a small
//                          reference implementation of the real worker's
//                          route surface — see its header). Zero npm
//                          dependencies, zero network. Point --entry at any
//                          other module exposing a default { fetch(request,
//                          env) } to run the exact same assertions against it.
//   --testnet              Real EIP-3009 USDC payment on Base Sepolia against
//                          a live deployed worker. Needs the optional peers
//                          `x402-fetch` + `viem` (npm install, not bundled —
//                          keeps --mock dependency-free) and the env var
//                          X402_TEST_BUYER_KEY (a funded Base Sepolia test
//                          wallet's private key). NEVER logged, NEVER
//                          committed, no default value — see README.md.
//
// Usage:
//   node buyer.mjs --mock [--entry=<path to a worker module with a default
//                           export exposing fetch(request, env)>]
//   node buyer.mjs --testnet --url=<https://staging-worker-url> (or set
//                  X402_TARGET_URL instead of --url)
//
// Exit code 0 = every assertion passed, 1 = at least one failed, 2 = usage /
// missing prerequisite error.

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeB64Json, decodeB64Json } from "./x402-codec.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://x402.buyer-sim.test";

// Hardhat/Anvil's well-known default account #0 — public, funds-less, the
// standard placeholder "buyer" address used throughout EVM tooling docs.
// Never a real wallet; buyer.mjs never needs to know a real address in
// advance because it always reads `payTo` from whatever challenge it
// receives, in both --mock and --testnet mode.
const MOCK_BUYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function parseArgs(argv) {
  const args = { mode: null, entry: null, url: null };
  for (const a of argv) {
    if (a === "--mock") args.mode = "mock";
    else if (a === "--testnet") args.mode = "testnet";
    else if (a.startsWith("--entry=")) args.entry = a.slice("--entry=".length);
    else if (a.startsWith("--url=")) args.url = a.slice("--url=".length);
  }
  return args;
}

// ---------- tiny assertion runner (no test framework — this is a CLI script,
// not a `node --test` unit test) ----------
let passed = 0;
let failed = 0;
function section(name) {
  console.log(`\n${name}`);
}
function check(label, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// Builds a syntactically-valid but NOT cryptographically real X-PAYMENT
// header from a 402 challenge's payment requirement. `overrides` lets tests
// construct a deliberately-invalid payment (e.g. underpaid).
function buildMockPaymentHeader(requirement, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: MOCK_BUYER_ADDRESS,
    to: requirement.payTo,
    value: overrides.value ?? requirement.maxAmountRequired,
    validAfter: String(now - 60),
    validBefore: String(now + (requirement.maxTimeoutSeconds || 60)),
    nonce: `0x${crypto.randomBytes(32).toString("hex")}`,
  };
  return encodeB64Json({
    x402Version: requirement.x402Version || 1,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: {
      // NOT a real ECDSA signature. The fixture facilitator's fake verify()
      // only checks shape/recipient/amount/window/nonce-replay, never
      // cryptographic validity — see fixture-worker.mjs's header comment.
      // --testnet mode replaces this entire function with real EIP-3009
      // signing via viem, so a real facilitator sees a real signature.
      signature: `0x${crypto.randomBytes(65).toString("hex")}`,
      authorization,
    },
  });
}

function paidRouteFixtures() {
  return [
    { method: "POST", path: "/scan/secrets", body: { text: "leaked token sk-live-abcdef1234567890abcdef" } },
    { method: "POST", path: "/audit/agent-config", body: { content: "# CLAUDE.md\n\n## Commands\nnpm test\n", kind: "CLAUDE.md" } },
    { method: "POST", path: "/render/og", body: { title: "buyer-sim smoke test" } },
    { method: "GET", path: "/buy/pack" },
    { method: "GET", path: "/buy/agent-kit" },
    { method: "GET", path: "/buy/ai-coding-security-pack-v1" },
  ];
}

function requestInit(route, extraHeaders) {
  const init = { method: route.method, headers: { ...extraHeaders } };
  if (route.body) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(route.body);
  }
  return init;
}

async function runMock(args) {
  const entryPath = args.entry
    ? path.resolve(process.cwd(), args.entry)
    : path.join(__dirname, "fixture-worker.mjs");
  console.log(`--mock: driving worker module ${entryPath}`);
  const mod = await import(pathToFileURL(entryPath).href);
  const worker = mod.default;
  if (!worker || typeof worker.fetch !== "function") {
    console.error(`${entryPath} has no default export with a fetch(request, env) method`);
    process.exit(2);
  }
  const env = {};

  section("free route: GET / (catalog)");
  {
    const res = await worker.fetch(new Request(`${BASE}/`), env);
    check("no payment needed, no 402", res.status === 200, `got ${res.status}`);
    const body = await res.json().catch(() => null);
    check("lists resources", Array.isArray(body?.resources) && body.resources.length >= 3, JSON.stringify(body));
  }

  for (const route of paidRouteFixtures()) {
    section(`paid route: ${route.method} ${route.path}`);

    const challengeRes = await worker.fetch(new Request(`${BASE}${route.path}`, requestInit(route)), env);
    check("no X-PAYMENT → 402", challengeRes.status === 402, `got ${challengeRes.status}`);
    const challengeBody = await challengeRes.json().catch(() => null);
    const requirement = challengeBody?.accepts?.[0];
    check(
      "challenge has x402Version + accepts[0]{scheme,network,payTo,maxAmountRequired,resource,asset}",
      challengeBody?.x402Version === 1 &&
        requirement?.scheme === "exact" &&
        typeof requirement?.network === "string" &&
        typeof requirement?.payTo === "string" &&
        typeof requirement?.maxAmountRequired === "string" &&
        typeof requirement?.resource === "string" &&
        typeof requirement?.asset === "string",
      JSON.stringify(challengeBody),
    );
    if (!requirement) {
      console.log("  (skipping remaining checks for this route — no usable challenge)");
      continue;
    }

    const underpaidHeader = buildMockPaymentHeader(requirement, { value: "1" });
    const underpaidRes = await worker.fetch(
      new Request(`${BASE}${route.path}`, requestInit(route, { "X-PAYMENT": underpaidHeader })),
      env,
    );
    check("underpaid X-PAYMENT → still 402 (not treated as paid)", underpaidRes.status === 402, `got ${underpaidRes.status}`);

    const paymentHeader = buildMockPaymentHeader(requirement);
    const paidRes = await worker.fetch(
      new Request(`${BASE}${route.path}`, requestInit(route, { "X-PAYMENT": paymentHeader })),
      env,
    );
    check("valid X-PAYMENT (full amount, correct payTo) → 200", paidRes.status === 200, `got ${paidRes.status}`);
    const settlement = decodeB64Json(paidRes.headers.get("X-PAYMENT-RESPONSE") || "");
    check("X-PAYMENT-RESPONSE header decodes to {success:true,...}", settlement?.success === true, JSON.stringify(settlement));
    const paidBody = await paidRes.json().catch(() => null);
    check("paid route returns delivery content", paidBody != null, JSON.stringify(paidBody));
    if (route.path.startsWith("/buy/")) {
      check("buy route marks delivered:true with a downloadUrl", paidBody?.delivered === true && !!paidBody?.downloadUrl, JSON.stringify(paidBody));
    }

    const replayRes = await worker.fetch(
      new Request(`${BASE}${route.path}`, requestInit(route, { "X-PAYMENT": paymentHeader })),
      env,
    );
    check("replaying the same X-PAYMENT (same nonce) → rejected, not double-delivered", replayRes.status === 402, `got ${replayRes.status}`);
  }

  finish();
}

async function runTestnet(args) {
  const url = args.url || process.env.X402_TARGET_URL;
  if (!url) {
    console.error("--testnet requires --url=<https://staging-worker> or the X402_TARGET_URL env var");
    process.exit(2);
  }
  const key = (process.env.X402_TEST_BUYER_KEY || "").trim();
  if (!key) {
    console.error(
      "--testnet requires X402_TEST_BUYER_KEY (a funded Base Sepolia test wallet's private key) as an " +
        "env var. Never pass it as a CLI argument (shows up in shell history / process listings) and it " +
        "is never logged by this script. See README.md for the faucet + funding steps.",
    );
    process.exit(2);
  }

  let x402Fetch, viem, viemAccounts, viemChains;
  try {
    x402Fetch = await import("x402-fetch");
    viem = await import("viem");
    viemAccounts = await import("viem/accounts");
    viemChains = await import("viem/chains");
  } catch {
    console.error(
      "--testnet needs the optional peer packages, not installed here on purpose (keeps --mock at zero " +
        "deps): run `npm install x402-fetch viem` inside examples/buyer-sim/ (or the repo root) first.",
    );
    process.exit(2);
  }

  const normalizedKey = key.startsWith("0x") ? key : `0x${key}`;
  let account;
  try {
    account = viemAccounts.privateKeyToAccount(normalizedKey);
  } catch {
    console.error("X402_TEST_BUYER_KEY is not a valid 32-byte hex EVM private key (0x-prefixed or not).");
    process.exit(2);
  }
  const walletClient = viem.createWalletClient({
    account,
    chain: viemChains.baseSepolia,
    transport: viem.http(),
  });
  const payingFetch = x402Fetch.wrapFetchWithPayment(fetch, walletClient);

  // The wallet ADDRESS is not secret (it's public on-chain); the private key
  // itself is never read again after privateKeyToAccount() above and is
  // never logged.
  console.log(`--testnet: buyer address ${account.address}, target ${url}`);

  const base = url.replace(/\/+$/, "");
  const routes = [
    { method: "GET", path: "/", paid: false },
    { method: "POST", path: "/scan/secrets", body: { text: "leaked token sk-live-abcdef1234567890abcdef" } },
    { method: "POST", path: "/audit/agent-config", body: { content: "# CLAUDE.md\n\n## Commands\nnpm test\n", kind: "CLAUDE.md" } },
    { method: "POST", path: "/render/og", body: { title: "buyer-sim testnet smoke" } },
    { method: "GET", path: "/buy/pack" },
  ];

  for (const route of routes) {
    section(`${route.paid === false ? "free" : "paid (auto-pay via x402-fetch)"}: ${route.method} ${route.path}`);
    const init = requestInit(route);
    const doFetch = route.paid === false ? fetch : payingFetch;
    let res;
    try {
      res = await doFetch(`${base}${route.path}`, init);
    } catch (e) {
      check(`${route.path} request completed`, false, String((e && e.message) || e));
      continue;
    }
    check(`${route.path} → 2xx (challenge auto-paid + retried if required)`, res.ok, `got ${res.status}`);
  }

  finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode) {
    console.error(
      "usage:\n" +
        "  node buyer.mjs --mock [--entry=<path to a worker module>]\n" +
        "  node buyer.mjs --testnet --url=<https://staging-worker> (or X402_TARGET_URL env var)\n" +
        "                 requires X402_TEST_BUYER_KEY env var + `npm install x402-fetch viem`",
    );
    process.exit(2);
  }
  if (args.mode === "mock") await runMock(args);
  else await runTestnet(args);
}

main().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exit(1);
});
