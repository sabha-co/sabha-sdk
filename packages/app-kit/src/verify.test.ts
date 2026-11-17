import { describe, expect, it } from "vitest";
import { sign, verify } from "./verify.js";

const secret = "whsec_test_secret";
const body = '{"event":"message_created"}';
const now = Date.parse("2026-11-16T09:00:00Z");
const ts = Math.floor(now / 1000);

describe("verify", () => {
  it("accepts a correctly signed, fresh delivery", async () => {
    expect(await verify(secret, { timestamp: String(ts), signature: await sign(secret, ts, body) }, body, now)).toEqual({ ok: true });
  });

  it("refuses a wrong secret, a tampered body, a missing header or a malformed signature", async () => {
    const good = await sign(secret, ts, body);
    expect(await verify(secret, { timestamp: String(ts), signature: await sign("other", ts, body) }, body, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify(secret, { timestamp: String(ts), signature: good }, body + " ", now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify(secret, { timestamp: null, signature: good }, body, now)).toEqual({ ok: false, reason: "missing_headers" });
    expect(await verify(secret, { timestamp: String(ts), signature: good.replace("sha256=", "sha1=") }, body, now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify(secret, { timestamp: String(ts), signature: "sha256=zz" }, body, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses timestamps more than 300 s off in either direction", async () => {
    for (const offset of [-301, 301]) {
      const at = ts + offset;
      expect(await verify(secret, { timestamp: String(at), signature: await sign(secret, at, body) }, body, now)).toEqual({ ok: false, reason: "stale" });
    }
    const recent = ts - 299;
    expect(await verify(secret, { timestamp: String(recent), signature: await sign(secret, recent, body) }, body, now)).toEqual({ ok: true });
  });
});
