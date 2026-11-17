// One app's connection to Sabha's AppEventsChannel, on AnyCable's extended protocol so a
// reconnect can ask for the events it missed. It reconnects by itself, with capped, jittered
// backoff, until stopped. Lifted from openclaw-sabha's cable socket, with the transport
// injected so a Worker, a Durable Object and Node can each open the socket their own way.
import { eventKey, parseEvent, type SabhaEvent } from "../events.js";
import { consoleLogger, type Logger } from "../log.js";

export const APP_EVENTS_IDENTIFIER = JSON.stringify({ channel: "AppEventsChannel" });
export const CABLE_PROTOCOL = "actioncable-v1-ext-json";

/** The parts of a WebSocket the client uses; the standard one, a Worker's and Node's all fit. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
}

/**
 * Opens the socket. The key must travel as a header on the handshake: Sabha never accepts it
 * in the URL. A rejected handshake throws `CableRejectedError` for 401 or 403. `signal` aborts
 * a handshake that takes too long or is no longer wanted.
 */
export type Connect = (url: string, options: { headers: Record<string, string>; protocol: string; signal?: AbortSignal }) => Promise<WebSocketLike>;

export interface StreamPosition {
  epoch: string;
  offset: number;
}

export interface EventMeta {
  streamId?: string;
  epoch?: string;
  offset?: number;
  /** Sabha sent it again from history, after a reconnect. */
  replayed?: boolean;
}

/**
 * Where the socket resumes from, and which events it has already taken. `begin` records an
 * event's key and position in one step, before its handlers run, so a host that restarts
 * mid-event never runs it twice: delivery is at most once.
 */
export interface ReplayStore {
  load(): Promise<{ positions: Record<string, StreamPosition>; aliveAt?: number }>;
  /** Moves the stream's position on; false when the event was already taken. */
  begin(key: string | undefined, meta: EventMeta): Promise<boolean>;
  /** The socket was up and current at this time (UNIX seconds); a replay starts here. */
  alive(at: number): Promise<void>;
  /** Sabha refused the saved positions; start over from time. */
  forget(): Promise<void>;
}

/**
 * A replay store that lives as long as the process: enough for tests, and for a Node host that
 * accepts losing what Sabha sends while it restarts.
 */
export class MemoryReplayStore implements ReplayStore {
  readonly positions: Record<string, StreamPosition> = {};
  readonly keys = new Set<string>();
  aliveAt: number | undefined;

  async load() {
    return { positions: { ...this.positions }, ...(this.aliveAt === undefined ? {} : { aliveAt: this.aliveAt }) };
  }

  async begin(key: string | undefined, meta: EventMeta): Promise<boolean> {
    // A repeat still moves the position on, so a reconnect doesn't ask for it again.
    advance(this.positions, meta);
    if (key === undefined) return true;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > 5_000) this.keys.delete(this.keys.values().next().value!);
    return true;
  }

  async alive(at: number) {
    this.aliveAt = at;
  }

  async forget() {
    for (const stream of Object.keys(this.positions)) delete this.positions[stream];
  }
}

/** Moves a stream's position forward to `meta`, if it is newer. */
export function advance(positions: Record<string, StreamPosition>, meta: EventMeta): boolean {
  if (!meta.streamId || !meta.epoch || typeof meta.offset !== "number") return false;
  const known = positions[meta.streamId];
  if (known && known.epoch === meta.epoch && meta.offset <= known.offset) return false;
  positions[meta.streamId] = { epoch: meta.epoch, offset: meta.offset };
  return true;
}

export class CableRejectedError extends Error {
  constructor(detail: string) {
    super(`Sabha refused the app's socket (${detail}); check the app key`);
    this.name = "CableRejectedError";
  }
}

export interface CableTimeouts {
  /** Opening the socket and Sabha's welcome, each. */
  handshakeMs: number;
  /** No subscription confirmed after the welcome. */
  subscribeMs: number;
  /** No frame at all; Sabha pings every 3 s, so silence means a dead path. */
  silenceMs: number;
}

export const DEFAULT_TIMEOUTS: CableTimeouts = { handshakeMs: 10_000, subscribeMs: 10_000, silenceMs: 10_000 };

/** How long Sabha keeps events to replay. */
const HISTORY_SECONDS = 300;
/** How often a live socket records that it's current. */
const ALIVE_EVERY_MS = 60_000;
/** A session up this long resets the backoff. */
const STEADY_MS = 60_000;
/** An answer goes on the socket only if a frame came this recently; otherwise through the API. */
const FRESH_MS = 5_000;

export interface CableClientOptions {
  url: string;
  apiKey: string;
  connect: Connect;
  store?: ReplayStore;
  /** Runs an event's handlers. The client doesn't wait for it before reading the next frame. */
  onEvent(event: SabhaEvent, meta: EventMeta): void | Promise<void>;
  /** Some events may be lost: the app was away longer than Sabha keeps them, or Sabha couldn't replay them. */
  onGap?(reason: string): void;
  /** Sabha refused an `answer` or `draft` the app sent. */
  onRefusal?(frame: Record<string, unknown>): void;
  /** The subscription is confirmed (true) or the socket closed (false). */
  onStatus?(connected: boolean): void;
  logger?: Logger;
  timeouts?: Partial<CableTimeouts>;
  /** The most a reconnect waits. */
  maxBackoffMs?: number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

type Frame = {
  type?: string;
  identifier?: string;
  message?: unknown;
  reason?: string;
  reconnect?: boolean;
  stream_id?: string;
  epoch?: string;
  offset?: number;
};

type Outcome = { readyMs: number; terminal?: Error };

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}

function closeQuietly(socket: WebSocketLike, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed or closing.
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** The delay before reconnect attempt `attempt` (from 0): 1 s, then full jitter over a doubling window, capped. */
export function backoffDelay(attempt: number, maxMs: number, random: () => number = Math.random): number {
  return Math.min(maxMs, 1_000 + Math.floor(random() * Math.min(maxMs, 1_000 * 2 ** attempt)));
}

/** A self-reconnecting socket to AppEventsChannel. */
export class CableClient {
  private readonly options: CableClientOptions;
  private readonly timeouts: CableTimeouts;
  private readonly logger: Logger;
  private readonly store: ReplayStore;
  private readonly stopping = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private socket: WebSocketLike | undefined;
  private ready = false;
  private lastFrame = 0;
  private running: Promise<void> | undefined;

  constructor(options: CableClientOptions) {
    this.options = options;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.logger = options.logger ?? consoleLogger;
    this.store = options.store ?? new MemoryReplayStore();
  }

  /** Whether the subscription is confirmed and the socket open. */
  get connected(): boolean {
    return this.ready;
  }

  /** When the last frame arrived (ms), or 0; a watchdog can tell a stuck client from it. */
  get lastFrameAt(): number {
    return this.lastFrame;
  }

  /** Starts the connect-and-reconnect loop; returns the running loop, once. It never rejects. */
  start(): Promise<void> {
    this.running ??= this.loop().catch((error: unknown) => {
      this.logger.error("the socket loop stopped", { error: messageOf(error) });
    });
    return this.running;
  }

  /** Closes the socket and stops reconnecting. */
  stop(): void {
    this.stopping.abort();
    if (this.socket) closeQuietly(this.socket, 1000, "stopping");
  }

  /** Keeps a handler's work in view, so `drain` can wait for it. */
  track(promise: Promise<unknown>): void {
    this.inflight.add(promise);
    void promise.catch(() => undefined).finally(() => this.inflight.delete(promise));
  }

  /** Waits for handlers still running, up to `ms`. */
  async drain(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimer(timer);
  }

  /**
   * Sends a channel action, such as `answer` or `draft`. False when the socket isn't ready or
   * has gone quiet, so the caller can use the API instead.
   */
  perform(action: string, data: Record<string, unknown>): boolean {
    const now = this.options.now ?? Date.now;
    if (!this.socket || !this.ready || now() - this.lastFrame > FRESH_MS) return false;
    try {
      this.socket.send(JSON.stringify({ command: "message", identifier: APP_EVENTS_IDENTIFIER, data: JSON.stringify({ ...data, action }) }));
      return true;
    } catch {
      return false;
    }
  }

  private notify(name: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.logger.error(`the app's ${name} callback failed`, { error: messageOf(error) });
    }
  }

  private quietly(name: string, work: Promise<unknown>): void {
    work.catch((error: unknown) => this.logger.error(`couldn't ${name}`, { error: messageOf(error) }));
  }

  private async loop(): Promise<void> {
    const sleep = this.options.sleep ?? abortableSleep;
    let attempt = 0;
    while (!this.stopping.signal.aborted) {
      const outcome = await this.session();
      if (this.stopping.signal.aborted) return;
      if (outcome.terminal) {
        this.logger.error("the socket can't connect; stopping", { error: outcome.terminal.message });
        throw outcome.terminal;
      }
      if (outcome.readyMs >= STEADY_MS) attempt = 0;
      const delay = backoffDelay(attempt++, this.options.maxBackoffMs ?? 60_000, this.options.random);
      this.logger.info("socket closed; reconnecting", { delay_ms: delay });
      await sleep(delay, this.stopping.signal);
    }
  }

  /** Opens the socket within the handshake time, or not at all once stopped. */
  private async open(): Promise<WebSocketLike | undefined> {
    const aborting = new AbortController();
    const abort = () => aborting.abort();
    const timer = setTimeout(abort, this.timeouts.handshakeMs);
    this.stopping.signal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<WebSocketLike>((resolve, reject) => {
        aborting.signal.addEventListener("abort", () => reject(new Error(`no socket within ${this.timeouts.handshakeMs} ms`)), { once: true });
        this.options
          .connect(this.options.url, { headers: { Authorization: `Bearer ${this.options.apiKey}` }, protocol: CABLE_PROTOCOL, signal: aborting.signal })
          .then((socket) => {
            // One that arrives after a timeout or a stop is closed, never used.
            if (aborting.signal.aborted) closeQuietly(socket, 1000, "too late");
            else resolve(socket);
          }, reject);
      });
    } catch (error) {
      if (error instanceof CableRejectedError) throw error;
      if (!this.stopping.signal.aborted) this.logger.warn("couldn't open the socket", { error: messageOf(error) });
      return undefined;
    } finally {
      clearTimer(timer);
      this.stopping.signal.removeEventListener("abort", abort);
    }
  }

  /** One connection, from opening to close. */
  private async session(): Promise<Outcome> {
    const now = this.options.now ?? Date.now;
    let saved: Awaited<ReturnType<ReplayStore["load"]>>;
    try {
      saved = await this.store.load();
    } catch (error) {
      this.logger.error("couldn't read where the socket left off", { error: messageOf(error) });
      return { readyMs: 0 };
    }

    let socket: WebSocketLike | undefined;
    try {
      socket = await this.open();
    } catch (error) {
      return { readyMs: 0, terminal: error as Error };
    }
    if (!socket) return { readyMs: 0 };
    if (this.stopping.signal.aborted) {
      closeQuietly(socket, 1000, "stopping");
      return { readyMs: 0 };
    }
    const live = socket;
    this.socket = live;
    this.lastFrame = now();

    return new Promise<Outcome>((resolve) => {
      let readyAt: number | undefined;
      let terminal: Error | undefined;
      let phaseTimer: ReturnType<typeof setTimeout> | undefined;
      let silenceTimer: ReturnType<typeof setTimeout> | undefined;
      let askedByPosition = false;
      let replaying = false;
      let aliveWrittenAt = 0;
      /** Positions Sabha refused: the next event on one of them shows whether events were skipped. */
      let refused: Record<string, StreamPosition> = {};
      let finished = false;

      const send = (frame: Record<string, unknown>) => {
        try {
          live.send(JSON.stringify(frame));
        } catch {
          // The close handler ends the session.
        }
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimer(phaseTimer);
        clearTimer(silenceTimer);
        this.ready = false;
        if (this.socket === live) this.socket = undefined;
        if (readyAt !== undefined) this.notify("onStatus", () => this.options.onStatus?.(false));
        const readyMs = readyAt === undefined ? 0 : now() - readyAt;
        resolve(terminal ? { readyMs, terminal } : { readyMs });
      };
      const end = (code: number, why: string) => {
        finish();
        closeQuietly(live, code, why.slice(0, 100));
      };
      const kill = (why: string) => {
        this.logger.warn(`${why}; dropping the socket`);
        end(4000, why);
      };
      const armPhase = (ms: number, why: string) => {
        clearTimer(phaseTimer);
        phaseTimer = setTimeout(() => kill(why), ms);
      };
      const armSilence = () => {
        clearTimer(silenceTimer);
        silenceTimer = setTimeout(() => kill(`no frames for ${this.timeouts.silenceMs} ms`), this.timeouts.silenceMs);
      };
      const markAlive = () => {
        aliveWrittenAt = now();
        this.quietly("record that the socket is current", this.store.alive(Math.floor(aliveWrittenAt / 1000)));
      };
      const gap = (reason: string) => {
        this.logger.warn("some events may have been missed", { reason });
        this.notify("onGap", () => this.options.onGap?.(reason));
      };
      const requestHistory = () => {
        const streams = saved.positions;
        const since = saved.aliveAt;
        if (since !== undefined) {
          const away = Math.floor(now() / 1000) - since;
          if (away > HISTORY_SECONDS) gap(`the app was away for ${away} s, longer than Sabha keeps events`);
        }
        askedByPosition = Object.keys(streams).length > 0;
        if (!askedByPosition && since === undefined) return markAlive();
        replaying = true;
        send({ command: "history", identifier: APP_EVENTS_IDENTIFIER, history: { ...(askedByPosition ? { streams } : {}), ...(since === undefined ? {} : { since }) } });
      };

      armPhase(this.timeouts.handshakeMs, "no welcome from Sabha");
      armSilence();

      live.addEventListener("message", (message) => {
        if (finished) return;
        this.lastFrame = now();
        armSilence();
        if (readyAt !== undefined && !replaying && this.lastFrame - aliveWrittenAt >= ALIVE_EVERY_MS) markAlive();
        let frame: Frame;
        try {
          frame = JSON.parse(typeof message.data === "string" ? message.data : new TextDecoder().decode(message.data as ArrayBuffer)) as Frame;
        } catch {
          return;
        }
        switch (frame.type) {
          case "ping":
            return;
          case "welcome":
            armPhase(this.timeouts.subscribeMs, "the AppEventsChannel subscription was never confirmed");
            send({ command: "subscribe", identifier: APP_EVENTS_IDENTIFIER });
            return;
          case "confirm_subscription":
            if (frame.identifier !== APP_EVENTS_IDENTIFIER) return;
            clearTimer(phaseTimer);
            readyAt = now();
            this.ready = true;
            this.notify("onStatus", () => this.options.onStatus?.(true));
            requestHistory();
            return;
          case "reject_subscription":
            if (frame.identifier !== APP_EVENTS_IDENTIFIER) return;
            terminal = new CableRejectedError("subscription rejected");
            end(1000, "rejected");
            return;
          case "confirm_history":
            replaying = false;
            markAlive();
            return;
          case "reject_history":
            // Sabha restarted, the stream went idle, or more happened than it keeps. Ask again by
            // time alone, once, and watch whether the replay skips past where the app left off.
            if (askedByPosition && saved.aliveAt !== undefined) {
              askedByPosition = false;
              refused = saved.positions;
              this.quietly("forget the refused positions", this.store.forget());
              send({ command: "history", identifier: APP_EVENTS_IDENTIFIER, history: { since: saved.aliveAt } });
              return;
            }
            replaying = false;
            gap("Sabha couldn't replay missed events: its history expired or it restarted");
            return;
          case "presence": // Sabha marking the app online, not an event
            return;
          case "disconnect":
            if (frame.reconnect === false) terminal = new CableRejectedError(frame.reason ?? "disconnect");
            end(1000, "disconnect");
            return;
        }
        if (frame.identifier !== APP_EVENTS_IDENTIFIER || frame.message == null) return;
        const meta: EventMeta = { streamId: frame.stream_id, epoch: frame.epoch, offset: frame.offset, replayed: replaying };
        const before = meta.streamId ? refused[meta.streamId] : undefined;
        if (before && meta.streamId) {
          delete refused[meta.streamId];
          if (before.epoch === meta.epoch && typeof meta.offset === "number" && meta.offset > before.offset + 1) {
            gap(`Sabha replayed from offset ${meta.offset}, past ${before.offset + 1}`);
          }
        }
        this.track(this.take(frame.message, meta));
      });
      live.addEventListener("close", () => finish());
      live.addEventListener("error", () => {
        this.logger.warn("socket error");
      });
    });
  }

  /** Records an event, then hands it to the app; refusals of the app's own frames go aside. */
  private async take(message: unknown, meta: EventMeta): Promise<void> {
    const raw = message as Record<string, unknown>;
    if (raw && (raw.event === "answer_refused" || raw.event === "draft_refused")) {
      this.logger.warn("Sabha refused a frame the app sent", { event: String(raw.event) });
      this.notify("onRefusal", () => this.options.onRefusal?.(raw));
      return;
    }
    let event: SabhaEvent;
    try {
      event = parseEvent(message);
    } catch (error) {
      this.logger.error("an event from the socket couldn't be read", { error: messageOf(error) });
      return;
    }
    try {
      if (!(await this.store.begin(eventKey(event), meta))) return;
    } catch (error) {
      this.logger.error("couldn't record an event; handling it anyway", { error: messageOf(error) });
    }
    try {
      await this.options.onEvent(event, meta);
    } catch (error) {
      this.logger.error("an event's handlers failed", { event: event.event, error: error instanceof Error ? error.name : "error" });
    }
  }
}
