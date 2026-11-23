import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

function resolveAgentHttpPort(): number {
  const envPort = Number(process.env.FLOWBOARD_HTTP_PORT || "");
  if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) {
    return envPort;
  }
  try {
    const activeFile = path.resolve(__dirname, "..", "storage", "active-ports.json");
    if (fs.existsSync(activeFile)) {
      const raw = JSON.parse(fs.readFileSync(activeFile, "utf8")) as { http_port?: unknown };
      if (typeof raw.http_port === "number" && Number.isInteger(raw.http_port) && raw.http_port > 0) {
        return raw.http_port;
      }
    }
  } catch {
    // ignore
  }
  return 8434;
}

const agentHttpPort = resolveAgentHttpPort();
const fePort = Number(process.env.FLOWBOARD_FRONTEND_PORT || "5173") || 5173;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom", "zustand"],
          "vendor-xyflow": ["@xyflow/react"],
        },
      },
    },
  },
  server: {
    port: fePort,
    proxy: {
      "/api": `http://127.0.0.1:${agentHttpPort}`,
      "/media": `http://127.0.0.1:${agentHttpPort}`,
      "/ws": {
        target: `ws://127.0.0.1:${agentHttpPort}`,
        ws: true,
      },
    },
  },
});
