import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const LAUNCHER_LOG_PATH = path.join(REPO_ROOT, "storage", "launcher.log");

const HTTP_PORT_CANDIDATES = [8434, 18434, 18435, 18436, 28434, 28435, 38434];
const WS_PORT_CANDIDATES = [8355, 18355, 28355, 38355];
const FRONTEND_PORT_CANDIDATES = [5173, 15173, 25173];

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

function canBindLoopbackPort(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

function allocateEphemeralLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function pickBindablePort(preferred, candidates, disallow = new Set()) {
  const ordered = [];
  for (const p of [preferred, ...candidates]) {
    if (Number.isInteger(p) && p > 0 && p <= 65535 && !disallow.has(p) && !ordered.includes(p)) {
      ordered.push(p);
    }
  }
  for (const candidate of ordered) {
    if (await canBindLoopbackPort(candidate)) {
      return candidate;
    }
  }
  for (let i = 0; i < 5; i++) {
    const ephemeral = await allocateEphemeralLoopbackPort();
    if (ephemeral > 0 && !disallow.has(ephemeral)) {
      return ephemeral;
    }
  }
  throw new Error("Unable to allocate a bindable loopback port on 127.0.0.1");
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

async function isFlowboardAgentAt(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
      headers: { Host: `127.0.0.1:${port}` },
    });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true && typeof body?.ws_stats === "object" && body.ws_stats !== null;
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
  const activePortsFile = path.join(storageDir, "active-ports.json");

  let agentPid = null;
  let frontendPid = null;

  const prefHttp = Number(cleanEnv.FLOWBOARD_HTTP_PORT || "8434");
  const prefWs = Number(cleanEnv.FLOWBOARD_EXT_WS_PORT || "8355");
  const prefFe = Number(cleanEnv.FLOWBOARD_FRONTEND_PORT || "5173");

  let httpPort = null;
  let wsPort = prefWs;
  for (const candidate of [prefHttp, ...HTTP_PORT_CANDIDATES]) {
    if (await isFlowboardAgentAt(candidate)) {
      httpPort = candidate;
      break;
    }
  }

  let fePort = null;
  for (const candidate of [prefFe, ...FRONTEND_PORT_CANDIDATES]) {
    if (await isHttpOk(`http://127.0.0.1:${candidate}/`)) {
      fePort = candidate;
      break;
    }
  }
  if (!fePort) {
    fePort = await pickBindablePort(
      prefFe,
      FRONTEND_PORT_CANDIDATES,
      httpPort ? new Set([httpPort]) : new Set(),
    );
  }

  if (!httpPort) {
    httpPort = await pickBindablePort(prefHttp, HTTP_PORT_CANDIDATES, new Set([fePort]));
    wsPort = await pickBindablePort(prefWs, WS_PORT_CANDIDATES, new Set([httpPort, fePort]));

    const agentProc = spawn(
      pythonExe,
      [
        "-m",
        "uvicorn",
        "flowboard.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(httpPort),
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
          FLOWBOARD_HTTP_PORT: String(httpPort),
          FLOWBOARD_EXT_WS_PORT: String(wsPort),
          FLOWBOARD_FRONTEND_PORT: String(fePort),
        },
      },
    );
    agentPid = agentProc.pid ?? null;
    agentProc.unref();
    appendLauncherLog(`Spawned web Agent pid=${agentPid ?? "unknown"} http=:${httpPort} ws=:${wsPort}`);
  }

  fs.writeFileSync(
    activePortsFile,
    JSON.stringify(
      {
        http_port: httpPort,
        ws_port: wsPort,
        frontend_port: fePort,
        pid: agentPid,
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  if (!(await isHttpOk(`http://127.0.0.1:${fePort}/`))) {
    const feProc = spawn(process.execPath, [viteJs, "--port", String(fePort), "--strictPort"], {
      cwd: frontendDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...cleanEnv,
        FLOWBOARD_HTTP_PORT: String(httpPort),
        FLOWBOARD_FRONTEND_PORT: String(fePort),
      },
    });
    frontendPid = feProc.pid ?? null;
    feProc.unref();
    appendLauncherLog(`Spawned web Frontend pid=${frontendPid ?? "unknown"} port=:${fePort}`);
  }

  fs.writeFileSync(
    pidFile,
    JSON.stringify(
      {
        agent_pid: agentPid,
        frontend_pid: frontendPid,
        http_port: httpPort,
        ws_port: wsPort,
        frontend_port: fePort,
      },
      null,
      2,
    ),
    "utf8",
  );

  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    const [agentOk, feOk] = await Promise.all([
      isFlowboardAgentAt(httpPort),
      isHttpOk(`http://127.0.0.1:${fePort}/`),
    ]);
    if (agentOk && feOk) {
      ready = true;
      break;
    }
    await sleep(250);
  }

  if (!ready) {
    throw new Error(`Timed out waiting for silent web services (:${httpPort} and :${fePort})`);
  }

  if (!noOpen && process.platform === "win32") {
    const opener = spawn("explorer.exe", [`http://localhost:${fePort}`], {
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
