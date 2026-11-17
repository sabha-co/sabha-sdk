import type { components } from "./generated/api.js";

type Schemas = components["schemas"];

export type MessageEvent = Schemas["MessageEvent"];
export type ReactionEvent = Schemas["ReactionEvent"];
export type CommandEvent = Schemas["CommandEvent"];
export type BlockActionsEvent = Schemas["BlockActionsEvent"];
export type UserEvent = Schemas["UserEvent"];
export type EventMessage = Schemas["EventMessage"];
export type EventRoom = Schemas["EventRoom"];
export type EventUser = Schemas["EventUser"];
export type Message = Schemas["Message"];
export type Blocks = Schemas["Blocks"];

export type SabhaEvent = MessageEvent | ReactionEvent | CommandEvent | BlockActionsEvent | UserEvent;
export type EventName = SabhaEvent["event"];

/** The payload of one event name, with `event` narrowed to that name. */
export type EventOf<N extends EventName> = N extends MessageEvent["event"]
  ? MessageEvent & { event: N }
  : N extends ReactionEvent["event"]
    ? ReactionEvent & { event: N }
    : N extends UserEvent["event"]
      ? UserEvent & { event: N }
      : N extends "command"
        ? CommandEvent
        : BlockActionsEvent;

export const EVENT_NAMES: readonly EventName[] = [
  "message_created",
  "message_updated",
  "message_deleted",
  "reaction_created",
  "reaction_deleted",
  "command",
  "block_actions",
  "user_created",
  "user_deleted",
];

/** Where a message sits, from `room.type`: a forum post's replies are `post`, not `thread`. */
export type Place = "dm" | "thread" | "room" | "post";

export function placeOf(room: Pick<EventRoom, "type">): Place | undefined {
  switch (room.type) {
    case "Direct":
      return "dm";
    case "Thread":
      return "thread";
    case "Post":
      return "post";
    case "Open":
    case "Closed":
    case "Forum":
      return "room";
    default:
      return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class EventShapeError extends Error {
  constructor(detail: string) {
    super(`Sabha event is malformed: ${detail}`);
    this.name = "EventShapeError";
  }
}

/** Checks the fields the kit relies on. An unknown event name passes through, so a new Sabha event never breaks an app. */
export function parseEvent(raw: unknown): SabhaEvent {
  if (!isRecord(raw) || typeof raw.event !== "string") throw new EventShapeError("missing event name");
  const has = (value: unknown, field: string) => isRecord(value) && value[field] !== undefined;
  switch (raw.event) {
    case "message_created":
    case "message_updated":
    case "message_deleted":
    case "reaction_created":
    case "reaction_deleted":
      if (!has(raw.message, "id") || !has(raw.room, "id") || !has(raw.user, "id")) {
        throw new EventShapeError(`${raw.event} without message, room or user`);
      }
      if (raw.event.startsWith("reaction") && !has(raw.reaction, "id")) throw new EventShapeError(`${raw.event} without reaction`);
      break;
    case "command":
      if (typeof raw.id !== "string" || typeof raw.command !== "string" || typeof raw.response_url !== "string") {
        throw new EventShapeError("command without id, command or response_url");
      }
      break;
    case "block_actions":
      if (typeof raw.id !== "string" || !Array.isArray(raw.actions) || typeof raw.response_url !== "string") {
        throw new EventShapeError("block_actions without id, actions or response_url");
      }
      break;
    case "user_created":
    case "user_deleted":
      if (!has(raw.user, "id")) throw new EventShapeError(`${raw.event} without user`);
      break;
  }
  return raw as unknown as SabhaEvent;
}

/**
 * The identity of an event across redeliveries. Sabha mints a new delivery id on every retry
 * and message and reaction events carry no id of their own, so the key is built from what the
 * event is about. An edit is keyed by its time, so each edit is its own event.
 */
export function eventKey(event: SabhaEvent): string | undefined {
  switch (event.event) {
    case "message_created":
      return `message:${event.message.id}`;
    case "message_updated":
      return `edit:${event.message.id}:${event.message.updated_at}`;
    case "message_deleted":
      return `delete:${event.message.id}`;
    case "reaction_created":
      return `react:${event.reaction.id}`;
    case "reaction_deleted":
      return `unreact:${event.reaction.id}`;
    case "command":
      return `command:${event.id}`;
    case "block_actions":
      return `action:${event.id}`;
    case "user_created":
    case "user_deleted":
      return `${event.event}:${event.user.id}`;
    default:
      return undefined;
  }
}

/** The person behind an event. */
export function actorOf(event: SabhaEvent): { id: number; name: string } {
  if (event.event === "command") return { id: event.user_id, name: event.user_name };
  return { id: event.user.id, name: event.user.name };
}

/** The room an event happened in, when it has one. */
export function roomIdOf(event: SabhaEvent): number | undefined {
  switch (event.event) {
    case "command":
      return event.room_id;
    case "user_created":
    case "user_deleted":
      return undefined;
    default:
      return event.room.id;
  }
}
