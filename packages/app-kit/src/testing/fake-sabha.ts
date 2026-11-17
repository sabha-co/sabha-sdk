import type { FetchLike } from "../client.js";

export interface FakeMessage {
  id: number;
  room_id: number;
  body: string;
  creator: { id: number; name: string };
  created_at: string;
  parent_message_id?: number;
  client_message_id?: string;
  deleted?: boolean;
  /** The thread room under this message, once it has replies. */
  thread_room_id?: number;
}

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | null;
}

/**
 * A stand-in for Sabha's apps API, as a `fetch`. It records every call and keeps messages the
 * way Sabha does: a repeated `client_message_id` from the same app answers 200 with the first
 * post (even one deleted since, or in another room), another app's id answers 422, and
 * listings are newest first with a `next_cursor`.
 */
export class FakeSabha {
  readonly calls: FakeCall[] = [];
  readonly messages: FakeMessage[] = [];
  /** Answers to queue for the next matching call, such as a 429. */
  readonly scripted: { method: string; path: RegExp; response: () => Response }[] = [];
  private nextId = 1000;
  private clock: number;
  private readonly apps = new Map<string, { id: number; name: string; permissions: string[] }>();

  constructor(options: { now?: number } = {}) {
    this.clock = options.now ?? Date.parse("2026-11-16T09:00:00Z");
  }

  /**
   * Registers an app key, so posts made with it are by that app. Its permissions default to a
   * new app's in Sabha: `post`, `read_messages` and `read_directory`.
   */
  app(key: string, profile: { id: number; name: string; permissions?: string[] }): this {
    this.apps.set(key, { permissions: ["post", "read_messages", "read_directory"], ...profile });
    return this;
  }

  /** Adds a message as if a person (or app) posted it. `at` is milliseconds. */
  seed(message: { room_id: number; body: string; creator: { id: number; name: string }; parent_message_id?: number; at?: number }): FakeMessage {
    return this.store({ ...message, created_at: new Date(message.at ?? this.tick()).toISOString() });
  }

  /** Adds a reply in a message's thread, as if a person posted it. */
  reply(parentId: number, message: { body: string; creator: { id: number; name: string }; at?: number }): FakeMessage {
    return this.seed({ ...message, room_id: this.threadRoomOf(parentId), parent_message_id: parentId });
  }

  /** Sets the clock: what Sabha stamps the next post with, a second later. */
  setNow(ms: number): this {
    this.clock = ms - 1_000;
    return this;
  }

  edit(id: number, body: string): void {
    const message = this.messages.find((candidate) => candidate.id === id);
    if (message) message.body = body;
  }

  remove(id: number): void {
    const message = this.messages.find((candidate) => candidate.id === id);
    if (message) message.deleted = true;
  }

  /** Messages still showing in a room, oldest first. */
  visible(roomId: number): FakeMessage[] {
    return this.messages.filter((message) => message.room_id === roomId && !message.deleted);
  }

  readonly fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? safeJson(init.body) : init.body ?? undefined;
    this.calls.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, authorization: headers.get("Authorization") });

    const scripted = this.scripted.findIndex((entry) => entry.method === method && entry.path.test(url.pathname));
    if (scripted >= 0) return this.scripted.splice(scripted, 1)[0]!.response();

    const key = headers.get("Authorization")?.replace(/^Bearer /, "");
    const me = key ? this.apps.get(key) : undefined;
    return this.answer(method, url, body as Record<string, unknown> | undefined, me);
  };

  private answer(method: string, url: URL, body: Record<string, unknown> | undefined, me: { id: number; name: string } | undefined): Response {
    const path = url.pathname;
    let match: RegExpExecArray | null;

    if (path.startsWith("/api/v1/") && !me && !path.endsWith("/interaction_responses")) return error(401, "unauthorized");

    if (method === "GET" && path === "/api/v1/me") return Response.json({ ...me, workspace: { name: "Test", url: "https://sabha.test" } });

    if (method === "POST" && (match = /^\/api\/v1\/rooms\/(\d+)\/messages$/.exec(path))) {
      const roomId = Number(match[1]);
      const clientMessageId = body?.client_message_id as string | undefined;
      if (clientMessageId) {
        const earlier = this.messages.find((message) => message.client_message_id === clientMessageId);
        if (earlier && earlier.creator.id !== me!.id) return error(422, "validation_failed", "client_message_id is already taken");
        if (earlier) return Response.json({ id: earlier.id, room_id: earlier.room_id }, { status: 200 });
      }
      const parentId = body?.parent_message_id as number | undefined;
      const message = this.store({
        room_id: parentId ? this.threadRoomOf(parentId) : roomId,
        body: String(body?.body ?? body?.text ?? ""),
        creator: me!,
        created_at: new Date(this.tick()).toISOString(),
        ...(parentId ? { parent_message_id: parentId } : {}),
        ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
      });
      return Response.json({ id: message.id, room_id: message.room_id }, { status: 201 });
    }

    if (method === "GET" && (match = /^\/api\/v1\/rooms\/(\d+)\/messages$/.exec(path))) {
      const roomId = Number(match[1]);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
      const before = url.searchParams.get("before");
      const all = this.visible(roomId).slice().reverse();
      const start = before ? all.findIndex((message) => String(message.id) === before) + 1 : 0;
      const page = all.slice(start, start + limit);
      const hasMore = start + limit < all.length;
      return Response.json({ results: page.map((message) => this.render(message)), has_more: hasMore, next_cursor: hasMore ? String(page.at(-1)!.id) : null });
    }

    if ((match = /^\/api\/v1\/messages\/(\d+)$/.exec(path))) {
      const message = this.messages.find((candidate) => candidate.id === Number(match![1]) && !candidate.deleted);
      if (!message) return error(404, "not_found");
      if (method === "GET") return Response.json(this.render(message));
      if (method === "DELETE") {
        message.deleted = true;
        return new Response(null, { status: 204 });
      }
      if (method === "PATCH") {
        message.body = String(body?.body ?? message.body);
        return Response.json(this.render(message));
      }
    }

    if (path === "/api/v1/interaction_responses" && method === "POST") return Response.json({ ok: true });
    if ((match = /^\/api\/v1\/rooms\/(\d+)\/status$/.exec(path))) return method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ draft_id: crypto.randomUUID() });
    if ((match = /^\/api\/v1\/rooms\/(\d+)\/drafts$/.exec(path))) return Response.json({ draft_id: body?.draft_id }, { status: 201 });
    if (/^\/api\/v1\/drafts\//.test(path)) return new Response(null, { status: 204 });

    return error(404, "not_found");
  }

  private store(message: Omit<FakeMessage, "id">): FakeMessage {
    const stored = { ...message, id: this.nextId++ };
    this.messages.push(stored);
    return stored;
  }

  private threadRoomOf(parentId: number): number {
    const parent = this.messages.find((message) => message.id === parentId);
    if (!parent) return 0;
    parent.thread_room_id ??= 900_000 + parent.id;
    return parent.thread_room_id;
  }

  private render(message: FakeMessage) {
    const replies = message.thread_room_id
      ? { room_id: message.thread_room_id, count: this.visible(message.thread_room_id).length }
      : null;
    return {
      id: message.id,
      room_id: message.room_id,
      body: { plain: message.body, html: message.body, markdown: message.body },
      creator: message.creator,
      created_at: message.created_at,
      replies,
      thread: message.parent_message_id ? { id: message.room_id, parent_message_id: message.parent_message_id, parent_room_id: 0 } : null,
      attachment: null,
      url: `https://sabha.test/messages/${message.id}`,
      mentionees: [],
    };
  }

  private tick(): number {
    this.clock += 1_000;
    return this.clock;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function error(status: number, code: string, message = code): Response {
  return Response.json({ error: message, code }, { status });
}
