import {
  createExecutionContext,
  createScheduledController,
  env,
  abortAllDurableObjects,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signedDelivery } from "../../src/testing/sign.js";
import { messageEvent } from "../../src/testing/fixtures.js";
import worker, { handled, sabha, scheduled, sockets } from "./worker.js";

const webhookEnv = { ...env, TRANSPORT: "webhook" };
const stub = () => env.SABHA_SOCKET.get(env.SABHA_SOCKET.idFromName("socket"));
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
/** Plays Sabha's side of the socket from inside the object, where real frames arrive. */
const inObject = (play: () => void) => runInDurableObject(stub(), async () => play());

async function call(request: Request, environment: Cloudflare.Env = env) {
  const ctx = createExecutionContext();
  const response = await worker.fetch!(request as never, environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("the Worker in webhook mode", () => {
  it("runs a signed delivery's handler", async () => {
    const before = handled.length;
    const response = await call(await signedDelivery({ secret: env.SABHA_SIGNING_SECRET!, payload: messageEvent({ message: { id: 7001 } }) }), webhookEnv);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(handled.slice(before)).toEqual(["mention:7001"]);
  });

  it("answers 404 for any other route, without running a handler", async () => {
    const before = handled.length;
    expect((await call(new Request("https://app.test/admin"), webhookEnv)).status).toBe(404);
    expect(handled.length).toBe(before);
  });

  it("answers 500 when the signing secret is missing", async () => {
    const request = await signedDelivery({ secret: "whatever", payload: messageEvent() });
    expect((await call(request, { ...webhookEnv, SABHA_SIGNING_SECRET: "" })).status).toBe(500);
  });

  it("runs schedules on the cron tick, in local time", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: Date.parse("2026-03-30T08:00:00Z") }), webhookEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(scheduled).toContain("standup:2026-03-30");
  });
});

describe("the Worker in socket mode", () => {
  it("drops webhook deliveries and wakes the socket host", async () => {
    const before = handled.length;
    const response = await call(await signedDelivery({ secret: env.SABHA_SIGNING_SECRET!, payload: messageEvent({ message: { id: 7002 } }) }));
    expect(response.status).toBe(200);
    expect(handled.length).toBe(before);
    expect(sockets.length).toBeGreaterThan(0);
  });

  it("runs the same handler for an event from the socket, through the API", async () => {
    const status = await (await call(new Request("https://app.test/connect"))).json();
    expect(status).toMatchObject({ transport: "socket" });
    const socket = sockets.at(-1)!;
    await inObject(() => {
      socket.confirm();
      socket.event(messageEvent({ message: { id: 7003 } }), 1);
    });
    await settle();
    expect(handled).toContain("mention:7003");
    expect(sabha.messages.some((message) => message.body === "Seen 7003")).toBe(true);
  });

  it("reconnects after a reset, asks for history from the stored position, and doesn't rerun taken events", async () => {
    await call(new Request("https://app.test/connect"));
    let socket = sockets.at(-1)!;
    await inObject(() => {
      socket.confirm();
      socket.event(messageEvent({ message: { id: 7004 } }), 2);
    });
    await settle();
    const runs = () => handled.filter((entry) => entry === "mention:7004").length;
    expect(runs()).toBe(1);

    // The object is reset, as after a crash or a deploy; its storage stays.
    await abortAllDurableObjects();
    const count = sockets.length;
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(sockets.length).toBe(count + 1);
    socket = sockets.at(-1)!;
    await inObject(() => socket.confirm());
    const history = socket.sent.find((frame) => frame.command === "history") as { history: { streams: Record<string, unknown> } };
    expect(history.history.streams["app_events:99"]).toEqual({ epoch: "e1", offset: 2 });
    await inObject(() => socket.event(messageEvent({ message: { id: 7004 } }), 2));
    await settle();
    expect(runs()).toBe(1);
  });

  it("closes the socket and stops its alarm once TRANSPORT is no longer socket", async () => {
    await call(new Request("https://app.test/connect"));
    const socket = sockets.at(-1)!;
    await runInDurableObject(stub(), async (object: unknown, state: DurableObjectState) => {
      const instance = object as unknown as { env: Cloudflare.Env; alarm(): Promise<void> };
      instance.env.TRANSPORT = "webhook";
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(socket.closed).toBe(true);
  });
});
