import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { SABHA_API_KEY: "sabha_app_standup_test", SABHA_SIGNING_SECRET: "whsec_standup_test" } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
