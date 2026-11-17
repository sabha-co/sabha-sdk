import { SabhaClient, type FetchLike, type InteractionResponse, type Posted } from "./client.js";
import type { Context, Draft, Handler, HandlerResult, Runtime, SabhaEnv, SayOptions } from "./context.js";
import { SeenEvents } from "./dedupe.js";
import { ConfigError, RetryLater } from "./errors.js";
import {
  actorOf,
  eventKey,
  placeOf,
  roomIdOf,
  type EventName,
  type EventOf,
  type Place,
  type SabhaEvent,
} from "./events.js";
import { consoleLogger, describeError, type Logger } from "./log.js";
import { due, type Schedule, type ScheduleHandler, type ScheduleSpec } from "./schedule.js";
import { stableId } from "./stable-id.js";

export interface AppOptions {
  logger?: Logger;
  /**
   * Whether Sabha posts a handler's quick answer to a message or reaction for it (the
   * auto-reply shortcut). It does when the app holds `post`, which an app answering mentions
   * needs anyway. Turn it off for an app without `post`: Sabha then waits only 30 seconds.
   */
  inlineReplies?: boolean;
  /** How long a command's handler may take to answer inline. Sabha allows 15 s from when it ran. */
  commandWindowMs?: number;
  /** How long a message or reaction handler may take to answer inline. Sabha allows 300 s. */
  replyWindowMs?: number;
  /** How long any other handler is waited for before Sabha is answered. Sabha allows 30 s. */
  acceptWindowMs?: number;
  /** For tests: the fetch every client uses. */
  fetch?: FetchLike;
}

/** What answering one webhook delivery came to. */
export type Answer =
  | { status: 200; text: string }
  | { status: 200; json: Record<string, unknown> }
  | { status: 503 };

type MessageFilter = { in?: Place | Place[] };

interface Route<Env extends SabhaEnv> {
  event: EventName;
  matches(event: SabhaEvent): boolean;
  handler: (context: never) => HandlerResult | Promise<HandlerResult>;
}

const REPLY_EVENTS = new Set<EventName>(["message_created", "reaction_created"]);
/** Events Sabha never retries: a delivery that can carry a reply is answered or dropped. */
const UNRETRIED_EVENTS = new Set<EventName>(["message_created", "reaction_created", "command"]);

const timeout = (ms: number) => new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms));

type Outcome = { ok: true; value: HandlerResult } | { ok: false; error: unknown };

/**
 * A Sabha app: one set of handlers, run the same over webhooks or the socket.
 *
 *   const app = new App();
 *   app.mention(({ user }) => `Hi ${user.name}`);
 */
export class App<Env extends SabhaEnv = SabhaEnv> {
  readonly logger: Logger;
  readonly options: Required<Omit<AppOptions, "logger" | "fetch">> & { fetch?: FetchLike };
  readonly schedules: Schedule<Env>[] = [];
  private readonly routes: Route<Env>[] = [];
  private readonly seen = new SeenEvents();
  private readonly clients = new Map<string, SabhaClient>();
  private readonly selves = new Map<string, Promise<number | undefined>>();
  private gapHandler: ((info: { reason: string }) => void) | undefined;

  constructor(options: AppOptions = {}) {
    this.logger = options.logger ?? consoleLogger;
    this.options = {
      inlineReplies: options.inlineReplies ?? true,
      commandWindowMs: options.commandWindowMs ?? 3_000,
      replyWindowMs: options.replyWindowMs ?? 280_000,
      acceptWindowMs: options.acceptWindowMs ?? 25_000,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
  }

  // Registering handlers -------------------------------------------------------

  /** A message that names the app (Slack's `app_mention`), not one that only says @everyone. */
  mention(handler: Handler<"message_created", Env>): this {
    return this.route("message_created", (event) => event.event === "message_created" && event.mentions_app === true, handler);
  }

  /** Every new message the app hears, or those in some places: `dm`, `thread`, `room` or `post`. */
  message(handler: Handler<"message_created", Env>): this;
  message(filter: MessageFilter, handler: Handler<"message_created", Env>): this;
  message(filterOrHandler: MessageFilter | Handler<"message_created", Env>, maybeHandler?: Handler<"message_created", Env>): this {
    const filter = typeof filterOrHandler === "function" ? {} : filterOrHandler;
    const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler!;
    const places = filter.in === undefined ? undefined : new Set(([] as Place[]).concat(filter.in));
    return this.route(
      "message_created",
      (event) => event.event === "message_created" && (!places || places.has(placeOf(event.room) as Place)),
      handler,
    );
  }

  /** One of the app's slash commands, named with its slash: `/deploy`. */
  command(name: string, handler: Handler<"command", Env>): this {
    const wanted = name.startsWith("/") ? name : `/${name}`;
    return this.route("command", (event) => event.event === "command" && event.command === wanted, handler);
  }

  /** A click on one of the app's controls, by `action_id` (a string or a pattern). */
  action(actionId: string | RegExp, handler: Handler<"block_actions", Env>): this {
    const test = (id: string) => (typeof actionId === "string" ? id === actionId : actionId.test(id));
    return this.route("block_actions", (event) => event.event === "block_actions" && event.actions.some((action) => test(action.action_id)), handler);
  }

  /** A reaction added to a message, optionally one emoji. */
  reaction(handler: Handler<"reaction_created", Env>): this;
  reaction(filter: { emoji: string }, handler: Handler<"reaction_created", Env>): this;
  reaction(filterOrHandler: { emoji: string } | Handler<"reaction_created", Env>, maybeHandler?: Handler<"reaction_created", Env>): this {
    const emoji = typeof filterOrHandler === "function" ? undefined : filterOrHandler.emoji;
    const handler = typeof filterOrHandler === "function" ? filterOrHandler : maybeHandler!;
    return this.route("reaction_created", (event) => event.event === "reaction_created" && (!emoji || event.reaction.body === emoji), handler);
  }

  /** Any event by name, for those without a shortcut. */
  event<N extends EventName>(name: N, handler: Handler<N, Env>): this {
    return this.route(name, (event) => event.event === name, handler);
  }

  /** Runs at a local time on set days. See `ScheduleSpec`. */
  schedule(name: string, spec: ScheduleSpec<Env>, handler: ScheduleHandler<Env>): this {
    if (this.schedules.some((schedule) => schedule.name === name)) throw new ConfigError(`two schedules are named "${name}"`);
    this.schedules.push({ name, spec, handler });
    return this;
  }

  /** Called when the socket couldn't replay missed events, so some may be lost. */
  onGap(handler: (info: { reason: string }) => void): this {
    this.gapHandler = handler;
    return this;
  }

  reportGap(reason: string): void {
    this.logger.warn("Sabha couldn't replay missed events", { reason });
    this.gapHandler?.({ reason });
  }

  private route<N extends EventName>(event: N, matches: (event: SabhaEvent) => boolean, handler: Handler<N, Env>): this {
    this.routes.push({ event, matches, handler: handler as Route<Env>["handler"] });
    return this;
  }

  // Hosts ----------------------------------------------------------------------

  /** One client per key and URL, kept for the life of the isolate or process. */
  clientFor(env: Env): SabhaClient {
    if (!env.SABHA_BASE_URL || !env.SABHA_API_KEY) throw new ConfigError("SABHA_BASE_URL and SABHA_API_KEY must be set");
    const cacheKey = `${env.SABHA_BASE_URL}\n${env.SABHA_API_KEY}\n${env.SABHA_SOCKET_URL ?? ""}`;
    let client = this.clients.get(cacheKey);
    if (!client) {
      client = new SabhaClient({
        baseUrl: env.SABHA_BASE_URL,
        apiKey: env.SABHA_API_KEY,
        logger: this.logger,
        ...(env.SABHA_SOCKET_URL ? { socketUrl: env.SABHA_SOCKET_URL } : {}),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
      this.clients.set(cacheKey, client);
    }
    return client;
  }

  /** Whether any handler would run for this event. */
  handles(event: SabhaEvent): boolean {
    return this.routes.some((route) => route.event === event.event && route.matches(event));
  }

  /**
   * Runs an event's handlers. Over a webhook (`inline: true`) it answers within the event's
   * window: the first matching handler's quick return value becomes Sabha's answer, and
   * anything later goes through `say` or `respond`. Over the socket every return value is
   * delivered through the API, a command's through the socket's answer frame when it's quick.
   */
  async dispatch(event: SabhaEvent, runtime: Runtime<Env>, options: { inline: boolean; claimed?: boolean }): Promise<Answer | undefined> {
    const key = eventKey(event);
    if (key && !options.claimed && !this.seen.claim(key)) {
      runtime.logger.info("skipped a repeated event", { event: event.event, key });
      return undefined;
    }
    const routes = this.routes.map((route, index) => ({ route, index })).filter(({ route }) => route.event === event.event && route.matches(event));
    if (routes.length === 0) return undefined;
    if (await this.isOwnEcho(event, runtime)) return undefined;

    const runs = routes.map(({ route, index }) => this.run(route, index, event, key, runtime));
    const window = this.windowFor(event, options.inline);
    const settledAll = Promise.all(runs);
    const first = await (window === undefined ? settledAll : Promise.race([settledAll, timeout(window)]));

    if (first === "timeout") {
      runtime.waitUntil(settledAll.then((outcomes) => this.deliverAll(event, outcomes, routes.map((r) => r.index), key, runtime, undefined)));
      return options.inline ? { status: 200, text: "" } : undefined;
    }

    const retry = first.some((outcome) => !outcome.ok && outcome.error instanceof RetryLater);
    if (retry) {
      if (!UNRETRIED_EVENTS.has(event.event) && options.inline) {
        if (key) this.seen.release(key);
        runtime.logger.info("a handler asked Sabha to retry", { event: event.event, key });
        return { status: 503 };
      }
      runtime.logger.warn("RetryLater ignored: Sabha doesn't retry this event", { event: event.event, transport: runtime.transport });
    }

    let inlineIndex = options.inline ? first.findIndex((outcome) => outcome.ok && this.inlineable(event, outcome.value)) : -1;
    const answer = inlineIndex >= 0 ? this.toAnswer(event, (first[inlineIndex] as { value: HandlerResult }).value) : undefined;
    if (!options.inline && event.event === "command" && runtime.answerCommand) {
      // Over the socket a quick command answer goes back on the socket, like an inline answer.
      const index = first.findIndex((outcome) => outcome.ok && outcome.value !== undefined && outcome.value !== null);
      const quick = index >= 0 ? this.toAnswer(event, (first[index] as { value: HandlerResult }).value) : undefined;
      if (quick && "json" in quick && runtime.answerCommand(event.id, quick.json)) inlineIndex = index;
    }
    runtime.waitUntil(this.deliverAll(event, first, routes.map((r) => r.index), key, runtime, inlineIndex));
    return options.inline ? (answer ?? { status: 200, text: "" }) : undefined;
  }

  /** Runs the schedules due at this tick. Each runs alone; one failing doesn't stop the rest. */
  async runSchedules(scheduledTime: number, runtime: Runtime<Env>): Promise<{ name: string; ran: boolean; error?: unknown }[]> {
    return Promise.all(
      this.schedules.map(async (schedule) => {
        try {
          const localDate = due(schedule.spec, scheduledTime, runtime.env);
          if (!localDate) return { name: schedule.name, ran: false };
          await schedule.handler({
            name: schedule.name,
            runKey: `${schedule.name}:${localDate}`,
            localDate,
            scheduledTime,
            env: runtime.env,
            client: runtime.client,
            logger: runtime.logger,
            stableId: (key) => stableId(runtime.env.SABHA_API_KEY, key),
          });
          return { name: schedule.name, ran: true };
        } catch (error) {
          runtime.logger.error("a schedule failed", { schedule: schedule.name, error: describeError(error, secretsOf(runtime.env)) });
          return { name: schedule.name, ran: false, error };
        }
      }),
    );
  }

  // Internals --------------------------------------------------------------------

  private windowFor(event: SabhaEvent, inline: boolean): number | undefined {
    if (event.event === "command") return this.options.commandWindowMs;
    if (!inline) return undefined;
    if (REPLY_EVENTS.has(event.event) && this.options.inlineReplies) return this.options.replyWindowMs;
    return this.options.acceptWindowMs;
  }

  /** Sabha may send the app its own messages and reactions; never answer them. */
  private async isOwnEcho(event: SabhaEvent, runtime: Runtime<Env>): Promise<boolean> {
    if (event.event === "command" || event.event === "block_actions" || event.event === "user_created" || event.event === "user_deleted") return false;
    const cacheKey = runtime.env.SABHA_BASE_URL + runtime.env.SABHA_API_KEY;
    let self = this.selves.get(cacheKey);
    if (!self) {
      self = runtime.client.me().then(
        (me) => me.id,
        (error) => {
          runtime.logger.warn("couldn't read the app's own id", { error: describeError(error, secretsOf(runtime.env)) });
          this.selves.delete(cacheKey);
          return undefined;
        },
      );
      this.selves.set(cacheKey, self);
    }
    return (await self) === event.user.id;
  }

  private async run(route: Route<Env>, index: number, event: SabhaEvent, key: string | undefined, runtime: Runtime<Env>): Promise<Outcome> {
    try {
      const context = this.contextFor(event, index, key, runtime);
      return { ok: true, value: await (route.handler as (context: Context) => HandlerResult | Promise<HandlerResult>)(context) };
    } catch (error) {
      if (!(error instanceof RetryLater)) {
        runtime.logger.error("a handler failed", { event: event.event, key, error: describeError(error, secretsOf(runtime.env)) });
      }
      return { ok: false, error };
    }
  }

  /** Whether a return value can be Sabha's inline answer to this event. */
  private inlineable(event: SabhaEvent, value: HandlerResult): boolean {
    if (value === undefined || value === null) return false;
    if (event.event === "command") return true;
    if (REPLY_EVENTS.has(event.event) && this.options.inlineReplies) {
      // A JSON body would be posted as an attachment, so only text goes inline.
      return typeof value === "string" || (typeof value.text === "string" && value.blocks === undefined);
    }
    return false;
  }

  private toAnswer(event: SabhaEvent, value: HandlerResult): Answer | undefined {
    if (value === undefined || value === null) return undefined;
    if (event.event === "command") return { status: 200, json: typeof value === "string" ? { text: value } : { ...value } };
    return { status: 200, text: typeof value === "string" ? value : String(value.text) };
  }

  private async deliverAll(
    event: SabhaEvent,
    outcomes: Outcome[],
    indexes: number[],
    key: string | undefined,
    runtime: Runtime<Env>,
    answeredIndex: number | undefined,
  ): Promise<void> {
    await Promise.all(
      outcomes.map(async (outcome, position) => {
        if (!outcome.ok || position === answeredIndex) return;
        if (outcome.value === undefined || outcome.value === null) return;
        try {
          await this.deliver(event, outcome.value, indexes[position]!, key, runtime);
        } catch (error) {
          runtime.logger.error("couldn't deliver a handler's answer", { event: event.event, error: describeError(error, secretsOf(runtime.env)) });
        }
      }),
    );
  }

  /** Sends a return value that wasn't Sabha's inline answer. */
  private async deliver(event: SabhaEvent, value: NonNullable<HandlerResult>, index: number, key: string | undefined, runtime: Runtime<Env>): Promise<void> {
    const context = this.contextFor(event, index, key, runtime, "return");
    switch (event.event) {
      case "command":
      case "block_actions":
        await runtime.client.respond(event.response_url, value);
        return;
      case "message_created":
      case "reaction_created":
        if (typeof value === "string") {
          await context.say(value);
        } else {
          const reply = value as InteractionResponse;
          await context.say({ ...(reply.text === undefined ? {} : { text: reply.text }), ...(reply.blocks === undefined ? {} : { blocks: reply.blocks }) });
        }
        return;
      default:
        runtime.logger.warn("a handler's return value was ignored: this event has nowhere to answer", { event: event.event });
    }
  }

  /** The context a handler gets. `scope` separates ids for `say` calls from return values. */
  contextFor(event: SabhaEvent, index: number, key: string | undefined, runtime: Runtime<Env>, scope = "say"): Context {
    const env = runtime.env;
    const client = runtime.client;
    let says = 0;
    let drafts = 0;
    const idFor = (kind: string, n: number) =>
      key ? stableId(env.SABHA_API_KEY, `${kind}:${index}:${key}:${n}`) : Promise.resolve(crypto.randomUUID());
    const place = placeFor(event);

    const say = async (message: string | SayOptions): Promise<Posted> => {
      const options = typeof message === "string" ? { body: message } : message;
      const { thread, ...post } = options;
      const roomId = requirePlace(place, "say").roomId;
      const parentMessageId = thread ? place?.messageId : undefined;
      return client.post(roomId, { ...post, ...(parentMessageId ? { parentMessageId } : {}), clientMessageId: await idFor(scope, says++) });
    };

    const status = async (text: string | null, options: { thread?: boolean } = {}) => {
      const { roomId, messageId } = requirePlace(place, "status");
      const parent = options.thread && messageId ? { parentMessageId: messageId } : {};
      if (text === null) await client.clearStatus(roomId, parent);
      else await client.setStatus(roomId, text, parent);
    };

    const draft = async (options: { thread?: boolean } = {}): Promise<Draft> => {
      const { roomId, messageId } = requirePlace(place, "draft");
      const parent = options.thread && messageId ? { parentMessageId: messageId } : {};
      const id = await idFor("draft", drafts++);
      await client.openDraft(roomId, id, parent);
      return {
        id,
        update: async (update) => {
          await client.updateDraft(id, update);
        },
        finish: (message) => client.post(roomId, { ...(typeof message === "string" ? { body: message } : message), ...parent, clientMessageId: id }),
        end: async () => {
          await client.endDraft(id);
        },
      };
    };

    const base = {
      event,
      eventKey: key,
      user: actorOf(event),
      env,
      client,
      logger: runtime.logger,
      transport: runtime.transport,
      stableId: (stableKey: string) => stableId(env.SABHA_API_KEY, stableKey),
      say,
      status,
      draft,
    };

    switch (event.event) {
      case "message_created":
      case "message_updated":
      case "message_deleted":
        return { ...base, message: event.message, room: event.room } as unknown as Context;
      case "reaction_created":
      case "reaction_deleted":
        return { ...base, message: event.message, room: event.room, reaction: event.reaction } as unknown as Context;
      case "command":
        return { ...base, command: event, respond: (response: InteractionResponse | string) => client.respond(event.response_url, response) } as unknown as Context;
      case "block_actions":
        return {
          ...base,
          action: event.actions[0],
          actions: event.actions,
          respond: (response: InteractionResponse | string) => client.respond(event.response_url, response),
        } as unknown as Context;
      default:
        return base as unknown as Context;
    }
  }
}

export type { EventOf };

function placeFor(event: SabhaEvent): { roomId: number; messageId?: number } | undefined {
  switch (event.event) {
    case "message_created":
    case "message_updated":
    case "message_deleted":
    case "reaction_created":
    case "reaction_deleted":
      return { roomId: event.room.id, messageId: event.message.id };
    case "command":
      return { roomId: event.thread?.id ?? event.room_id };
    case "block_actions":
      return { roomId: event.room.id, messageId: event.message.id };
    default: {
      const roomId = roomIdOf(event);
      return roomId === undefined ? undefined : { roomId };
    }
  }
}

function requirePlace<T>(place: T | undefined, what: string): T {
  if (!place) throw new ConfigError(`${what} needs an event that happened in a room`);
  return place;
}

export function secretsOf(env: SabhaEnv): string[] {
  return [env.SABHA_API_KEY, env.SABHA_SIGNING_SECRET].filter((value): value is string => Boolean(value));
}
