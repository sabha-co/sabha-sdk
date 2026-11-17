const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keys.set(secret, key);
  }
  return key;
}

/**
 * A client message id that is the same every time for the same key, and unique to the app.
 * Sabha's `client_message_id` is unique across the whole workspace and another app's id is
 * refused, so it is keyed with the app's own secret: two apps answering one message never
 * collide, and no other app can predict it. Rotating the secret changes future ids.
 */
export async function stableId(secret: string, key: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(key)));
  const bytes = mac.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8: a custom UUID
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
