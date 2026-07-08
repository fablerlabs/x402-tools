# python-httpx.py — pay an x402 endpoint with a hand-built EIP-3009 authorization.
# One-time:  pip install httpx eth-account
# Env:       X402_PRIVATE_KEY = hex key of a funded Base wallet (USDC + a little gas).
#            NEVER hard-code or commit a key; use a low-balance agent wallet.
import base64, json, os, secrets, time, httpx
from eth_account import Account
from eth_utils import to_hex

URL = "https://x402.fablerlabs.com/audit/agent-config"
BODY = {"content": "# CLAUDE.md\n\n## Commands\nnpm test\n", "kind": "CLAUDE.md"}
acct = Account.from_key(os.environ["X402_PRIVATE_KEY"])

with httpx.Client(timeout=30) as c:
    r = c.post(URL, json=BODY)                       # 1) unpaid → 402 + requirements
    if r.status_code != 402:
        raise SystemExit(f"expected 402, got {r.status_code}: {r.text[:200]}")
    req = r.json()["accepts"][0]                      # first advertised payment method

    # 2) Sign a TransferWithAuthorization (EIP-3009) for exactly the asked amount.
    nonce = secrets.token_bytes(32)
    auth = {"from": acct.address, "to": req["payTo"],
            "value": int(req["maxAmountRequired"]), "validAfter": 0,
            "validBefore": int(time.time()) + int(req["maxTimeoutSeconds"]),
            "nonce": to_hex(nonce)}
    typed = {"primaryType": "TransferWithAuthorization",
             "types": {"TransferWithAuthorization": [
                 {"name": "from", "type": "address"}, {"name": "to", "type": "address"},
                 {"name": "value", "type": "uint256"}, {"name": "validAfter", "type": "uint256"},
                 {"name": "validBefore", "type": "uint256"}, {"name": "nonce", "type": "bytes32"}]},
             "domain": {"name": req["extra"]["name"], "version": req["extra"]["version"],
                        "chainId": 8453, "verifyingContract": req["asset"]},  # 8453 = Base
             "message": {**auth, "nonce": nonce}}     # sign nonce as raw bytes32
    sig = to_hex(Account.sign_typed_data(acct.key, full_message=typed).signature)

    # 3) Base64 the X-PAYMENT header and retry → 200 + the JSON audit result.
    payment = {"x402Version": 1, "scheme": req["scheme"], "network": req["network"],
               "payload": {"signature": sig, "authorization": auth}}
    header = base64.b64encode(json.dumps(payment).encode()).decode()
    paid = c.post(URL, json=BODY, headers={"X-PAYMENT": header})
    print("HTTP", paid.status_code, paid.json())      # → { score, findings, summary }
