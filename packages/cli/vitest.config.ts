import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@workmesh/core": fileURLToPath(
        new URL("../core/src/index.ts", import.meta.url),
      ),
      "@workmesh/protocol": fileURLToPath(
        new URL("../protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests that install hooks point HOME at a temp dir; a CLAUDE_CONFIG_DIR or
    // CODEX_HOME from the developer's shell would aim them at a real profile.
    setupFiles: ["test/setup-env.ts"],
    // Never reach the machine's real launchd / systemd from a test (SPEC §24 service).
    env: { WORKMESH_NO_SERVICE: "1" },
  },
});
