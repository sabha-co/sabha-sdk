import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { createWorker } from "@sabha-co/sdk/cloudflare";
import { FakeSabha, messageEvent, signedDelivery, type FakeMessage } from "@sabha-co/sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStandup, type StandupEnv } from "../src/app.js";

const KEY = "sabha_app_standup_test";
const SECRET = "whsec_standup_test";
const APP = { id: 99, name: "Standup" };
const ASHA = { id: 7, name: "Asha" };
const BEN = { id: 8, name: "Ben" };
const CHEN = { id: 9, name: "Chen" };
const ROOM = 10;
// R18: the standup reads its profile, posts, reacts, and reads messages; nothing else.
const ALLOWED = [
  /^GET \/api\/v1\/me$/,
  /^POST \/api\/v1\/rooms\/\d+\/messages$/,
  /^GET \/api\/v1\/rooms\/\d+\/messages$/,
  /^POST \/api\/v1\/messages\/\d+\/reactions$/,
];

const standupEnv: StandupEnv = {
  ...env,
  SABHA_BASE_URL: "https://sabha.test",
  SABHA_API_KEY: KEY,
  SABHA_SIGNING_SECRET: SECRET,
  TRANSPORT: "webhook",
  STANDUP_ROOM_ID: String(ROOM),
  STANDUP_TIMEZONE: "Europe/London",
  STANDUP_DAYS: "mon-fri",
  STANDUP_PROMPT_AT: "09:00",
  STANDUP_DIGEST_AT: "17:00",
};

let fakes: FakeSabha[] = [];

function setup(overrides: Partial<StandupEnv> = {}) {
  const sabha = new FakeSabha().app(KEY, APP);
  fakes.push(sabha);
  const errors: string[] = [];
  const app = createStandup({ fetch: sabha.fetch, logger: { info() {}, warn() {}, error: (message) => void errors.push(message) } });
  const worker = createWorker(app);
  const tick = async (iso: string) => {
    const at = Date.parse(iso);
    sabha.setNow(at);
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: at }), { ...standupEnv, ...overrides }, ctx);
    await waitOnExecutionContext(ctx);
  };
  // Sabha's webhook delivery of a reply in a thread, as the room it sits in sees it.
  const deliver = async (reply: FakeMessage) => {
    const parent = sabha.messages.find((message) => message.id === reply.parent_message_id)!;
    const payload = messageEvent({
      mentions_app: false,
      room: { id: reply.room_id, name: null, type: "Thread", has_app: true, members: 5, messages_url: `https://sabha.test/api/v1/rooms/${reply.room_id}/messages` },
      user: { ...reply.creator, role: "member", url: `https://sabha.test/users/${reply.creator.id}` },
      message: { id: reply.id, created_at: reply.created_at, thread: { id: reply.room_id, parent_message_id: parent.id, parent_room_id: parent.room_id } },
    });
    const ctx = createExecutionContext();
    const request = (await signedDelivery({ secret: SECRET, payload })) as Parameters<NonNullable<typeof worker.fetch>>[0];
    const response = await worker.fetch!(request, { ...standupEnv, ...overrides }, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
  };
  const posts = () => sabha.visible(ROOM).filter((message) => message.creator.id === APP.id);
  const prompt = () => posts()[0]!;
  const digest = () => posts().find((message) => message.body.includes("Read the thread"));
  return { sabha, tick, deliver, posts, prompt, digest, errors };
}

afterEach(() => {
  for (const sabha of fakes) {
    for (const call of sabha.calls) expect(ALLOWED.some((allowed) => allowed.test(`${call.method} ${call.path}`)), `${call.method} ${call.path}`).toBe(true);
  }
  fakes = [];
});

describe("the prompt", () => {
  it("posts once a day however often the tick fires in its window (AE1)", async () => {
    const { tick, posts } = setup();
    await tick("2026-11-16T09:00:00Z");
    await tick("2026-11-16T09:00:00Z");
    for (let minute = 1; minute <= 11; minute++) await tick(`2026-11-16T09:${String(minute).padStart(2, "0")}:00Z`);
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toContain("I'll post a digest here at 17:00.");
  });

  it("asks at 09:00 local on both sides of the clocks changing (AE4)", async () => {
    const { tick, posts } = setup();
    await tick("2026-03-27T08:00:00Z");
    expect(posts()).toHaveLength(0);
    await tick("2026-03-27T09:00:00Z");
    expect(posts()).toHaveLength(1);
    await tick("2026-03-30T08:00:00Z");
    expect(posts()).toHaveLength(2);
  });

  it("skips the weekend", async () => {
    const { tick, posts } = setup();
    await tick("2026-11-14T09:00:00Z");
    expect(posts()).toHaveLength(0);
  });
});

describe("the digest", () => {
  it("finds a prompt asked in the hour the clocks repeat", async () => {
    const { tick, digest } = setup({ STANDUP_DAYS: "daily", STANDUP_PROMPT_AT: "01:30" });
    await tick("2026-10-25T00:30:00Z"); // the first 01:30, still BST
    await tick("2026-10-25T17:00:00Z");
    expect(digest()).toBeDefined();
  });

  it("posts once, even when the tick fires twice", async () => {
    const { tick, posts } = setup();
    await tick("2026-11-16T09:00:00Z");
    await tick("2026-11-16T17:00:00Z");
    await tick("2026-11-16T17:01:00Z");
    expect(posts()).toHaveLength(2);
  });

  it("says no one posted an update when the thread is empty (AE2)", async () => {
    const { tick, digest } = setup();
    await tick("2026-11-16T09:00:00Z");
    await tick("2026-11-16T17:00:00Z");
    expect(digest()!.body).toContain("No one posted an update today.");
  });

  it("shows a reply as edited before the digest (AE3)", async () => {
    const { sabha, tick, prompt, digest } = setup();
    await tick("2026-11-16T09:00:00Z");
    const reply = sabha.reply(prompt().id, { body: "Shipping the thing", creator: ASHA });
    sabha.edit(reply.id, "Shipped the thing");
    await tick("2026-11-16T17:00:00Z");
    expect(digest()!.body).toContain("“Shipped the thing”");
    expect(digest()!.body).not.toContain("Shipping");
  });

  it("gives one line per person in the order they replied, without the app's own", async () => {
    const { sabha, tick, prompt, digest } = setup();
    await tick("2026-11-16T09:00:00Z");
    sabha.reply(prompt().id, { body: "Ben first", creator: BEN });
    sabha.reply(prompt().id, { body: "Asha one", creator: ASHA });
    sabha.reply(prompt().id, { body: "Reminder: digest at five", creator: APP });
    sabha.reply(prompt().id, { body: "Chen here", creator: CHEN });
    sabha.reply(prompt().id, { body: "Asha two", creator: ASHA });
    await tick("2026-11-16T17:00:00Z");
    const body = digest()!.body;
    expect(body).toContain("<strong>Ben</strong>: “Ben first”<br><strong>Asha</strong>: “Asha one” “Asha two”<br><strong>Chen</strong>: “Chen here”");
    expect(body).not.toContain("Reminder");
    expect(body).toContain(`href="https://sabha.test/messages/${prompt().id}"`);
  });

  it("reads every page of a long thread", async () => {
    const { sabha, tick, prompt, digest } = setup();
    await tick("2026-11-16T09:00:00Z");
    for (let n = 1; n <= 205; n++) sabha.reply(prompt().id, { body: `note ${n}`, creator: n % 2 ? ASHA : BEN });
    await tick("2026-11-16T17:00:00Z");
    expect(digest()!.body).toContain("“note 1”");
    expect(digest()!.body).toContain("“note 205”");
  });

  it("quotes a reply's mention and link as text that neither notifies nor links", async () => {
    const { sabha, tick, prompt, digest } = setup();
    await tick("2026-11-16T09:00:00Z");
    sabha.reply(prompt().id, { body: "cc @{8}, see https://evil.test and <a href=x>this</a>", creator: ASHA });
    await tick("2026-11-16T17:00:00Z");
    const quoted = digest()!.body.split("<strong>Asha</strong>")[1]!;
    expect(quoted).not.toMatch(/@\{|https?:\/\/|<a /);
  });

  it("isn't posted when no prompt went out today, even with yesterday's in the room", async () => {
    const { sabha, tick, posts } = setup();
    sabha.seed({ room_id: ROOM, body: "Yesterday's prompt", creator: APP, at: Date.parse("2026-11-13T09:00:00Z") });
    await tick("2026-11-16T17:00:00Z");
    expect(posts()).toHaveLength(1);
  });

  it("isn't posted when today's prompt was deleted, and the run doesn't fail", async () => {
    const { sabha, tick, prompt, posts, errors } = setup();
    await tick("2026-11-16T09:00:00Z");
    sabha.remove(prompt().id);
    await tick("2026-11-16T17:00:00Z");
    expect(posts()).toHaveLength(0);
    expect(errors).toEqual([]);
  });
});

describe("a reply", () => {
  it("gets a ✅ in today's prompt's thread", async () => {
    const { sabha, tick, deliver, prompt } = setup();
    await tick("2026-11-16T09:00:00Z");
    const reply = sabha.reply(prompt().id, { body: "Fixed the flaky test", creator: ASHA });
    await deliver(reply);
    expect(reply.reactions?.map((reaction) => reaction.content)).toEqual(["✅"]);
  });

  it("gets nothing under yesterday's prompt, or once the digest is out", async () => {
    const { sabha, tick, deliver, prompt, posts } = setup();
    await tick("2026-11-13T09:00:00Z");
    const yesterdays = prompt();
    await tick("2026-11-16T09:00:00Z");
    await tick("2026-11-16T17:00:00Z");
    const late = sabha.reply(posts()[1]!.id, { body: "Sorry, late", creator: BEN });
    const stale = sabha.reply(yesterdays.id, { body: "Wrong thread", creator: CHEN });
    await deliver(late);
    await deliver(stale);
    expect(late.reactions).toBeUndefined();
    expect(stale.reactions).toBeUndefined();
  });
});
