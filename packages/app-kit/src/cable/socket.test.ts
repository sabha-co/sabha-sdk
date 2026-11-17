import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import type { SabhaEnv } from "../context.js";
import { FakeSabha } from "../testing/fake-sabha.js";
import { commandEvent, messageEvent } from "../testing/fixtures.js";
import { socketApp } from "./dispatch.js";
import {
  APP_EVENTS_IDENTIFIER,
  CABLE_PROTOCOL,
  CableClient,
  CableRejectedError,
  MemoryReplayStore,
  backoffDelay,
  type Connect,
  type WebSocketLike,
} from "./socket.js";

/** A socket the test plays Sabha's side of. */
class FakeSocket implements WebSocketLike {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  private listeners: Record<string, ((event: never) => void)[]> = {};

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.listeners.close ?? []) listener({} as never);
  }
  addEventListener(type: string, listener: (event: never) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  frame(frame: Record<string, unknown>) {
    for (const listener of this.listeners.message ?? []) listener({ data: JSON.stringify(frame) } as never);
  }
  welcomeAndConfirm() {
    this.frame({ type: "welcome" });
    this.frame({ type: "confirm_subscription", identifier: APP_EVENTS_IDENTIFIER });
  }
  event(message: unknown, offset: number) {
    this.frame({ identifier: APP_EVENTS_IDENTIFIER, message, stream_id: "app_events:99", epoch: "e1", offset });
  }
  commands(name: string) {
    return this.sent.filter((frame) => frame.command === name);
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const handshakes: { url: string; headers: Record<string, string>; protocol: string }[] = [];
  const connect: Connect = async (url, options) => {
    handshakes.push({ url, ...options });
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  return { sockets, handshakes, connect };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const env: SabhaEnv = { SABHA_BASE_URL: "https://sabha.test", SABHA_API_KEY: "sabha_app_socket_key" };

afterEach(() => vi.useRealTimers());

describe("CableClient", () => {
  it("sends the key as a header with the ext protocol, never in the URL, then subscribes", async () => {
    const { sockets, handshakes, connect } = harness();
    const cable = new CableClient({ url: "wss://sabha.test/cable", apiKey: "sabha_app_key", connect, onEvent() {} });
    void cable.start();
    await tick();
    expect(handshakes[0]).toEqual({ url: "wss://sabha.test/cable", headers: { Authorization: "Bearer sabha_app_key" }, protocol: CABLE_PROTOCOL });
    sockets[0]!.frame({ type: "welcome" });
    expect(sockets[0]!.commands("subscribe")).toEqual([{ command: "subscribe", identifier: APP_EVENTS_IDENTIFIER }]);
    cable.stop();
  });

  it("dispatches events once, skips presence, and records positions before dispatch", async () => {
    const { sockets, connect } = harness();
    const store = new MemoryReplayStore();
    const seen: string[] = [];
    const cable = new CableClient({
      url: "wss://x",
      apiKey: "k",
      connect,
      store,
      onEvent: (event) => {
        expect(store.positions["app_events:99"]).toBeDefined();
        seen.push(event.event);
      },
    });
    void cable.start();
    await tick();
    sockets[0]!.welcomeAndConfirm();
    sockets[0]!.frame({ type: "presence", identifier: APP_EVENTS_IDENTIFIER, message: { type: "join" } });
    sockets[0]!.event(messageEvent(), 1);
    sockets[0]!.event(messageEvent(), 2); // the same message again
    await tick();
    expect(seen).toEqual(["message_created"]);
    expect(store.positions["app_events:99"]).toEqual({ epoch: "e1", offset: 2 });
    cable.stop();
  });

  it("hands refusals of the app's own frames aside instead of dispatching them", async () => {
    const { sockets, connect } = harness();
    const onEvent = vi.fn();
    const onRefusal = vi.fn();
    const cable = new CableClient({ url: "wss://x", apiKey: "k", connect, onEvent, onRefusal });
    void cable.start();
    await tick();
    sockets[0]!.welcomeAndConfirm();
    sockets[0]!.event({ event: "answer_refused", id: "cmd-1", error: "late" }, 1);
    await tick();
    expect(onEvent).not.toHaveBeenCalled();
    expect(onRefusal).toHaveBeenCalledWith(expect.objectContaining({ event: "answer_refused" }));
    cable.stop();
  });

  it("drops a silent socket and reconnects", async () => {
    vi.useFakeTimers();
    const { sockets, connect } = harness();
    const cable = new CableClient({ url: "wss://x", apiKey: "k", connect, onEvent() {}, random: () => 0 });
    void cable.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.welcomeAndConfirm();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(sockets[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    cable.stop();
  });

  it("backs off with jitter, never past the cap", () => {
    expect(backoffDelay(0, 60_000, () => 0.999)).toBeLessThan(1_000);
    expect(backoffDelay(3, 60_000, () => 0.5)).toBe(4_000);
    for (let attempt = 0; attempt < 30; attempt++) expect(backoffDelay(attempt, 60_000, () => 0.999)).toBeLessThan(60_000);
  });

  it("asks for history from saved positions, falls back to time, then reports a gap", async () => {
    const { sockets, connect } = harness();
    const store = new MemoryReplayStore();
    store.positions["app_events:99"] = { epoch: "e1", offset: 7 };
    store.connectedAt = 1_700_000_000;
    const onGap = vi.fn();
    const cable = new CableClient({ url: "wss://x", apiKey: "k", connect, store, onEvent() {}, onGap });
    void cable.start();
    await tick();
    sockets[0]!.welcomeAndConfirm();
    expect(sockets[0]!.commands("history")[0]).toMatchObject({ history: { streams: { "app_events:99": { epoch: "e1", offset: 7 } }, since: 1_700_000_000 } });
    sockets[0]!.frame({ type: "reject_history", identifier: APP_EVENTS_IDENTIFIER });
    expect(sockets[0]!.commands("history")[1]).toMatchObject({ history: { since: 1_700_000_000 } });
    expect(sockets[0]!.commands("history")[1]!.history).not.toHaveProperty("streams");
    sockets[0]!.frame({ type: "reject_history", identifier: APP_EVENTS_IDENTIFIER });
    expect(onGap).toHaveBeenCalledOnce();
    cable.stop();
  });

  it("stops for good when Sabha rejects the key", async () => {
    const connect: Connect = async () => {
      throw new CableRejectedError("HTTP 401");
    };
    const cable = new CableClient({ url: "wss://x", apiKey: "k", connect, onEvent() {} });
    await expect(cable.start()).resolves.toBeUndefined();
  });
});

describe("socketApp", () => {
  function setup(commandWindowMs = 3_000) {
    const sabha = new FakeSabha().app(env.SABHA_API_KEY, { id: 99, name: "Helper" });
    const app = new App({ fetch: sabha.fetch, commandWindowMs, logger: { info() {}, warn() {}, error() {} } });
    const { sockets, connect } = harness();
    const cable = socketApp({ app, env, connect });
    return { app, sabha, sockets, cable };
  }

  it("runs the same handlers a webhook would, posting a mention's answer through the API", async () => {
    const { app, sabha, sockets, cable } = setup();
    app.mention(({ user }) => `Hi ${user.name}`);
    void cable.start();
    await tick();
    sockets[0]!.welcomeAndConfirm();
    sockets[0]!.event(messageEvent(), 1);
    await vi.waitFor(() => expect(sabha.messages).toHaveLength(1));
    expect(sabha.messages[0]!.body).toBe("Hi Asha");
    cable.stop();
  });

  it("answers a quick command on the socket, and a slow one through response_url", async () => {
    const { app, sabha, sockets, cable } = setup(20);
    app.command("/ticket", async ({ command }) => {
      if (command.text === "slow") await new Promise((resolve) => setTimeout(resolve, 60));
      return { text: `Filed: ${command.text}` };
    });
    void cable.start();
    await tick();
    sockets[0]!.welcomeAndConfirm();
    sockets[0]!.event(commandEvent(), 1);
    await vi.waitFor(() => expect(sockets[0]!.commands("message")).toHaveLength(1));
    expect(JSON.parse(String(sockets[0]!.commands("message")[0]!.data))).toEqual({ id: "cmd-1", text: "Filed: printer is on fire", action: "answer" });

    sockets[0]!.event(commandEvent({ id: "cmd-2", text: "slow" }), 2);
    await vi.waitFor(() => expect(sabha.calls.some((call) => call.path === "/api/v1/interaction_responses")).toBe(true));
    expect(sockets[0]!.commands("message")).toHaveLength(1);
    cable.stop();
  });

  it("delivers every event exactly once across a drop, reconnect and replay", async () => {
    vi.useFakeTimers();
    const sabha = new FakeSabha().app(env.SABHA_API_KEY, { id: 99, name: "Helper" });
    const app = new App({ fetch: sabha.fetch, logger: { info() {}, warn() {}, error() {} } });
    const handled: number[] = [];
    app.message(({ message }) => void handled.push(message.id));
    const { sockets, connect } = harness();
    const cable = socketApp({ app, env, connect, cable: { random: () => 0 } });
    void cable.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.welcomeAndConfirm();
    sockets[0]!.event(messageEvent({ message: { id: 1 } }), 1);
    sockets[0]!.event(messageEvent({ message: { id: 2 } }), 2);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.close();
    await vi.advanceTimersByTimeAsync(1);
    sockets[1]!.welcomeAndConfirm();
    expect(sockets[1]!.commands("history")[0]).toMatchObject({ history: { streams: { "app_events:99": { epoch: "e1", offset: 2 } } } });
    // Sabha replays from the position, overlapping one event.
    sockets[1]!.event(messageEvent({ message: { id: 2 } }), 2);
    sockets[1]!.event(messageEvent({ message: { id: 3 } }), 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(handled).toEqual([1, 2, 3]);
    cable.stop();
  });
});
