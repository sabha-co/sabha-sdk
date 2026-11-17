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
   * Whether a string a message or reaction handler returns within `replyWindowMs` is answered
   * inline over a webhook, for Sabha to post as the app's reply (its auto-reply shortcut).
   * By default it is when the key holds `post`, read from `GET /me`: Sabha waits only 30 s
   * on any other app, then sends the event again. Set it to override that.
   */
  inlineReplies?: boolean;
  /** How long a command's handler may take to answer inline. Sabha allows 15 s from when it ran. */
  commandWindowMs?: number;
  /**
   * How long a message or reaction handler may take to answer inline; 10 s by default. Sabha
   * would wait 300 s, but it holds one of its few webhook workers for as long as the kit
   * waits, so a slow handler would hold up other apps' deliveries. Past it, the reply is
   * posted with `say`. Raise it only for handlers that are always quick.
   */
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

/** Settles with `work`, or "timeout" after `ms`, never leaving the timer behind. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ms)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type Outcome = { ok: true; value: HandlerResult } | { ok: false; error: unknown };

/** How long an event waits for the app's profile before going on without it. */
const SELF_LOOKUP_MS = 5_000;
/** How long the app's profile is trusted before it's read again. */
const PROFILE_FOR_MS = 5 * 60_000;

type Profile = { id: number; permissions?: string[] };

/** How long Sabha waits for a delivery it won't post a reply to. */
const ACCEPT_WAIT_MS = 30_000;
/** Time left for the answer to travel back to Sabha. */
const ANSWER_MARGIN_MS = 1_500;

/** A window, shortened to end before Sabha stops waiting, when it said how long it waits. */
function capped(window: number, answerBy: number | undefined): number {
  return answerBy === undefined ? window : Math.max(0, Math.min(window, answerBy - ANSWER_MARGIN_MS - Date.now()));
}

/**
 * A Sabha app: one set of handlers, run the same over webhooks or the socket.
 *
 *   const app = new App();
 *   app.mention(({ user }) => `Hi ${user.name}`);
 */
export class App<Env extends SabhaEnv = SabhaEnv> {
  readonly logger: Logger;
  readonly options: Required<Omit<AppOptions, "logger" | "fetch" | "inlineReplies">> & { fetch?: FetchLike; inlineReplies?: boolean };
  readonly schedules: Schedule<Env>[] = [];
  private readonly routes: Route<Env>[] = [];
  private readonly seen = new SeenEvents();
  private readonly clients = new Map<string, SabhaClient>();
  private readonly profiles = new Map<string, { at: number; profile: Promise<Profile | undefined> }>();
  private gapHandler: ((info: { reason: string }) => void) | undefined;

  constructor(options: AppOptions = {}) {
    this.logger = options.logger ?? consoleLogger;
    this.options = {
      ...(options.inlineReplies === undefined ? {} : { inlineReplies: options.inlineReplies }),
      commandWindowMs: options.commandWindowMs ?? 3_000,
      replyWindowMs: options.replyWindowMs ?? 10_000,
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
   * Runs an event's handlers. Every handler is kept alive with `waitUntil` from the start.
   *
   * - A command is answered by the first handler to return a value within its window: inline
   *   over a webhook, on the socket otherwise. Anything later goes to its `response_url`.
   * - A message or reaction is accepted at once and every return value is posted with `say`,
   *   unless inline replies are on: then the first string returned within the window is
   *   answered inline for Sabha to post.
   * - Any other event waits for its handlers within the accept window, so a `RetryLater`
   *   can ask Sabha to send it again.
   */
  async dispatch(event: SabhaEvent, runtime: Runtime<Env>, options: { inline: boolean; claimed?: boolean; answerBy?: number }): Promise<Answer | undefined> {
    const key = eventKey(event);
    if (key && !options.claimed && !this.seen.claim(key)) {
      runtime.logger.info("skipped a repeated event", { event: event.event, key });
      return undefined;
    }
    const routes = this.routes.map((route, index) => ({ route, index })).filter(({ route }) => route.event === event.event && route.matches(event));
    if (routes.length === 0) return undefined;
    if (await this.isOwnEcho(event, runtime)) return undefined;

    const runs = routes.map(({ route, index }) => this.run(route, index, event, key, runtime));
    const settledAll = Promise.all(runs);
    // A host may end the request before the window does; the handlers keep running.
    runtime.waitUntil(settledAll);
    const deliverEach = (skip: number) =>
      runs.forEach((run, position) => {
        if (position !== skip) runtime.waitUntil(run.then((outcome) => this.deliverOutcome(event, outcome, routes[position]!.index, key, runtime)));
      });

    if (event.event !== "command" && !REPLY_EVENTS.has(event.event)) {
      const outcomes = options.inline ? await within(settledAll, capped(this.options.acceptWindowMs, options.answerBy)) : await settledAll;
      if (outcomes !== "timeout" && outcomes.some((outcome) => !outcome.ok && outcome.error instanceof RetryLater) && options.inline && !UNRETRIED_EVENTS.has(event.event)) {
        if (key) this.seen.release(key);
        runtime.logger.info("a handler asked Sabha to retry", { event: event.event, key });
        return { status: 503 };
      }
      deliverEach(-1);
      return options.inline ? { status: 200, text: "" } : undefined;
    }

    const replies = options.inline && REPLY_EVENTS.has(event.event) && (await this.repliesInline(runtime, options.answerBy));
    const window = event.event === "command" ? this.options.commandWindowMs : replies ? this.options.replyWindowMs : undefined;
    const capWindow = window === undefined ? undefined : capped(window, options.answerBy);
    let index = -1;
    if (capWindow !== undefined) {
      const picked = await within(this.firstQuick(runs, event, replies), capWindow);
      if (picked !== "timeout") index = picked;
    }
    const value = index >= 0 ? (runs[index] ? ((await runs[index]) as { value: HandlerResult }).value : undefined) : undefined;
    let answer: Answer | undefined;
    if (index >= 0 && options.inline) answer = this.toAnswer(event, value);
    else if (index >= 0 && event.event === "command") {
      // Over the socket the quick answer goes back on the socket, when it can.
      const quick = this.toAnswer(event, value);
      if (!(quick && "json" in quick && runtime.answerCommand?.(event.id, quick.json))) index = -1;
    }
    deliverEach(index);
    return options.inline ? (answer ?? { status: 200, text: "" }) : undefined;
  }

  /** The position of the first run to settle with a value that can be the inline answer, or -1. */
  private firstQuick(runs: Promise<Outcome>[], event: SabhaEvent, replies: boolean): Promise<number> {
    return new Promise((resolve) => {
      let left = runs.length;
      runs.forEach((run, position) =>
        run.then((outcome) => {
          if (outcome.ok && this.inlineable(event, outcome.value, replies)) resolve(position);
          else if (--left === 0) resolve(-1);
        }),
      );
    });
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
            stableId: (key) => stableId(runtime.env.SABHA_API_KEY, `app:${key}`),
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

  /**
   * Whether Sabha will post an inline reply to this delivery. Its wait says so: a delivery it
   * will post a reply to waits longer than one it only hands over. Without that, it will when
   * the key holds `post`.
   */
  private async repliesInline(runtime: Runtime<Env>, answerBy: number | undefined): Promise<boolean> {
    if (this.options.inlineReplies !== undefined) return this.options.inlineReplies;
    if (answerBy !== undefined) return answerBy - Date.now() > ACCEPT_WAIT_MS;
    return (await this.profileOf(runtime))?.permissions?.includes("post") ?? false;
  }

  /**
   * The app's id and permissions from `GET /me`, read once a few minutes per key, so an
   * admin's change of permissions reaches a long-lived host. Undefined while it can't be read.
   */
  private async profileOf(runtime: Runtime<Env>): Promise<Profile | undefined> {
    const cacheKey = runtime.env.SABHA_BASE_URL + runtime.env.SABHA_API_KEY;
    let entry = this.profiles.get(cacheKey);
    if (!entry || Date.now() - entry.at > PROFILE_FOR_MS) {
      const profile = runtime.client.me().then(
        (me) => ({ id: me.id, permissions: me.permissions }),
        (error) => {
          runtime.logger.warn("couldn't read the app's profile", { error: describeError(error, secretsOf(runtime.env)) });
          if (this.profiles.get(cacheKey)?.profile === profile) this.profiles.delete(cacheKey);
          return undefined;
        },
      );
      entry = { at: Date.now(), profile };
      this.profiles.set(cacheKey, entry);
    }
    const profile = await within(entry.profile, SELF_LOOKUP_MS);
    if (profile !== "timeout") return profile;
    if (this.profiles.get(cacheKey) === entry) this.profiles.delete(cacheKey);
    return undefined;
  }

  /**
   * Sabha may send the app its own messages and reactions; never answer them. While the app's
   * own id can't be read, an event from any app is treated as its own, so it never answers itself.
   */
  private async isOwnEcho(event: SabhaEvent, runtime: Runtime<Env>): Promise<boolean> {
    if (event.event === "command" || event.event === "block_actions" || event.event === "user_created" || event.event === "user_deleted") return false;
    const profile = await this.profileOf(runtime);
    if (!profile) return (event.user as { role?: string }).role === "bot";
    return profile.id === event.user.id;
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

  /** Whether a return value can be the inline answer to this event. */
  private inlineable(event: SabhaEvent, value: HandlerResult, replies: boolean): boolean {
    if (value === undefined || value === null) return false;
    if (event.event === "command") return true;
    // Inline text is the message body as Sabha stores it; anything richer goes through `say`.
    return replies && typeof value === "string";
  }

  private toAnswer(event: SabhaEvent, value: HandlerResult): Answer | undefined {
    if (value === undefined || value === null) return undefined;
    if (event.event === "command") return { status: 200, json: typeof value === "string" ? { text: value } : { ...value } };
    return { status: 200, text: typeof value === "string" ? value : String(value.text) };
  }

  /** Sends one handler's return value, if it has one, unless it was the inline answer. */
  private async deliverOutcome(event: SabhaEvent, outcome: Outcome, index: number, key: string | undefined, runtime: Runtime<Env>): Promise<void> {
    if (!outcome.ok) {
      if (outcome.error instanceof RetryLater) runtime.logger.warn("RetryLater ignored: too late, or Sabha doesn't retry this event", { event: event.event, transport: runtime.transport });
      return;
    }
    if (outcome.value === undefined || outcome.value === null) return;
    try {
      await this.deliver(event, outcome.value, index, key, runtime);
    } catch (error) {
      runtime.logger.error("couldn't deliver a handler's answer", { event: event.event, error: describeError(error, secretsOf(runtime.env)) });
    }
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
      // Prefixed, so an app's own keys can never match the kit's ids for say and drafts.
      stableId: (stableKey: string) => stableId(env.SABHA_API_KEY, `app:${stableKey}`),
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
