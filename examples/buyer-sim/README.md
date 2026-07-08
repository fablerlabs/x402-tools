# x402 buyer-simulation example

`buyer.mjs` plays a **buying agent** against a Fabler x402 worker: request a
paid route → get a 402 challenge → construct a payment → retry → verify
delivery. It's both a worked example of the 402-challenge → pay → retry loop
and a self-contained regression test this repo's CI runs on every push.

## Modes

- **`--mock`** (default for CI) — fully offline. Drives `fixture-worker.mjs`,
  a small in-process reference implementation of
  [x402.fablerlabs.com](https://x402.fablerlabs.com)'s route surface and x402
  JSON contract, with a fake facilitator that checks payment shape/recipient/
  amount/window/nonce-replay but never a real signature. Zero npm
  dependencies, zero network — good for CI and for understanding the contract
  without touching real money.
- **`--testnet`** — a real EIP-3009 USDC payment on Base Sepolia against a
  live worker (the real x402.fablerlabs.com, or your own staging deploy of
  compatible routes). Needs the optional peers `x402-fetch` + `viem` and a
  funded test wallet — see below.

## Commands

```bash
cd examples/buyer-sim
node buyer.mjs --mock
```

Expect `47 passed, 0 failed` and exit code 0 against the fixture. Every paid
route (`/scan/secrets`, `/audit/agent-config`, `/render/og`, and `/buy/:sku`
for three catalog SKUs) is checked for: 402-without-payment,
402-on-underpayment, 200-with-full-payment (+ a decodable
`X-PAYMENT-RESPONSE`), delivery content, and 402-on-nonce-replay. The free
catalog route (`GET /`) is checked too.

You can also point `--mock` at any other module exposing a default
`{ fetch(request, env) }` export — e.g. a local Cloudflare Worker checkout —
to run the exact same assertions against it:

```bash
node buyer.mjs --mock --entry=/path/to/some/worker/src/index.ts
```

(Only works if that entry point is directly `import()`-able as-is — a
TypeScript worker typically needs a build step first.)

## Testnet run (real money on a testnet — needs a funded wallet)

1. **Get a Base Sepolia test wallet.** Generate one (e.g. `cast wallet new`
   or any EVM wallet tool) — do **not** reuse any wallet that ever held or
   will hold real funds. Never commit its private key, never paste it into a
   chat or issue.
2. **Fund it:**
   - Base Sepolia ETH (gas): a Base Sepolia faucet, e.g.
     `https://www.alchemy.com/faucets/base-sepolia`.
   - Base Sepolia USDC: the Circle testnet faucet
     (`https://faucet.circle.com`, select Base Sepolia).
3. **Point `--testnet` at a staging worker** (not production) that exposes
   the same route contract — `--url=https://<staging-worker-url>` or the
   `X402_TARGET_URL` env var.
4. **Install the optional peers** (kept out of `--mock`'s dependency graph on
   purpose):
   ```bash
   npm install x402-fetch viem
   ```
5. **Run it:**
   ```bash
   X402_TEST_BUYER_KEY=<hex key> node buyer.mjs --testnet --url=https://<staging-worker-url>
   ```
6. **Expected output:** one line per route, each `2xx` — `x402-fetch` handles
   the 402 → sign → retry loop automatically using the wallet client. A
   failure means either the worker's challenge shape differs, the wallet is
   unfunded, or the facilitator rejected the payment.

## Why the mock payment isn't cryptographically real

`fixture-worker.mjs`'s fake facilitator checks payment *shape*, recipient,
amount, time window, and nonce replay — not the EIP-3009 signature itself (a
real facilitator would reject every payment this harness's mock mode
constructs). That's intentional: mock mode's job is to pin the HTTP/JSON
contract fast and offline, matching what
[`mcp/tools.js`](../../mcp/tools.js) actually sends. Real signature
verification only happens in `--testnet` mode, against a real facilitator,
with a real funded wallet.
