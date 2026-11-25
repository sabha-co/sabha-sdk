import { describe, expect, it } from "vitest";
import { SabhaClient } from "../client.js";
import { verify } from "../verify.js";
import { FakeSabha } from "./fake-sabha.js";
import { messageEvent } from "./fixtures.js";
import { signedDelivery } from "./sign.js";

describe("signedDelivery", () => {
  it("signs as Sabha does, and can be made stale", async () => {
    const fresh = await signedDelivery({ secret: "s3cret", payload: messageEvent() });
    const headers = (request: Request) => ({ timestamp: request.headers.get("X-Sabha-Timestamp"), signature: request.headers.get("X-Sabha-Signature") });
    expect(await verify("s3cret", headers(fresh), await fresh.text())).toEqual({ ok: true });
    const stale = await signedDelivery({ secret: "s3cret", payload: messageEvent(), at: Date.now() - 400_000 });
    expect(await verify("s3cret", headers(stale), await stale.text())).toEqual({ ok: false, reason: "stale" });
  });
});

describe("FakeSabha", () => {
  const sabha = () => new FakeSabha().app("key_one_123", { id: 1, name: "One" }).app("key_two_123", { id: 2, name: "Two" });
  const client = (fake: FakeSabha, key: string) => new SabhaClient({ baseUrl: "https://sabha.test", apiKey: key, fetch: fake.fetch });

  it("answers a repeated client_message_id with the first post, even after a delete", async () => {
    const fake = sabha();
    const one = client(fake, "key_one_123");
    const first = await one.post(10, { body: "Hi", clientMessageId: "id-1" });
    await one.deleteMessage(first.id);
    const again = await one.post(10, { body: "Hi", clientMessageId: "id-1" });
    expect(first.repeated).toBe(false);
    expect(again).toEqual({ ...first, repeated: true });
    expect(fake.messages).toHaveLength(1);
  });

  it("refuses another app's client_message_id with 422", async () => {
    const fake = sabha();
    await client(fake, "key_one_123").post(10, { body: "Hi", clientMessageId: "id-1" });
    await expect(client(fake, "key_two_123").post(10, { body: "Hi", clientMessageId: "id-1" })).rejects.toMatchObject({ status: 422 });
  });

  it("pages a 450-reply thread in pages of 200, 200 and 50", async () => {
    const fake = sabha();
    const one = client(fake, "key_one_123");
    const prompt = await one.post(10, "Standup");
    for (let i = 0; i < 450; i++) await one.post(10, { body: `reply ${i}`, parentMessageId: prompt.id });
    const threadChannel = (await one.message(prompt.id)).replies!.channel_id;
    const sizes: number[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await one.messages(threadChannel, { limit: 200, ...(before ? { before } : {}) });
      sizes.push(page.results.length);
      if (!page.has_more) break;
      before = page.next_cursor!;
    }
    expect(sizes).toEqual([200, 200, 50]);
  });
});
