import { createSocketHost, createWorker } from "@sabha-co/app-kit/cloudflare";
import { createStandup } from "./app.js";

const app = createStandup();

export default createWorker(app);
export const SocketHost = createSocketHost(app);
