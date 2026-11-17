// Runs an app in a long-lived Node process (Node 24+) over the socket, so it needs no public URL
// and shows online. Settings come from the environment:
//   SABHA_BASE_URL=https://team.sabha.co SABHA_API_KEY=sabha_app_… node run-node.ts
import { runSocket } from "@sabha-co/sdk/node";
import { app } from "./mention-reply.ts";

const { SABHA_BASE_URL, SABHA_API_KEY, SABHA_SOCKET_URL } = process.env;
if (!SABHA_BASE_URL || !SABHA_API_KEY) throw new Error("Set SABHA_BASE_URL and SABHA_API_KEY");

const running = runSocket(app, { env: { SABHA_BASE_URL, SABHA_API_KEY, ...(SABHA_SOCKET_URL ? { SABHA_SOCKET_URL } : {}) } });

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => running.close());
