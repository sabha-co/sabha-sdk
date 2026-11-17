import type { StandupEnv } from "../src/app.js";

declare global {
  namespace Cloudflare {
    interface Env extends StandupEnv {}
  }
}
