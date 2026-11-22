import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const LAUNCHER_LOG_PATH = path.join(REPO_ROOT, "storage", "launcher.log");

function appendLauncherLog(message) {
  try {
    fs.mkdirSync(path.dirname(LAUNCHER_LOG_PATH), { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LAUNCHER_LOG_PATH, line, "utf8");
  } catch {
    // Non-fatal: logging must never block launch.
  }
}

const args = process.argv.slice(2);
const modeWeb = args.includes("--web");
const noOpen = args.includes("--no-open");
const extraDesktopArgs = args.filter(
  (a) => a !== "--desktop" && a !== "--web" && a !== "--no-open",
);

const cleanEnv = { ...process.env };
delete cleanEnv.ELECTRON_RUN_AS_NODE;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runHidden(command, commandArgs, { cwd, env = cleanEnv } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${commandArgs.join(" ")} exited with ${code}`));
    });
  });
}

async function isHttpOk(url, headers = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(url, { signal: controller.signal, headers });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureFrontendDist() {
  const frontendDir = path.join(REPO_ROOT, "frontend");
  const distIndex = path.join(frontendDir, "dist", "index.html");
  if (fs.existsSync(distIndex)) return;

  const viteJs = path.join(frontendDir, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteJs)) {
    await runHidden(
      process.platform === "win32" ? "cmd.exe" : "npm",
      process.platform === "win32" ? ["/d", "/c", "npm", "install"] : ["install"],
      { cwd: frontendDir },
    );
  }
  await runHidden(process.execPath, [viteJs, "build"], { cwd: frontendDir });
}

async function ensureDesktopReady() {
  const desktopDir = path.join(REPO_ROOT, "desktop");
  const desktopMain = path.join(desktopDir, "dist", "main.js");
  const electronInstallJs = path.join(desktopDir, "node_modules", "electron", "install.js");

  if (!fs.existsSync(electronInstallJs)) {
    await runHidden(
      process.platform === "win32" ? "cmd.exe" : "npm",
      process.platform === "win32" ? ["/d", "/c", "npm", "install"] : ["install"],
      {
        cwd: desktopDir,
        env: {
          ...cleanEnv,
          ELECTRON_MIRROR: cleanEnv.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
        },
      },
    );
  }

  const electronBin = path.join(
    desktopDir,
    "node_modules",
    "electron",
    "dist",
    process.platform === "win32" ? "electron.exe" : "electron",
  );
  if (!fs.existsSync(electronBin)) {
    await runHidden(process.execPath, [electronInstallJs], {
      cwd: desktopDir,
      env: {
        ...cleanEnv,
        ELECTRON_MIRROR: cleanEnv.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
      },
    });
  }

  if (!fs.existsSync(desktopMain)) {
    const tscJs = path.join(desktopDir, "node_modules", "typescript", "bin", "tsc");
    if (fs.existsSync(tscJs)) {
      await runHidden(process.execPath, [tscJs, "-p", "tsconfig.json"], { cwd: desktopDir });
    } else {
      await runHidden(
        process.platform === "win32" ? "cmd.exe" : "npm",
        process.platform === "win32" ? ["/d", "/c", "npm", "run", "build"] : ["run", "build"],
        { cwd: desktopDir },
      );
    }
  }

  return electronBin;
}

async function launchDesktop() {
  await ensureFrontendDist();
  const electronBin = await ensureDesktopReady();
  const desktopDir = path.join(REPO_ROOT, "desktop");

  const child = spawn(electronBin, [desktopDir, ...extraDesktopArgs], {
    cwd: desktopDir,
    env: cleanEnv,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  appendLauncherLog(`Spawned desktop Electron pid=${child.pid ?? "unknown"} bin=${electronBin}`);
  child.unref();
}

async function launchWeb() {
  const agentDir = path.join(REPO_ROOT, "agent");
  const frontendDir = path.join(REPO_ROOT, "frontend");
  const storageDir = path.resolve(cleanEnv.FLOWBOARD_STORAGE || path.join(REPO_ROOT, "storage"));
  const pythonExe =
    process.platform === "win32"
      ? path.join(agentDir, ".venv", "Scripts", "python.exe")
      : path.join(agentDir, ".venv", "bin", "python");

  if (!fs.existsSync(pythonExe)) {
    throw new Error(`Missing Python venv executable: ${pythonExe}`);
  }

  const viteJs = path.join(frontendDir, "node_modules", "vite", "bin", "vite.js");
  if (!fs.existsSync(viteJs)) {
    await runHidden(
      process.platform === "win32" ? "cmd.exe" : "npm",
      process.platform === "win32" ? ["/d", "/c", "npm", "install"] : ["install"],
      { cwd: frontendDir },
    );
  }

  fs.mkdirSync(storageDir, { recursive: true });
  const pidFile = path.join(storageDir, "web-service-pids.json");

  let agentPid = null;
  let frontendPid = null;

  if (!(await isHttpOk("http://127.0.0.1:8434/api/health", { Host: "127.0.0.1:8434" }))) {
    const agentProc = spawn(
      pythonExe,
      [
        "-m",
        "uvicorn",
        "flowboard.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        "8434",
        "--timeout-graceful-shutdown",
        "2",
      ],
      {
        cwd: agentDir,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...cleanEnv,
          PYTHONUTF8: "1",
          FLOWBOARD_STORAGE: storageDir,
        },
      },
    );
    agentPid = agentProc.pid ?? null;
    agentProc.unref();
  }

  if (!(await isHttpOk("http://127.0.0.1:5173/"))) {
    const feProc = spawn(process.execPath, [viteJs, "--strictPort"], {
      cwd: frontendDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: cleanEnv,
    });
    frontendPid = feProc.pid ?? null;
    feProc.unref();
  }

  fs.writeFileSync(
    pidFile,
    JSON.stringify({ agent_pid: agentPid, frontend_pid: frontendPid }, null, 2),
    "utf8",
  );

  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    const [agentOk, feOk] = await Promise.all([
      isHttpOk("http://127.0.0.1:8434/api/health", { Host: "127.0.0.1:8434" }),
      isHttpOk("http://127.0.0.1:5173/"),
    ]);
    if (agentOk && feOk) {
      ready = true;
      break;
    }
    await sleep(250);
  }

  if (!ready) {
    throw new Error("Timed out waiting for silent web services (:8434 and :5173)");
  }

  if (!noOpen && process.platform === "win32") {
    const opener = spawn("explorer.exe", ["http://localhost:5173"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    opener.unref();
  }
}

async function main() {
  const mode = modeWeb ? "web" : "desktop";
  appendLauncherLog(`Launcher started mode=${mode} args=${JSON.stringify(args)}`);
  if (modeWeb) {
    await launchWeb();
  } else {
    await launchDesktop();
  }
  appendLauncherLog(`Launcher finished mode=${mode}`);
}

main().catch((err) => {
  const detail = err instanceof Error ? (err.stack || err.message) : String(err);
  appendLauncherLog(`Launcher ERROR: ${detail}`);
  console.error("[Flowboard Launcher]", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
