import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
