// The Worker the Cloudflare tests run: one app, a fake Sabha, and fake sockets handed to the
// socket host in place of the real fetch Upgrade.
import { App } from "../../src/app.js";
import { APP_EVENTS_IDENTIFIER, type Connect, type WebSocketLike } from "../../src/cable/socket.js";
import { createSocketHost, createWorker, type CloudflareEnv } from "../../src/cloudflare/index.js";
import { FakeSabha } from "../../src/testing/fake-sabha.js";

export const sabha = new FakeSabha().app("sabha_app_cloudflare_key", { id: 99, name: "Helper" });
export const handled: string[] = [];
export const scheduled: string[] = [];

export class FakeSocket implements WebSocketLike {
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
  confirm() {
    this.frame({ type: "welcome" });
    this.frame({ type: "confirm_subscription", identifier: APP_EVENTS_IDENTIFIER });
  }
  event(message: unknown, offset: number) {
    this.frame({ identifier: APP_EVENTS_IDENTIFIER, message, stream_id: "app_events:99", epoch: "e1", offset });
  }
}

export const sockets: FakeSocket[] = [];
const connect: Connect = async () => {
  const socket = new FakeSocket();
  sockets.push(socket);
  return socket;
};

export const app = new App<CloudflareEnv>({ fetch: sabha.fetch, logger: { info() {}, warn() {}, error() {} } });
app.mention(async ({ message, say }) => {
  handled.push(`mention:${message.id}`);
  await say(`Seen ${message.id}`);
});
app.schedule("standup", { at: "09:00", timezone: "Europe/London", days: "mon-fri" }, ({ runKey }) => void scheduled.push(runKey));

export default createWorker(app);
export const SocketHost = createSocketHost(app, { connect });
