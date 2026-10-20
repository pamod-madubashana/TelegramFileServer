import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@tauri-apps/api/core": path.resolve(__dirname, "src/lib/ipc/core.ts"),
      "@tauri-apps/api/event": path.resolve(__dirname, "src/lib/ipc/event.ts"),
      "@tauri-apps/api/app": path.resolve(__dirname, "src/lib/ipc/app.ts"),
      "@tauri-apps/api/window": path.resolve(__dirname, "src/lib/ipc/window.ts"),
      "@tauri-apps/api/webviewWindow": path.resolve(
        __dirname,
        "src/lib/ipc/webviewWindow.ts",
      ),
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
