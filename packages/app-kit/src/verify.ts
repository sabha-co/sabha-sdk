/** How far a delivery's timestamp may be from now, either way, before it's refused. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | undefined {
  if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** The `X-Sabha-Signature` value for a body sent at `timestamp` (UNIX seconds). */
export async function sign(secret: string, timestamp: number | string, body: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(`${timestamp}.${body}`));
  return `sha256=${Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type Verdict = { ok: true } | { ok: false; reason: "missing_headers" | "stale" | "bad_signature" };

/**
 * Checks a delivery as APPS.md §4 specifies: HMAC-SHA256 of "{timestamp}.{raw body}" with the
 * app's signing secret, and a timestamp within five minutes either way. The comparison is
 * `crypto.subtle.verify`, which is constant-time.
 */
export async function verify(
  secret: string,
  headers: { timestamp: string | null; signature: string | null },
  body: string,
  now: number = Date.now(),
): Promise<Verdict> {
  const { timestamp, signature } = headers;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };
  const seconds = Number(timestamp);
  if (!Number.isInteger(seconds) || Math.abs(now / 1000 - seconds) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale" };
  }
  const expected = signature.startsWith("sha256=") ? hexToBytes(signature.slice(7)) : undefined;
  if (!expected) return { ok: false, reason: "bad_signature" };
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), expected, encoder.encode(`${timestamp}.${body}`));
  return valid ? { ok: true } : { ok: false, reason: "bad_signature" };
}
