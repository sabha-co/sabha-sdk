import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COVERED_OPERATIONS, SabhaClient } from "./client.js";
import { SabhaApiError } from "./errors.js";

const key = "sabha_app_secret_key_42";

function recorder(answers: (Response | Error)[] = []) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? Response.json({ id: 1, channel_id: 2 }, { status: 201 });
  };
  const waits: number[] = [];
  const client = new SabhaClient({ baseUrl: "https://sabha.test/", apiKey: key, fetch, sleep: async (ms) => void waits.push(ms) });
  return { client, calls, waits };
}

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe("SabhaClient", () => {
  it("covers every operation in the spec", () => {
    const spec = readFileSync(new URL("../spec/v1.yaml", import.meta.url), "utf8");
    const operationIds = [...spec.matchAll(/operationId: (\w+)/g)].map((match) => match[1]);
    expect(operationIds.filter((id) => !(id! in COVERED_OPERATIONS))).toEqual([]);
  });

  it("sends the key, the verb, the path and the body", async () => {
    const { client, calls } = recorder();
    await client.post(10, { body: "Hi", parentMessageId: 5, clientMessageId: "abc" });
    expect(calls[0]!.url).toBe("https://sabha.test/api/v1/channels/10/messages");
    expect(calls[0]!.init.method).toBe("POST");
    expect(header(calls[0]!.init, "Authorization")).toBe(`Bearer ${key}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ body: "Hi", parent_message_id: 5, client_message_id: "abc" });

    // Sabha reads a reaction's whole body as the emoji, so it goes as plain text, not JSON.
    await client.react(7, "✅");
    expect(calls[1]!.url).toBe("https://sabha.test/api/v1/messages/7/reactions");
    expect(header(calls[1]!.init, "Content-Type")).toMatch(/^text\/plain/);
    expect(calls[1]!.init.body).toBe("✅");
  });

  it("tells a first post from a repeat", async () => {
    const { client } = recorder([Response.json({ id: 1, channel_id: 2 }, { status: 201 }), Response.json({ id: 1, channel_id: 2 }, { status: 200 })]);
    expect(await client.post(2, { body: "x", clientMessageId: "id" })).toEqual({ id: 1, channel_id: 2, repeated: false });
    expect(await client.post(2, { body: "x", clientMessageId: "id" })).toEqual({ id: 1, channel_id: 2, repeated: true });
  });

  it("prefixes a SaaS workspace and derives its socket URL", async () => {
    const calls: string[] = [];
    const client = new SabhaClient({ baseUrl: "https://x.test/1000001", apiKey: key, fetch: async (url) => (calls.push(url), Response.json({})) });
    await client.me();
    expect(calls[0]).toBe("https://x.test/1000001/api/v1/me");
    expect(client.socketUrl).toBe("wss://x.test/cable?wid=1000001");
    expect(new SabhaClient({ baseUrl: "http://localhost:3000", apiKey: key }).socketUrl).toBe("ws://localhost:3000/cable");
    expect(new SabhaClient({ baseUrl: "https://x.test", apiKey: key, socketUrl: "wss://cable.x.test/cable" }).socketUrl).toBe("wss://cable.x.test/cable");
  });

  it("waits for Retry-After on a 429, then retries", async () => {
    const { client, calls, waits } = recorder([Response.json({ code: "rate_limited" }, { status: 429, headers: { "Retry-After": "2" } }), Response.json({ id: 9, name: "Bot" })]);
    expect(await client.me()).toEqual({ id: 9, name: "Bot" });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2_000]);
  });

  it("backs off on 503 workspace_offline and network errors, then gives up after three tries", async () => {
    const offline = () => Response.json({ code: "workspace_offline", error: "Offline" }, { status: 503 });
    const { client, calls } = recorder([offline(), new TypeError("fetch failed"), offline()]);
    const error = await client.me().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SabhaApiError);
    expect((error as SabhaApiError).code).toBe("workspace_offline");
    expect(calls).toHaveLength(3);
  });

  it("never repeats a POST without an id after a lost connection or a gateway error", async () => {
    const lost = recorder([new TypeError("fetch failed"), Response.json({})]);
    await expect(lost.client.react(5, "👍")).rejects.toThrow("fetch failed");
    expect(lost.calls).toHaveLength(1);

    const gateway = recorder([new Response("", { status: 502 }), Response.json({})]);
    await expect(gateway.client.react(5, "👍")).rejects.toBeInstanceOf(SabhaApiError);
    expect(gateway.calls).toHaveLength(1);

    const keyed = recorder([new TypeError("fetch failed"), Response.json({ id: 1, channel_id: 2 }, { status: 201 })]);
    await keyed.client.post(2, { body: "x", clientMessageId: "id" });
    expect(keyed.calls).toHaveLength(2);
  });

  it("abandons an attempt that never answers", async () => {
    const client = new SabhaClient({
      baseUrl: "https://sabha.test",
      apiKey: key,
      timeoutMs: 20,
      attempts: 1,
      fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    });
    await expect(client.me()).rejects.toThrow();
  });

  it("raises missing_permission with the permission needed, never with the key or body", async () => {
    const { client } = recorder([Response.json({ code: "missing_permission", error: "Needs dm", needed: "dm" }, { status: 403 })]);
    const error = (await client.openDm([1]).catch((caught: unknown) => caught)) as SabhaApiError;
    expect(error.status).toBe(403);
    expect(error.needed).toBe("dm");
    expect(String(error)).not.toContain(key);
    expect(String(error)).not.toContain("user_ids");
  });

  it("follows a same-origin redirect with the key, and a cross-origin one without it", async () => {
    const same = recorder([new Response(null, { status: 308, headers: { Location: "/api/v1/me?moved=1" } }), Response.json({ id: 1 })]);
    await same.client.me();
    expect(header(same.calls[1]!.init, "Authorization")).toBe(`Bearer ${key}`);

    const other = recorder([new Response(null, { status: 301, headers: { Location: "https://elsewhere.test/api/v1/me" } }), Response.json({ id: 1 })]);
    await other.client.me();
    expect(other.calls[1]!.url).toBe("https://elsewhere.test/api/v1/me");
    expect(header(other.calls[1]!.init, "Authorization")).toBeUndefined();
  });

  it("never sends the key to a full URL on another origin", async () => {
    const { client, calls } = recorder([Response.json({ ok: true }), Response.json({ ok: true })]);
    await client.call("POST", "https://elsewhere.test/hook");
    await client.call("GET", "https://sabha.test/api/v1/me");
    expect(header(calls[0]!.init, "Authorization")).toBeUndefined();
    expect(header(calls[1]!.init, "Authorization")).toBe(`Bearer ${key}`);
  });

  it("answers a response_url without the key, and never names the URL in errors", async () => {
    const url = "https://sabha.test/api/v1/interaction_responses?token=very-secret-token";
    const { client, calls } = recorder([Response.json({ code: "not_found" }, { status: 404 })]);
    const error = await client.respond(url, "Done").catch((caught: unknown) => caught);
    expect(header(calls[0]!.init, "Authorization")).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "Done" });
    expect(String(error)).not.toContain("very-secret-token");
  });

  it("pages through a channel's messages", async () => {
    const page = (ids: number[], next: string | null) => Response.json({ results: ids.map((id) => ({ id })), has_more: next !== null, next_cursor: next });
    const { client, calls } = recorder([page([3, 2], "c1"), page([1], null)]);
    const ids: number[] = [];
    for await (const message of client.allMessages(10)) ids.push(message.id);
    expect(ids).toEqual([3, 2, 1]);
    expect(calls[1]!.url).toBe("https://sabha.test/api/v1/channels/10/messages?limit=200&before=c1");
  });
});
