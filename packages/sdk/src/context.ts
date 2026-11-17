import type { InteractionResponse, PostOptions, Posted, SabhaClient } from "./client.js";
import type {
  BlockActionsEvent,
  CommandEvent,
  EventMessage,
  EventName,
  EventOf,
  EventRoom,
  MessageEvent,
  ReactionEvent,
} from "./events.js";
import type { Logger } from "./log.js";

/** The settings every app reads. A host passes its own env, which carries these. */
export interface SabhaEnv {
  /** The workspace's URL: `https://chat.example.com`, or `https://sabha.co/1000001` under SaaS. */
  SABHA_BASE_URL: string;
  SABHA_API_KEY: string;
  SABHA_SIGNING_SECRET?: string;
  SABHA_SOCKET_URL?: string;
  /** `socket` takes events over the socket; anything else, webhooks. */
  TRANSPORT?: string;
}

/** What a host gives the SDK for one event: where to call, and how to keep work alive. */
export interface Runtime<Env extends SabhaEnv = SabhaEnv> {
  env: Env;
  client: SabhaClient;
  logger: Logger;
  transport: "webhook" | "socket";
  /** Keeps work running after the response is sent. */
  waitUntil(promise: Promise<unknown>): void;
  /** Socket only: sends a command's inline answer. False when the socket is gone. */
  answerCommand?(id: string, answer: Record<string, unknown>): boolean;
}

export type SayOptions = Omit<PostOptions, "clientMessageId" | "parentMessageId"> & {
  /** Posts in the thread under the event's message, instead of beside it. */
  thread?: boolean;
};

/** A live draft of a reply. `finish` posts it in place of the draft. */
export interface Draft {
  readonly id: string;
  update(update: { text?: string; activity?: string }): Promise<void>;
  finish(message: string | Omit<SayOptions, "thread">): Promise<Posted>;
  end(): Promise<void>;
}

export interface BaseContext<N extends EventName, Env extends SabhaEnv> {
  event: EventOf<N>;
  /** The event's identity across redeliveries; key outside side effects on it. */
  eventKey: string | undefined;
  /** The person behind the event. */
  user: { id: number; name: string };
  env: Env;
  client: SabhaClient;
  logger: Logger;
  transport: "webhook" | "socket";
  /** A client message id that is the same every time for `key`, and unique to this app. */
  stableId(key: string): Promise<string>;
  /**
   * Posts where the event happened. A redelivery's repeated `say` returns the first post, so
   * it never posts twice.
   */
  say(message: string | SayOptions): Promise<Posted>;
  /** Shows a status line (`null` clears it) where the event happened. */
  status(text: string | null, options?: { thread?: boolean }): Promise<void>;
  /** Opens a live draft where the event happened. */
  draft(options?: { thread?: boolean }): Promise<Draft>;
}

type Respond = { respond(response: InteractionResponse | string): Promise<unknown> };

type Extras<N extends EventName> = N extends MessageEvent["event"]
  ? { message: EventMessage; room: EventRoom }
  : N extends ReactionEvent["event"]
    ? { message: EventMessage; room: EventRoom; reaction: ReactionEvent["reaction"] }
    : N extends "command"
      ? { command: CommandEvent } & Respond
      : N extends "block_actions"
        ? { action: BlockActionsEvent["actions"][number]; actions: BlockActionsEvent["actions"] } & Respond
        : unknown;

export type Context<N extends EventName = EventName, Env extends SabhaEnv = SabhaEnv> = BaseContext<N, Env> & Extras<N>;

/** What a handler may return: text or a message to answer with, or nothing. */
export type HandlerResult = string | InteractionResponse | void | undefined | null;

export type Handler<N extends EventName, Env extends SabhaEnv> = (context: Context<N, Env>) => HandlerResult | Promise<HandlerResult>;
