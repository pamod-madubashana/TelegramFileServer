import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { fileURLToPath } from "url";
import { componentTagger } from "lovable-tagger";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: "/",
  server: {
    host: "::",
    port: 3000,
    hmr: {
      overlay: false,
    },
    proxy: {
      "/api": "http://127.0.0.1:8090",
      "/healthz": "http://127.0.0.1:8090",
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(
    Boolean,
  ),
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
  build: {
    outDir: "../crates/server/static/webui",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;

          if (id.includes("/antd/") || id.includes("\\antd\\")) return "antd";
          if (id.includes("/recharts/") || id.includes("\\recharts\\")) {
            return "recharts";
          }
          if (id.includes("/plyr/") || id.includes("\\plyr\\")) return "plyr";
          if (id.includes("/@radix-ui/") || id.includes("\\@radix-ui\\")) {
            return "radix";
          }
          if (id.includes("/react-router") || id.includes("\\react-router")) {
            return "router";
          }
          if (id.includes("/@tauri-apps/") || id.includes("\\@tauri-apps\\")) {
            return "tauri";
          }

          return "vendor";
        },
      },
    },
  },
}));
