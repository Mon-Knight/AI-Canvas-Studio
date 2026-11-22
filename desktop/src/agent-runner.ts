import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_BASE_URL,
  AGENT_HTTP_PORT,
  AGENT_WS_PORT,
  FRONTEND_DIST_DIR,
  IS_PACKAGED,
  PACKAGED_AGENT_EXE,
  PYTHON_EXE,
  REPO_ROOT,
  RESOURCES_ROOT,
  STORAGE_DIR,
} from "./config";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AgentRunner {
  private proc: ChildProcess | null = null;
  private owned = false;

  public get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  public get isOwnedProcess(): boolean {
    return this.owned;
  }

  public async isHealthy(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`${AGENT_BASE_URL}/api/health`, {
        signal: controller.signal,
        headers: { Host: `127.0.0.1:${AGENT_HTTP_PORT}` },
      });
      clearTimeout(timer);
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean };
      return body?.ok === true;
    } catch {
      return false;
    }
  }

  public async ensureStarted(): Promise<void> {
    if (await this.isHealthy()) {
      console.log(`[Desktop] Reusing healthy FastAPI agent at ${AGENT_BASE_URL}`);
      this.owned = false;
      return;
    }

    fs.mkdirSync(STORAGE_DIR, { recursive: true });

    const usePackagedExe = IS_PACKAGED || fs.existsSync(PACKAGED_AGENT_EXE);
    this.owned = true;
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;

    const agentEnv = {
      ...childEnv,
      PYTHONUTF8: "1",
      FLOWBOARD_EMBEDDED_BROWSER: "1",
      FLOWBOARD_HTTP_PORT: String(AGENT_HTTP_PORT),
      FLOWBOARD_EXT_WS_PORT: String(AGENT_WS_PORT),
      FLOWBOARD_STORAGE: STORAGE_DIR,
      FLOWBOARD_APP_ROOT: RESOURCES_ROOT,
      FLOWBOARD_FRONTEND_DIST: FRONTEND_DIST_DIR,
    };

    if (usePackagedExe) {
      if (!fs.existsSync(PACKAGED_AGENT_EXE)) {
        throw new Error(`未找到打包后端服务程序：${PACKAGED_AGENT_EXE}`);
      }
      console.log(
        `[Desktop] Spawning packaged FastAPI agent (${PACKAGED_AGENT_EXE}) on 127.0.0.1:${AGENT_HTTP_PORT} (ws:${AGENT_WS_PORT})`,
      );
      this.proc = spawn(
        PACKAGED_AGENT_EXE,
        ["--host", "127.0.0.1", "--port", String(AGENT_HTTP_PORT)],
        {
          cwd: STORAGE_DIR,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: agentEnv,
        },
      );
    } else {
      if (!fs.existsSync(PYTHON_EXE)) {
        throw new Error(
          `未找到 Python 虚拟环境可执行文件：${PYTHON_EXE}。请先初始化 agent/.venv。`,
        );
      }
      const agentDir = path.join(REPO_ROOT, "agent");
      console.log(`[Desktop] Spawning FastAPI agent on 127.0.0.1:${AGENT_HTTP_PORT} (ws:${AGENT_WS_PORT})`);

      this.proc = spawn(
        PYTHON_EXE,
        [
          "-m",
          "uvicorn",
          "flowboard.main:app",
          "--host",
          "127.0.0.1",
          "--port",
          String(AGENT_HTTP_PORT),
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
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) {
        throw new Error(
          `本地 FastAPI 服务启动后意外退出 (code=${this.proc.exitCode})。\n${recentStderr}`,
        );
      }
      if (await this.isHealthy()) {
        console.log("[Desktop] FastAPI agent is ready.");
        return;
      }
      await sleep(250);
    }

    await this.stop();
    throw new Error(`等待本地 FastAPI 服务就绪超时 (:8434)。\n${recentStderr}`);
  }

  public async stop(): Promise<void> {
    const child = this.proc;
    this.proc = null;
    if (!child || !this.owned || child.exitCode !== null) return;

    const pid = child.pid;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => {
        child.once("exit", () => resolve(true));
      }),
      sleep(1800).then(() => false),
    ]);

    if (!exited && pid && process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("close", () => resolve());
        killer.once("error", () => resolve());
      });
    }
  }
}
