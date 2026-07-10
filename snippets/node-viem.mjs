// node-viem.mjs — pay an x402 (protocol v2) endpoint from Node with a hand-built
// EIP-3009 authorization, so you can see exactly what gets signed and paid.
// One-time:  npm i viem            (Node 18+, ESM: file ends in .mjs)
// Env:       X402_PRIVATE_KEY = hex key of a funded Base wallet (USDC + a little
//            ETH for the facilitator). NEVER hard-code or commit a key; use a
//            low-balance, single-purpose agent wallet.
import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, toHex } from "viem";

const URL_ = "https://x402.fablerlabs.com/audit/agent-config";
const BODY = { content: "# CLAUDE.md\n\n## Commands\nnpm test\n", kind: "claude-md" }; // or kind:"constitution"

const key = process.env.X402_PRIVATE_KEY;
if (!key) throw new Error("set X402_PRIVATE_KEY to a funded Base wallet key");
const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");

// 1) Unpaid request → 402. In v2 the requirements ride in the base64
//    PAYMENT-REQUIRED response header (the body is empty), not the body.
const challengeRes = await fetch(URL_, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(BODY),
});
if (challengeRes.status !== 402) throw new Error(`expected 402, got ${challengeRes.status}`);
const challenge = JSON.parse(Buffer.from(challengeRes.headers.get("PAYMENT-REQUIRED"), "base64").toString());
const req = challenge.accepts[0]; // first advertised payment method

// 2) Sign a TransferWithAuthorization (EIP-3009) for exactly the asked amount.
//    `req.extra.{name,version}` are the token's EIP-712 domain params; `req.amount`
//    is the atomic USDC amount (v2 renamed v1's maxAmountRequired → amount).
const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: account.address,
  to: getAddress(req.payTo),
  value: req.amount,
  validAfter: "0",
  validBefore: String(now + req.maxTimeoutSeconds),
  nonce: toHex(randomBytes(32)),
};
const signature = await account.signTypedData({
  domain: { name: req.extra.name, version: req.extra.version, chainId: 8453, verifyingContract: getAddress(req.asset) }, // 8453 = Base
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: authorization.from, to: authorization.to, value: BigInt(authorization.value),
    validAfter: 0n, validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce,
  },
});

// 3) Retry with the base64 PAYMENT-SIGNATURE header → 200 + the JSON audit result.
//    The payload echoes the chosen requirement back in `accepted` (v2 shape).
// Echo declared extensions so facilitators can process optional metadata such as
// Bazaar discovery during settlement. Older/non-extension routes simply omit it.
const payment = {
  x402Version: 2,
  accepted: req,
  payload: { authorization, signature },
  ...(challenge.extensions ? { extensions: challenge.extensions } : {}),
};
const res = await fetch(URL_, {
  method: "POST",
  headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": b64(payment) },
  body: JSON.stringify(BODY),
});
console.log("HTTP", res.status);
console.log(await res.json()); // { score, findings, summary }
// Settlement (tx hash, payer) comes back in the PAYMENT-RESPONSE response header:
const settle = res.headers.get("PAYMENT-RESPONSE");
if (settle) console.log("settlement", JSON.parse(Buffer.from(settle, "base64").toString()));
