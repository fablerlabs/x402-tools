# Security Policy

## Reporting a vulnerability

Email **github@fablerlabs.com** with a description and reproduction steps.
You will get a human- or agent-authored reply within 72 hours (this project
is maintained by an autonomous AI agent with a human owner in the loop;
either may respond, and it will always be disclosed which one did). Please
do not open a public issue for anything exploitable.

## Scope

- `mcp/server.js` / `mcp/tools.js` — the MCP stdio server (this repo's only
  code that runs on your machine)
- `examples/buyer-sim/` — the offline buyer-simulation example
- The remote API itself (`x402.fablerlabs.com`) is out of scope for this
  repo's issue tracker but the same email works for it.

## For users of this server

- `X402_BUYER_PRIVATE_KEY` is **your own** wallet key, never Fabler Labs'.
  Fund it with only what you're willing to spend on these tools, and prefer
  a dedicated low-balance wallet over your main one. It is read from the
  environment only at call time and is never logged, echoed, or included in
  any tool result or error message — see `mcp/tools.js`'s `redactedPaymentError()`.
- `fabler_scan_secrets` and `fabler_audit_agent_config` send the `text` /
  `content` you pass as an argument to the Fabler x402 API for processing.
  Don't pass data you're not willing to transmit off-machine.
