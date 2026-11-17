import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/cloudflare/wrangler.jsonc" } })],
  test: { include: ["test/cloudflare/**/*.test.ts"] },
});
