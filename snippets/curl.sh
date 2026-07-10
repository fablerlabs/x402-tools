#!/usr/bin/env bash
# x402 (protocol v2) by hand, in two curls — see the 402, then pay it.
# Endpoint: POST https://x402.fablerlabs.com/audit/agent-config
#           (scores a CLAUDE.md / CONSTITUTION.md 0–100; see x402/src/engines/audit.ts)
#
# In v2 the payment requirements are NOT in the 402 body (it's empty {}) — they
# ride in a base64-encoded PAYMENT-REQUIRED response header. curl can't sign an
# EIP-3009 authorization, so step 2 sends a PAYMENT-SIGNATURE header you produced
# with a real signer (see node-viem.mjs / python-httpx.py). Put that base64
# header in X402_PAYMENT. NEVER a private key.
set -euo pipefail
URL="https://x402.fablerlabs.com/audit/agent-config"
BODY='{"content":"# CLAUDE.md\n\n## Commands\nnpm test\n","kind":"claude-md"}'

# 1) Unpaid request → 402 Payment Required. Dump the response headers and pull the
#    base64 PAYMENT-REQUIRED value; decoding it shows the requirements
#    ({x402Version:2, accepts:[{scheme, network, asset, amount, payTo, extra}]}).
echo "── 1. unpaid request → expect HTTP 402 + PAYMENT-REQUIRED header ──"
HDRS="$(curl -sS -D - -o /dev/null -w 'HTTP %{http_code}\n' \
  -X POST "$URL" -H 'Content-Type: application/json' -d "$BODY" || true)"
echo "$HDRS"
CHALLENGE_B64="$(printf '%s\n' "$HDRS" | tr -d '\r' | awk -F': ' 'tolower($1)=="payment-required"{print $2}')"
if [ -n "${CHALLENGE_B64:-}" ]; then
  echo "── decoded payment requirements ──"
  printf '%s' "$CHALLENGE_B64" | base64 -d 2>/dev/null || echo "(could not base64-decode; header value above)"
  echo
fi

# 2) Retry with the signed payment header → 200 and the JSON audit result.
if [ -n "${X402_PAYMENT:-}" ]; then
  echo "── 2. paid retry → expect HTTP 200 ──"
  curl -sS -w '\nHTTP %{http_code}\n' \
    -X POST "$URL" -H 'Content-Type: application/json' \
    -H "PAYMENT-SIGNATURE: $X402_PAYMENT" -d "$BODY"
else
  echo "set X402_PAYMENT=<base64 PAYMENT-SIGNATURE header> to run the paid retry" >&2
fi
