import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The board is built into the Worker's static assets (wrangler.jsonc "assets").
// `pnpm dev:board` runs Vite with HMR and proxies the API to `wrangler dev` on :8787.
export default defineConfig({
  root: "src/board",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: {
    proxy: {
      "/api": { target: "http://localhost:8787", ws: true },
      "/relay": "http://localhost:8787",
    },
  },
});
