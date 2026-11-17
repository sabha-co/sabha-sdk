// Running an app in a long-lived Node process (Node 24 or later): the socket for events, and a
// minute timer for schedules. Node's WebSocket is undici's, which accepts handshake headers.
import type { App } from "../app.js";
import { socketApp } from "../cable/dispatch.js";
import type { CableClient, Connect, ReplayStore, WebSocketLike } from "../cable/socket.js";
import type { Runtime, SabhaEnv } from "../context.js";

/** Opens Sabha's socket with Node's built-in WebSocket, sending the key as a header. */
export const connectNode: Connect = (url, { headers, protocol }) =>
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
  /** Stops the socket and the schedule timer. */
  close(): void;
}

/** Runs an app over the socket, with its schedules on a minute timer, until closed. */
export function runSocket<Env extends SabhaEnv>(app: App<Env>, options: RunSocketOptions<Env>): RunningApp {
  const cable = socketApp({ app, env: options.env, connect: options.connect ?? connectNode, ...(options.store ? { store: options.store } : {}) });
  void cable.start();

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.schedules !== false && app.schedules.length > 0) {
    const runtime: Runtime<Env> = {
      env: options.env,
      client: app.clientFor(options.env),
      logger: app.logger,
      transport: "socket",
      waitUntil: () => {},
    };
    const next = () => {
      const now = Date.now();
      timer = setTimeout(() => {
        void app.runSchedules(Math.floor(Date.now() / 60_000) * 60_000, runtime);
        next();
      }, 60_000 - (now % 60_000));
    };
    next();
  }

  return {
    cable,
    close() {
      clearTimeout(timer);
      cable.stop();
    },
  };
}
