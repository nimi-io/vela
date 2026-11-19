import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  build: {
    emptyOutDir: mode !== "iife",
    lib: {
      entry: "src/index.ts",
      name: "VelaPlayer",
      formats: mode === "iife" ? ["iife"] : ["es"],
      fileName: () => (mode === "iife" ? "vela-player.js" : "vela-player.mjs"),
    },
    target: "es2019",
    minify: true,
  },
}));
