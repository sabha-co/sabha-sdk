import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { App } from "../app.js";
import { CABLE_PROTOCOL } from "../cable/socket.js";
import { FakeSabha } from "../testing/fake-sabha.js";
import { connectNode, runSocket } from "./index.js";

afterEach(() => vi.useRealTimers());

describe("connectNode", () => {
  it("sends the bearer key and the ext protocol on the handshake", async () => {
    const server = new WebSocketServer({ port: 0 });
    const seen = new Promise<{ authorization?: string; protocol?: string }>((resolve) =>
      server.on("connection", (_socket, request) => resolve({ authorization: request.headers.authorization, protocol: request.headers["sec-websocket-protocol"] })),
    );
    await new Promise((resolve) => server.on("listening", resolve));
    const { port } = server.address() as { port: number };
    const socket = await connectNode(`ws://127.0.0.1:${port}/cable`, { headers: { Authorization: "Bearer sabha_app_node" }, protocol: CABLE_PROTOCOL });
    expect(await seen).toEqual({ authorization: "Bearer sabha_app_node", protocol: CABLE_PROTOCOL });
    socket.close();
    server.close();
  });
});

describe("runSocket", () => {
  it("runs schedules once a minute until closed", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-16T08:59:30Z") });
    const env = { SABHA_BASE_URL: "https://sabha.test", SABHA_API_KEY: "sabha_app_node_key" };
    const app = new App({ fetch: new FakeSabha().app(env.SABHA_API_KEY, { id: 1, name: "Bot" }).fetch, logger: { info() {}, warn() {}, error() {} } });
    const runs: string[] = [];
    app.schedule("tick", { at: "09:00", timezone: "UTC", days: "daily", retryFor: 5 }, ({ runKey }) => void runs.push(runKey));
    const running = runSocket(app, { env, connect: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual(["tick:2026-11-16", "tick:2026-11-16"]);
    running.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toHaveLength(2);
  });

  it("waits on close for a schedule still running", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-16T08:59:59Z") });
    const env = { SABHA_BASE_URL: "https://sabha.test", SABHA_API_KEY: "sabha_app_node_key" };
    const app = new App({ fetch: new FakeSabha().app(env.SABHA_API_KEY, { id: 1, name: "Bot" }).fetch, logger: { info() {}, warn() {}, error() {} } });
    let finished = false;
    app.schedule("slow", { at: "09:00", timezone: "UTC", days: "daily" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      finished = true;
    });
    const running = runSocket(app, { env, connect: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(1_000);
    const closed = running.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await closed;
    expect(finished).toBe(true);
  });
});
