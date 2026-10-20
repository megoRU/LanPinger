import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const nodeEnv = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: nodeEnv.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !nodeEnv.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!nodeEnv.TAURI_ENV_DEBUG,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    clearMocks: true,
  },
});
