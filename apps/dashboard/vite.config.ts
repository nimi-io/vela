import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = process.env.VITE_API_PROXY ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the dashboard talks to the API through this proxy (same origin → cookies just work).
    proxy: { "/v1": api, "/auth": api },
  },
  build: { outDir: "dist", sourcemap: false },
});
