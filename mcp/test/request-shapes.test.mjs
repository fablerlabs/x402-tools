#!/usr/bin/env node
// Offline contract test: asserts each MCP tool sends the exact request shape
// the live x402 worker's OpenAPI spec (../../openapi.yaml) and route
// validators (../../src/limits.ts) require, and that the v2 payment-required
// challenge (base64-JSON header, not a v1 body challenge) is decoded
// correctly. Mocks global.fetch — no network, no env vars.
//
// Schemas asserted here (mirror ../../openapi.yaml components.schemas):
//   ScanSecretsRequest  required: [text]
//   AuditRequest        required: [content, kind]           (kind enum: "CLAUDE.md" | "constitution")
//   DiffSecurityRequest required: [diff]
//   PreDeployRequest   required: [results]
//   UrlSecurityRequest required: [url]
//   ScrapeRequest      required query: [url]
//   RenderOgRequest     required: [title]  optional: subtitle, theme
//   FundingSpreadsRequest required query: [] optional query: [symbol] (2-15 ASCII letters/digits, uppercased)
//   GET /                                  free catalog (not /products.json)
// Guards against regressing the 3 field/route bugs q142 found (fabler_list_products
// hit /products.json 404; fabler_audit_agent_config sent {text} not {content,kind};
// fabler_render_og sent {title,eyebrow,sub,kicker} not {title,subtitle,theme}) and
// the v1-body-challenge assumption q192 found (real challenge is a base64-JSON
// `payment-required` response header per src/x402guard.ts's @x402/hono v2 stack).

import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const tools = require("../tools.js");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok: ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok: ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

function b64json(obj) {
  return Buffer.from(JSON.stringify(obj), "utf-8").toString("base64");
}

// Records every fetch call and answers with a canned 200 JSON response unless
// a test overrides globalThis.fetch itself for 402-path assertions.
function installRecordingFetch(responseBody = { ok: true }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return calls;
}

await checkAsync("fabler_scan_secrets sends POST /scan/secrets {text}", async () => {
  const calls = installRecordingFetch();
  await tools.callTool("fabler_scan_secrets", { text: "hello" });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/scan/secrets");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["text"]);
  assert.equal(calls[0].body.text, "hello");
});

await checkAsync("fabler_audit_agent_config sends POST /audit/agent-config {content,kind} — not {text}", async () => {
  const calls = installRecordingFetch();
  await tools.callTool("fabler_audit_agent_config", { content: "# CLAUDE.md" });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/audit/agent-config");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["content", "kind"]);
  assert.equal(calls[0].body.content, "# CLAUDE.md");
  assert.ok(["CLAUDE.md", "constitution"].includes(calls[0].body.kind), "kind must be a valid AuditRequest enum value");
  assert.equal(calls[0].body.kind, "CLAUDE.md", "defaults to CLAUDE.md when not given");
  assert.equal(calls[0].body.text, undefined, "v1 remnant: must not send the old {text} field");
});

await checkAsync("fabler_audit_agent_config kind:constitution passes through", async () => {
  const calls = installRecordingFetch();
  await tools.callTool("fabler_audit_agent_config", { content: "# CONSTITUTION", kind: "constitution" });
  assert.equal(calls[0].body.kind, "constitution");
});

await checkAsync("fabler_audit_diff_security sends POST /audit/diff-security {diff}", async () => {
  const calls = installRecordingFetch();
  const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+export const ok = true;";
  await tools.callTool("fabler_audit_diff_security", { diff });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/audit/diff-security");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(Object.keys(calls[0].body), ["diff"]);
  assert.equal(calls[0].body.diff, diff);
});

await checkAsync("fabler_audit_pre_deploy sends POST /audit/pre-deploy {results}", async () => {
  const calls = installRecordingFetch();
  const results = [{ id: "secrets-scanned", status: "pass", evidence: "CI run 842" }];
  await tools.callTool("fabler_audit_pre_deploy", { results });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/audit/pre-deploy");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { results });
});

await checkAsync("fabler_audit_pre_deploy rejects duplicate ids before fetch", async () => {
  const calls = installRecordingFetch();
  const result = { id: "secrets-scanned", status: "pass", evidence: "CI run 842" };
  await assert.rejects(() => tools.callTool("fabler_audit_pre_deploy", { results: [result, result] }), /duplicate/);
  assert.equal(calls.length, 0);
});

await checkAsync("fabler_audit_url_security sends POST /audit/url-security {url}", async () => {
  const calls = installRecordingFetch();
  await tools.callTool("fabler_audit_url_security", { url: "https://Example.com/security?q=1" });
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/audit/url-security");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { url: "https://example.com/security?q=1" });
});

await checkAsync("fabler_audit_url_security rejects unsafe URLs before fetch", async () => {
  for (const url of [
    "http://example.com",
    "https://127.0.0.1/admin",
    "https://metadata.internal/latest",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://example.com/#fragment",
  ]) {
    const calls = installRecordingFetch();
    await assert.rejects(() => tools.callTool("fabler_audit_url_security", { url }));
    assert.equal(calls.length, 0, `unsafe URL must fail before fetch: ${url}`);
  }
});

await checkAsync("fabler_scrape_web_page sends GET /scrape with one encoded url query parameter", async () => {
  const calls = installRecordingFetch();
  await tools.callTool("fabler_scrape_web_page", { url: "https://Example.com/article?q=one two" });
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.pathname, "/scrape");
  assert.equal(requestUrl.searchParams.get("url"), "https://example.com/article?q=one%20two");
  assert.deepEqual([...requestUrl.searchParams.keys()], ["url"]);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
});

await checkAsync("fabler_scrape_web_page rejects unsafe URLs before payment or fetch", async () => {
  for (const url of ["http://example.com", "https://127.0.0.1/", "https://metadata.internal/"]) {
    const calls = installRecordingFetch();
    await assert.rejects(() => tools.callTool("fabler_scrape_web_page", { url }));
    assert.equal(calls.length, 0, `unsafe URL must fail before fetch: ${url}`);
  }
});

await checkAsync(
  "fabler_render_og sends POST /render/og {title,subtitle?,theme?} — not {eyebrow,sub,kicker}",
  async () => {
    const calls = installRecordingFetch();
    await tools.callTool("fabler_render_og", { title: "Hi", subtitle: "sub", theme: "light" });
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).pathname, "/render/og");
    assert.deepEqual(Object.keys(calls[0].body).sort(), ["subtitle", "theme", "title"]);
    assert.equal(calls[0].body.title, "Hi");
    assert.equal(calls[0].body.subtitle, "sub");
    assert.equal(calls[0].body.theme, "light");
    for (const v1Field of ["eyebrow", "sub", "kicker"]) {
      assert.equal(calls[0].body[v1Field], undefined, `v1 remnant: must not send the old {${v1Field}} field`);
    }
  },
);

await checkAsync("fabler_render_og omits optional fields when not given", async () => {
  const calls = installRecordingFetch();
  await tools.callTool("fabler_render_og", { title: "Hi" });
  assert.deepEqual(Object.keys(calls[0].body), ["title"]);
});

await checkAsync("fabler_list_products hits GET / (free) — not GET /products.json", async () => {
  const calls = installRecordingFetch({ api: { baseUrl: "https://x402.fablerlabs.com" } });
  await tools.callTool("fabler_list_products", {});
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
});

await checkAsync("fabler_market_funding_spreads sends GET /market/funding-spreads with no query params when symbol omitted", async () => {
  const calls = installRecordingFetch();
  await tools.callTool("fabler_market_funding_spreads", {});
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.pathname, "/market/funding-spreads");
  assert.deepEqual([...requestUrl.searchParams.keys()], []);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
});

await checkAsync("fabler_market_funding_spreads uppercase-normalizes a lowercase symbol before fetch", async () => {
  const calls = installRecordingFetch();
  await tools.callTool("fabler_market_funding_spreads", { symbol: "btc" });
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.pathname, "/market/funding-spreads");
  assert.equal(requestUrl.searchParams.get("symbol"), "BTC");
});

await checkAsync("fabler_market_funding_spreads sends exactly one encoded symbol query param and no body", async () => {
  const calls = installRecordingFetch();
  await tools.callTool("fabler_market_funding_spreads", { symbol: "ETH" });
  assert.equal(calls.length, 1);
  const requestUrl = new URL(calls[0].url);
  assert.deepEqual([...requestUrl.searchParams.keys()], ["symbol"]);
  assert.equal(requestUrl.searchParams.get("symbol"), "ETH");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
});

await checkAsync("fabler_market_funding_spreads rejects invalid symbols before fetch", async () => {
  const invalid = [
    null, // wrong type: null
    42, // wrong type: number
    ["BTC"], // wrong type: array
    { symbol: "BTC" }, // wrong type: object
    "B", // too short (1 char)
    "TOOLONGSYMBOL016", // too long (16 chars)
    "BTCUSDTPERPXXXXX", // too long (16 chars)
    "BT€", // Unicode look-alike / non-ASCII
    "ＢＴＣ", // fullwidth Unicode digits/letters
    "BT-C", // punctuation
    "BT C", // whitespace
    "", // empty string
  ];
  for (const symbol of invalid) {
    const calls = installRecordingFetch();
    await assert.rejects(
      () => tools.callTool("fabler_market_funding_spreads", { symbol }),
      `invalid symbol must be rejected before fetch: ${JSON.stringify(symbol)}`,
    );
    assert.equal(calls.length, 0, `invalid symbol must fail before fetch: ${JSON.stringify(symbol)}`);
  }
});

check("decodePaymentRequiredHeader decodes a v2 base64-JSON challenge", () => {
  const challenge = {
    x402Version: 2,
    resource: { url: "https://x402.fablerlabs.com/audit/agent-config" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "50000",
        asset: "USDC",
        payTo: "0x0000000000000000000000000000000000000000",
        maxTimeoutSeconds: 120,
      },
    ],
  };
  const res = new Response("{}", {
    status: 402,
    headers: { "Content-Type": "application/json", "payment-required": b64json(challenge) },
  });
  const decoded = tools.decodePaymentRequiredHeader(res);
  assert.deepEqual(decoded, challenge);
});

check("decodePaymentRequiredHeader returns null when the header is absent", () => {
  const res = new Response("{}", { status: 402 });
  assert.equal(tools.decodePaymentRequiredHeader(res), null);
});

await checkAsync("callApi surfaces the v2 header challenge, not the empty v2 body, on 402", async () => {
  const challenge = {
    x402Version: 2,
    resource: { url: "https://x402.fablerlabs.com/scan/secrets" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "5000",
        asset: "USDC",
        payTo: "0x0000000000000000000000000000000000000000",
        maxTimeoutSeconds: 120,
      },
    ],
  };
  globalThis.fetch = async () =>
    new Response("{}", {
      // real worker's v2 402 body is always `{}` — everything useful is in the header
      status: 402,
      headers: { "Content-Type": "application/json", "payment-required": b64json(challenge) },
    });
  const result = await tools.callApi("/scan/secrets", { method: "POST", body: { text: "x" } });
  assert.equal(result.paid, false);
  assert.equal(result.status, 402);
  assert.deepEqual(result.challenge, challenge);
  assert.equal(result.challenge.x402Version, 2, "must not silently report a v1 challenge shape");
});

await checkAsync("callApi falls back gracefully to the body when payment-required header is missing", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ some: "unexpected-body" }), { status: 402 });
  const result = await tools.callApi("/scan/secrets", { method: "POST", body: { text: "x" } });
  assert.equal(result.status, 402);
  assert.deepEqual(result.challenge, { some: "unexpected-body" });
});

if (failures > 0) {
  console.error(`FAIL: ${failures} request-shape check(s) failed`);
  process.exit(1);
}
console.log("PASS: request-shapes");
