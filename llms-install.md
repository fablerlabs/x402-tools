# llms-install.md — AI-assisted installation guide

Instructions for an AI agent (Cline, Claude Code, etc.) installing the
**Fabler x402 Tools MCP server** for a user. Follow the steps in order; every
step has a verification check.

## What you are installing

A zero-required-dependency MCP stdio server (Node 18+) exposing six tools:

| Tool | Cost | What it does |
|---|---|---|
| `fabler_list_products` | free | List current products and their per-call USDC price. |
| `fabler_scan_secrets` | paid | Scan text for leaked API keys/secrets/tokens. |
| `fabler_audit_agent_config` | paid | Audit a CLAUDE.md/AGENTS.md/CONSTITUTION.md; returns a score + findings. |
| `fabler_audit_diff_security` | paid | Scan a unified diff for leaked secrets and high-signal security patterns. |
| `fabler_audit_pre_deploy` | paid | Validate an 18-point release record for missing, failed, or evidence-free checks. |
| `fabler_render_og` | paid | Render a branded 1200×630 OG/social-card image. |

The server talks to `https://x402.fablerlabs.com`, a live, already-deployed
service — there is nothing for the user to deploy themselves (unlike a
self-hosted server). It needs **no required env var**: with none set, paid
tools return the raw 402 payment challenge instead of an error.

## Step 0 — Does the user want automatic payment?

Ask the user whether they want this server to **auto-pay** 402 challenges
with their own wallet, or just **receive the challenge** and settle it
themselves (e.g. through an agent framework's own x402 support).

- If they want to just receive challenges: skip straight to Step 1, no key
  needed.
- If they want auto-pay: they need an EVM wallet private key funded with a
  small amount of USDC + ETH on Base mainnet — **their own key, never
  Fabler Labs'**. Tell them plainly this is real mainnet money and to use a
  low-balance, single-purpose wallet, never their main one.

## Step 1 — Register the MCP server

No install step is required — `npx` runs it straight from GitHub. Add to the
MCP settings file of your client (for Claude Code: `.mcp.json` at the
project root; for Claude Desktop: `claude_desktop_config.json`; for Cline:
`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "fabler-x402-tools": {
      "command": "npx",
      "args": ["-y", "github:fablerlabs/x402-tools"],
      "env": {
        "X402_BUYER_PRIVATE_KEY": "YOUR-OWN-WALLET-KEY-OR-OMIT"
      }
    }
  }
}
```

If the user chose "just receive challenges" in Step 0, omit the `env` block
entirely rather than setting it to an empty string.

Alternatives that behave identically:

- From a checkout: `"command": "node", "args": ["/path/to/x402-tools/mcp/server.js"]`
- Claude Desktop `.mcpb` extension: build via `bash mcp/build-mcpb.sh` (or
  download from a GitHub release) and drag the resulting file into Claude
  Desktop's extension settings — configure the wallet key in its settings UI
  instead of a JSON file.

## Step 2 — Auto-pay only: confirm the payment dependencies

The GitHub package installs its optional payment dependencies by default, so no
extra command is normally required. If it was installed with `--omit=optional`,
use a local checkout and install the peers before enabling automatic payment:

```bash
git clone https://github.com/fablerlabs/x402-tools && cd x402-tools
npm install @x402/fetch @x402/evm viem
```

## Step 3 — Verify

1. The server starts and answers a handshake with no env set:

   ```bash
   printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
     | npx -y github:fablerlabs/x402-tools
   ```

   Expect two JSON-RPC responses; the second lists all six `fabler_*` tools.

2. End-to-end, no wallet needed: call `fabler_list_products` from the MCP
   client. It's free and hits the live catalog — a non-empty product list is
   a success. Without a client, the same check over raw stdio:

   ```bash
   printf '%s\n' \
     '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fabler_list_products","arguments":{}}}' \
     | npx -y github:fablerlabs/x402-tools
   ```

3. If auto-pay was configured (Step 0/2): call any paid tool, e.g.
   `fabler_scan_secrets` with a short text sample, and confirm the result is
   the real tool output (not a `{paid:false, status:402, ...}` challenge
   object) — that confirms the wallet paid successfully.

## Troubleshooting

- **Paid tool returns `{paid:false, status:402, challenge:{...}}`** — this is
  not an error. It means no wallet is configured (or the optional peers
  aren't installed), so the server handed back the raw payment challenge.
  Either configure `X402_BUYER_PRIVATE_KEY` + the optional peers (Step 2), or
  pay the challenge through your own x402-capable rails and retry.
- **`x402 API 5xx` tool error** — the live endpoint is unreachable or
  degraded; not something this install fixes. Check
  `https://x402.fablerlabs.com/health`.
- `npx` requires Node ≥ 18 (`node --version`).

## Security notes (tell the user)

- `X402_BUYER_PRIVATE_KEY` is read from the environment only, used solely to
  build a local wallet client, and never logged, echoed, or transmitted to
  Fabler Labs in any form.
- `fabler_scan_secrets` and `fabler_audit_agent_config` send whatever text
  the agent passes them to the Fabler x402 API for processing — don't run
  them on data you're not willing to transmit off-machine.
- Full policy in [SECURITY.md](SECURITY.md).
