# python-httpx.py — pay an x402 (protocol v2) endpoint with a hand-built EIP-3009
# authorization, so you can see exactly what gets signed and paid.
# One-time:  pip install httpx eth-account
# Env:       X402_PRIVATE_KEY = hex key of a funded Base wallet (USDC + a little gas).
#            NEVER hard-code or commit a key; use a low-balance agent wallet.
import base64, json, os, secrets, time, httpx
from eth_account import Account
from eth_utils import to_hex

URL = "https://x402.fablerlabs.com/audit/agent-config"
BODY = {"content": "# CLAUDE.md\n\n## Commands\nnpm test\n", "kind": "claude-md"}
acct = Account.from_key(os.environ["X402_PRIVATE_KEY"])

with httpx.Client(timeout=30) as c:
    r = c.post(URL, json=BODY)                        # 1) unpaid → 402
    if r.status_code != 402:
        raise SystemExit(f"expected 402, got {r.status_code}: {r.text[:200]}")
    # v2 carries the requirements in the base64 PAYMENT-REQUIRED header (body is
    # empty), not the body. Decode it, then take the first advertised method.
    challenge = json.loads(base64.b64decode(r.headers["payment-required"]))
    req = challenge["accepts"][0]

    # 2) Sign a TransferWithAuthorization (EIP-3009) for exactly the asked amount.
    #    req["amount"] is the atomic USDC amount (v2 renamed v1's maxAmountRequired);
    #    req["extra"] carries the token's EIP-712 domain name/version.
    nonce = secrets.token_bytes(32)
    auth = {"from": acct.address, "to": req["payTo"],
            "value": int(req["amount"]), "validAfter": 0,
            "validBefore": int(time.time()) + int(req["maxTimeoutSeconds"]),
            "nonce": to_hex(nonce)}
    typed = {"primaryType": "TransferWithAuthorization",
             "types": {"TransferWithAuthorization": [
                 {"name": "from", "type": "address"}, {"name": "to", "type": "address"},
                 {"name": "value", "type": "uint256"}, {"name": "validAfter", "type": "uint256"},
                 {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"}]},
             "domain": {"name": req["extra"]["name"], "version": req["extra"]["version"],
                        "chainId": 8453, "verifyingContract": req["asset"]},  # 8453 = Base
             "message": {**auth, "nonce": nonce}}      # sign nonce as raw bytes32
    sig = to_hex(Account.sign_typed_data(acct.key, full_message=typed).signature)

    # 3) Base64 the PAYMENT-SIGNATURE header and retry → 200 + the JSON audit result.
    #    The v2 payload echoes the chosen requirement back in `accepted`.
    payment = {"x402Version": 2, "accepted": req,
               "payload": {"signature": sig, "authorization": auth}}
    header = base64.b64encode(json.dumps(payment).encode()).decode()
    paid = c.post(URL, json=BODY, headers={"PAYMENT-SIGNATURE": header})
    print("HTTP", paid.status_code, paid.json())       # → { score, findings, summary }
    # Settlement (tx hash, payer) rides back in the PAYMENT-RESPONSE header:
    if "payment-response" in paid.headers:
        print("settlement", json.loads(base64.b64decode(paid.headers["payment-response"])))
