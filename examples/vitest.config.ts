import { defineConfig } from "vitest/config";

// The standup is its own package with Workers tests; it runs them itself.
export default defineConfig({ test: { include: ["*.test.ts"] } });
