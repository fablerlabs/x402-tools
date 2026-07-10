# x402 buyer-simulation harness (q123)

`buyer.mjs` plays a **buying agent** against the Fabler x402 worker: request a
paid route → get a 402 challenge → construct a payment → retry → verify
delivery. It exists to prove the full agent-buys-from-us loop with no human
in it.

## Status at the time this was written

The real x402 payment worker (tracked as **q115**, expected at
`x402/src/index.ts` + a `wrangler.jsonc`) had not been built yet by any lane —
only its pieces existed: `src/engines/scrub.ts` (secret scanner),
`src/engines/audit.ts` (agent-config auditor, on `lane/w1`, not yet merged),
and the MCP client in `x402/mcp/` (assumes a deployed worker at
`https://x402.fablerlabs.com`).

So `--mock` drives **`fixture-worker.mjs`** — a small reference
implementation of the same route surface and x402 JSON contract (see its file
header for the exact spec sources used) with a fake facilitator. It is not a
stand-in forever: `buyer.mjs --mock --entry=<path>` can point at any module
with a default export exposing `fetch(request, env)`, so the moment q115
ships a real worker, running

```
node buyer.mjs --mock --entry=../../src/index.ts
```

exercises the exact same assertions against the real thing. If the real
worker needs bindings (KV, secrets, etc.), extend the `env` object built in
`runMock()` in `buyer.mjs` (currently just `{}`, because the fixture needs
nothing) to supply them.

## Commands

```bash
cd x402
npm install         # only needed for typecheck of src/**, not for buyer-sim
npm run test:buyer-mock     # just the buyer-sim mock run
npm test                    # unit tests (test/**/*.test.ts) + buyer-sim mock
```

Direct invocation:

```bash
node test/buyer-sim/buyer.mjs --mock
# The real worker (x402/src/index.ts) now exists, but its v2 payment path calls a
# live facilitator to verify/settle — so --entry against it is not an offline run;
# use --testnet against a deployed worker for a real end-to-end payment instead.
```

Expect `47 passed, 0 failed` and exit code 0 against the fixture today. Every
paid route (`/scan/secrets`, `/audit/agent-config`, `/render/og`, and
`/buy/:sku` for all three catalog SKUs) is checked for: 402-without-payment
(with a well-formed `PAYMENT-REQUIRED` header challenge), 402-on-underpayment,
200-with-full-payment (+ a decodable `PAYMENT-RESPONSE` header), delivery
content, and 402-on-nonce-replay. The free route `/products.json` is checked too.

### Protocol version

This harness speaks **x402 protocol v2** (the version the real worker runs, via
`@x402/hono` — see `x402/src/x402guard.ts`). The v2 wire shape differs from v1
in ways this test pins:

- the 402 challenge's `PaymentRequired` (`{ x402Version: 2, resource, accepts[] }`)
  travels **base64-encoded in the `PAYMENT-REQUIRED` response header**, not the
  body (the body is `{}`);
- each `accepts[]` requirement uses `amount` (v1: `maxAmountRequired`), a CAIP-2
  `network` (`eip155:8453`, v1: `base`), and carries the EIP-712 domain in
  `extra: { name, version }`;
- the buyer pays via a base64 **`PAYMENT-SIGNATURE`** request header carrying a
  `PaymentPayload` (`{ x402Version: 2, accepted, payload: { authorization,
  signature } }`), and settlement returns in the **`PAYMENT-RESPONSE`** header.

## Testnet runbook (brain executes this — needs a funded wallet + a deployed staging worker)

1. **Get a Base Sepolia test wallet.** Generate one (e.g.
   `cast wallet new` or any EVM wallet tool) — do **not** reuse any wallet
   that ever held or will hold real funds. Put its private key in `.env` (not
   in this worktree — the buyer-sim lane never has `.env`) as
   `X402_TEST_BUYER_KEY=...`. Never commit it, never paste it into a message,
   never let it appear in a journal or STATE.md.
2. **Fund it.**
   - Base Sepolia ETH (for gas): a Base Sepolia faucet (e.g. the Coinbase
     Developer Platform faucet at portal.cdp.coinbase.com, or
     `https://www.alchemy.com/faucets/base-sepolia`).
   - Base Sepolia USDC: the Circle testnet faucet
     (`https://faucet.circle.com`, select Base Sepolia). USDC contract on
     Base Sepolia: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (verified
     against `docs.cdp.coinbase.com/x402/network-support`; re-check before
     relying on it if this runs much later — testnet contracts occasionally
     get redeployed).
3. **Deploy the real x402 worker to a staging URL** (subdomain or
   `workers.dev`, not the production route) so this can run against it
   without touching prod.
4. **Install the optional peers** (kept out of `--mock`'s dependency graph on
   purpose). `x402-fetch` must be a version that speaks **protocol v2** (the
   `PAYMENT-SIGNATURE` header + `PAYMENT-REQUIRED`-header challenge); a v1-only
   build will not pay a v2 worker:
   ```bash
   cd x402/test/buyer-sim   # or x402/, either works — node resolves up the tree
   npm install x402-fetch viem
   ```
5. **Run it:**
   ```bash
   X402_TEST_BUYER_KEY=<from .env> node buyer.mjs --testnet --url=https://<staging-worker-url>
   ```
   or set `X402_TARGET_URL` instead of `--url`.
6. **Expected output:** one line per route, each `2xx` — `x402-fetch` handles
   the 402 → sign → retry loop automatically using the wallet client, so a
   failure here means either the worker's challenge shape is wrong, the
   wallet is unfunded, or the deployed facilitator rejected the payment (read
   the printed status code / any thrown error — the key itself is never in
   that output).

## Why the mock payment isn't cryptographically real

`fixture-worker.mjs`'s fake facilitator checks payment *shape*, recipient,
amount, time window, and nonce replay — not the EIP-3009 signature itself (a
real facilitator would reject every payment this harness's mock mode
constructs). That's intentional: mock mode's job is to pin the HTTP/JSON
contract everything else in this repo already assumes (see
`x402/mcp/tools.js` and `RESULT-q118.md`'s note on the eventual
`/audit/agent-config` route), fast and offline. Real signature verification
only happens in `--testnet` mode, against a real facilitator, with a real
funded wallet.
