import { handleWebhook, type App, type SabhaEnv } from "@sabha-co/app-kit";
import { FakeSabha, blockActionsEvent, commandEvent, messageEvent, signedDelivery } from "@sabha-co/app-kit/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app as approvalCard } from "./approval-card.ts";
import { app as command } from "./command.ts";
import { app as mentionReply } from "./mention-reply.ts";
import { app as notifier } from "./notifier.ts";
import { app as streamingAgent } from "./streaming-agent.ts";

const env = { SABHA_BASE_URL: "https://sabha.test", SABHA_API_KEY: "sabha_app_examples", SABHA_SIGNING_SECRET: "whsec_examples" };

function fakeSabha() {
  const sabha = new FakeSabha().app(env.SABHA_API_KEY, { id: 99, name: "Example" });
  vi.stubGlobal("fetch", sabha.fetch);
  return sabha;
}

// Each example's app is shared across these tests and drops a repeated event, so every
// delivery here carries its own id.
async function deliver<Env extends SabhaEnv>(app: App<Env>, payload: Parameters<typeof signedDelivery>[0]["payload"], extra: Partial<Env> = {}) {
  const pending: Promise<unknown>[] = [];
  const response = await handleWebhook(app, await signedDelivery({ secret: env.SABHA_SIGNING_SECRET, payload }), {
    env: { ...env, ...extra } as Env,
    waitUntil: (promise) => void pending.push(promise),
  });
  while (pending.length) await pending.shift();
  return response;
}

const responseUrlCalls = (sabha: FakeSabha) => sabha.calls.filter((call) => call.path === "/api/v1/interaction_responses").map((call) => call.body);

afterEach(() => vi.unstubAllGlobals());

describe("mention-reply", () => {
  it("answers a mention inline with a greeting", async () => {
    fakeSabha();
    const response = await deliver(mentionReply, messageEvent());
    expect(await response.text()).toBe("Hi Asha! Ask me in a thread and I'll answer there.");
  });

  it("says pong to ping in a thread", async () => {
    const sabha = fakeSabha();
    const thread = { id: 900501, name: "thread", type: "Thread", has_app: true, members: 5, messages_url: "https://sabha.test/api/v1/rooms/900501/messages" };
    await deliver(mentionReply, messageEvent({ mentions_app: false, room: thread, message: { id: 502, body: { plain: "ping", html: "<p>ping</p>", markdown: "ping" } } }));
    expect(sabha.messages.map((message) => message.body)).toEqual(["pong"]);
  });
});

describe("command", () => {
  it("files a ticket and answers in the room", async () => {
    fakeSabha();
    const response = await deliver(command, commandEvent({ id: "cmd-ticket", text: "printer is on fire" }));
    expect(await response.json()).toEqual({ response_type: "in_channel", text: "Asha filed #1018: printer is on fire" });
  });

  it("explains its usage privately when given nothing", async () => {
    fakeSabha();
    const response = await deliver(command, commandEvent({ id: "cmd-usage", text: " " }));
    expect(await response.json()).toMatchObject({ response_type: "ephemeral" });
  });
});

describe("approval-card", () => {
  it("posts a card with Approve and Reject", async () => {
    fakeSabha();
    const response = await deliver(approvalCard, commandEvent({ id: "cmd-deploy", command: "/deploy", text: "deploy-42" }), { APPROVERS: "7" });
    const answer = (await response.json()) as { blocks: { type: string; elements?: { action_id: string }[] }[] };
    expect(answer.blocks[1]!.elements!.map((element) => element.action_id)).toEqual(["approve", "reject"]);
  });

  it("refuses a target written as mrkdwn, which could show approvers a different one", async () => {
    fakeSabha();
    const response = await deliver(approvalCard, commandEvent({ id: "cmd-deploy-sneaky", command: "/deploy", text: "<feature/drop-db|main>" }), { APPROVERS: "7" });
    expect(await response.json()).toMatchObject({ response_type: "ephemeral", text: "Name a branch or tag: /deploy main" });
  });

  it("lets a listed approver decide, replacing the card once", async () => {
    const sabha = fakeSabha();
    await deliver(approvalCard, blockActionsEvent({ id: "act-approver" }), { APPROVERS: "3, 7" });
    expect(responseUrlCalls(sabha)).toEqual([{ replace_original: true, text: "Approved by Asha: deploy-42" }]);
  });

  it("refuses everyone else, leaving the card as it was", async () => {
    const sabha = fakeSabha();
    await deliver(approvalCard, blockActionsEvent({ id: "act-stranger" }), { APPROVERS: "3" });
    expect(responseUrlCalls(sabha)).toEqual([{ response_type: "ephemeral", replace_original: false, text: "Only approvers can decide this deploy." }]);
  });
});

describe("notifier", () => {
  it("posts the feed's summary once, however often the tick repeats", async () => {
    const sabha = new FakeSabha().app(env.SABHA_API_KEY, { id: 99, name: "Example" });
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) =>
      String(input).startsWith("https://feed.test") ? Response.json({ summary: "All systems normal." }) : sabha.fetch(input, init),
    );
    const notifierEnv = { ...env, ROOM_ID: "10", FEED_URL: "https://feed.test/summary", TIMEZONE: "Europe/London" };
    const runtime = { env: notifierEnv, client: notifier.clientFor(notifierEnv), logger: notifier.logger, transport: "webhook" as const, waitUntil() {} };
    for (const at of ["2026-11-16T08:30:00Z", "2026-11-16T08:31:00Z", "2026-11-16T08:35:00Z"]) await notifier.runSchedules(Date.parse(at), runtime);
    expect(sabha.messages.map((message) => message.body)).toEqual(["All systems normal."]);
  });
});

describe("streaming-agent", () => {
  it("fills a draft with the whole text so far, then finishes it under the draft's id", async () => {
    const sabha = fakeSabha();
    await deliver(streamingAgent, messageEvent({ message: { id: 503 } }));
    const updates = sabha.calls.filter((call) => call.method === "PATCH" && call.path.startsWith("/api/v1/drafts/")).map((call) => (call.body as { text: string }).text);
    expect(updates).toEqual(["Here's", "Here's what", "Here's what I", "Here's what I found."]);
    const draftId = sabha.calls.find((call) => call.path === "/api/v1/rooms/10/drafts")!.body as { draft_id: string };
    expect(sabha.messages.at(-1)).toMatchObject({ body: "Here's what I found.", client_message_id: draftId.draft_id });
  });
});
