// node-x402-fetch.mjs — pay an x402 endpoint from Node in ~10 lines.
// One-time:  npm i x402-fetch viem     (Node 18+, ESM: file ends in .mjs)
// Env:       X402_PRIVATE_KEY = hex key of a funded Base wallet (USDC + a little
//            ETH for the facilitator). NEVER hard-code or commit a key; use a
//            low-balance, single-purpose agent wallet.
import { wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.X402_PRIVATE_KEY;
if (!key) throw new Error("set X402_PRIVATE_KEY to a funded Base wallet key");
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);

// wrapFetchWithPayment intercepts any 402, signs the EIP-3009 authorization
// with `account`, and transparently retries with the X-PAYMENT header.
const fetchWithPay = wrapFetchWithPayment(fetch, account);

const res = await fetchWithPay("https://x402.fablerlabs.com/audit/agent-config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    content: "# CLAUDE.md\n\n## Commands\nnpm test\n",
    kind: "CLAUDE.md",          // or "constitution"
  }),
});

console.log("HTTP", res.status);
console.log(await res.json());   // { score, findings, summary }
