// Running an app on Cloudflare: a Worker that takes Sabha's webhooks and a one-minute Cron
// Trigger for schedules, and a Durable Object that holds Sabha's socket when TRANSPORT is
// `socket`. The same handlers run either way.
import { DurableObject } from "cloudflare:workers";
import type { App } from "../app.js";
import { socketApp } from "../cable/dispatch.js";
import type { CableClient, Connect } from "../cable/socket.js";
import type { Runtime, SabhaEnv } from "../context.js";
import { describeError } from "../log.js";
import { handleWebhook } from "../webhook.js";
import { connectWorkers } from "./connect.js";
import { DurableReplayStore } from "./replay-store.js";

export { connectWorkers } from "./connect.js";
export { DurableReplayStore } from "./replay-store.js";

/** The Durable Object binding the template declares for the socket host. */
export const SOCKET_BINDING = "SABHA_SOCKET";
const WATCHDOG_MS = 30_000;
const STUCK_MS = 120_000;

export interface SocketHostStub {
  ensureConnected(): Promise<{ transport: string; connected: boolean; refused?: boolean }>;
}

export interface CloudflareEnv extends SabhaEnv {
  SABHA_SOCKET?: DurableObjectNamespace;
}

const isSocketMode = (env: SabhaEnv) => env.TRANSPORT === "socket";

function socketHost(env: CloudflareEnv): SocketHostStub | undefined {
  const namespace = env.SABHA_SOCKET;
  if (!namespace) return undefined;
  // One app, one socket: every request reaches the same object.
  return namespace.get(namespace.idFromName("socket")) as unknown as SocketHostStub;
}

export interface WorkerOptions {
  /** Where Sabha sends webhooks; `/` by default. */
  path?: string;
}

/**
 * The Worker's handlers. In webhook mode `fetch` answers Sabha's deliveries; in socket mode it
 * drops them (Sabha sends every event to the socket too) and wakes the socket host on any
 * request, so `GET /connect` after a deploy or in `wrangler dev` opens the socket.
 */
export function createWorker<Env extends CloudflareEnv>(app: App<Env>, options: WorkerOptions = {}): ExportedHandler<Env> {
  const path = options.path ?? "/";
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const host = isSocketMode(env) ? socketHost(env) : undefined;
      if (isSocketMode(env) && !host) app.logger.error(`TRANSPORT is socket but the ${SOCKET_BINDING} Durable Object isn't bound`);

      if (request.method === "GET" && url.pathname === "/connect") {
        if (!host) return new Response("Socket mode is off: events arrive by webhook.\n", { status: 200 });
        const status = await host.ensureConnected();
        return Response.json(status);
      }
      if (host) ctx.waitUntil(host.ensureConnected().catch(() => undefined));
      if (request.method === "POST" && url.pathname === path) {
        return handleWebhook(app, request as unknown as Request, { env, waitUntil: (promise) => ctx.waitUntil(promise) });
      }
      return new Response("Not found\n", { status: 404 });
    },

    async scheduled(controller, env, ctx) {
      if (isSocketMode(env)) {
        const host = socketHost(env);
        if (host) ctx.waitUntil(host.ensureConnected().catch((error: unknown) => app.logger.error("couldn't wake the socket host", { error: describeError(error) })));
      }
      if (app.schedules.length === 0) return;
      const runtime: Runtime<Env> = {
        env,
        client: app.clientFor(env),
        logger: app.logger,
        transport: isSocketMode(env) ? "socket" : "webhook",
        waitUntil: (promise) => ctx.waitUntil(promise),
      };
      await app.runSchedules(controller.scheduledTime, runtime);
    },
  };
}

export interface SocketHostOptions {
  /** Replaced in tests; the fetch Upgrade form by default. */
  connect?: Connect;
}

/**
 * The Durable Object class that holds the app's socket. Export it from the Worker under the
 * class name the Wrangler config declares:
 *
 *   export const SocketHost = createSocketHost(app);
 *
 * An alarm every 30 s reconnects it after an eviction or a deploy. When TRANSPORT is no longer
 * `socket` it closes the socket and stops its alarm, so switching back to webhooks needs no
 * code change and the app stops showing online.
 */
export type SocketHostClass<Env extends CloudflareEnv> = new (ctx: DurableObjectState, env: Env) => DurableObject<Env> & SocketHostStub;

export function createSocketHost<Env extends CloudflareEnv>(app: App<Env>, options: SocketHostOptions = {}): SocketHostClass<Env> {
  return class SocketHost extends DurableObject<Env> implements SocketHostStub {
    private cable: CableClient | undefined;
    private connected = false;
    private readonly store: DurableReplayStore;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);
      this.store = new DurableReplayStore(ctx.storage);
      ctx.blockConcurrencyWhile(async () => {
        if (isSocketMode(env)) {
          if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
        } else {
          await ctx.storage.deleteAlarm();
        }
      });
    }

    async ensureConnected(): Promise<{ transport: string; connected: boolean; refused?: boolean }> {
      if (!isSocketMode(this.env)) {
        await this.shutdown();
        return { transport: "webhook", connected: false };
      }
      const refused = !(await this.start());
      if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
      return { transport: "socket", connected: this.connected, ...(refused ? { refused } : {}) };
    }

    override async alarm(): Promise<void> {
      if (!isSocketMode(this.env)) {
        await this.shutdown();
        return;
      }
      // A client that exists but has heard nothing for minutes is stuck; replace it.
      if (this.cable && !this.cable.connected && Date.now() - this.cable.lastFrameAt > STUCK_MS) {
        app.logger.warn("the socket was stuck; starting it again");
        this.replace();
      }
      await this.start();
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    }

    /** Starts the socket unless it's running; false when Sabha refused this same key before. */
    private async start(): Promise<boolean> {
      if (this.cable) return true;
      const fingerprint = await fingerprintOf(this.env.SABHA_API_KEY);
      if (this.store.refusedKey() === fingerprint) return false;
      this.store.setRefusedKey(undefined);
      const cable = socketApp({
        app,
        env: this.env,
        connect: options.connect ?? connectWorkers,
        store: this.store,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
        cable: { onStatus: (connected) => (this.connected = connected) },
      });
      this.cable = cable;
      void cable.start().then(() => {
        // Still current, so it ended on its own: Sabha refused the key. Wait for a new one
        // rather than knock every 30 s.
        if (this.cable !== cable) return;
        this.cable = undefined;
        this.connected = false;
        this.store.setRefusedKey(fingerprint);
      });
      return true;
    }

    private replace(): void {
      const cable = this.cable;
      this.cable = undefined;
      this.connected = false;
      cable?.stop();
    }

    private async shutdown(): Promise<void> {
      this.replace();
      await this.ctx.storage.deleteAlarm();
    }
  };
}

async function fingerprintOf(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
