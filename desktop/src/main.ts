import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { AgentRunner } from "./agent-runner";
import {
  APP_ICON_PATH,
  cleanChromeUserAgent,
  E2E_CONTROL_PORT,
  ELECTRON_USER_DATA,
  PACKAGED_AGENT_EXE,
  PYTHON_EXE,
  REPO_ROOT,
  RESOURCES_ROOT,
  UI_URL,
} from "./config";
import { FlowEngineManager } from "./flow-engine";
import {
  IPC_CHANNELS,
  type FlowViewBounds,
  type OpenFlowDrawerOptions,
  type PickedImageFile,
  type PickImagesOptions,
  type PickImagesResult,
} from "./types";

// Store Electron's Chromium profile + all persist:flow-<id> partitions inside
// <STORAGE_DIR>/electron-user-data so sessions stay self-contained in the project.
app.setPath("userData", ELECTRON_USER_DATA);

const singleInstance = E2E_CONTROL_PORT ? true : app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
  process.exit(0);
}

const MAX_PICKED_IMAGE_BYTES = 10 * 1024 * 1024;
const PICKER_SCRIPT_PATH = path.join(REPO_ROOT, "desktop", "scripts", "win-file-picker.py");

const STARTUP_SPLASH_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#09090b;color:#f4f4f5;font-family:"Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;user-select:none}
.card{display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px 36px;border-radius:18px;background:rgba(24,24,27,0.86);border:1px solid rgba(255,255,255,0.08)}
.ring{width:28px;height:28px;border-radius:50%;border:2.5px solid rgba(255,255,255,0.14);border-top-color:#38bdf8;animation:s .8s linear infinite}
.title{font-size:15px;font-weight:600;letter-spacing:.02em}
.sub{font-size:12px;color:#a1a1aa}
@keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="card"><div class="ring"></div><div class="title">正在启动画布工作台…</div><div class="sub">正在连接本地创作服务与扩展桥</div></div></body></html>`;
const STARTUP_SPLASH_URL = `data:text/html;charset=utf-8,${encodeURIComponent(STARTUP_SPLASH_HTML)}`;

let mainWindow: BrowserWindow | null = null;
let flowEngine: FlowEngineManager | null = null;
let e2eServer: http.Server | null = null;
let shuttingDown = false;
let activePickerPromise: Promise<PickImagesResult> | null = null;
let activePickerProc: ChildProcess | null = null;
const agentRunner = new AgentRunner();

function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  const gifHdr = buf.subarray(0, 6).toString("ascii");
  if (gifHdr === "GIF87a" || gifHdr === "GIF89a") return "image/gif";
  return null;
}

function readPickedImages(paths: string[], multiple: boolean): PickImagesResult {
  const limited = multiple ? paths : paths.slice(0, 1);
  const files: PickedImageFile[] = [];
  for (const filePath of limited) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { canceled: true, files: [], error: `无法读取所选文件：${path.basename(filePath)}` };
    }
    if (!stat.isFile() || stat.size === 0) {
      return { canceled: true, files: [], error: `文件为空或不可读取：${path.basename(filePath)}` };
    }
    if (stat.size > MAX_PICKED_IMAGE_BYTES) {
      return {
        canceled: true,
        files: [],
        error: `图片「${path.basename(filePath)}」超过 10 MB 上限，请压缩后再上传。`,
      };
    }
    const raw = fs.readFileSync(filePath);
    const mime = sniffImageMime(raw);
    if (!mime) {
      return {
        canceled: true,
        files: [],
        error: `仅支持 PNG、JPG、WebP、GIF 格式的图片（${path.basename(filePath)}）。`,
      };
    }
    files.push({
      name: path.basename(filePath),
      mime,
      bytes: new Uint8Array(raw),
    });
  }
  return { canceled: files.length === 0, files };
}

function invokeOutOfProcessPicker(opts?: PickImagesOptions): Promise<PickImagesResult> {
  if (activePickerPromise) {
    return activePickerPromise;
  }

  const multiple = Boolean(opts?.multiple);
  const mockJson = process.env.FLOWBOARD_MOCK_PICK_FILES?.trim();
  if (mockJson) {
    try {
      const parsed = JSON.parse(mockJson) as unknown;
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
        return Promise.resolve(
          parsed.length === 0 ? { canceled: true, files: [] } : readPickedImages(parsed, multiple),
        );
      }
    } catch (err) {
      return Promise.resolve({
        canceled: true,
        files: [],
        error: `测试文件配置无效：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const hasPackagedPicker = fs.existsSync(PACKAGED_AGENT_EXE);
  const hasScriptPicker = fs.existsSync(PYTHON_EXE) && fs.existsSync(PICKER_SCRIPT_PATH);

  if (process.platform !== "win32" || (!hasPackagedPicker && !hasScriptPicker)) {
    activePickerPromise = dialog
      .showOpenDialog({
        title: opts?.title || "选择要上传的图片",
        filters: [{ name: "图片文件", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
        properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      })
      .then((res) => (res.canceled ? { canceled: true, files: [] } : readPickedImages(res.filePaths, multiple)))
      .finally(() => {
        activePickerPromise = null;
      });
    return activePickerPromise;
  }

  const pickerExe = hasPackagedPicker ? PACKAGED_AGENT_EXE : PYTHON_EXE;
  const args = hasPackagedPicker ? ["--pick-images"] : [PICKER_SCRIPT_PATH];
  if (multiple) args.push("--multiple");
  if (opts?.title) args.push("--title", opts.title);

  activePickerPromise = new Promise<PickImagesResult>((resolve) => {
    const child = spawn(pickerExe, args, {
      cwd: RESOURCES_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1" },
    });
    activePickerProc = child;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => {
      if (activePickerProc === child) activePickerProc = null;
      resolve({
        canceled: true,
        files: [],
        error: `启动文件选择器失败：${err.message}`,
      });
    });
    child.once("close", () => {
      if (activePickerProc === child) activePickerProc = null;
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({
          canceled: true,
          files: [],
          error: stderr ? `文件选择器异常退出：${stderr.slice(0, 200)}` : undefined,
        });
        return;
      }
      try {
        const parsed = JSON.parse(trimmed) as { canceled?: boolean; paths?: string[]; error?: string };
        if (parsed.error) {
          resolve({ canceled: true, files: [], error: parsed.error });
          return;
        }
        if (parsed.canceled || !Array.isArray(parsed.paths) || parsed.paths.length === 0) {
          resolve({ canceled: true, files: [] });
          return;
        }
        resolve(readPickedImages(parsed.paths, multiple));
      } catch {
        resolve({
          canceled: true,
          files: [],
          error: "无法解析文件选择结果，请重试。",
        });
      }
    });
  }).finally(() => {
    activePickerPromise = null;
  });

  return activePickerPromise;
}

function bringWindowToFront(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.setAlwaysOnTop(false);
}

app.on("second-instance", () => {
  if (mainWindow) bringWindowToFront(mainWindow);
});

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.GET_STATE, () => flowEngine?.getState() ?? null);
  ipcMain.handle(IPC_CHANNELS.OPEN_DRAWER, (_ev, opts?: OpenFlowDrawerOptions) =>
    flowEngine ? flowEngine.openDrawer(opts) : null,
  );
  ipcMain.handle(IPC_CHANNELS.CLOSE_DRAWER, () =>
    flowEngine ? flowEngine.closeDrawer() : null,
  );
  ipcMain.handle(IPC_CHANNELS.SET_DRAWER_BOUNDS, (_ev, bounds: FlowViewBounds) => {
    flowEngine?.setDrawerBounds(bounds);
  });
  ipcMain.handle(IPC_CHANNELS.RELOAD_FLOW, () => {
    flowEngine?.reloadFlow();
  });
  ipcMain.handle(IPC_CHANNELS.OPEN_STANDALONE_AUTH, () => {
    flowEngine?.openStandaloneAuthWindow();
  });
  ipcMain.handle(IPC_CHANNELS.SYNC_ACCOUNTS_NOW, () =>
    flowEngine ? flowEngine.syncAccountsNow() : null,
  );
  ipcMain.handle(IPC_CHANNELS.PAIR_WITH_CODE, (_ev, code: string) =>
    flowEngine ? flowEngine.pairWithCode(code) : { ok: false, error: "内层引擎尚未启动" },
  );
  ipcMain.handle(IPC_CHANNELS.PICK_IMAGES, (_ev, opts?: PickImagesOptions) =>
    invokeOutOfProcessPicker(opts),
  );
  ipcMain.handle(IPC_CHANNELS.QUIT_APP, () => {
    setTimeout(() => app.quit(), 80);
  });
}

/**
 * Loopback-only diagnostic/test control endpoint enabled ONLY when
 * FLOWBOARD_E2E_PORT is explicitly set by automated E2E tests.
 */
async function startE2eControlServer(port: number): Promise<void> {
  e2eServer = http.createServer(async (req, res) => {
    const sendJson = (code: number, data: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };

    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
      if (req.method === "GET" && url.pathname === "/status") {
        sendJson(200, {
          windowReady: Boolean(mainWindow && !mainWindow.isDestroyed()),
          canvasUrl: mainWindow?.webContents.getURL() ?? "",
          agentPid: agentRunner.pid,
          agentOwned: agentRunner.isOwnedProcess,
          inner: flowEngine?.getInnerViewDebugInfo() ?? null,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/eval-canvas") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const { script } = JSON.parse(raw || "{}") as { script: string };
        if (!mainWindow) {
          sendJson(503, { error: "no mainWindow" });
          return;
        }
        const result = await mainWindow.webContents.executeJavaScript(script, true);
        sendJson(200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/eval-flow") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const { script } = JSON.parse(raw || "{}") as { script: string };
        if (!flowEngine) {
          sendJson(503, { error: "no flowEngine" });
          return;
        }
        const result = await flowEngine.executeInFlowViewForTest(script);
        sendJson(200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/quit") {
        sendJson(200, { ok: true });
        setTimeout(() => app.quit(), 50);
        return;
      }

      sendJson(404, { error: "not found" });
    } catch (err) {
      sendJson(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    e2eServer!.once("error", reject);
    e2eServer!.listen(port, "127.0.0.1", () => resolve());
  });
}

async function boot(): Promise<void> {
  await app.whenReady();

  const cleanUa = cleanChromeUserAgent(app.userAgentFallback);
  app.userAgentFallback = cleanUa;

  registerIpcHandlers();

  const canvasPreloadPath = path.join(__dirname, "preload", "canvas-preload.js");
  const flowPreloadPath = path.join(__dirname, "preload", "flow-preload.js");

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: !E2E_CONTROL_PORT,
    backgroundColor: "#09090b",
    autoHideMenuBar: true,
    title: "AI Canvas Studio · 无限画布创作工作台",
    ...(fs.existsSync(APP_ICON_PATH) ? { icon: APP_ICON_PATH } : {}),
    webPreferences: {
      preload: canvasPreloadPath,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Open external documentation / support links in the user's default OS browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(url);
      }
    } catch {
      // ignore
    }
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (!E2E_CONTROL_PORT) {
    void mainWindow.loadURL(STARTUP_SPLASH_URL);
    bringWindowToFront(mainWindow);
  }

  try {
    await agentRunner.ensureStarted();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
      mainWindow = null;
    }
    if (!E2E_CONTROL_PORT) {
      dialog.showErrorBox("Flowboard 本地服务启动失败", msg);
    } else {
      console.error("[Desktop] Agent startup failed:", msg);
    }
    app.quit();
    return;
  }

  if (!mainWindow || mainWindow.isDestroyed() || shuttingDown) {
    return;
  }

  flowEngine = new FlowEngineManager({
    mainWindow,
    cleanUserAgent: cleanUa,
    flowPreloadPath,
  });
  flowEngine.start();

  await mainWindow.loadURL(UI_URL);

  if (E2E_CONTROL_PORT) {
    await startE2eControlServer(E2E_CONTROL_PORT);
  }
}

async function gracefulTeardown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (activePickerProc && activePickerProc.exitCode === null) {
    try {
      activePickerProc.kill();
    } catch {
      // ignore
    }
    activePickerProc = null;
  }

  if (e2eServer) {
    try {
      e2eServer.close();
    } catch {
      // ignore
    }
    e2eServer = null;
  }

  if (flowEngine) {
    await flowEngine.dispose();
    flowEngine = null;
  }

  await agentRunner.stop();
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (!shuttingDown) {
    event.preventDefault();
    void gracefulTeardown().finally(() => {
      app.exit(0);
    });
  }
});

void boot();
