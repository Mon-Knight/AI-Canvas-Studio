import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  ACTIVE_PORTS_FILE,
  FRONTEND_DIST_DIR,
  getAgentBaseUrl,
  getAgentHttpPort,
  getAgentWsPort,
  HAS_EXPLICIT_HTTP_PORT,
  HAS_EXPLICIT_WS_PORT,
  HTTP_PORT_CANDIDATES,
  IS_PACKAGED,
  PACKAGED_AGENT_EXE,
  PYTHON_EXE,
  REPO_ROOT,
  RESOURCES_ROOT,
  setResolvedAgentPorts,
  STORAGE_DIR,
  WS_PORT_CANDIDATES,
} from "./config";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function canBindLoopbackPort(port: number): Promise<boolean> {
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

function allocateEphemeralLoopbackPort(): Promise<number> {
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

export async function pickBindablePort(
  preferred: number,
  candidates: readonly number[],
  disallow: ReadonlySet<number> = new Set(),
): Promise<number> {
  const ordered: number[] = [];
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
  throw new Error("无法在本机 127.0.0.1 分配可用回环端口，请检查系统防火墙或 WinNAT 状态。");
}

function readPersistedPorts(): { httpPort: number | null; wsPort: number | null } {
  try {
    if (!fs.existsSync(ACTIVE_PORTS_FILE)) return { httpPort: null, wsPort: null };
    const raw = JSON.parse(fs.readFileSync(ACTIVE_PORTS_FILE, "utf8")) as {
      http_port?: unknown;
      ws_port?: unknown;
    };
    const httpPort =
      typeof raw.http_port === "number" && Number.isInteger(raw.http_port) && raw.http_port > 0
        ? raw.http_port
        : null;
    const wsPort =
      typeof raw.ws_port === "number" && Number.isInteger(raw.ws_port) && raw.ws_port > 0
        ? raw.ws_port
        : null;
    return { httpPort, wsPort };
  } catch {
    return { httpPort: null, wsPort: null };
  }
}

function writePersistedPorts(httpPort: number, wsPort: number, pid: number | null): void {
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    fs.writeFileSync(
      ACTIVE_PORTS_FILE,
      JSON.stringify(
        {
          http_port: httpPort,
          ws_port: wsPort,
          pid,
          updated_at: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // Non-fatal diagnostic/discovery state
  }
}

const PORT_BIND_ERROR_RE =
  /10013|10048|EACCES|EADDRINUSE|error while attempting to bind|address already in use/i;

export class AgentRunner {
  private proc: ChildProcess | null = null;
  private owned = false;

  public get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  public get isOwnedProcess(): boolean {
    return this.owned;
  }

  private async isHealthyAtPort(port: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: controller.signal,
        headers: { Host: `127.0.0.1:${port}` },
      });
      clearTimeout(timer);
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean; ws_stats?: unknown };
      return body?.ok === true && typeof body.ws_stats === "object" && body.ws_stats !== null;
    } catch {
      return false;
    }
  }

  public async isHealthy(): Promise<boolean> {
    return this.isHealthyAtPort(getAgentHttpPort());
  }

  private async findExistingHealthyAgent(): Promise<{ httpPort: number; wsPort: number } | null> {
    const persisted = readPersistedPorts();
    const probeOrder: number[] = [];
    const addPort = (p: number | null) => {
      if (p && Number.isInteger(p) && p > 0 && !probeOrder.includes(p)) {
        probeOrder.push(p);
      }
    };

    addPort(getAgentHttpPort());
    if (!HAS_EXPLICIT_HTTP_PORT) {
      addPort(persisted.httpPort);
      for (const candidate of HTTP_PORT_CANDIDATES) {
        addPort(candidate);
      }
    }

    for (const candidateHttp of probeOrder) {
      if (await this.isHealthyAtPort(candidateHttp)) {
        const wsPort =
          !HAS_EXPLICIT_WS_PORT && persisted.httpPort === candidateHttp && persisted.wsPort
            ? persisted.wsPort
            : getAgentWsPort();
        return { httpPort: candidateHttp, wsPort };
      }
    }
    return null;
  }

  public async ensureStarted(): Promise<void> {
    const existing = await this.findExistingHealthyAgent();
    if (existing) {
      setResolvedAgentPorts(existing.httpPort, existing.wsPort);
      console.log(
        `[Desktop] Reusing healthy FastAPI agent at ${getAgentBaseUrl()} (ws:${existing.wsPort})`,
      );
      this.owned = false;
      return;
    }

    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    const usePackagedExe = IS_PACKAGED || fs.existsSync(PACKAGED_AGENT_EXE);
    if (usePackagedExe && !fs.existsSync(PACKAGED_AGENT_EXE)) {
      throw new Error(`未找到打包后端服务程序：${PACKAGED_AGENT_EXE}`);
    }
    if (!usePackagedExe && !fs.existsSync(PYTHON_EXE)) {
      throw new Error(
        `未找到 Python 虚拟环境可执行文件：${PYTHON_EXE}。请先初始化 agent/.venv。`,
      );
    }

    const initialPreferredHttp = getAgentHttpPort();
    const initialPreferredWs = getAgentWsPort();
    const failedPorts = new Set<number>();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const httpPort = await pickBindablePort(
        initialPreferredHttp,
        HTTP_PORT_CANDIDATES,
        failedPorts,
      );
      const wsDisallow = new Set<number>([...failedPorts, httpPort]);
      const wsPort = await pickBindablePort(
        initialPreferredWs,
        WS_PORT_CANDIDATES,
        wsDisallow,
      );

      setResolvedAgentPorts(httpPort, wsPort);
      if (httpPort !== initialPreferredHttp || wsPort !== initialPreferredWs) {
        console.log(
          `[Desktop] Default port unavailable or reserved by Windows; auto-switched to 127.0.0.1:${httpPort} (ws:${wsPort})`,
        );
      }

      this.owned = true;
      const childEnv = { ...process.env };
      delete childEnv.ELECTRON_RUN_AS_NODE;

      const agentEnv = {
        ...childEnv,
        PYTHONUTF8: "1",
        FLOWBOARD_EMBEDDED_BROWSER: "1",
        FLOWBOARD_HTTP_PORT: String(httpPort),
        FLOWBOARD_EXT_WS_PORT: String(wsPort),
        FLOWBOARD_STORAGE: STORAGE_DIR,
        FLOWBOARD_APP_ROOT: RESOURCES_ROOT,
        FLOWBOARD_FRONTEND_DIST: FRONTEND_DIST_DIR,
      };

      if (usePackagedExe) {
        console.log(
          `[Desktop] Spawning packaged FastAPI agent (${PACKAGED_AGENT_EXE}) on 127.0.0.1:${httpPort} (ws:${wsPort})`,
        );
        this.proc = spawn(
          PACKAGED_AGENT_EXE,
          ["--host", "127.0.0.1", "--port", String(httpPort)],
          {
            cwd: STORAGE_DIR,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: agentEnv,
          },
        );
      } else {
        const agentDir = path.join(REPO_ROOT, "agent");
        console.log(`[Desktop] Spawning FastAPI agent on 127.0.0.1:${httpPort} (ws:${wsPort})`);
        this.proc = spawn(
          PYTHON_EXE,
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
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: agentEnv,
          },
        );
      }

      let recentStderr = "";
      this.proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) console.log(`[Agent] ${text}`);
      });
      this.proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trim();
        if (text) {
          recentStderr = (recentStderr + "\n" + text).slice(-1200);
          console.log(`[Agent] ${text}`);
        }
      });

      const deadline = Date.now() + 25_000;
      let started = false;
      let bindRaceDetected = false;

      while (Date.now() < deadline) {
        if (this.proc.exitCode !== null) {
          if (PORT_BIND_ERROR_RE.test(recentStderr) && attempt < 2) {
            failedPorts.add(httpPort);
            failedPorts.add(wsPort);
            bindRaceDetected = true;
            this.proc = null;
            break;
          }
          lastError = new Error(
            `本地 FastAPI 服务启动后意外退出 (code=${this.proc.exitCode})。\n${recentStderr}`,
          );
          break;
        }
        if (await this.isHealthyAtPort(httpPort)) {
          started = true;
          break;
        }
        await sleep(220);
      }

      if (started) {
        writePersistedPorts(httpPort, wsPort, this.proc?.pid ?? null);
        return;
      }

      if (bindRaceDetected) {
        continue;
      }

      if (lastError) {
        throw lastError;
      }

      throw new Error(`等待本地 FastAPI 服务就绪超时 (:${httpPort})。\n${recentStderr}`);
    }

    throw lastError ?? new Error("本地 FastAPI 服务无法绑定可用端口。");
  }

  public async stop(): Promise<void> {
    if (!this.owned || !this.proc || this.proc.exitCode !== null) {
      return;
    }
    const child = this.proc;
    this.proc = null;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });

    if (process.platform === "win32" && child.pid) {
      try {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        await new Promise<void>((resolve) => {
          killer.once("exit", () => resolve());
          killer.once("error", () => resolve());
        });
      } catch {
        child.kill();
      }
    } else {
      child.kill("SIGTERM");
    }

    await Promise.race([exited, sleep(3000)]);
  }
}
