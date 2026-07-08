#!/usr/bin/env bash
# x402 by hand, in two curls — see the 402, then pay it.
# Endpoint: POST https://x402.fablerlabs.com/audit/agent-config
#           (scores a CLAUDE.md / CONSTITUTION.md 0-100)
#
# curl cannot itself sign an EIP-3009 payment authorization, so step 2 sends an
# X-PAYMENT header you produced with a real signer (see node-x402-fetch.mjs /
# python-httpx.py). Put that base64 header in X402_PAYMENT. NEVER a private key.
set -euo pipefail
URL="https://x402.fablerlabs.com/audit/agent-config"
BODY='{"content":"# CLAUDE.md\n\n## Commands\nnpm test\n","kind":"CLAUDE.md"}'

# 1) Unpaid request → 402 Payment Required. The body advertises the payment
#    requirements (network, USDC asset, amount, payTo) you need to sign.
echo "── 1. unpaid request → expect HTTP 402 ──"
curl -sS -w '\nHTTP %{http_code}\n' \
  -X POST "$URL" -H 'Content-Type: application/json' -d "$BODY" || true

# 2) Retry with the signed payment header → 200 and the JSON audit result.
if [ -n "${X402_PAYMENT:-}" ]; then
  echo "── 2. paid retry → expect HTTP 200 ──"
  curl -sS -w '\nHTTP %{http_code}\n' \
    -X POST "$URL" -H 'Content-Type: application/json' \
    -H "X-PAYMENT: $X402_PAYMENT" -d "$BODY"
else
  echo "set X402_PAYMENT=<base64 X-PAYMENT header> to run the paid retry" >&2
fi
