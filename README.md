# Fabler x402 Tools

**Paid agent tools, billed per call over [x402](https://www.x402.org/) on
Base.** Point any MCP client (Claude Code, Claude Desktop, ...) at this
server to give your agent secret scanning, agent-config auditing, diff-security
gating, and OG image rendering — plus a free product catalog it can check before spending
anything. No account, no API key: payment over x402 *is* the auth.

> **Built and operated by an autonomous AI agent.** Fabler Labs' products,
> including this server and the API behind it, are built by a Claude agent
> running a real business unattended on a VPS ([the agent's public
> brain](https://github.com/fablerlabs/brain)). The agent discloses this
> everywhere, including here: no human wrote the code in this repo.

## Tools

| Tool | Cost | What it does |
|---|---|---|
| `fabler_list_products` | free | List current products and their per-call USDC price. Call this first. |
| `fabler_scan_secrets` | paid | Scan text for leaked API keys/secrets/tokens (Stripe, GitHub, AWS, PEM keys, JWTs, Slack, Telegram, Cloudflare, generic high-entropy). |
| `fabler_audit_agent_config` | paid | Audit a `CLAUDE.md`/`AGENTS.md` or a governing `CONSTITUTION.md` against agent-config best practices; returns a 0-100 score and specific findings. |
| `fabler_audit_diff_security` | paid | Scan added lines in a unified diff for leaked secrets and high-signal security patterns; returns a pass/block verdict. |
| `fabler_render_og` | paid | Render a branded 1200×630 OG/social-card image from a title/subtitle; returns the raw image bytes. |

Exact per-call prices are served live by `fabler_list_products` — they are
not hardcoded here so this README can't go stale. See
[x402.fablerlabs.com](https://x402.fablerlabs.com) for the human-readable
overview, or `GET https://x402.fablerlabs.com/` for the machine-readable
catalog these tools call under the hood.

## Install

Three ways to run this server — pick one:

### 1. `npx`, straight from GitHub (no install step)

```json
{
  "mcpServers": {
    "fabler-x402-tools": {
      "command": "npx",
      "args": ["-y", "github:fablerlabs/x402-tools"],
      "env": { "X402_BUYER_PRIVATE_KEY": "0x..." }
    }
  }
}
```

Add that to your MCP client config — Claude Code: `.mcp.json` at your
project root; Claude Desktop: `claude_desktop_config.json`.

### 2. From a checkout

```bash
git clone https://github.com/fablerlabs/x402-tools && cd x402-tools
npm install
```

```json
{ "command": "node", "args": ["/path/to/x402-tools/mcp/server.js"] }
```

### 3. Claude Desktop extension (`.mcpb`)

Build (or download from a [release](https://github.com/fablerlabs/x402-tools/releases))
`dist/fabler-x402-tools.mcpb` via `bash mcp/build-mcpb.sh`, then drag it into
Claude Desktop's extensions settings. Configure `X402_BUYER_PRIVATE_KEY` in
the extension's settings UI instead of a config file.

`X402_BUYER_PRIVATE_KEY` is **optional** in every install path — omit it
entirely if you'd rather pay challenges through your own x402-capable rails
(see "Payment flow" below).

To let this server **pay automatically** instead of just reporting the
payment challenge, also install the optional x402 payment peers alongside
it:

```bash
npm install @x402/fetch @x402/evm viem
```

(`npx github:...` users: clone the repo instead so you have a place to
`npm install` these — `npx` alone won't pull in optional peers for a
GitHub-sourced package.)

## Payment flow

Every paid tool call hits a Fabler x402 endpoint under
`https://x402.fablerlabs.com` (override with `X402_BASE_URL`, e.g. for local
testing against a staging deploy).

- **With `X402_BUYER_PRIVATE_KEY` set and the v2 `@x402/fetch`, `@x402/evm`, and `viem` packages installed:**
  the server signs and settles the 402 payment on Base automatically using
  `@x402/fetch`'s v2 payment wrapper, then returns the tool's real result.
- **Otherwise:** the server makes a plain request. If the endpoint answers
  `402 Payment Required`, the server does **not** treat this as an error — it
  decodes the x402 v2 `PAYMENT-REQUIRED` response header and returns the parsed
  challenge (`accepts` array: scheme, network, amount, `payTo` address, asset,
  etc.) as the tool's structured result, along
  with a note explaining how to pay it. Your agent (or you) can settle that
  challenge through any x402-capable wallet/rails and retry the call.

See [`snippets/`](snippets/) for three ways to pay a challenge by hand
(curl + a signer, Node + `x402-fetch`, Python + `eth-account`), and
[`examples/buyer-sim/`](examples/buyer-sim/) for a full offline
challenge→pay→retry→verify harness you can run without spending anything.

## Security note

`X402_BUYER_PRIVATE_KEY` is **your own** wallet key — never Fabler Labs'.
It is:

- read from the environment only, at call time;
- used exclusively to construct a local `viem` wallet client for signing
  x402 payment payloads;
- **never logged, echoed in a tool result, or included in any error
  message** — errors from the payment path are reduced to a fixed, generic
  string precisely so a stack trace can't leak key material;
- never transmitted to Fabler Labs in any form — only the resulting signed
  payment payload (standard x402 protocol behavior) goes to the endpoint
  you're paying.

Treat it like any other hot-wallet key: fund it with only what you're willing
to spend on these tools, and prefer a dedicated wallet over your main one.

Also note: the scan and audit tools send the text or diff you pass as an
argument to the Fabler x402 API for processing. Don't pass data you're not
willing to transmit off-machine. Full policy in
[SECURITY.md](SECURITY.md).

## Publish targets (for maintainers)

- **Official MCP registry** — [`mcp/server.json`](mcp/server.json) declares
  `com.fablerlabs/x402-tools` as an **npm**-registry package
  (`fabler-x402-mcp`). Publish with `npm publish` from the repo root, then
  submit `mcp/server.json` via `mcp-publisher` (DNS auth on `fablerlabs.com`).
- **Claude Desktop extension** — `bash mcp/build-mcpb.sh` builds
  `dist/fabler-x402-tools.mcpb` from [`manifest.json`](manifest.json) +
  `mcp/server.js` + `mcp/tools.js` + `LICENSE`, for a GitHub release asset.
  This is a second, independent distribution path from the npm one above —
  both point at the same source, packaged differently for different
  installers.
- **Claude Code plugin** — [`.claude-plugin/`](.claude-plugin/) makes this
  repo installable as a Claude Code plugin directly (`plugin.json` +
  `mcp.json`), the same pattern as
  [fablerlabs/relay](https://github.com/fablerlabs/relay).

## Dev / test

```bash
npm install
npm test
```

Runs `mcp/test/mcp-smoke.mjs` (spawns `mcp/server.js`, performs a real
`initialize` + `tools/list` handshake over stdio, asserts all five tools are
present with a `description` and `inputSchema` — no network, no env vars)
followed by `examples/buyer-sim/buyer.mjs --mock` (an offline
challenge→pay→retry→verify simulation against every paid route — see that
directory's README). Neither test calls the real API or needs a wallet.

## Links

- Human storefront (same products, Stripe checkout): https://fablerlabs.com
- Machine storefront (this server's backend): https://x402.fablerlabs.com
- The story behind this business: https://fablerlabs.com/story
- x402 protocol spec: https://x402.org

## License

MIT
