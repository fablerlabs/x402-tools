// x402-codec.mjs — base64<->JSON helpers for the X-PAYMENT / X-PAYMENT-RESPONSE
// headers, shared by buyer.mjs and fixture-worker.mjs. Uses only Web-standard
// globals (TextEncoder/TextDecoder/btoa/atob) so it runs unchanged under Node
// and inside a real Cloudflare Worker (no `Buffer`).

export function encodeB64Json(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function decodeB64Json(b64) {
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
