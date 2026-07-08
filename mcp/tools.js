// tools.js — shared MCP tool definitions + JSON-RPC dispatch for the Fabler
// x402 Tools MCP server. Imported by server.js (stdio transport). Zero
// required dependencies: works offline for initialize/tools/list, and for
// tools/call falls back to plain fetch when no wallet is configured.
//
// Env:
//   X402_BASE_URL           https://x402.fablerlabs.com  (override for testing)
//   X402_BUYER_PRIVATE_KEY  YOUR OWN EVM wallet private key, used only to
//                            auto-pay x402 402 challenges via the optional
//                            x402-fetch + viem packages. Never Fabler Labs'
//                            key. NEVER logged, echoed, or included in any
//                            error message or tool result — see redact().
//
// Payment flow: every paid tool call hits a Fabler x402 endpoint. If
// X402_BUYER_PRIVATE_KEY is set AND the optional peer packages `x402-fetch`
// and `viem` are installed alongside this server, the request auto-pays a
// 402 challenge on Base and retries. Otherwise (no key, or peers missing)
// a bare 402 response is parsed and returned as structured content so the
// calling agent can pay through its own x402-capable rails and retry.
//
// fabler_list_products is free and never touches the payment path.

const SERVER_INFO = { name: "fabler-x402-tools", version: "1.0.0" };
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

function x402Base() {
  return (process.env.X402_BASE_URL || "https://x402.fablerlabs.com").replace(/\/+$/, "");
}

function buyerKey() {
  return (process.env.X402_BUYER_PRIVATE_KEY || "").trim();
}

function tryRequire(name) {
  try {
    // eslint-disable-next-line global-require
    return require(name);
  } catch {
    return null;
  }
}

// Never surface e.message from inside the payment-signing path verbatim if it
// could conceivably echo key material (it shouldn't — viem never puts the raw
// key on the account/error objects — but we only pass through a fixed string
// here anyway, out of caution).
function redactedPaymentError() {
  return new Error(
    "failed to initialize the x402 payment client — check that X402_BUYER_PRIVATE_KEY is a " +
      "valid 32-byte hex EVM private key (0x-prefixed or not)",
  );
}

// Returns a fetch function wrapped to auto-pay x402 challenges, or null when
// no wallet key is set or the optional peer packages aren't installed (in
// which case callers fall back to plain fetch and surface the 402 challenge).
async function getPayingFetch() {
  const key = buyerKey();
  if (!key) return null;
  const x402Fetch = tryRequire("x402-fetch");
  const viem = tryRequire("viem");
  const viemAccounts = tryRequire("viem/accounts");
  const viemChains = tryRequire("viem/chains");
  if (!x402Fetch || !viem || !viemAccounts || !viemChains) return null;
  try {
    const normalized = key.startsWith("0x") ? key : `0x${key}`;
    const account = viemAccounts.privateKeyToAccount(normalized);
    const walletClient = viem.createWalletClient({
      account,
      chain: viemChains.base,
      transport: viem.http(),
    });
    return x402Fetch.wrapFetchWithPayment(fetch, walletClient);
  } catch {
    throw redactedPaymentError();
  }
}

const TOOLS = [
  {
    name: "fabler_scan_secrets",
    description:
      "Scan text for leaked API keys/secrets/tokens (Stripe, GitHub, AWS, PEM private keys, " +
      "JWTs, Slack, Telegram, Cloudflare, generic high-entropy strings). Paid x402 tool billed " +
      "in USDC on Base — call fabler_list_products first for the current per-call price. The " +
      "raw `text` is sent to the Fabler x402 API for scanning; only masked matches come back, " +
      "but treat the request itself as sensitive if `text` may contain real secrets.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to scan (file contents, diff, config, etc.)" },
      },
      required: ["text"],
    },
  },
  {
    name: "fabler_audit_agent_config",
    description:
      "Audit an AI agent's instructions file (CLAUDE.md, AGENTS.md, system prompt) or a governing " +
      "CONSTITUTION.md against current agent-config best practices and return a score plus specific " +
      "findings. Paid x402 tool billed in USDC on Base — call fabler_list_products first for the " +
      "current per-call price.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Full contents of the agent config file to audit" },
        kind: {
          type: "string",
          enum: ["CLAUDE.md", "constitution"],
          description:
            'Which rubric to score against: "CLAUDE.md" for a CLAUDE.md/AGENTS.md project-instructions ' +
            'file, "constitution" for an unattended-agent CONSTITUTION.md. Defaults to "CLAUDE.md".',
        },
      },
      required: ["content"],
    },
  },
  {
    name: "fabler_render_og",
    description:
      "Render a branded 1200x630 OG/social-card image (PNG, or SVG if the raster step falls back) " +
      "from a title and optional subtitle, and return the raw image bytes plus content type. Paid " +
      "x402 tool billed in USDC on Base — call fabler_list_products first for the current " +
      "per-call price.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Headline text (auto-clipped past 2 lines)" },
        subtitle: { type: "string", description: "Optional smaller subline below the title" },
        theme: { type: "string", enum: ["dark", "light"], description: 'Color theme, default "dark"' },
      },
      required: ["title"],
    },
  },
  {
    name: "fabler_list_products",
    description:
      "List Fabler Labs' x402 products with their current per-call USDC price. Free, no wallet " +
      "or payment required — call this first to see what everything costs before spending.",
    inputSchema: { type: "object", properties: {} },
  },
];

// callApi hits one x402 endpoint. `paid: true` (default) means: try to
// auto-pay via getPayingFetch() when a wallet is configured; otherwise parse
// and return a bare 402 as structured data instead of throwing. `paid: false`
// (fabler_list_products) always uses plain fetch and never touches payment.
async function callApi(path, { method = "GET", body, paid = true } = {}) {
  const url = `${x402Base()}${path}`;
  const init = {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  };

  let usedFetch = fetch;
  let payingFetchActive = false;
  if (paid) {
    const payingFetch = await getPayingFetch();
    if (payingFetch) {
      usedFetch = payingFetch;
      payingFetchActive = true;
    }
  }

  const res = await usedFetch(url, init);
  const text = await res.text();

  if (paid && res.status === 402 && !payingFetchActive) {
    let challenge;
    try {
      challenge = JSON.parse(text);
    } catch {
      challenge = { raw: text };
    }
    return {
      paid: false,
      status: 402,
      challenge,
      note:
        "Payment required. Set X402_BUYER_PRIVATE_KEY and `npm install x402-fetch viem` " +
        "alongside this server to pay automatically, or settle this challenge through your " +
        "own x402-capable rails and retry the call.",
    };
  }

  if (!res.ok) {
    throw new Error(`x402 API ${res.status}: ${text.slice(0, 500)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { paid: payingFetchActive, status: res.status, data };
}

function requireNonEmptyText(value, field) {
  const text = (value || "").toString();
  if (!text.trim()) throw new Error(`${field} is required and must be non-empty`);
  return text;
}

async function callTool(name, args) {
  if (name === "fabler_scan_secrets") {
    const text = requireNonEmptyText(args.text, "text");
    return JSON.stringify(await callApi("/scan/secrets", { method: "POST", body: { text } }), null, 2);
  }
  if (name === "fabler_audit_agent_config") {
    const content = requireNonEmptyText(args.content, "content");
    const kind = args.kind === "constitution" ? "constitution" : "CLAUDE.md";
    return JSON.stringify(
      await callApi("/audit/agent-config", { method: "POST", body: { content, kind } }),
      null,
      2,
    );
  }
  if (name === "fabler_render_og") {
    const title = requireNonEmptyText(args.title, "title");
    const body = { title };
    if (typeof args.subtitle === "string" && args.subtitle) body.subtitle = args.subtitle;
    if (args.theme === "light" || args.theme === "dark") body.theme = args.theme;
    return JSON.stringify(await callApi("/render/og", { method: "POST", body }), null, 2);
  }
  if (name === "fabler_list_products") {
    // The free, machine-readable catalog is served at the API root, not a
    // separate /products.json path — see README.md's "Routes" table.
    return JSON.stringify(await callApi("/", { method: "GET", paid: false }), null, 2);
  }
  throw new Error(`unknown tool: ${name}`);
}

// dispatch(msg) → a JSON-RPC response object, or null when there is nothing to
// answer (a notification, or an unparseable/non-request message).
async function dispatch(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  if (msg.id === undefined || msg.id === null) return null;
  try {
    if (msg.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: (msg.params && msg.params.protocolVersion) || DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };
    }
    if (msg.method === "tools/list") {
      return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } };
    }
    if (msg.method === "tools/call") {
      try {
        const params = msg.params || {};
        const text = await callTool(params.name, params.arguments || {});
        return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } };
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: String((e && e.message) || e) }],
            isError: true,
          },
        };
      }
    }
    if (msg.method === "ping") {
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    }
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `method not found: ${msg.method}` },
    };
  } catch (e) {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32603, message: String((e && e.message) || e) },
    };
  }
}

module.exports = { TOOLS, SERVER_INFO, DEFAULT_PROTOCOL_VERSION, callApi, callTool, dispatch };
