import type { components, operations } from "./generated/api.js";
import { SabhaApiError } from "./errors.js";
import type { Blocks, Message } from "./events.js";
import { consoleLogger, type Logger } from "./log.js";

type Json<O extends keyof operations, S extends number = 200> = operations[O]["responses"] extends Record<S, { content: { "application/json": infer B } }> ? B : never;

export type Posted = components["schemas"]["Posted"];
export type MessagePage = Json<"messages_index">;
export type Me = Json<"profiles_show">;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** The workspace's own URL: `https://chat.example.com`, or `https://sabha.co/1000001` under SaaS. */
  baseUrl: string;
  apiKey: string;
  /** Overrides the socket URL derived from `baseUrl`, for installs that serve it from another host. */
  socketUrl?: string;
  fetch?: FetchLike;
  logger?: Logger;
  /** How many times a call is tried before it fails. */
  attempts?: number;
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PostOptions {
  /** HTML or plain text. Use `text` for Slack mrkdwn instead. */
  body?: string;
  text?: string;
  blocks?: Blocks | unknown[];
  /** Posts in the thread under this message. */
  parentMessageId?: number;
  /** Makes a retried post safe: a repeat returns the first post. See `stableId`. */
  clientMessageId?: string;
}

export interface Reply {
  text?: string;
  blocks?: Blocks | unknown[];
}

export interface InteractionResponse extends Reply {
  response_type?: "in_channel" | "ephemeral";
  replace_original?: boolean;
  delete_original?: boolean;
}

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Each apps API operation and the client method that covers it, so a new one shows up in tests. */
export const COVERED_OPERATIONS = {
  specs_show: "spec",
  profiles_show: "me",
  profiles_update_patch: "updateProfile",
  profiles_update_put: "updateProfile",
  profiles_icons_update_put: "setIcon",
  profiles_icons_update_patch: "setIcon",
  profiles_icons_destroy: "deleteIcon",
  profiles_commands_show: "commands",
  profiles_commands_update_patch: "setCommands",
  profiles_commands_update_put: "setCommands",
  rooms_index: "rooms",
  rooms_create: "createRoom",
  rooms_show: "room",
  rooms_update_patch: "renameRoom",
  rooms_update_put: "renameRoom",
  rooms_destroy: "deleteRoom",
  messages_index: "messages",
  messages_create: "post",
  ephemerals_create: "postPrivately",
  statuses_update_patch: "setStatus",
  statuses_update_put: "setStatus",
  statuses_destroy: "clearStatus",
  drafts_create: "openDraft",
  drafts_update_patch: "updateDraft",
  drafts_update_put: "updateDraft",
  drafts_destroy: "endDraft",
  members_index: "members",
  members_create: "addMember",
  members_destroy: "removeMember",
  memberships_create: "join",
  memberships_destroy: "leave",
  messages_show: "message",
  messages_update_patch: "editMessage",
  messages_update_put: "editMessage",
  messages_destroy: "deleteMessage",
  messages_reactions_index: "reactions",
  messages_reactions_create: "react",
  messages_reactions_destroy: "unreact",
  interaction_responses_create: "respond",
  direct_messages_create: "openDm",
  searches_show: "search",
  users_index: "users",
  users_show: "user",
  autocompletable_users_index: "findUsers",
  incoming_webhooks_create: "incomingWebhook",
  incoming_webhooks_create_mattermost: "incomingWebhook",
} as const satisfies Record<keyof operations, keyof SabhaClient>;

/** Sabha's apps API, over `fetch`. Retries what's safe to retry and never logs the key. */
export class SabhaClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly socketUrlOverride: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly attempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.socketUrlOverride = options.socketUrl;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.logger = options.logger ?? consoleLogger;
    this.attempts = options.attempts ?? 3;
    this.sleep = options.sleep ?? sleep;
  }

  /** Where the app's socket is: `/cable` on the install, with `?wid=` under SaaS. */
  get socketUrl(): string {
    if (this.socketUrlOverride) return this.socketUrlOverride;
    const url = new URL(this.baseUrl);
    const workspace = url.pathname.split("/").filter(Boolean)[0];
    const socket = new URL("/cable", url);
    socket.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    if (workspace && /^\d+$/.test(workspace)) socket.searchParams.set("wid", workspace);
    return socket.toString();
  }

  // Profile ------------------------------------------------------------------

  spec(): Promise<unknown> {
    return this.call("GET", "/api/v1/openapi.json", { auth: false });
  }

  me(): Promise<Me> {
    return this.call("GET", "/api/v1/me");
  }

  updateProfile(changes: { name?: string; webhook_url?: string | null; mentions_url?: string | null; everything_url?: string | null }): Promise<unknown> {
    return this.call("PATCH", "/api/v1/profile", { json: changes });
  }

  setIcon(image: Blob, filename = "icon.png"): Promise<unknown> {
    const form = new FormData();
    form.set("image", image, filename);
    return this.call("PUT", "/api/v1/profile/icon", { form });
  }

  deleteIcon(): Promise<unknown> {
    return this.call("DELETE", "/api/v1/profile/icon");
  }

  commands(): Promise<Json<"profiles_commands_show">> {
    return this.call("GET", "/api/v1/profile/commands");
  }

  setCommands(commands: { command: string; description?: string | null; usage_hint?: string | null }[]): Promise<unknown> {
    return this.call("PUT", "/api/v1/profile/commands", { json: { commands } });
  }

  // Messages -----------------------------------------------------------------

  /** Posts a message. A repeat of a `clientMessageId` returns the first post with `repeated: true`. */
  async post(roomId: number, message: PostOptions | string): Promise<Posted & { repeated: boolean }> {
    const options = typeof message === "string" ? { body: message } : message;
    const json: Record<string, unknown> = {};
    if (options.body !== undefined) json.body = options.body;
    if (options.text !== undefined) json.text = options.text;
    if (options.blocks !== undefined) json.blocks = options.blocks;
    if (options.parentMessageId !== undefined) json.parent_message_id = options.parentMessageId;
    if (options.clientMessageId !== undefined) json.client_message_id = options.clientMessageId;
    const response = await this.raw("POST", `/api/v1/rooms/${roomId}/messages`, { json });
    const posted = (await response.json()) as Posted;
    return { ...posted, repeated: response.status === 200 };
  }

  postPrivately(roomId: number, message: { userId: number; body?: string; text?: string; blocks?: Blocks | unknown[]; parentMessageId?: number }): Promise<unknown> {
    const { userId, parentMessageId, ...rest } = message;
    return this.call("POST", `/api/v1/rooms/${roomId}/ephemerals`, {
      json: { ...rest, user_id: userId, ...(parentMessageId === undefined ? {} : { parent_message_id: parentMessageId }) },
    });
  }

  message(id: number): Promise<Json<"messages_show">> {
    return this.call("GET", `/api/v1/messages/${id}`);
  }

  /** One page of a room's (or a thread's) messages, newest first. */
  messages(roomId: number, page: { before?: string; after?: string; limit?: number } = {}): Promise<MessagePage> {
    return this.call("GET", `/api/v1/rooms/${roomId}/messages`, { query: page });
  }

  /** Every message in a room (or thread), newest first, a page at a time; `break` to stop early. */
  async *allMessages(roomId: number, options: { after?: string; limit?: number } = {}): AsyncGenerator<Message> {
    let before: string | undefined;
    for (;;) {
      const page = await this.messages(roomId, { ...options, limit: options.limit ?? 200, ...(before ? { before } : {}) });
      for (const message of page.results) yield message;
      if (!page.has_more || !page.next_cursor) return;
      before = page.next_cursor;
    }
  }

  editMessage(id: number, changes: { body?: string; blocks?: Blocks | unknown[] }): Promise<unknown> {
    return this.call("PATCH", `/api/v1/messages/${id}`, { json: changes });
  }

  deleteMessage(id: number): Promise<unknown> {
    return this.call("DELETE", `/api/v1/messages/${id}`);
  }

  reactions(messageId: number): Promise<unknown> {
    return this.call("GET", `/api/v1/messages/${messageId}/reactions`);
  }

  react(messageId: number, emoji: string): Promise<{ id: number; content: string }> {
    return this.call("POST", `/api/v1/messages/${messageId}/reactions`, { json: { body: emoji } });
  }

  unreact(messageId: number, reactionId: number): Promise<unknown> {
    return this.call("DELETE", `/api/v1/messages/${messageId}/reactions/${reactionId}`);
  }

  // Statuses and drafts ------------------------------------------------------

  setStatus(roomId: number, status: string, options: { parentMessageId?: number } = {}): Promise<{ draft_id: string }> {
    return this.call("PUT", `/api/v1/rooms/${roomId}/status`, {
      json: { status, ...(options.parentMessageId === undefined ? {} : { parent_message_id: options.parentMessageId }) },
    });
  }

  clearStatus(roomId: number, options: { parentMessageId?: number } = {}): Promise<unknown> {
    return this.call("DELETE", `/api/v1/rooms/${roomId}/status`, {
      query: options.parentMessageId === undefined ? {} : { parent_message_id: options.parentMessageId },
    });
  }

  /** Opens a live draft. Finish it by posting with `clientMessageId` set to `draftId`. */
  openDraft(roomId: number, draftId: string, options: { parentMessageId?: number } = {}): Promise<{ draft_id: string }> {
    return this.call("POST", `/api/v1/rooms/${roomId}/drafts`, {
      json: { draft_id: draftId, ...(options.parentMessageId === undefined ? {} : { parent_message_id: options.parentMessageId }) },
    });
  }

  /** Replaces the draft's whole text so far, its activity line, or both. Send one update at a time. */
  updateDraft(draftId: string, update: { text?: string; activity?: string }): Promise<unknown> {
    return this.call("PATCH", `/api/v1/drafts/${draftId}`, { json: update });
  }

  endDraft(draftId: string): Promise<unknown> {
    return this.call("DELETE", `/api/v1/drafts/${draftId}`);
  }

  // Rooms, members and people ------------------------------------------------

  rooms(query: { joinable?: boolean; query?: string; page?: number; per_page?: number } = {}): Promise<unknown> {
    return this.call("GET", "/api/v1/rooms", { query });
  }

  room(id: number): Promise<unknown> {
    return this.call("GET", `/api/v1/rooms/${id}`);
  }

  createRoom(room: { name: string; type?: string }): Promise<unknown> {
    return this.call("POST", "/api/v1/rooms", { json: room });
  }

  renameRoom(id: number, name: string): Promise<unknown> {
    return this.call("PATCH", `/api/v1/rooms/${id}`, { json: { name } });
  }

  deleteRoom(id: number): Promise<unknown> {
    return this.call("DELETE", `/api/v1/rooms/${id}`);
  }

  members(roomId: number): Promise<unknown> {
    return this.call("GET", `/api/v1/rooms/${roomId}/members`);
  }

  addMember(roomId: number, userId: number): Promise<unknown> {
    return this.call("POST", `/api/v1/rooms/${roomId}/members`, { json: { user_id: userId } });
  }

  removeMember(roomId: number, userId: number): Promise<unknown> {
    return this.call("DELETE", `/api/v1/rooms/${roomId}/members/${userId}`);
  }

  join(roomId: number): Promise<unknown> {
    return this.call("POST", `/api/v1/rooms/${roomId}/membership`);
  }

  leave(roomId: number): Promise<unknown> {
    return this.call("DELETE", `/api/v1/rooms/${roomId}/membership`);
  }

  openDm(userIds: number[]): Promise<{ id: number } & Record<string, unknown>> {
    return this.call("POST", "/api/v1/direct_messages", { json: { user_ids: userIds } });
  }

  users(query: { room_id?: number; page?: number; per_page?: number } = {}): Promise<unknown> {
    return this.call("GET", "/api/v1/users", { query });
  }

  user(id: number, query: { room_id?: number } = {}): Promise<unknown> {
    return this.call("GET", `/api/v1/users/${id}`, { query });
  }

  findUsers(query: { query: string; room_id?: number }): Promise<unknown> {
    return this.call("GET", "/api/v1/autocompletable/users", { query });
  }

  search(query: { q: string; room_ids?: number[]; author_ids?: number[]; before?: string; after?: string; limit?: number }): Promise<unknown> {
    const { room_ids, author_ids, ...rest } = query;
    return this.call("GET", "/api/v1/search", { query: { ...rest, "room_ids[]": room_ids, "author_ids[]": author_ids } });
  }

  // Answers -------------------------------------------------------------------

  /**
   * Answers a command or a click through its `response_url`. The URL carries its own token, so
   * the app's key is not sent, and the URL is never logged.
   */
  respond(responseUrl: string, response: InteractionResponse | string): Promise<unknown> {
    const json = typeof response === "string" ? { text: response } : response;
    return this.call("POST", responseUrl, { json, auth: false, label: "response_url" });
  }

  /** Posts through an incoming webhook URL (write-only, no key). */
  incomingWebhook(url: string, message: { text?: string; blocks?: unknown[]; thread_ts?: string }, idempotencyKey?: string): Promise<unknown> {
    return this.call("POST", url, {
      json: message,
      auth: false,
      label: "incoming webhook",
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
    });
  }

  // Transport -----------------------------------------------------------------

  /** Any call, for an endpoint this client doesn't name yet. Answers the parsed JSON body. */
  async call<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(method, path, options);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** The raw response of a successful call; throws `SabhaApiError` otherwise. */
  async raw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const auth = options.auth ?? true;
    let url = this.urlFor(path, options.query);
    const label = options.label ?? `${new URL(url).pathname}`;
    let sendKey = auth;

    for (let attempt = 1; ; attempt++) {
      const init: RequestInit = { method, redirect: "manual", headers: { Accept: "application/json", ...options.headers } };
      const headers = init.headers as Record<string, string>;
      if (sendKey) headers.Authorization = `Bearer ${this.apiKey}`;
      if (options.json !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(options.json);
      } else if (options.form) {
        init.body = options.form;
      }

      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (error) {
        if (attempt >= this.attempts) throw error;
        await this.sleep(backoff(attempt));
        continue;
      }

      if (response.status === 301 || response.status === 308) {
        const location = response.headers.get("Location");
        if (!location || attempt >= this.attempts + 2) throw await apiError(response, method, label);
        const next = new URL(location, url);
        // The key goes only to the origin it was meant for.
        if (next.origin !== new URL(url).origin) sendKey = false;
        url = next.toString();
        continue;
      }
      if (response.ok) return response;

      const retryable = response.status === 429 || RETRYABLE_STATUSES.has(response.status);
      if (!retryable || attempt >= this.attempts) throw await apiError(response, method, label);
      const retryAfter = Number(response.headers.get("Retry-After"));
      const wait = response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : backoff(attempt);
      this.logger.warn("retrying a Sabha API call", { method, path: label, status: response.status, wait_ms: wait });
      await this.sleep(wait);
    }
  }

  private urlFor(path: string, query?: Record<string, unknown>): string {
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, String(item));
      else url.searchParams.set(name, String(value));
    }
    return url.toString();
  }
}

export interface RequestOptions {
  json?: unknown;
  form?: FormData;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** False for URLs that carry their own token, such as a response_url. */
  auth?: boolean;
  /** How the call is named in errors and logs, in place of its path. */
  label?: string;
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8_000) * (0.5 + Math.random() / 2);
}

async function apiError(response: Response, method: string, path: string): Promise<SabhaApiError> {
  let body: { code?: string; error?: string; needed?: string } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Not JSON; the status says enough.
  }
  return new SabhaApiError({ status: response.status, method, path, ...body });
}
