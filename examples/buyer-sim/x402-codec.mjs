// x402-codec.mjs — base64<->JSON helpers for the x402 protocol v2 payment headers
// (PAYMENT-REQUIRED on the 402 challenge, PAYMENT-SIGNATURE on the paid request,
// PAYMENT-RESPONSE on the settled 200), shared by buyer.mjs and fixture-worker.mjs.
//
// Byte-for-byte identical to @x402/core's safeBase64Encode/Decode (UTF-8 →
// per-byte binary string → btoa, and the inverse) — so a header this produces
// decodes in the real worker's library and vice-versa. Uses only Web-standard
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
