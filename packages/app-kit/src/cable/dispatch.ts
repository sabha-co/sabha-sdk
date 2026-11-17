import type { App } from "../app.js";
import type { Runtime, SabhaEnv } from "../context.js";
import type { SabhaEvent } from "../events.js";
import { CableClient, type CableClientOptions, type Connect, type ReplayStore } from "./socket.js";

export interface SocketAppOptions<Env extends SabhaEnv> {
  app: App<Env>;
  env: Env;
  connect: Connect;
  store?: ReplayStore;
  /** Keeps a handler's later work alive; a host without a limit can leave it out. */
  waitUntil?(promise: Promise<unknown>): void;
  cable?: Partial<Omit<CableClientOptions, "url" | "apiKey" | "connect" | "store" | "onEvent">>;
}

/**
 * Runs an app over the socket: each event goes to the same handlers a webhook would reach,
 * and a command's quick answer goes back on the socket.
 */
export function socketApp<Env extends SabhaEnv>(options: SocketAppOptions<Env>): CableClient {
  const { app, env } = options;
  const client = app.clientFor(env);
  const pending = new Set<Promise<unknown>>();
  const waitUntil =
    options.waitUntil ??
    ((promise: Promise<unknown>) => {
      pending.add(promise);
      void promise.finally(() => pending.delete(promise));
    });

  const cable: CableClient = new CableClient({
    logger: app.logger,
    onGap: (reason) => app.reportGap(reason),
    ...options.cable,
    url: client.socketUrl,
    apiKey: env.SABHA_API_KEY,
    connect: options.connect,
    ...(options.store ? { store: options.store } : {}),
    onEvent: async (event: SabhaEvent) => {
      const runtime: Runtime<Env> = {
        env,
        client,
        logger: app.logger,
        transport: "socket",
        waitUntil,
        answerCommand: (id, answer) => cable.perform("answer", { id, ...answer }),
      };
      await app.dispatch(event, runtime, { inline: false, claimed: true });
    },
  });
  return cable;
}
