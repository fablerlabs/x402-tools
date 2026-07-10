// tools.js — shared MCP tool definitions + JSON-RPC dispatch for the Fabler
// x402 Tools MCP server. Imported by server.js (stdio transport). Zero
// required dependencies: works offline for initialize/tools/list, and for
// tools/call falls back to plain fetch when no wallet is configured.
//
// Env:
//   X402_BASE_URL           https://x402.fablerlabs.com  (override for testing)
//   X402_BUYER_PRIVATE_KEY  YOUR OWN EVM wallet private key, used only to
//                            auto-pay x402 402 challenges via the optional
//                            @x402/fetch + @x402/evm + viem packages. Never Fabler Labs'
//                            key. NEVER logged, echoed, or included in any
//                            error message or tool result — see redact().
//
// Payment flow: every paid tool call hits a Fabler x402 endpoint. If
// X402_BUYER_PRIVATE_KEY is set AND the optional payment dependencies are
// installed alongside this server, the request auto-pays a
// 402 challenge on Base and retries. Otherwise (no key, or peers missing)
// a bare 402 response is parsed and returned as structured content so the
// calling agent can pay through its own x402-capable rails and retry. The
// deployed worker speaks x402 protocol v2 (@x402/hono): the challenge is
// NOT in the 402 response body (which is `{}`) — it's base64-JSON in the
// `payment-required` response header. See decodePaymentRequiredHeader().
//
// fabler_list_products is free and never touches the payment path.

const SERVER_INFO = { name: "fabler-x402-tools", version: "1.0.6" };
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const RELEASE_CHECK_IDS = [
  "secrets-scanned",
  "env-history-clean",
  "production-debug-off",
  "default-credentials-changed",
  "cors-origin-allowlist",
  "mutating-authz",
  "secure-credential-hashing",
  "session-cookie-flags",
  "auth-rate-limits",
  "parameterized-queries",
  "output-sanitization",
  "upload-bounds",
  "dependency-audit",
  "dependency-maintenance",
  "infrastructure-least-access",
  "deploy-credential-scope",
  "rollback-ready",
  "residual-risk-owners",
];
const RELEASE_CHECK_ID_SET = new Set(RELEASE_CHECK_IDS);
const BLOCKED_URL_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
  ".test",
  ".example",
  ".invalid",
  ".onion",
];

function x402Base() {
  return (process.env.X402_BASE_URL || "https://x402.fablerlabs.com").replace(/\/+$/, "");
}

function buyerKey() {
  return (process.env.X402_BUYER_PRIVATE_KEY || "").trim();
}

function loadPaymentDependencies() {
  try {
    return {
      x402Fetch: require("@x402/fetch"),
      x402Evm: require("@x402/evm"),
      viemAccounts: require("viem/accounts"),
    };
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
// no wallet key is set or the optional payment dependencies aren't installed (in
// which case callers fall back to plain fetch and surface the 402 challenge).
async function getPayingFetch() {
  const key = buyerKey();
  if (!key) return null;
  const deps = loadPaymentDependencies();
  if (!deps) return null;
  try {
    const normalized = key.startsWith("0x") ? key : `0x${key}`;
    const account = deps.viemAccounts.privateKeyToAccount(normalized);
    return deps.x402Fetch.wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: "eip155:8453", client: new deps.x402Evm.ExactEvmScheme(account) }],
    });
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
    name: "fabler_audit_diff_security",
    description:
      "Scan the added lines in a unified code diff for leaked secrets and high-signal security " +
      "patterns, then return a pass/block merge-gate verdict. This is heuristic pattern matching, " +
      "not a full static analyzer. Paid x402 tool billed in USDC on Base — call " +
      "fabler_list_products first for the current per-call price.",
    inputSchema: {
      type: "object",
      properties: {
        diff: {
          type: "string",
          maxLength: 200000,
          description: "Unified diff text, such as the output of git diff (maximum 200,000 characters)",
        },
      },
      required: ["diff"],
    },
  },
  {
    name: "fabler_audit_pre_deploy",
    description:
      "Validate an 18-point pre-deploy review record and return missing checks, failures, blank " +
      "evidence gaps, and a ready/blocked verdict. This validates evidence completeness; it does " +
      "not scan code or verify that submitted evidence is true. Paid x402 tool billed in USDC on " +
      "Base — call fabler_list_products first for the current per-call price.",
    inputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          minItems: 1,
          maxItems: 18,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", enum: RELEASE_CHECK_IDS },
              status: { type: "string", enum: ["pass", "fail", "not-applicable"] },
              evidence: {
                type: "string",
                maxLength: 500,
                description: "One-line evidence or not-applicable justification; blank evidence blocks readiness.",
              },
            },
            required: ["id", "status", "evidence"],
          },
        },
      },
      required: ["results"],
    },
  },
  {
    name: "fabler_audit_url_security",
    description:
      "Create a bounded response-metadata snapshot for a public HTTPS URL: status, validated " +
      "redirects, HSTS, CSP, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, and " +
      "cookie flags. The service does not retain response-body content and is not a vulnerability " +
      "scan or TLS-certificate audit. Paid x402 tool billed in USDC on Base - call " +
      "fabler_list_products first for the current per-call price.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          format: "uri",
          maxLength: 2048,
          description: "Public HTTPS URL using the default port, without credentials or a fragment",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "fabler_scrape_web_page",
    description:
      "Fetch a public HTTPS page and return clean readable text plus title, author, publish date, " +
      "hostname, excerpt, word count, final URL, and redirect evidence. HTML only, with bounded " +
      "source size, output size, redirects, and runtime. Paid x402 tool billed in USDC on Base - " +
      "call fabler_list_products first for the current per-call price.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          format: "uri",
          maxLength: 2048,
          description: "Public HTTPS page URL using the default port, without credentials or a fragment",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "fabler_render_og",
    description:
      "Render a branded 1200x630 OG/social-card image (PNG, or SVG if the raster step falls back) " +
      "from a title and optional subtitle, and return it as base64 image data plus content type. " +
      "Paid x402 tool billed in USDC on Base — call fabler_list_products first for the current " +
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

// x402 protocol v2 (@x402/hono, see src/x402guard.ts) puts the payment
// challenge in a base64-JSON `payment-required` response header, not the
// body (the 402 body is `{}`). Mirrors @x402/core's safeBase64Decode +
// PaymentRequiredV2Schema shape: { x402Version: 2, resource, accepts: [...] }.
// Returns null on a missing/malformed header so the caller can fall back.
function decodePaymentRequiredHeader(res) {
  const header = res.headers.get("payment-required");
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

// callApi hits one x402 endpoint. `paid: true` (default) means: try to
// auto-pay via getPayingFetch() when a wallet is configured; otherwise parse
// and return a bare 402 as structured data instead of throwing. `paid: false`
// (fabler_list_products) always uses plain fetch and never touches payment.
// `binary: true` (fabler_render_og) means a 200 response body is an image, not
// JSON — read it as bytes and base64-encode it rather than mangling it through
// res.text() + JSON.parse.
async function callApi(path, { method = "GET", body, paid = true, binary = false } = {}) {
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

  if (paid && res.status === 402 && !payingFetchActive) {
    // Primary path: v2 challenge lives in the `payment-required` header.
    let challenge = decodePaymentRequiredHeader(res);
    if (!challenge) {
      // Defensive fallback only — the deployed worker never sends a v1-style
      // body challenge, but don't swallow a 402 body an intermediary (proxy,
      // test fixture) might still send instead of/alongside the header.
      const text = await res.text();
      try {
        challenge = JSON.parse(text);
      } catch {
        challenge = { raw: text };
      }
    } else {
      await res.text().catch(() => {}); // drain the (empty) v2 body
    }
    return {
      paid: false,
      status: 402,
      challenge,
      note:
        "Payment required (x402 protocol v2). Set X402_BUYER_PRIVATE_KEY and " +
        "`npm install @x402/fetch @x402/evm viem` alongside this server to pay automatically, or settle " +
        "this challenge through your own x402-capable rails and retry the call.",
    };
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`x402 API ${res.status}: ${text.slice(0, 500)}`);
  }

  if (binary) {
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      paid: payingFetchActive,
      status: res.status,
      contentType: res.headers.get("content-type") || "application/octet-stream",
      dataBase64: buf.toString("base64"),
    };
  }

  const text = await res.text();
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

function requirePublicHttpsUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) {
    throw new Error("url is required and must contain 1-2048 characters");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("url must be a valid absolute HTTPS URL");
  }
  if (url.protocol !== "https:") throw new Error("url must use HTTPS");
  if (url.username || url.password) throw new Error("url must not contain credentials");
  if (url.port && url.port !== "443") throw new Error("url must use the default HTTPS port");
  if (url.hash) throw new Error("url must not contain a fragment");

  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  if (
    host === "localhost" ||
    host.endsWith(".") ||
    !host.includes(".") ||
    host.includes(":") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    BLOCKED_URL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    host.length > 253 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("url host must be a public DNS name");
  }
  return url.toString();
}

function requireReleaseResults(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > RELEASE_CHECK_IDS.length) {
    throw new Error(`results is required and must contain 1-${RELEASE_CHECK_IDS.length} checklist records`);
  }
  const seen = new Set();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("each result must be an object");
    if (typeof raw.id !== "string" || !RELEASE_CHECK_ID_SET.has(raw.id)) throw new Error(`unknown checklist id: ${raw.id}`);
    if (seen.has(raw.id)) throw new Error(`duplicate checklist id: ${raw.id}`);
    if (!new Set(["pass", "fail", "not-applicable"]).has(raw.status)) {
      throw new Error('result status must be "pass", "fail", or "not-applicable"');
    }
    if (typeof raw.evidence !== "string" || raw.evidence.length > 500) {
      throw new Error("result evidence must be a string of at most 500 characters");
    }
    seen.add(raw.id);
    return { id: raw.id, status: raw.status, evidence: raw.evidence };
  });
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
  if (name === "fabler_audit_diff_security") {
    const diff = requireNonEmptyText(args.diff, "diff");
    return JSON.stringify(
      await callApi("/audit/diff-security", { method: "POST", body: { diff } }),
      null,
      2,
    );
  }
  if (name === "fabler_audit_pre_deploy") {
    const results = requireReleaseResults(args.results);
    return JSON.stringify(
      await callApi("/audit/pre-deploy", { method: "POST", body: { results } }),
      null,
      2,
    );
  }
  if (name === "fabler_audit_url_security") {
    const url = requirePublicHttpsUrl(args.url);
    return JSON.stringify(
      await callApi("/audit/url-security", { method: "POST", body: { url } }),
      null,
      2,
    );
  }
  if (name === "fabler_scrape_web_page") {
    const url = requirePublicHttpsUrl(args.url);
    return JSON.stringify(
      await callApi(`/scrape?url=${encodeURIComponent(url)}`, { method: "GET" }),
      null,
      2,
    );
  }
  if (name === "fabler_render_og") {
    const title = requireNonEmptyText(args.title, "title");
    const body = { title };
    if (typeof args.subtitle === "string" && args.subtitle) body.subtitle = args.subtitle;
    if (args.theme === "light" || args.theme === "dark") body.theme = args.theme;
    return JSON.stringify(await callApi("/render/og", { method: "POST", body, binary: true }), null, 2);
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

module.exports = {
  TOOLS,
  SERVER_INFO,
  DEFAULT_PROTOCOL_VERSION,
  callApi,
  callTool,
  dispatch,
  decodePaymentRequiredHeader,
};
