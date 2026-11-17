import type { BlockActionsEvent, CommandEvent, MessageEvent, ReactionEvent, UserEvent } from "../events.js";

const room = { id: 10, name: "engineering", type: "Open", has_app: true, members: 5, messages_url: "https://sabha.test/api/v1/rooms/10/messages" };
const user = { id: 7, name: "Asha", role: "member", url: "https://sabha.test/users/7" };

export function messageEvent(overrides: Omit<Partial<MessageEvent>, "message"> & { message?: Partial<MessageEvent["message"]> } = {}): MessageEvent {
  const { message, ...rest } = overrides;
  const event = rest.event ?? "message_created";
  const messageId = message?.id ?? 501;
  return {
    event,
    // Sabha's ids are UUIDs; a readable one per message and edit is enough for tests.
    id: `evt-${event}-${messageId}-${message?.updated_at ?? ""}`,
    mentions_app: true,
    room,
    user,
    ...rest,
    message: {
      id: 501,
      body: { plain: "@app hello", html: "<p>@app hello</p>", markdown: "@app hello" },
      attachment: null,
      has_attachment: false,
      mentionees: [],
      replies: null,
      thread: null,
      created_at: "2026-11-16T09:00:00Z",
      updated_at: "2026-11-16T09:00:00Z",
      url: "https://sabha.test/rooms/10/@501",
      ...message,
    },
  };
}

export function reactionEvent(overrides: Partial<ReactionEvent> = {}): ReactionEvent {
  const base = messageEvent();
  const event = overrides.event ?? "reaction_created";
  const reaction = overrides.reaction ?? { id: 77, body: "👍" };
  return { event, id: `evt-${event}-${reaction.id}`, room, user, message: base.message, reaction, ...overrides };
}

export function commandEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    event: "command",
    id: "cmd-1",
    command: "/ticket",
    text: "printer is on fire",
    response_url: "https://sabha.test/api/v1/interaction_responses?token=secret-token",
    room_id: 10,
    room_name: "engineering",
    user_id: 7,
    user_name: "Asha",
    ...overrides,
  };
}

export function blockActionsEvent(overrides: Partial<BlockActionsEvent> = {}): BlockActionsEvent {
  return {
    event: "block_actions",
    id: "act-1",
    actions: [{ action_id: "approve", block_id: "b1", type: "button", value: "deploy-42" }],
    message: { id: 501, url: "https://sabha.test/rooms/10/@501" },
    response_url: "https://sabha.test/api/v1/interaction_responses?token=secret-token",
    room: { id: 10, name: "engineering" },
    user: { id: 7, name: "Asha", role: "member" },
    ...overrides,
  };
}

export function userEvent(overrides: Partial<UserEvent> = {}): UserEvent {
  const event = overrides.event ?? "user_created";
  return { event, id: `evt-${event}-${(overrides.user ?? user).id}`, user, ...overrides };
}
