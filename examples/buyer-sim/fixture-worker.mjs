// fixture-worker.mjs — self-contained, in-process reference implementation of
// the Fabler x402 payment worker's HTTP contract (x402 protocol v2), for offline
// buyer-sim testing ONLY.
//
// Why this file exists: buyer.mjs's `--mock` mode needs a live worker to drive
// end-to-end, with zero network and zero npm dependencies. The real worker
// (x402/src/index.ts) delegates the whole protocol to @x402/hono's
// paymentMiddleware, which calls a live facilitator to verify/settle — not
// runnable offline. This fixture stands in with the SAME v2 HTTP contract but a
// FAKE facilitator: it checks payment shape, recipient, amount, time window, and
// nonce replay, but never verifies the EIP-3009 signature cryptographically (a
// real facilitator would reject every payment this fixture accepts). That's fine
// for exercising the HTTP contract; buyer.mjs's --testnet mode is what exercises
// real signing/verification against a deployed worker.
//
// The v2 wire contract this mirrors (verified against @x402/core + @x402/hono
// v2.17, the versions the real worker pins — see x402/src/x402guard.ts /
// facilitator.ts / catalog.ts on main):
//   • 402 challenge:  status 402, EMPTY JSON body ({}), and a base64-encoded
//                     `PAYMENT-REQUIRED` response header carrying the
//                     PaymentRequired object { x402Version:2, resource,
//                     accepts:[ PaymentRequirements ] }. (v1 put this in the body;
//                     v2 moved it to the header — see @x402/core
//                     x402HTTPResourceServer.createHTTPPaymentRequiredResponse.)
//   • PaymentRequirements: { scheme:"exact", network:"eip155:8453" (CAIP-2),
//                     asset (Base USDC), amount (atomic string — renamed from v1's
//                     maxAmountRequired), payTo, maxTimeoutSeconds, extra:{name,
//                     version} } — the EIP-712 domain name/version the signer needs.
//   • payment:        the buyer retries with a base64 `PAYMENT-SIGNATURE` request
//                     header carrying the PaymentPayload { x402Version:2, accepted
//                     (the chosen requirement echoed back), payload:{ authorization,
//                     signature } }.
//   • settlement:     status 200 + a base64 `PAYMENT-RESPONSE` response header
//                     carrying the SettleResponse { success, transaction, network,
//                     payer }.
//
// Exports a standard Workers `{ fetch(request) }` handler, so buyer.mjs's --mock
// mode can also point `--entry` at any other module with a default export
// exposing fetch(request, env) (see README.md) without changing buyer.mjs.

import { encodeB64Json, decodeB64Json } from "./x402-codec.mjs";

export const PRODUCTS = [
  { sku: "pack", name: "Constitution Pack", priceUsdc: "24000000" },
  { sku: "agent-kit", name: "Agent Kit", priceUsdc: "29000000" },
  { sku: "security-pack", name: "Security Pack", priceUsdc: "29000000" },
];

const TOOL_PRICE_USDC = "10000"; // $0.01 in USDC atomic units (6 decimals)
const FUNDING_SPREADS_PRICE_USDC = "1000"; // $0.001 in USDC atomic units (6 decimals)

// CAIP-2 chain id for Base mainnet — the fixed protocol network the real v2 worker
// advertises (x402guard.ts: export const NETWORK = "eip155:8453"). The buyer never
// hardcodes this; it reads whatever network the challenge advertises.
const NETWORK = "eip155:8453";
// Canonical USDC (6-decimal) on Base mainnet — the public token contract the real
// worker prices in (see @x402/evm DEFAULT_STABLECOINS["eip155:8453"]). Only used to
// populate the mock challenge's `asset`; never touched on-chain by this fixture.
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// EIP-712 domain params for that USDC contract (name/version) — required in every
// v2 exact-scheme challenge so a real signer can build the TransferWithAuthorization
// typed-data. Same values @x402/evm ships for eip155:8453.
const ASSET_EXTRA = { name: "USD Coin", version: "2" };
// Placeholder receiving address for offline mock testing only — the Base "burn"
// address, famously public and owned by nobody. Never a real Fabler Labs wallet.
// buyer.mjs never hardcodes a payTo; it always reads whatever address the challenge
// it receives specifies.
const FIXTURE_PAY_TO = "0x000000000000000000000000000000000000dEaD";

// Replay protection state. Fine for a single test-process lifetime; a real Worker
// delegates this to the facilitator's own nonce/authorization tracking.
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
  if (pathname === "/market/funding-spreads") return FUNDING_SPREADS_PRICE_USDC;
  if (pathname === "/scrape") return "5000";
  return null;
}

// One v2 PaymentRequirements entry (see @x402/core PaymentRequirements type).
function buildRequirement(url, price) {
  return {
    scheme: "exact",
    network: NETWORK,
    asset: ASSET,
    amount: price,
    payTo: FIXTURE_PAY_TO,
    maxTimeoutSeconds: 60,
    extra: ASSET_EXTRA,
  };
}

// The v2 PaymentRequired object carried (base64-encoded) in the PAYMENT-REQUIRED
// header of a 402 response.
function buildPaymentRequired(url, price) {
  return {
    x402Version: 2,
    error: "payment required",
    resource: url.toString(),
    accepts: [buildRequirement(url, price)],
  };
}

// Fake facilitator verify+settle for a v2 exact/evm payment. Checks everything
// EXCEPT the cryptographic validity of `payload.signature` — see file header.
function verifyAndSettle(payment, requirement) {
  if (!payment || payment.x402Version !== 2) return { ok: false, reason: "bad x402Version" };
  // v2 echoes the chosen requirement back as `accepted`; a real resource server
  // matches it against the route's advertised requirements.
  const accepted = payment.accepted;
  if (!accepted || accepted.scheme !== requirement.scheme) return { ok: false, reason: "scheme mismatch" };
  if (accepted.network !== requirement.network) return { ok: false, reason: "network mismatch" };
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
    required = BigInt(requirement.amount);
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

function paidResult(url, body) {
  const pathname = url.pathname;
  if (pathname === "/scan/secrets") {
    const text = String((body && body.text) || "");
    const matches = /sk-[a-zA-Z0-9]{10,}/.test(text) ? [{ type: "generic-secret", masked: "sk-****...****" }] : [];
    return { matches };
  }
  if (pathname === "/audit/agent-config") {
    const text = String((body && body.text) || "");
    return {
      score: text.trim() ? 72 : 10,
      findings: [{ rule: "fixture", severity: "warn", fix: "this is a fixture response, not the real audit engine" }],
    };
  }
  if (pathname === "/render/og") {
    return { url: "https://fixture.local/og/mock.png" };
  }
  if (pathname === "/scrape") {
    return { title: "Example Domain", text: "Example Domain", word_count: 2, truncated: false };
  }
  if (pathname === "/market/funding-spreads") {
    const symbol = url.searchParams.get("symbol");
    if (symbol) {
      return {
        symbol,
        venues: {
          binance: { fundingRate: "0.00010", markPrice: "65000.00" },
          bybit: { fundingRate: "0.00012", markPrice: "65005.50" },
          hyperliquid: { fundingRate: "0.00009", markPrice: "64998.10" },
          okx: { fundingRate: "0.00011", markPrice: "65002.75" },
        },
        grossSpreadBps: 3,
      };
    }
    return {
      top: [
        { symbol: "BTC", grossSpreadBps: 3 },
        { symbol: "ETH", grossSpreadBps: 5 },
      ],
      venuesCovered: ["binance", "bybit", "hyperliquid"],
    };
  }
  if (pathname.startsWith("/buy/")) {
    const sku = pathname.slice("/buy/".length);
    return { sku, delivered: true, downloadUrl: `https://fixture.local/delivery/${sku}` };
  }
  return {};
}

// A v2 402 challenge: empty JSON body, PaymentRequired in the PAYMENT-REQUIRED
// header. `error` lets a rejected retry report why (still an empty body, matching
// the real worker's shape).
function challengeResponse(url, price, error) {
  const paymentRequired = buildPaymentRequired(url, price);
  if (error) paymentRequired.error = error;
  return Response.json(
    {},
    { status: 402, headers: { "PAYMENT-REQUIRED": encodeB64Json(paymentRequired) } },
  );
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/products.json") {
      return Response.json({ products: PRODUCTS });
    }

    const price = priceFor(url.pathname);
    if (price == null) return new Response("not found", { status: 404 });

    const requirement = buildRequirement(url, price);
    // v2 reads PAYMENT-SIGNATURE; the real middleware also accepts the legacy
    // X-PAYMENT header, so mirror that fallback here.
    const paymentHeader = request.headers.get("PAYMENT-SIGNATURE") || request.headers.get("X-PAYMENT");
    if (!paymentHeader) {
      return challengeResponse(url, price);
    }

    const payment = decodeB64Json(paymentHeader);
    const result = verifyAndSettle(payment, requirement);
    if (!result.ok) {
      return challengeResponse(url, price, result.reason);
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
    return Response.json(paidResult(url, body), {
      status: 200,
      headers: { "PAYMENT-RESPONSE": encodeB64Json(settlement) },
    });
  },
};
