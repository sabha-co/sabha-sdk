import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type AppOptions } from "./app.js";
import type { SabhaEnv } from "./context.js";
import { RetryLater } from "./errors.js";
import type { Logger } from "./log.js";
import { FakeSabha } from "./testing/fake-sabha.js";
import { blockActionsEvent, commandEvent, messageEvent, reactionEvent } from "./testing/fixtures.js";
import { signedDelivery } from "./testing/sign.js";
import { handleWebhook } from "./webhook.js";

const env: SabhaEnv = {
  SABHA_BASE_URL: "https://sabha.test",
  SABHA_API_KEY: "sabha_app_test_key_1234",
  SABHA_SIGNING_SECRET: "whsec_test_secret",
};

function setup(options: AppOptions = {}, permissions?: string[]) {
  const sabha = new FakeSabha().app(env.SABHA_API_KEY, { id: 99, name: "Helper", ...(permissions ? { permissions } : {}) });
  const logs: { level: string; message: string; fields?: unknown }[] = [];
  const logger: Logger = {
    info: (message, fields) => logs.push({ level: "info", message, fields }),
    warn: (message, fields) => logs.push({ level: "warn", message, fields }),
    error: (message, fields) => logs.push({ level: "error", message, fields }),
  };
  const app = new App({ fetch: sabha.fetch, logger, ...options });
  const pending: Promise<unknown>[] = [];
  const deliver = async (payload: Parameters<typeof signedDelivery>[0]["payload"], extra: Partial<Parameters<typeof signedDelivery>[0]> = {}, overrides: Partial<SabhaEnv> = {}) => {
    const request = await signedDelivery({ secret: env.SABHA_SIGNING_SECRET!, payload, ...extra });
    const response = await handleWebhook(app, request, { env: { ...env, ...overrides }, waitUntil: (promise) => pending.push(promise) });
    return { status: response.status, type: response.headers.get("Content-Type"), body: await response.text() };
  };
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  return { app, sabha, logs, deliver, settle };
}

const posts = (sabha: FakeSabha) => sabha.calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages"));

afterEach(() => vi.useRealTimers());

describe("handleWebhook: verification", () => {
  it("answers 401 and runs nothing for a delivery over 300 s old", async () => {
    const { app, deliver } = setup();
    const handler = vi.fn();
    app.mention(handler);
    const result = await deliver(messageEvent(), { at: Date.now() - 301_000 });
    expect(result.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 401 for a delivery signed with another secret", async () => {
    const { app, deliver } = setup();
    const handler = vi.fn();
    app.mention(handler);
    expect((await deliver(messageEvent(), { secret: "not-the-secret" })).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers 500 when the signing secret isn't set, so the cause is visible", async () => {
    const { deliver, logs } = setup();
    expect((await deliver(messageEvent(), {}, { SABHA_SIGNING_SECRET: "" })).status).toBe(500);
    expect(logs.some((log) => log.level === "error" && log.message.includes("SABHA_SIGNING_SECRET"))).toBe(true);
  });

  it("answers 200 and drops the event in socket mode", async () => {
    const { app, deliver } = setup();
    const handler = vi.fn();
    app.mention(handler);
    expect((await deliver(messageEvent(), {}, { TRANSPORT: "socket" })).status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("handleWebhook: routing", () => {
  it("runs mention handlers for the app's name, not for @everyone alone", async () => {
    const { app, deliver } = setup();
    const handler = vi.fn();
    app.mention(handler);
    await deliver(messageEvent({ mentions_app: false, message: { id: 1 } }));
    expect(handler).not.toHaveBeenCalled();
    await deliver(messageEvent({ message: { id: 2 } }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("routes message handlers by place, keeping forum post replies out of threads", async () => {
    const { app, deliver } = setup();
    const inThread = vi.fn();
    app.message({ in: "thread" }, inThread);
    const room = messageEvent().room;
    await deliver(messageEvent({ room: { ...room, type: "Post" }, message: { id: 3 } }));
    expect(inThread).not.toHaveBeenCalled();
    await deliver(messageEvent({ room: { ...room, type: "Thread" }, message: { id: 4 } }));
    expect(inThread).toHaveBeenCalledOnce();
  });

  it("matches commands by name and answers 200 when nothing matches", async () => {
    const { app, deliver } = setup();
    const handler = vi.fn(() => "ok");
    app.command("/ticket", handler);
    const result = await deliver(commandEvent({ command: "/other" }));
    expect(result.status).toBe(200);
    expect(result.body).toBe("");
    expect(handler).not.toHaveBeenCalled();
  });

  it("treats any app's message as its own while its own id can't be read", async () => {
    const { app, deliver } = setup();
    const handler = vi.fn();
    app.message(handler);
    const unreadable = { SABHA_API_KEY: "sabha_app_unknown_key" };
    await deliver(messageEvent({ message: { id: 31 }, user: { id: 50, name: "Other bot", role: "bot", url: "" } }), {}, unreadable);
    expect(handler).not.toHaveBeenCalled();
    await deliver(messageEvent({ message: { id: 32 } }), {}, unreadable);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("never answers the app's own messages", async () => {
    const { app, deliver } = setup();
    const handler = vi.fn();
    app.message(handler);
    await deliver(messageEvent({ user: { id: 99, name: "Helper", role: "bot", url: "" } }));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("handleWebhook: answers", () => {
  it("answers a mention inline with text/plain when the key can post and the handler returns text in time", async () => {
    const { app, deliver, sabha } = setup();
    app.mention(({ user }) => `Hi ${user.name}`);
    const result = await deliver(messageEvent());
    expect(result).toMatchObject({ status: 200, body: "Hi Asha" });
    expect(result.type).toContain("text/plain");
    expect(posts(sabha)).toHaveLength(0);
  });

  it("never answers a message with JSON: a reply with blocks is posted instead", async () => {
    const { app, deliver, sabha, settle } = setup();
    app.mention(() => ({ text: "Look", blocks: [{ type: "divider" }] }));
    const result = await deliver(messageEvent());
    await settle();
    expect(result).toMatchObject({ status: 200, body: "" });
    expect(result.type).toContain("text/plain");
    expect(posts(sabha)).toHaveLength(1);
    expect(posts(sabha)[0]!.body).toMatchObject({ text: "Look", blocks: [{ type: "divider" }] });
  });

  it("without inline replies, answers at once and posts the return value", async () => {
    const { app, deliver, sabha, settle } = setup({ inlineReplies: false });
    app.mention(() => "Hello");
    const result = await deliver(messageEvent());
    await settle();
    expect(result.body).toBe("");
    expect(posts(sabha)).toHaveLength(1);
  });

  it("posts an object return through say even with inline replies, so it renders the same however quick", async () => {
    const { app, deliver, sabha, settle } = setup();
    app.mention(() => ({ text: "Deployed <https://ci.test/1|build 1>" }));
    const result = await deliver(messageEvent());
    await settle();
    expect(result.body).toBe("");
    expect(posts(sabha)[0]!.body).toMatchObject({ text: "Deployed <https://ci.test/1|build 1>" });
  });

  it("accepts a message at once when the key can't post, keeping its handler alive past the response", async () => {
    const { app, deliver, settle } = setup({}, ["read_messages"]);
    let finished = false;
    app.message(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
    });
    const result = await deliver(messageEvent());
    expect(result).toMatchObject({ status: 200, body: "" });
    expect(finished).toBe(false);
    await settle();
    expect(finished).toBe(true);
  });

  it("follows the delivery's X-Sabha-Timeout over the key's permissions: a 30 s wait means no inline reply", async () => {
    const { app, deliver, sabha, settle } = setup();
    app.mention(() => "On it");
    expect((await deliver(messageEvent({ message: { id: 51 } }), { timeout: 30 })).body).toBe("");
    await settle();
    expect(posts(sabha)).toHaveLength(1);
    expect((await deliver(messageEvent({ message: { id: 52 } }), { timeout: 300 })).body).toBe("On it");
  });

  it("ends a command's window before Sabha stops waiting, when X-Sabha-Timeout says it's nearly out", async () => {
    const { app, deliver, sabha, settle } = setup();
    app.command("/ticket", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return "Filed";
    });
    const started = Date.now();
    const result = await deliver(commandEvent({ id: "cmd-late" }), { timeout: 2 });
    expect(Date.now() - started).toBeLessThan(900);
    expect(result.body).toBe("");
    await settle();
    expect(sabha.calls.find((call) => call.path === "/api/v1/interaction_responses")?.body).toEqual({ text: "Filed" });
  });

  it("reads the key's permissions again after a few minutes, so an admin's change reaches it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { app, deliver, sabha, settle } = setup();
    app.mention(() => "On it");
    expect((await deliver(messageEvent({ message: { id: 41 } }))).body).toBe("On it");

    sabha.app(env.SABHA_API_KEY, { id: 99, name: "Helper", permissions: ["read_messages"] });
    expect((await deliver(messageEvent({ message: { id: 42 } }))).body).toBe("On it"); // still the profile it read

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    expect((await deliver(messageEvent({ message: { id: 43 } }))).body).toBe("");
    await settle();
    expect(sabha.calls.filter((call) => call.path === "/api/v1/me")).toHaveLength(2);
  });

  it("answers a command from its quick handler while a slow sibling is still running", async () => {
    const { app, deliver, sabha, settle } = setup({ commandWindowMs: 50 });
    app.command("/deploy", () => "Deploying…");
    app.event("command", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    const started = Date.now();
    const result = await deliver(commandEvent({ command: "/deploy" }));
    expect(Date.now() - started).toBeLessThan(150);
    expect(JSON.parse(result.body)).toEqual({ text: "Deploying…" });
    await settle();
    expect(sabha.calls.filter((call) => call.path === "/api/v1/interaction_responses")).toHaveLength(0);
  });

  it("answers a command inline with JSON within its window", async () => {
    const { app, deliver } = setup();
    app.command("/ticket", ({ command }) => ({ text: `Filed: ${command.text}` }));
    const result = await deliver(commandEvent());
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ text: "Filed: printer is on fire" });
  });

  it("answers a slow command empty, then sends its result to response_url without the key", async () => {
    const { app, deliver, sabha, settle } = setup({ commandWindowMs: 20 });
    app.command("/ticket", async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "Done";
    });
    const result = await deliver(commandEvent());
    expect(result).toMatchObject({ status: 200, body: "" });
    await settle();
    const respond = sabha.calls.find((call) => call.path === "/api/v1/interaction_responses");
    expect(respond?.body).toEqual({ text: "Done" });
    expect(respond?.authorization).toBeNull();
  });

  it("waits for other events within the accept window, and runs them to completion", async () => {
    const { app, deliver } = setup();
    const done = vi.fn();
    app.event("message_updated", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      done();
    });
    const result = await deliver(messageEvent({ event: "message_updated" }));
    expect(result.status).toBe(200);
    expect(done).toHaveBeenCalledOnce();
  });

  it("answers 200 when a handler throws, and logs the error without secrets", async () => {
    const { app, deliver, logs } = setup();
    app.mention(() => {
      throw new Error(`boom with ${env.SABHA_API_KEY}`);
    });
    expect((await deliver(messageEvent())).status).toBe(200);
    const logged = logs.find((log) => log.level === "error");
    expect(JSON.stringify(logged)).not.toContain(env.SABHA_API_KEY);
    expect(JSON.stringify(logged)).not.toContain("@app hello");
  });
});

describe("handleWebhook: retries and repeats", () => {
  it("answers 503 for RetryLater on an event Sabha retries, and runs the redelivery", async () => {
    const { app, deliver } = setup();
    let calls = 0;
    app.event("message_updated", () => {
      calls++;
      if (calls === 1) throw new RetryLater();
    });
    expect((await deliver(messageEvent({ event: "message_updated" }))).status).toBe(503);
    expect((await deliver(messageEvent({ event: "message_updated" }))).status).toBe(200);
    expect(calls).toBe(2);
  });

  it("answers 200 for RetryLater on a mention or command, which Sabha never retries", async () => {
    const { app, deliver, logs } = setup();
    app.mention(() => {
      throw new RetryLater();
    });
    app.command("/ticket", () => {
      throw new RetryLater();
    });
    expect((await deliver(messageEvent())).status).toBe(200);
    expect((await deliver(commandEvent())).status).toBe(200);
    expect(logs.filter((log) => log.message.startsWith("RetryLater ignored"))).toHaveLength(2);
  });

  it("runs a redelivered message once, though each retry has a new delivery id", async () => {
    const { app, deliver } = setup();
    const handler = vi.fn();
    app.mention(handler);
    await deliver(messageEvent(), { deliveryId: "d1" });
    await deliver(messageEvent(), { deliveryId: "d2" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("gives say calls stable ids: different within a handler, the same on a redelivery", async () => {
    const first = setup();
    first.app.mention(async ({ say }) => {
      await say("one");
      await say("two");
    });
    await first.deliver(messageEvent());
    await first.settle();
    const ids = posts(first.sabha).map((call) => (call.body as { client_message_id: string }).client_message_id);
    expect(new Set(ids).size).toBe(2);

    // A fresh isolate (no memory of the first delivery) sending the same event again.
    const second = setup();
    second.app.mention(async ({ say }) => {
      await say("one");
      await say("two");
    });
    await second.deliver(messageEvent());
    await second.settle();
    expect(posts(second.sabha).map((call) => (call.body as { client_message_id: string }).client_message_id)).toEqual(ids);
  });

  it("gives two handlers matching one event different say ids", async () => {
    const { app, deliver, sabha } = setup();
    app.mention(({ say }) => void say("from mention"));
    app.message(({ say }) => void say("from message"));
    await deliver(messageEvent());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ids = posts(sabha).map((call) => (call.body as { client_message_id: string }).client_message_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe("context helpers", () => {
  it("say posts in the event's room, or its thread when asked", async () => {
    const { app, deliver, sabha, settle } = setup();
    app.mention(async ({ say }) => {
      await say({ body: "in the room" });
      await say({ body: "in the thread", thread: true });
    });
    await deliver(messageEvent());
    await settle();
    expect(posts(sabha).map((call) => call.path)).toEqual(["/api/v1/rooms/10/messages", "/api/v1/rooms/10/messages"]);
    expect(posts(sabha)[1]!.body).toMatchObject({ parent_message_id: 501 });
  });

  it("respond on a click answers through response_url", async () => {
    const { app, deliver, sabha } = setup();
    app.action("approve", async ({ action, respond }) => {
      await respond({ text: `Approved ${action.value}`, replace_original: true });
    });
    await deliver(blockActionsEvent());
    expect(sabha.calls.find((call) => call.path === "/api/v1/interaction_responses")?.body).toEqual({ text: "Approved deploy-42", replace_original: true });
  });

  it("a draft opens, updates and finishes as a post carrying the draft's id", async () => {
    const { app, deliver, sabha, settle } = setup();
    app.mention(async ({ draft, status }) => {
      await status("Thinking…");
      const reply = await draft();
      await reply.update({ text: "Partial" });
      await reply.finish("Partial answer, done");
    });
    await deliver(messageEvent());
    await settle();
    const opened = sabha.calls.find((call) => call.path === "/api/v1/rooms/10/drafts")!.body as { draft_id: string };
    expect(posts(sabha)[0]!.body).toMatchObject({ client_message_id: opened.draft_id });
    expect(sabha.calls.some((call) => call.path === "/api/v1/rooms/10/status" && call.method === "PUT")).toBe(true);
  });

  it("reaction handlers can filter by emoji", async () => {
    const { app, deliver } = setup();
    const thumbs = vi.fn();
    app.reaction({ emoji: "🎉" }, thumbs);
    await deliver(reactionEvent());
    expect(thumbs).not.toHaveBeenCalled();
    await deliver(reactionEvent({ reaction: { id: 78, body: "🎉" } }));
    expect(thumbs).toHaveBeenCalledOnce();
  });
});
