import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { STORAGE_DIR } from "./config";

const CHROME_MINIMIZE_PS = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32Window {
  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$needle = $env:FB_PROFILE_NEEDLE
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and
  $_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine.IndexOf('--type=', [System.StringComparison]::OrdinalIgnoreCase) -lt 0
}
foreach ($p in $procs) {
  try {
    $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) {
      [void][Win32Window]::ShowWindowAsync($gp.MainWindowHandle, 6)
    }
  } catch {}
}
`;

const CHROME_FIND_PIDS_PS = `
$needle = $env:FB_PROFILE_NEEDLE
$procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and
  $_.CommandLine.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine.IndexOf('--type=', [System.StringComparison]::OrdinalIgnoreCase) -lt 0
}
foreach ($p in $procs) {
  Write-Output $p.ProcessId
}
`;

const CHROME_LAUNCH_MINIMIZED_PS = `
$argList = [string[]]($env:FB_CHROME_ARGS | ConvertFrom-Json)
$p = Start-Process -FilePath $env:FB_CHROME_EXE -ArgumentList $argList -WindowStyle Minimized -PassThru
if ($p) { Write-Output $p.Id }
`;

export interface ManagedChromeCallbacks {
  mainWindow: BrowserWindow;
  isDisposed: () => boolean;
  targetUrlForAccount: (projectId: string | null) => string;
  onStateError: (message: string) => void;
  onClearError: () => void;
}

export class ManagedChromeController {
  private managedChromePids = new Map<string, Set<number>>();
  private managedLaunchTimestamps = new Map<string, number>();
  private launchingAccounts = new Set<string>();
  private readonly callbacks: ManagedChromeCallbacks;

  constructor(callbacks: ManagedChromeCallbacks) {
    this.callbacks = callbacks;
  }

  public isLaunching(accountId: string): boolean {
    return this.launchingAccounts.has(accountId);
  }

  public getLastLaunchAt(accountId: string): number {
    return this.managedLaunchTimestamps.get(accountId) ?? 0;
  }

  public clearLaunchTimestamp(accountId: string): void {
    this.managedLaunchTimestamps.delete(accountId);
  }

  private resolveChromeExecutable(): string | null {
    const override = process.env.FLOWBOARD_CHROME_EXE?.trim();
    if (override) {
      return fs.existsSync(override) ? override : null;
    }
    const candidates: string[] = [];
    if (process.platform === "win32") {
      for (const envKey of ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]) {
        const root = process.env[envKey];
        if (root) {
          candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
        }
      }
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    const pathEnv = process.env.PATH || "";
    const binNames =
      process.platform === "win32"
        ? ["chrome.exe"]
        : ["google-chrome", "chromium", "chromium-browser", "chrome"];
    for (const dir of pathEnv.split(path.delimiter)) {
      if (!dir) continue;
      for (const bin of binNames) {
        const full = path.join(dir, bin);
        if (fs.existsSync(full)) return full;
      }
    }
    return null;
  }

  public managedProfileDir(accountId: string): string {
    if (!/^[0-9a-f]{32}$/i.test(accountId)) {
      throw new Error(`Invalid account profile id: ${accountId}`);
    }
    return path.resolve(STORAGE_DIR, "flow-browser-profiles", accountId);
  }

  private recordManagedPid(accountId: string, pid: number | undefined | null): void {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return;
    let set = this.managedChromePids.get(accountId);
    if (!set) {
      set = new Set<number>();
      this.managedChromePids.set(accountId, set);
    }
    set.add(pid);
  }

  private runPowerShell(script: string, extraEnv: Record<string, string>): Promise<string> {
    if (process.platform !== "win32") return Promise.resolve("");
    return new Promise((resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
          env: { ...process.env, ...extraEnv },
        },
      );
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        resolve(stdout.trim());
      }, 4500);
      child.once("close", () => {
        clearTimeout(timer);
        resolve(stdout.trim());
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve("");
      });
    });
  }

  public async findManagedChromePids(accountId?: string): Promise<number[]> {
    const needle = accountId
      ? this.managedProfileDir(accountId)
      : path.resolve(STORAGE_DIR, "flow-browser-profiles");
    const out = await this.runPowerShell(CHROME_FIND_PIDS_PS, {
      FB_PROFILE_NEEDLE: needle,
    });
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const num = Number(line.trim());
      if (Number.isInteger(num) && num > 0) pids.add(num);
    }
    return Array.from(pids);
  }

  public async minimizeWindows(accountId: string): Promise<void> {
    if (this.callbacks.isDisposed() || process.platform !== "win32") return;
    try {
      const needle = this.managedProfileDir(accountId);
      await this.runPowerShell(CHROME_MINIMIZE_PS, { FB_PROFILE_NEEDLE: needle });
    } catch {
      // ignore minimize best-effort error
    }
    if (!this.callbacks.isDisposed() && !this.callbacks.mainWindow.isDestroyed()) {
      this.callbacks.mainWindow.focus();
    }
  }

  public async launch(
    accountId: string,
    projectId: string | null,
    opts: { minimized: boolean },
  ): Promise<void> {
    if (this.callbacks.isDisposed() || this.launchingAccounts.has(accountId)) return;
    this.launchingAccounts.add(accountId);
    try {
      const chromeExe = this.resolveChromeExecutable();
      if (!chromeExe) {
        this.callbacks.onStateError("未在本机检测到 Google Chrome，请安装 Chrome 后重试。");
        return;
      }

      const profileDir = this.managedProfileDir(accountId);
      fs.mkdirSync(profileDir, { recursive: true });

      if (opts.minimized) {
        const runningPids = await this.findManagedChromePids(accountId);
        if (runningPids.length > 0) {
          for (const pid of runningPids) this.recordManagedPid(accountId, pid);
          this.managedLaunchTimestamps.set(accountId, Date.now());
          return;
        }
      }

      const targetUrl = this.callbacks.targetUrlForAccount(projectId);
      const chromeArgs = [
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        opts.minimized ? "--start-minimized" : "--new-window",
        targetUrl,
      ];

      this.managedLaunchTimestamps.set(accountId, Date.now());
      this.callbacks.onClearError();

      if (
        process.platform === "win32" &&
        opts.minimized &&
        chromeExe.toLowerCase().endsWith(".exe")
      ) {
        const pidText = await this.runPowerShell(CHROME_LAUNCH_MINIMIZED_PS, {
          FB_CHROME_EXE: chromeExe,
          FB_CHROME_ARGS: JSON.stringify(chromeArgs),
        });
        const pidNum = Number(pidText.split(/\r?\n/).pop()?.trim() || "");
        this.recordManagedPid(accountId, pidNum);
        return;
      }

      const child =
        process.platform === "win32" && /\.(cmd|bat)$/i.test(chromeExe)
          ? spawn("cmd.exe", ["/d", "/c", chromeExe, ...chromeArgs], {
              detached: true,
              stdio: "ignore",
              windowsHide: true,
              env: { ...process.env },
            })
          : spawn(chromeExe, chromeArgs, {
              detached: true,
              stdio: "ignore",
              windowsHide: false,
              env: { ...process.env },
            });
      this.recordManagedPid(accountId, child.pid);
      child.unref();
    } catch (err) {
      this.callbacks.onStateError(
        `启动 Chrome 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.launchingAccounts.delete(accountId);
    }
  }

  public async stopProcesses(accountId?: string): Promise<void> {
    const pidSet = new Set<number>();
    if (accountId) {
      for (const pid of this.managedChromePids.get(accountId) ?? []) pidSet.add(pid);
      this.managedChromePids.delete(accountId);
      for (const pid of await this.findManagedChromePids(accountId)) pidSet.add(pid);
    } else {
      for (const set of this.managedChromePids.values()) {
        for (const pid of set) pidSet.add(pid);
      }
      this.managedChromePids.clear();
      for (const pid of await this.findManagedChromePids()) pidSet.add(pid);
    }

    const pids = Array.from(pidSet).filter((pid) => pid > 0);
    if (pids.length === 0) return;

    const killTree = (pid: number, force: boolean) =>
      new Promise<void>((resolve) => {
        if (process.platform === "win32") {
          const killer = spawn(
            "taskkill",
            force ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.once("close", () => resolve());
          killer.once("error", () => resolve());
          return;
        }
        try {
          process.kill(pid, force ? "SIGKILL" : "SIGTERM");
        } catch {
          // ignore
        }
        resolve();
      });

    await Promise.all(pids.map((pid) => killTree(pid, false)));

    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && pids.some(isAlive)) {
      await new Promise((r) => setTimeout(r, 180));
    }

    const survivors = pids.filter(isAlive);
    if (survivors.length > 0) {
      await Promise.all(survivors.map((pid) => killTree(pid, true)));
    }
  }
}
