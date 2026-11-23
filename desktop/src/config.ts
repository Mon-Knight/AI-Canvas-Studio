import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export const REPO_ROOT = path.resolve(__dirname, "..", "..");
export const IS_PACKAGED = Boolean(app?.isPackaged);
export const RESOURCES_ROOT = IS_PACKAGED ? process.resourcesPath : REPO_ROOT;

export const PACKAGED_AGENT_EXE = path.join(
  RESOURCES_ROOT,
  "agent-bin",
  process.platform === "win32" ? "flowboard-agent.exe" : "flowboard-agent",
);

export const FRONTEND_DIST_DIR = IS_PACKAGED
  ? path.join(RESOURCES_ROOT, "frontend-dist")
  : path.join(REPO_ROOT, "frontend", "dist");
export const FRONTEND_DIST_INDEX = path.join(FRONTEND_DIST_DIR, "index.html");
export const EXTENSION_DIR = path.join(RESOURCES_ROOT, "extension");
export const APP_ICON_PATH = IS_PACKAGED
  ? path.join(RESOURCES_ROOT, process.platform === "win32" ? "icon.ico" : "icon.png")
  : path.join(REPO_ROOT, "desktop", "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

function resolveStorageDir(): string {
  const envDir = process.env.FLOWBOARD_STORAGE?.trim();
  if (envDir) {
    return path.resolve(envDir);
  }
  if (IS_PACKAGED) {
    if (fs.existsSync(path.join(RESOURCES_ROOT, ".portable"))) {
      return path.join(path.dirname(process.execPath), "data");
    }
    return path.join(app.getPath("userData"), "workspace-storage");
  }
  return path.join(REPO_ROOT, "storage");
}

export const STORAGE_DIR = resolveStorageDir();

export const ELECTRON_USER_DATA = path.join(STORAGE_DIR, "electron-user-data");
export const TOKENS_FILE = path.join(ELECTRON_USER_DATA, "flow-bridge-tokens.json");

export const PYTHON_EXE =
  process.env.FLOWBOARD_PYTHON_EXE ||
  path.join(REPO_ROOT, "agent", ".venv", "Scripts", "python.exe");

export const AGENT_HTTP_PORT = Number(process.env.FLOWBOARD_HTTP_PORT || "8434");
export const AGENT_WS_PORT = Number(process.env.FLOWBOARD_EXT_WS_PORT || "8355");

export const AGENT_BASE_URL = `http://127.0.0.1:${AGENT_HTTP_PORT}`;
export const AGENT_WS_URL = `ws://127.0.0.1:${AGENT_WS_PORT}`;
export const CALLBACK_URL = `${AGENT_BASE_URL}/api/ext/callback`;

export const FLOW_BASE_URL = (
  process.env.FLOWBOARD_FLOW_BASE_URL || "https://flow.google.com"
).replace(/\/+$/, "");

export const IS_DEV_MODE =
  process.argv.includes("--dev") || process.env.FLOWBOARD_DESKTOP_DEV === "1";

export const UI_URL =
  process.env.FLOWBOARD_UI_URL ||
  (IS_DEV_MODE ? "http://127.0.0.1:5173" : `${AGENT_BASE_URL}/`);

export const E2E_CONTROL_PORT = process.env.FLOWBOARD_E2E_PORT
  ? Number(process.env.FLOWBOARD_E2E_PORT)
  : null;

/**
 * Strip Electron/<ver> and custom app tokens from Electron's default User-Agent
 * so the UA matches the underlying Chromium version cleanly without spoofing a
 * mismatched browser build.
 */
export function cleanChromeUserAgent(rawUa: string): string {
  return rawUa
    .replace(/\s+Electron\/[^\s]+/gi, "")
    .replace(/\s+flowboard-desktop\/[^\s]+/gi, "")
    .replace(/\s+Flowboard\/[^\s]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
