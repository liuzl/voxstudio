import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // The only intentionally large file is the capability-loaded LiveKit SDK. The
    // tighter entry/eager/panel budgets are enforced by tools/check-web-bundle.ts.
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          // Long-lived framework code changes less often than product panels, so browsers
          // can retain it across Studio releases instead of redownloading the entry chunk.
          if (/\/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(?:react|react-dom|scheduler)\//.test(path)) {
            return "react-runtime";
          }
          // Consolidate icons shared by the shell and lazy panels; without this Rollup
          // emits several sub-kilobyte cross-panel chunks.
          if (path.includes("/node_modules/lucide-react/") || path.includes("/node_modules/.bun/lucide-react@")) {
            return "icons";
          }
          // LiveKit ships as one upstream-prebundled ESM module, so Rollup cannot split
          // its internals. Keep that substantial graph isolated and capability-loaded.
          if (path.includes("/node_modules/livekit-client/") || path.includes("/node_modules/.bun/livekit-client@")) {
            return "livekit-sdk";
          }
        },
      },
    },
  },
  server: {
    // Development convenience only: the built app is served behind the same origin as the
    // gateway (a tunnel in deployment), so /v1 is always same-origin in production.
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:8790",
        ws: true,
      },
      "/healthz": {
        target: "http://127.0.0.1:8790",
      },
    },
  },
});
