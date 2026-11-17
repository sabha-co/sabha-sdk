import type { CloudflareEnv } from "../../src/cloudflare/index.js";

declare global {
  namespace Cloudflare {
    interface Env extends CloudflareEnv {
      SABHA_SOCKET: DurableObjectNamespace;
    }
  }
}
