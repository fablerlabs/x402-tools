// fixture-worker.mjs — self-contained, in-process reference implementation of
// the Fabler x402 payment worker's HTTP contract, for offline buyer-sim
// testing ONLY.
//
// Same route surface as the real https://x402.fablerlabs.com (GET / for the
// free catalog, POST /scan/secrets, POST /audit/agent-config, POST /render/og,
// GET /buy/:sku), same x402 challenge / X-PAYMENT / X-PAYMENT-RESPONSE JSON
// shapes (per coinbase/x402's specs/x402-specification.md and
// specs/schemes/exact/scheme_exact_evm.md), but with a FAKE facilitator: it
// checks payment shape, recipient, amount, time window, and nonce replay, but
// never verifies the EIP-3009 signature cryptographically (a real facilitator
// would reject every payment this fixture accepts). That's fine for
// exercising the HTTP contract offline; a real wallet against the real
// deployed worker is what actually moves USDC — this fixture never does.
//
// Exports a standard Workers `{ fetch(request) }` handler, so buyer.mjs's
// `--mock` mode can also point `--entry` at any other module with the same
// shape (e.g. a local worker checkout) without any change to buyer.mjs itself.

import { encodeB64Json, decodeB64Json } from "./x402-codec.mjs";

export const PRODUCTS = [
  { sku: "pack", name: "AI Coding Workflow Pack", priceUsdc: "24000000" },
  { sku: "agent-kit", name: "Autonomous Agent Starter Kit", priceUsdc: "29000000" },
  { sku: "ai-coding-security-pack-v1", name: "AI Coding Security Pack", priceUsdc: "29000000" },
];

const TOOL_PRICE_USDC = "10000"; // $0.01 in USDC atomic units (6 decimals)
const NETWORK = "base-sepolia";
// USDC on Base Sepolia (public token contract, not a secret) — verified against
// docs.cdp.coinbase.com/x402/network-support. Only used to populate the mock
// challenge's `asset` field; never touched on-chain by this fixture.
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
// Placeholder receiving address for offline mock testing only — the Base
// "burn" address, famously public and owned by nobody. Never a real Fabler
// Labs wallet. buyer.mjs never hardcodes a payTo; it always reads whatever
// address the challenge it receives specifies.
const FIXTURE_PAY_TO = "0x000000000000000000000000000000000000dEaD";

// Replay protection state. Fine for a single test-process lifetime; the real
// deployed worker backs this with its facilitator's own nonce tracking.
const usedNonces = new Set();

function priceFor(pathname) {
  if (pathname.startsWith("/buy/")) {
    const sku = pathname.slice("/buy/".length);
    const product = PRODUCTS.find((p) => p.sku === sku);
    return product ? product.priceUsdc : null;
  }
  if (pathname === "/scan/secrets" || pathname === "/audit/agent-config" || pathname === "/render/og") {
    return TOOL_PRICE_USDC;
  }
  return null;
}

function buildChallenge(url, price) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        maxAmountRequired: price,
        resource: url.toString(),
        description: `Fabler x402 fixture — ${url.pathname}`,
        mimeType: "application/json",
        payTo: FIXTURE_PAY_TO,
        maxTimeoutSeconds: 60,
        asset: ASSET,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

// Fake facilitator verify+settle. Checks everything EXCEPT the cryptographic
// validity of `payload.signature` — see file header.
function verifyAndSettle(payment, requirement) {
  if (!payment || payment.x402Version !== 1) return { ok: false, reason: "bad x402Version" };
  if (payment.scheme !== requirement.scheme) return { ok: false, reason: "scheme mismatch" };
  if (payment.network !== requirement.network) return { ok: false, reason: "network mismatch" };
  const auth = payment.payload && payment.payload.authorization;
  if (!auth || typeof payment.payload.signature !== "string") {
    return { ok: false, reason: "malformed payload" };
  }
  if (String(auth.to).toLowerCase() !== requirement.payTo.toLowerCase()) {
    return { ok: false, reason: "payTo mismatch" };
  }
  let value, required;
  try {
    value = BigInt(auth.value);
    required = BigInt(requirement.maxAmountRequired);
  } catch {
    return { ok: false, reason: "malformed amount" };
  }
  if (value < required) return { ok: false, reason: "underpaid" };
  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validAfter) > now || Number(auth.validBefore) < now) {
    return { ok: false, reason: "authorization window expired" };
  }
  if (typeof auth.nonce !== "string" || usedNonces.has(auth.nonce)) {
    return { ok: false, reason: "nonce already used" };
  }
  usedNonces.add(auth.nonce);
  return { ok: true, txHash: `0xfixture${auth.nonce.replace(/^0x/, "").slice(0, 24)}`, payer: auth.from };
}

function paidResult(pathname, body) {
  if (pathname === "/scan/secrets") {
    const text = String((body && body.text) || "");
    const matches = /sk-[a-zA-Z0-9]{10,}/.test(text) ? [{ type: "generic-secret", masked: "sk-****...****" }] : [];
    return { matches };
  }
  if (pathname === "/audit/agent-config") {
    const content = String((body && body.content) || "");
    return {
      score: content.trim() ? 72 : 10,
      findings: [{ rule: "fixture", severity: "warn", fix: "this is a fixture response, not the real audit engine" }],
    };
  }
  if (pathname === "/render/og") {
    return { url: "https://fixture.local/og/mock.png" };
  }
  if (pathname.startsWith("/buy/")) {
    const sku = pathname.slice("/buy/".length);
    return { sku, delivered: true, downloadUrl: `https://fixture.local/delivery/${sku}` };
  }
  return {};
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({
        name: "Fabler Labs x402 Storefront (fixture)",
        x402Version: 1,
        resources: PRODUCTS.map((p) => ({ resource: `/buy/${p.sku}`, metadata: { description: p.name } })),
      });
    }

    const price = priceFor(url.pathname);
    if (price == null) return new Response("not found", { status: 404 });

    const requirement = buildChallenge(url, price).accepts[0];
    const paymentHeader = request.headers.get("X-PAYMENT");
    if (!paymentHeader) {
      return Response.json(buildChallenge(url, price), { status: 402 });
    }

    const payment = decodeB64Json(paymentHeader);
    const result = verifyAndSettle(payment, requirement);
    if (!result.ok) {
      return Response.json({ ...buildChallenge(url, price), error: result.reason }, { status: 402 });
    }

    let body = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
      try {
        body = await request.json();
      } catch {
        body = null;
      }
    }

    const settlement = {
      success: true,
      transaction: result.txHash,
      network: requirement.network,
      payer: result.payer,
    };
    return Response.json(paidResult(url.pathname, body), {
      status: 200,
      headers: { "X-PAYMENT-RESPONSE": encodeB64Json(settlement) },
    });
  },
};
