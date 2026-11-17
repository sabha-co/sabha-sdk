// Running an app in a long-lived Node process (Node 24 or later): the socket for events, and a
// minute timer for schedules. Node's WebSocket is undici's, which accepts handshake headers.
import type { App } from "../app.js";
import { socketApp } from "../cable/dispatch.js";
import type { CableClient, Connect, ReplayStore, WebSocketLike } from "../cable/socket.js";
import type { Runtime, SabhaEnv } from "../context.js";

/** Opens Sabha's socket with Node's built-in WebSocket, sending the key as a header. */
export const connectNode: Connect = (url, { headers, protocol, signal }) =>
  new Promise<WebSocketLike>((resolve, reject) => {
    // undici's WebSocket takes an init object with headers in place of the protocols argument.
    const init = { protocols: [protocol], headers } as unknown as string[];
    const socket = new WebSocket(url, init);
    const opened = () => {
      socket.removeEventListener("error", failed);
      resolve(socket as unknown as WebSocketLike);
    };
    const failed = () => {
      socket.removeEventListener("open", opened);
      reject(new Error("the socket handshake failed"));
    };
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", () => socket.close(), { once: true });
  });

export interface RunSocketOptions<Env extends SabhaEnv> {
  env: Env;
  store?: ReplayStore;
  /** Defaults to Node's own WebSocket. */
  connect?: Connect;
  /** Runs schedules once a minute; on by default. */
  schedules?: boolean;
}

export interface RunningApp {
  cable: CableClient;
  /**
   * Settles when the socket stops for good: after `close`, or when Sabha refuses the key. A
   * host can exit non-zero on it, so a supervisor restarts or alerts.
   */
  done: Promise<void>;
  /** Stops the socket and the schedule timer, then waits up to `drainMs` for running handlers. */
  close(drainMs?: number): Promise<void>;
}

const MINUTE = 60_000;
/** The most missed minutes a stalled process catches up on. */
const CATCH_UP_MINUTES = 5;

/** Runs an app over the socket, with its schedules on a minute timer, until closed. */
export function runSocket<Env extends SabhaEnv>(app: App<Env>, options: RunSocketOptions<Env>): RunningApp {
  const cable = socketApp({ app, env: options.env, connect: options.connect ?? connectNode, ...(options.store ? { store: options.store } : {}) });
  const done = cable.start();

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.schedules !== false && app.schedules.length > 0) {
    const runtime: Runtime<Env> = {
      env: options.env,
      client: app.clientFor(options.env),
      logger: app.logger,
      transport: "socket",
      waitUntil: (promise) => cable.track(promise),
    };
    let last = Math.floor(Date.now() / MINUTE) * MINUTE;
    // Armed for a minute boundary, not from the time it fires: a timer firing a little early
    // or late still runs each minute once, and a stall catches up on a few missed minutes.
    const arm = (target: number) => {
      timer = setTimeout(() => {
        const reached = Math.max(target, Math.floor(Date.now() / MINUTE) * MINUTE);
        for (let tick = Math.max(last + MINUTE, reached - (CATCH_UP_MINUTES - 1) * MINUTE); tick <= reached; tick += MINUTE) {
          cable.track(app.runSchedules(tick, runtime));
        }
        last = reached;
        arm(reached + MINUTE);
      }, Math.max(0, target - Date.now()));
    };
    arm(last + MINUTE);
  }

  return {
    cable,
    done,
    async close(drainMs = 10_000) {
      clearTimeout(timer);
      cable.stop();
      await cable.drain(drainMs);
    },
  };
}
