import { mkdirSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The assets binding needs its directory to exist even before the board is built.
mkdirSync("dist/client", { recursive: true });

export default defineConfig({
  // No remote bindings in tests: summary tests use a fake provider, and nothing calls Workers AI.
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, remoteBindings: false })],
  test: { include: ["test/**/*.test.ts"] },
});
