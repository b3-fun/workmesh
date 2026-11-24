import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
  // core and protocol are private workspace packages (and pull in zod) — bundle
  // them so the published CLI only depends on commander + chokidar at runtime.
  noExternal: ["@workmesh/core", "@workmesh/protocol"],
});
