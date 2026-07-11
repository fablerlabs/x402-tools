#!/usr/bin/env node
// buyer.mjs — x402 buyer-simulation e2e harness (q123; migrated to protocol v2
// in q179).
//
// Plays a BUYING agent against a Fabler x402 worker (x402 protocol v2): request a
// paid route, receive a 402 challenge (the requirements come in the
// PAYMENT-REQUIRED response header, base64-encoded — v2 moved them out of the
// body), construct a payment, retry with a PAYMENT-SIGNATURE request header, and
// verify delivery + the PAYMENT-RESPONSE settlement header. Covers every paid
// route (the per-call tools + /buy/:sku for every catalog SKU) plus one free route.
//
// Modes:
//   --mock                Fully offline. Drives an in-process worker module
//                          directly (default: ./fixture-worker.mjs — see its
//                          header for why a fixture exists instead of the
//                          real q115 worker). Zero npm dependencies, zero
//                          network. Point --entry at the real worker once it
//                          exists to run the exact same assertions against it.
//   --testnet              Real EIP-3009 USDC payment against a live deployed
//                          worker, auto-paid by a v2-capable x402 client. Needs
//                          the optional peers `x402-fetch` (a version that speaks
//                          protocol v2 — PAYMENT-SIGNATURE header, not v1's
//                          X-PAYMENT) + `viem` (npm install, not bundled — keeps
//                          --mock dependency-free) and the env var
//                          X402_TEST_BUYER_KEY (a funded test wallet's private
//                          key). NEVER logged, NEVER committed, no default value —
//                          see README.md. This path is NOT exercised by the
//                          offline mock run; the brain validates it live.
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

// Builds a syntactically-valid but NOT cryptographically real PAYMENT-SIGNATURE
// header (a base64-encoded v2 PaymentPayload) from a 402 challenge's payment
// requirement. `overrides` lets tests construct a deliberately-invalid payment
// (e.g. underpaid).
function buildMockPaymentHeader(requirement, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: MOCK_BUYER_ADDRESS,
    to: requirement.payTo,
    // v2 renamed v1's `maxAmountRequired` to `amount` (atomic token units).
    value: overrides.value ?? requirement.amount,
    validAfter: String(now - 60),
    validBefore: String(now + (requirement.maxTimeoutSeconds || 60)),
    nonce: `0x${crypto.randomBytes(32).toString("hex")}`,
  };
  return encodeB64Json({
    x402Version: 2,
    // v2 echoes the chosen requirement back in `accepted` (see @x402/core
    // PaymentPayload) so the resource server can match it to the route.
    accepted: requirement,
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

// Decode a v2 402 challenge: the PaymentRequired object lives base64-encoded in
// the PAYMENT-REQUIRED response header (empty JSON body), not in the body.
function readChallenge(res) {
  const header = res.headers.get("PAYMENT-REQUIRED");
  return header ? decodeB64Json(header) : null;
}

function paidRouteFixtures() {
  return [
    { method: "POST", path: "/scan/secrets", body: { text: "leaked token sk-live-abcdef1234567890abcdef" } },
    { method: "POST", path: "/audit/agent-config", body: { text: "# CLAUDE.md\n\n## Commands\nnpm test\n" } },
    { method: "POST", path: "/render/og", body: { title: "buyer-sim smoke test" } },
    { method: "GET", path: "/scrape?url=https%3A%2F%2Fexample.com%2F" },
    { method: "GET", path: "/market/funding-spreads?symbol=BTC" },
    { method: "GET", path: "/buy/pack" },
    { method: "GET", path: "/buy/agent-kit" },
    { method: "GET", path: "/buy/security-pack" },
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

  section("free route: GET /products.json");
  {
    const res = await worker.fetch(new Request(`${BASE}/products.json`), env);
    check("no payment needed, no 402", res.status === 200, `got ${res.status}`);
    const body = await res.json().catch(() => null);
    check("lists the product catalog", Array.isArray(body?.products) && body.products.length >= 3, JSON.stringify(body));
  }

  for (const route of paidRouteFixtures()) {
    section(`paid route: ${route.method} ${route.path}`);

    const challengeRes = await worker.fetch(new Request(`${BASE}${route.path}`, requestInit(route)), env);
    check("no PAYMENT-SIGNATURE → 402", challengeRes.status === 402, `got ${challengeRes.status}`);
    const challenge = readChallenge(challengeRes);
    const requirement = challenge?.accepts?.[0];
    check(
      "PAYMENT-REQUIRED header decodes to v2 challenge {x402Version:2, resource, accepts[0]{scheme,network,payTo,amount,asset,extra{name,version}}}",
      challenge?.x402Version === 2 &&
        typeof challenge?.resource === "string" &&
        requirement?.scheme === "exact" &&
        typeof requirement?.network === "string" &&
        typeof requirement?.payTo === "string" &&
        typeof requirement?.amount === "string" &&
        typeof requirement?.asset === "string" &&
        typeof requirement?.extra?.name === "string" &&
        typeof requirement?.extra?.version === "string",
      JSON.stringify(challenge),
    );
    if (!requirement) {
      console.log("  (skipping remaining checks for this route — no usable challenge)");
      continue;
    }

    const underpaidHeader = buildMockPaymentHeader(requirement, { value: "1" });
    const underpaidRes = await worker.fetch(
      new Request(`${BASE}${route.path}`, requestInit(route, { "PAYMENT-SIGNATURE": underpaidHeader })),
      env,
    );
    check("underpaid PAYMENT-SIGNATURE → still 402 (not treated as paid)", underpaidRes.status === 402, `got ${underpaidRes.status}`);

    const paymentHeader = buildMockPaymentHeader(requirement);
    const paidRes = await worker.fetch(
      new Request(`${BASE}${route.path}`, requestInit(route, { "PAYMENT-SIGNATURE": paymentHeader })),
      env,
    );
    check("valid PAYMENT-SIGNATURE (full amount, correct payTo) → 200", paidRes.status === 200, `got ${paidRes.status}`);
    const settlement = decodeB64Json(paidRes.headers.get("PAYMENT-RESPONSE") || "");
    check("PAYMENT-RESPONSE header decodes to {success:true,...}", settlement?.success === true, JSON.stringify(settlement));
    const paidBody = await paidRes.json().catch(() => null);
    check("paid route returns delivery content", paidBody != null, JSON.stringify(paidBody));
    if (route.path.startsWith("/buy/")) {
      check("buy route marks delivered:true with a downloadUrl", paidBody?.delivered === true && !!paidBody?.downloadUrl, JSON.stringify(paidBody));
    }

    const replayRes = await worker.fetch(
      new Request(`${BASE}${route.path}`, requestInit(route, { "PAYMENT-SIGNATURE": paymentHeader })),
      env,
    );
    check("replaying the same PAYMENT-SIGNATURE (same nonce) → rejected, not double-delivered", replayRes.status === 402, `got ${replayRes.status}`);
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
        "deps): run `npm install x402-fetch viem` inside x402/test/buyer-sim/ (or hoist to x402/) first.",
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
    { method: "GET", path: "/products.json", paid: false },
    { method: "POST", path: "/scan/secrets", body: { text: "leaked token sk-live-abcdef1234567890abcdef" } },
    { method: "POST", path: "/audit/agent-config", body: { text: "# CLAUDE.md\n\n## Commands\nnpm test\n" } },
    { method: "POST", path: "/render/og", body: { title: "buyer-sim testnet smoke" } },
    { method: "GET", path: "/scrape?url=https%3A%2F%2Fexample.com%2F" },
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
