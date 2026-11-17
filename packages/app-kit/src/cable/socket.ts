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
 * in the URL. A rejected handshake throws `CableRejectedError` for 401 or 403.
 */
export type Connect = (url: string, options: { headers: Record<string, string>; protocol: string }) => Promise<WebSocketLike>;

export interface StreamPosition {
  epoch: string;
  offset: number;
}

export interface EventMeta {
  streamId?: string;
  epoch?: string;
  offset?: number;
}

/**
 * Where the socket resumes from, and which events it has already taken. `begin` records an
 * event's key and position in one step, before its handlers run, so a host that restarts
 * mid-event never runs it twice.
 */
export interface ReplayStore {
  load(): Promise<{ positions: Record<string, StreamPosition>; connectedAt?: number }>;
  /** Moves the stream's position on; false when the event was already taken. */
  begin(key: string | undefined, meta: EventMeta): Promise<boolean>;
  /** The app is connected now (UNIX seconds). */
  connected(at: number): Promise<void>;
  /** Sabha refused the saved positions; start over from time. */
  forget(): Promise<void>;
}

/** A replay store that lives as long as the process: enough for Node and for tests. */
export class MemoryReplayStore implements ReplayStore {
  readonly positions: Record<string, StreamPosition> = {};
  readonly keys = new Set<string>();
  connectedAt: number | undefined;

  async load() {
    return { positions: { ...this.positions }, ...(this.connectedAt === undefined ? {} : { connectedAt: this.connectedAt }) };
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

  async connected(at: number) {
    this.connectedAt = at;
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
  /** No welcome after opening. */
  handshakeMs: number;
  /** No subscription confirmed after the welcome. */
  subscribeMs: number;
  /** No frame at all; Sabha pings every 3 s, so silence means a dead path. */
  silenceMs: number;
}

export const DEFAULT_TIMEOUTS: CableTimeouts = { handshakeMs: 10_000, subscribeMs: 10_000, silenceMs: 10_000 };

export interface CableClientOptions {
  url: string;
  apiKey: string;
  connect: Connect;
  store?: ReplayStore;
  /** Runs an event's handlers. The client doesn't wait for it before reading the next frame. */
  onEvent(event: SabhaEvent, meta: EventMeta): void | Promise<void>;
  /** Sabha couldn't replay missed events, so some may be lost. */
  onGap?(reason: string): void;
  /** Sabha refused an `answer` or `draft` the app sent. */
  onRefusal?(frame: Record<string, unknown>): void;
  /** The subscription is confirmed (true) or the socket closed (false). */
  onStatus?(connected: boolean): void;
  logger?: Logger;
  timeouts?: Partial<CableTimeouts>;
  /** The most a reconnect waits, before jitter. */
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

type Outcome = { ready: boolean; terminal?: Error };

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** The delay before reconnect attempt `attempt` (from 0): full jitter over 1 s doubling, capped. */
export function backoffDelay(attempt: number, maxMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(maxMs, 1_000 * 2 ** attempt));
}

/** A self-reconnecting socket to AppEventsChannel. */
export class CableClient {
  private readonly options: CableClientOptions;
  private readonly timeouts: CableTimeouts;
  private readonly logger: Logger;
  private readonly store: ReplayStore;
  private readonly stopping = new AbortController();
  private socket: WebSocketLike | undefined;
  private ready = false;
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

  /** Starts the connect-and-reconnect loop; returns the running loop, once. */
  start(): Promise<void> {
    this.running ??= this.loop();
    return this.running;
  }

  /** Closes the socket and stops reconnecting. */
  stop(): void {
    this.stopping.abort();
    this.socket?.close(1000, "stopping");
  }

  /** Sends a channel action, such as `answer` or `draft`. False when the socket isn't ready. */
  perform(action: string, data: Record<string, unknown>): boolean {
    if (!this.socket || !this.ready) return false;
    try {
      this.socket.send(JSON.stringify({ command: "message", identifier: APP_EVENTS_IDENTIFIER, data: JSON.stringify({ ...data, action }) }));
      return true;
    } catch {
      return false;
    }
  }

  private async loop(): Promise<void> {
    const sleep = this.options.sleep ?? abortableSleep;
    let attempt = 0;
    while (!this.stopping.signal.aborted) {
      const outcome = await this.session();
      if (this.stopping.signal.aborted) return;
      if (outcome.terminal) {
        this.logger.error("the socket can't connect; stopping", { error: outcome.terminal.message });
        return;
      }
      if (outcome.ready) attempt = 0;
      const delay = backoffDelay(attempt++, this.options.maxBackoffMs ?? 60_000, this.options.random);
      this.logger.info("socket closed; reconnecting", { delay_ms: delay });
      await sleep(delay, this.stopping.signal);
    }
  }

  /** One connection, from opening to close. */
  private async session(): Promise<Outcome> {
    const now = this.options.now ?? Date.now;
    let socket: WebSocketLike;
    try {
      socket = await this.options.connect(this.options.url, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        protocol: CABLE_PROTOCOL,
      });
    } catch (error) {
      if (error instanceof CableRejectedError) return { ready: false, terminal: error };
      this.logger.warn("couldn't open the socket", { error: error instanceof Error ? error.message : String(error) });
      return { ready: false };
    }
    this.socket = socket;
    const saved = await this.store.load();

    return new Promise<Outcome>((resolve) => {
      let ready = false;
      let terminal: Error | undefined;
      let phaseTimer: ReturnType<typeof setTimeout> | undefined;
      let silenceTimer: ReturnType<typeof setTimeout> | undefined;
      let askedByPosition = false;
      let finished = false;

      const send = (frame: Record<string, unknown>) => {
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          // The close handler ends the session.
        }
      };
      const kill = (why: string) => {
        this.logger.warn(`${why}; dropping the socket`);
        socket.close(4000, why.slice(0, 100));
        finish();
      };
      const armPhase = (ms: number, why: string) => {
        clearTimeout(phaseTimer);
        phaseTimer = setTimeout(() => kill(why), ms);
      };
      const armSilence = () => {
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => kill(`no frames for ${this.timeouts.silenceMs} ms`), this.timeouts.silenceMs);
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(phaseTimer);
        clearTimeout(silenceTimer);
        this.ready = false;
        if (this.socket === socket) this.socket = undefined;
        if (ready) this.options.onStatus?.(false);
        resolve(terminal ? { ready, terminal } : { ready });
      };
      const requestHistory = () => {
        const streams = saved.positions;
        const since = saved.connectedAt;
        askedByPosition = Object.keys(streams).length > 0;
        if (!askedByPosition && since === undefined) return;
        send({ command: "history", identifier: APP_EVENTS_IDENTIFIER, history: { ...(askedByPosition ? { streams } : {}), ...(since === undefined ? {} : { since }) } });
      };

      armPhase(this.timeouts.handshakeMs, "no welcome from Sabha");
      armSilence();

      socket.addEventListener("message", (message) => {
        armSilence();
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
            clearTimeout(phaseTimer);
            ready = true;
            this.ready = true;
            this.options.onStatus?.(true);
            void this.store.connected(Math.floor(now() / 1000));
            requestHistory();
            return;
          case "reject_subscription":
            if (frame.identifier !== APP_EVENTS_IDENTIFIER) return;
            terminal = new CableRejectedError("subscription rejected");
            socket.close(1000, "rejected");
            finish();
            return;
          case "confirm_history":
            return;
          case "reject_history":
            // A stream whose history expired restarts at offset 1, so a saved offset is past
            // its newest entry. Ask again by time alone, once.
            if (askedByPosition && saved.connectedAt !== undefined) {
              askedByPosition = false;
              void this.store.forget();
              send({ command: "history", identifier: APP_EVENTS_IDENTIFIER, history: { since: saved.connectedAt } });
              return;
            }
            this.options.onGap?.("Sabha couldn't replay missed events: its history expired or it restarted");
            return;
          case "presence": // Sabha marking the app online, not an event
            return;
          case "disconnect":
            if (frame.reconnect === false) terminal = new CableRejectedError(frame.reason ?? "disconnect");
            socket.close(1000, "disconnect");
            finish();
            return;
        }
        if (frame.identifier !== APP_EVENTS_IDENTIFIER || frame.message == null) return;
        void this.take(frame.message, { streamId: frame.stream_id, epoch: frame.epoch, offset: frame.offset });
      });
      socket.addEventListener("close", () => finish());
      socket.addEventListener("error", () => {
        this.logger.warn("socket error");
      });
    });
  }

  /** Records an event, then hands it to the app; refusals of the app's own frames go aside. */
  private async take(message: unknown, meta: EventMeta): Promise<void> {
    const raw = message as Record<string, unknown>;
    if (raw && (raw.event === "answer_refused" || raw.event === "draft_refused")) {
      this.logger.warn("Sabha refused a frame the app sent", { event: String(raw.event) });
      this.options.onRefusal?.(raw);
      return;
    }
    let event: SabhaEvent;
    try {
      event = parseEvent(message);
    } catch (error) {
      this.logger.error("an event from the socket couldn't be read", { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      if (!(await this.store.begin(eventKey(event), meta))) return;
    } catch (error) {
      this.logger.error("couldn't record an event; handling it anyway", { error: error instanceof Error ? error.message : String(error) });
    }
    try {
      await this.options.onEvent(event, meta);
    } catch (error) {
      this.logger.error("an event's handlers failed", { event: event.event, error: error instanceof Error ? error.name : "error" });
    }
  }
}
