import type { App } from "../app.js";
import type { Runtime, SabhaEnv } from "../context.js";
import type { SabhaEvent } from "../events.js";
import { CableClient, type CableClientOptions, type Connect, type EventMeta, type ReplayStore } from "./socket.js";

export interface SocketAppOptions<Env extends SabhaEnv> {
  app: App<Env>;
  env: Env;
  connect: Connect;
  store?: ReplayStore;
  /** Keeps a handler's later work alive; a host without a limit can leave it out. */
  waitUntil?(promise: Promise<unknown>): void;
  cable?: Partial<Omit<CableClientOptions, "url" | "apiKey" | "connect" | "store" | "onEvent">>;
}

/** How long Sabha takes a command's answer: 15 s from the member's command. */
const ANSWER_FOR_MS = 15_000;

/**
 * Runs an app over the socket: each event goes to the same handlers a webhook would reach.
 * A quick command answer goes back on the socket, unless the command came from a replay (its
 * moment has passed) or Sabha refuses it; then it goes to the command's response_url.
 */
export function socketApp<Env extends SabhaEnv>(options: SocketAppOptions<Env>): CableClient {
  const { app, env } = options;
  const client = app.clientFor(env);
  const answers = new Map<string, { responseUrl: string; answer: Record<string, unknown>; at: number }>();

  const onRefusal = (frame: Record<string, unknown>) => {
    const pending = frame.event === "answer_refused" ? answers.get(String(frame.id)) : undefined;
    if (pending) {
      answers.delete(String(frame.id));
      cable.track(client.respond(pending.responseUrl, pending.answer).catch((error: unknown) => app.logger.error("couldn't answer a refused command", { error: error instanceof Error ? error.name : "error" })));
    }
    options.cable?.onRefusal?.(frame);
  };

  const cable: CableClient = new CableClient({
    logger: app.logger,
    onGap: (reason) => app.reportGap(reason),
    ...options.cable,
    onRefusal,
    url: client.socketUrl,
    apiKey: env.SABHA_API_KEY,
    connect: options.connect,
    ...(options.store ? { store: options.store } : {}),
    onEvent: async (event: SabhaEvent, meta: EventMeta) => {
      const runtime: Runtime<Env> = {
        env,
        client,
        logger: app.logger,
        transport: "socket",
        waitUntil: (promise) => (options.waitUntil ? options.waitUntil(promise) : cable.track(promise)),
        answerCommand: (id, answer) => {
          if (meta.replayed || event.event !== "command") return false;
          if (!cable.perform("answer", { id, ...answer })) return false;
          const now = Date.now();
          for (const [key, pending] of answers) if (now - pending.at > ANSWER_FOR_MS) answers.delete(key);
          answers.set(id, { responseUrl: event.response_url, answer, at: now });
          return true;
        },
      };
      await app.dispatch(event, runtime, { inline: false, claimed: true });
    },
  });
  return cable;
}
