import fs from "node:fs";
import path from "node:path";
import {
  BrowserWindow,
  session,
  WebContentsView,
  type Session,
} from "electron";
import WebSocket from "ws";
import {
  EXTENSION_DIR,
  FLOW_BASE_URL,
  getAgentBaseUrl,
  getAgentHttpPort,
  getAgentWsUrl,
  getCallbackUrl,
  STORAGE_DIR,
  TOKENS_FILE,
} from "./config";
import { ManagedChromeController } from "./managed-chrome";
import type {
  FlowDrawerMode,
  FlowEngineAuthState,
  FlowEngineState,
  FlowViewBounds,
  OpenFlowDrawerOptions,
  PairResult,
} from "./types";
import { IPC_CHANNELS } from "./types";

const CAPTCHA_SLOT = "__CAPTCHA__";
const MAX_RPC_TEXT = 32_000_000;
const PROJECT_SEGMENT_RE =
  /\/project\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9a-fA-F-])/;
const AUTH_COOKIE_NAMES = new Set([
  "SID",
  "__Secure-1PSID",
  "__Secure-3PSID",
  "SAPISID",
  "__Host-GAPS",
]);

interface BackendAccount {
  id: string;
  label: string;
  project_id: string | null;
  paired?: boolean;
  connected: boolean;
  flow_tab_open: boolean;
}

interface BackendAccountsSnapshot {
  active_account_id: string | null;
  accounts: BackendAccount[];
  extension_path?: string;
}

export class FlowEngineManager {
  private mainWindow: BrowserWindow;
  private cleanUserAgent: string;
  private flowPreloadPath: string;
  private readonly managedChromeMode: boolean;

  private flowView: WebContentsView | null = null;
  private standaloneAuthWin: BrowserWindow | null = null;
  private configuredPartitions = new Set<string>();
  private tokens: Record<string, string> = {};

  private readonly managedChrome: ManagedChromeController;
  private syncInFlight: Promise<FlowEngineState> | null = null;

  private ws: WebSocket | null = null;
  private wsAccountId: string | null = null;
  private callbackSecret: string | null = null;
  private wsKeepaliveTimer: NodeJS.Timeout | null = null;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private lastReportedPresence: boolean | null = null;
  private lastCreditsSyncAt = 0;
  private creditsSyncInFlight = false;
  private unverifiedHelloTicks = 0;
  private pendingPair: {
    resolve: (res: PairResult) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  private pollTimer: NodeJS.Timeout | null = null;
  private stateEvalTimer: NodeJS.Timeout | null = null;
  private autoCloseTimer: NodeJS.Timeout | null = null;
  private autoBindingInFlight = false;
  private disposed = false;

  private activeAccountProjectId: string | null = null;
  private viewVisible = false;
  private lastDrawerBounds: FlowViewBounds = {
    x: -10000,
    y: -10000,
    width: 1280,
    height: 800,
    visible: false,
  };

  private metrics = {
    requestCount: 0,
    successCount: 0,
    failedCount: 0,
    lastError: null as string | null,
  };

  private state: FlowEngineState = {
    isEmbeddedRuntime: true,
    managedChromeMode: false,
    extensionPath: EXTENSION_DIR,
    activeAccountId: null,
    authState: "idle",
    currentUrl: "",
    projectIdDetected: null,
    paired: false,
    wsConnected: false,
    drawerOpen: false,
    drawerMode: "auto-onboarding",
    standaloneWindowOpen: false,
    lastError: null,
    notice: null,
    metrics: {
      requestCount: 0,
      successCount: 0,
      failedCount: 0,
      lastError: null,
    },
  };

  constructor(opts: {
    mainWindow: BrowserWindow;
    cleanUserAgent: string;
    flowPreloadPath: string;
  }) {
    this.mainWindow = opts.mainWindow;
    this.cleanUserAgent = opts.cleanUserAgent;
    this.flowPreloadPath = opts.flowPreloadPath;
    this.managedChromeMode =
      process.env.FLOWBOARD_FORCE_MANAGED_CHROME === "1" ||
      FLOW_BASE_URL.startsWith("https://");
    this.state.managedChromeMode = this.managedChromeMode;
    this.managedChrome = new ManagedChromeController({
      mainWindow: this.mainWindow,
      isDisposed: () => this.disposed,
      targetUrlForAccount: (projectId) => this.targetUrlForAccount(projectId),
      onStateError: (message) =>
        this.updateState({ authState: "error", lastError: message }),
      onClearError: () => this.updateState({ lastError: null }),
    });
    this.loadTokens();
  }

  public getState(): FlowEngineState {
    return {
      ...this.state,
      metrics: { ...this.metrics },
    };
  }

  private pushMetricsUpdate(): void {
    this.state = { ...this.state, metrics: { ...this.metrics } };
    if (!this.disposed && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, this.getState());
    }
  }

  private finishPendingPair(result: PairResult): void {
    if (!this.pendingPair) return;
    const { resolve, timer } = this.pendingPair;
    this.pendingPair = null;
    clearTimeout(timer);
    resolve(result);
  }

  public getInnerViewDebugInfo() {
    return {
      state: this.getState(),
      hasView: Boolean(this.flowView),
      visible: Boolean(this.flowView && this.viewVisible),
      bounds: this.flowView ? this.flowView.getBounds() : null,
      metrics: { ...this.metrics },
    };
  }

  public async executeInFlowViewForTest<T = unknown>(script: string): Promise<T> {
    if (!this.flowView) {
      throw new Error("No active inner flowView");
    }
    return (await this.flowView.webContents.executeJavaScript(script, true)) as T;
  }

  public start(): void {
    void this.syncAccountsNow();
    this.pollTimer = setInterval(() => {
      void this.syncAccountsNow();
    }, 3000);
    this.stateEvalTimer = setInterval(() => {
      void this.evaluatePageState();
    }, 1500);
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.stateEvalTimer) clearInterval(this.stateEvalTimer);
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    this.closeWebSocket();
    this.destroyStandaloneAuthWindow();
    this.destroyFlowView();
    if (this.managedChromeMode) {
      await this.managedChrome.stopProcesses();
    }
    for (const partition of this.configuredPartitions) {
      try {
        await session.fromPartition(partition).cookies.flushStore();
      } catch {
        // ignore
      }
    }
  }

  private loadTokens(): void {
    try {
      if (fs.existsSync(TOKENS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")) as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (typeof v === "string" && v.length > 0) out[k] = v;
        }
        this.tokens = out;
      }
    } catch {
      this.tokens = {};
    }
  }

  private saveTokens(): void {
    try {
      fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
      fs.writeFileSync(TOKENS_FILE, JSON.stringify(this.tokens, null, 2), "utf8");
    } catch (err) {
      console.warn("[FlowEngine] Could not save bridge tokens:", err);
    }
  }

  private updateState(patch: Partial<FlowEngineState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof FlowEngineState>) {
      if (this.state[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    if (!this.disposed && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.STATE_CHANGED, this.getState());
    }
  }

  private preparePartitionSession(accountId: string): Session {
    const partition = `persist:flow-${accountId}`;
    const ses = session.fromPartition(partition);
    if (!this.configuredPartitions.has(partition)) {
      this.configuredPartitions.add(partition);
      ses.setUserAgent(this.cleanUserAgent);
      ses.webRequest.onBeforeSendHeaders(
        { urls: ["https://aisandbox-pa.googleapis.com/*"] },
        (details, callback) => {
          const headers = { ...details.requestHeaders };
          headers["Origin"] = "https://labs.google";
          headers["Referer"] = "https://labs.google/";
          callback({ requestHeaders: headers });
        },
      );
    }
    return ses;
  }

  private targetUrlForAccount(projectId: string | null): string {
    return projectId ? `${FLOW_BASE_URL}/project/${projectId}` : `${FLOW_BASE_URL}/`;
  }

  private ensureFlowView(accountId: string, initialProjectId: string | null): void {
    if (this.flowView && this.state.activeAccountId === accountId) {
      return;
    }

    this.destroyStandaloneAuthWindow();
    this.destroyFlowView();

    const ses = this.preparePartitionSession(accountId);
    const additionalArguments: string[] = [];
    if (!FLOW_BASE_URL.startsWith("https://flow.google.com")) {
      try {
        additionalArguments.push(`--flowboard-mock-flow-origin=${new URL(FLOW_BASE_URL).origin}`);
      } catch {
        // ignore
      }
    }

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        preload: this.flowPreloadPath,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        additionalArguments,
      },
    });

    view.webContents.setUserAgent(this.cleanUserAgent);
    view.webContents.setBackgroundThrottling(false);
    view.webContents.setAudioMuted(true);
    try {
      view.setBorderRadius(12);
    } catch {
      // ignore if unsupported on older OS compositor
    }

    // Handle window.open inside Flow (e.g., Google OAuth popups vs _blank project links)
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        const isFlowSameSite = url.startsWith(FLOW_BASE_URL);
        if (isFlowSameSite) {
          void view.webContents.loadURL(url);
          return { action: "deny" };
        }
        const isGoogleAuth =
          parsed.hostname === "accounts.google.com" ||
          parsed.hostname.endsWith(".google.com");
        if (isGoogleAuth) {
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              parent: this.mainWindow,
              modal: true,
              width: 520,
              height: 680,
              autoHideMenuBar: true,
              backgroundColor: "#141417",
              title: "Google 账号安全登录",
              webPreferences: {
                session: ses,
                contextIsolation: true,
                sandbox: true,
              },
            },
          };
        }
      } catch {
        // ignore malformed URL
      }
      return { action: "deny" };
    });

    const onUrlChange = (_event: unknown, url: string) => {
      this.updateState({ currentUrl: url, lastError: null });
      void this.evaluatePageState();
    };

    view.webContents.on("did-navigate", onUrlChange);
    view.webContents.on("did-navigate-in-page", onUrlChange);
    view.webContents.on("did-finish-load", () => {
      this.updateState({ currentUrl: view.webContents.getURL() });
      void this.evaluatePageState();
    });
    view.webContents.on("did-fail-load", (_ev, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = ERR_ABORTED on normal redirects
      this.updateState({
        authState: "error",
        lastError: `加载失败 (${code}): ${desc}`,
        currentUrl: validatedURL || view.webContents.getURL(),
      });
    });

    this.flowView = view;
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.contentView.addChildView(view);
    }

    // Start offscreen at realistic 1280x800 viewport while booting so rAF ticks cleanly
    this.applyViewVisibilityAndBounds();

    const startUrl = this.targetUrlForAccount(initialProjectId);
    this.updateState({
      activeAccountId: accountId,
      authState: "booting",
      currentUrl: startUrl,
      projectIdDetected: initialProjectId,
      paired: Boolean(this.tokens[accountId]),
      lastError: null,
    });

    void view.webContents.loadURL(startUrl);
  }

  private applyViewVisibilityAndBounds(): void {
    if (!this.flowView || this.mainWindow.isDestroyed()) return;
    if (
      this.state.drawerOpen &&
      !this.state.standaloneWindowOpen &&
      this.lastDrawerBounds.visible &&
      this.lastDrawerBounds.width > 20 &&
      this.lastDrawerBounds.height > 20
    ) {
      this.flowView.setBounds({
        x: this.lastDrawerBounds.x,
        y: this.lastDrawerBounds.y,
        width: this.lastDrawerBounds.width,
        height: this.lastDrawerBounds.height,
      });
      this.viewVisible = true;
      this.flowView.setVisible(true);
    } else {
      // Offscreen 1280x800 preserves desktop viewport metrics; once authenticated,
      // setVisible(false) halts GPU rasterization while backgroundThrottling:false keeps JS live.
      this.flowView.setBounds({
        x: -10000,
        y: -10000,
        width: 1280,
        height: 800,
      });
      const keepCompositorAwakeForBoot = this.state.authState === "booting";
      this.viewVisible = keepCompositorAwakeForBoot;
      this.flowView.setVisible(keepCompositorAwakeForBoot);
    }
  }

  private destroyFlowView(): void {
    const view = this.flowView;
    this.flowView = null;
    if (!view) return;
    try {
      if (!this.mainWindow.isDestroyed()) {
        this.mainWindow.contentView.removeChildView(view);
      }
    } catch {
      // ignore
    }
    try {
      (view.webContents as unknown as { close?: () => void }).close?.();
    } catch {
      // ignore
    }
  }

  public syncAccountsNow(): Promise<FlowEngineState> {
    if (this.disposed) return Promise.resolve(this.getState());
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.doSyncAccountsNow().finally(() => {
      this.syncInFlight = null;
    });
    return this.syncInFlight;
  }

  private async doSyncAccountsNow(): Promise<FlowEngineState> {
    if (this.disposed) return this.getState();
    try {
      const res = await fetch(`${getAgentBaseUrl()}/api/flow-accounts`, {
        headers: { Host: `127.0.0.1:${getAgentHttpPort()}` },
      });
      if (!res.ok) return this.getState();
      const snap = (await res.json()) as BackendAccountsSnapshot;
      if (this.managedChromeMode) {
        await this.syncManagedChromeAccounts(snap);
        return this.getState();
      }
      const activeId = snap.active_account_id;
      const activeRow = snap.accounts.find((a) => a.id === activeId) ?? null;
      this.activeAccountProjectId = activeRow?.project_id ?? null;

      if (!activeId) {
        this.closeWebSocket();
        this.destroyFlowView();
        this.updateState({
          activeAccountId: null,
          authState: "idle",
          currentUrl: "",
          projectIdDetected: null,
          paired: false,
          wsConnected: false,
          drawerOpen: false,
        });
        return this.getState();
      }

      if (this.state.activeAccountId !== activeId || !this.flowView) {
        this.unverifiedHelloTicks = 0;
        this.ensureFlowView(activeId, this.activeAccountProjectId);
        this.ensureWebSocket(activeId);
      } else {
        // Self-heal pairing if backend DB was wiped and no longer recognizes our saved token
        if (
          this.state.wsConnected &&
          this.tokens[activeId] &&
          activeRow &&
          !activeRow.connected
        ) {
          this.unverifiedHelloTicks += 1;
          if (this.unverifiedHelloTicks >= 2) {
            delete this.tokens[activeId];
            this.saveTokens();
            this.unverifiedHelloTicks = 0;
            this.closeWebSocket();
            this.ensureWebSocket(activeId);
          }
        } else {
          this.unverifiedHelloTicks = 0;
          if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            this.ensureWebSocket(activeId);
          }
        }
      }

      await this.evaluatePageState();
    } catch {
      // Agent may still be starting up
    }
    return this.getState();
  }

  // ── Official Managed Google Chrome Engine (Zero WebView Rejection) ───────

  private async syncManagedChromeAccounts(snap: BackendAccountsSnapshot): Promise<void> {
    const extensionPath = snap.extension_path || EXTENSION_DIR;
    const activeId = snap.active_account_id;
    const prevActiveId = this.state.activeAccountId;

    if (prevActiveId && prevActiveId !== activeId) {
      this.managedChrome.clearLaunchTimestamp(prevActiveId);
      void this.managedChrome.stopProcesses(prevActiveId);
    }

    if (!activeId) {
      this.activeAccountProjectId = null;
      this.updateState({
        managedChromeMode: true,
        extensionPath,
        activeAccountId: null,
        authState: "idle",
        currentUrl: "",
        projectIdDetected: null,
        paired: false,
        wsConnected: false,
        drawerOpen: false,
        lastError: null,
      });
      return;
    }

    const activeRow = snap.accounts.find((a) => a.id === activeId) ?? null;
    if (!activeRow) return;

    this.activeAccountProjectId = activeRow.project_id ?? null;
    const paired = Boolean(activeRow.paired || activeRow.connected);
    const wsConnected = Boolean(activeRow.connected);
    const ready = Boolean(activeRow.connected && activeRow.flow_tab_open);
    const nextAuth: FlowEngineAuthState = ready
      ? "authenticated"
      : wsConnected && !activeRow.flow_tab_open
        ? "login_required"
        : paired && !wsConnected
          ? this.state.lastError
            ? "error"
            : "booting"
          : "login_required";

    const nextUrl = this.targetUrlForAccount(this.activeAccountProjectId);
    this.updateState({
      managedChromeMode: true,
      extensionPath,
      activeAccountId: activeId,
      authState: nextAuth,
      currentUrl: nextUrl,
      projectIdDetected: activeRow.project_id ?? null,
      paired,
      wsConnected,
      lastError: ready ? null : this.state.lastError,
    });

    if (paired && !wsConnected && !this.managedChrome.isLaunching(activeId)) {
      const lastLaunched = this.managedChrome.getLastLaunchAt(activeId);
      if (Date.now() - lastLaunched > 25_000) {
        const shouldMinimize = !this.state.drawerOpen;
        await this.managedChrome.launch(activeId, this.activeAccountProjectId, {
          minimized: shouldMinimize,
        });
      }
    }

    const hasBoundProject = Boolean(activeRow.project_id);
    if (
      this.state.drawerOpen &&
      this.state.drawerMode === "auto-onboarding" &&
      ready &&
      hasBoundProject &&
      !this.autoCloseTimer
    ) {
      this.autoCloseTimer = setTimeout(() => {
        this.autoCloseTimer = null;
        if (
          this.state.drawerOpen &&
          this.state.drawerMode === "auto-onboarding" &&
          this.state.authState === "authenticated" &&
          this.state.paired
        ) {
          this.updateState({
            drawerOpen: false,
            notice: "Google Flow 正版 Chrome 伴侣引擎已就绪，已最小化转入后台运行。",
          });
          void this.managedChrome.minimizeWindows(activeId);
        }
      }, 450);
    }
  }

  private isFlowAuthenticatedAndReady(): boolean {
    return Boolean(this.state.activeAccountId && this.state.authState === "authenticated");
  }

  private async evaluatePageState(): Promise<void> {
    if (this.disposed) return;
    if (this.managedChromeMode) {
      if (this.state.drawerOpen || this.state.authState === "booting") {
        await this.syncAccountsNow();
      }
      return;
    }
    if (!this.flowView || !this.state.activeAccountId) return;
    const wc = this.flowView.webContents;
    if (wc.isDestroyed()) return;

    const url = wc.getURL() || "";
    const projectMatch = url.match(PROJECT_SEGMENT_RE);
    const detectedProject = projectMatch ? projectMatch[1].toLowerCase() : this.state.projectIdDetected;

    if (
      detectedProject &&
      !this.activeAccountProjectId &&
      !this.autoBindingInFlight &&
      this.state.activeAccountId
    ) {
      void this.autoBindProject(this.state.activeAccountId, detectedProject);
    }

    let nextAuth: FlowEngineAuthState = this.state.authState;

    try {
      const parsed = url ? new URL(url) : null;
      const isGoogleSignInPage =
        parsed &&
        (parsed.hostname === "accounts.google.com" ||
          parsed.pathname.startsWith("/signin") ||
          parsed.pathname.startsWith("/login"));

      if (isGoogleSignInPage) {
        nextAuth = "login_required";
      } else if (url.startsWith(FLOW_BASE_URL)) {
        const hasAtToken = Boolean(
          await wc
            .executeJavaScript(
              "Boolean(globalThis.WIZ_global_data && typeof globalThis.WIZ_global_data.SNlM0e === 'string' && globalThis.WIZ_global_data.SNlM0e.length > 0)",
              true,
            )
            .catch(() => false),
        );
        if (hasAtToken) {
          nextAuth = "authenticated";
        } else if (!wc.isLoadingMainFrame()) {
          const cookies = await wc.session.cookies.get({ url: FLOW_BASE_URL });
          const hasSessionCookie = cookies.some((c) => AUTH_COOKIE_NAMES.has(c.name));
          nextAuth = hasSessionCookie ? "booting" : "login_required";
          // Avoid staying stuck in 'booting' if page finished loading without SNlM0e (signed-out landing)
          if (hasSessionCookie) {
            const wizExists = Boolean(
              await wc
                .executeJavaScript("Boolean(globalThis.WIZ_global_data)", true)
                .catch(() => false),
            );
            if (!wizExists) nextAuth = "login_required";
          }
        } else {
          nextAuth = "booting";
        }
      } else if (url && !wc.isLoadingMainFrame()) {
        // Redirected to labs.google marketing landing page when signed out
        nextAuth = "login_required";
      }
    } catch {
      // ignore transient navigation race
    }

    const prevAuth = this.state.authState;
    this.updateState({
      currentUrl: url || this.state.currentUrl,
      projectIdDetected: detectedProject,
      authState: nextAuth,
    });

    if (prevAuth !== nextAuth) {
      if (nextAuth === "authenticated") {
        void wc.session.cookies.flushStore().catch(() => {});
      }
      this.applyViewVisibilityAndBounds();
    }

    this.pushPresenceIfNeeded();
    if (nextAuth === "authenticated") {
      void this.syncCreditsFromFlowView(false);
    }

    // Close standalone fallback auth window automatically as soon as session authenticates
    if (nextAuth === "authenticated" && this.standaloneAuthWin) {
      this.destroyStandaloneAuthWindow();
      void wc.loadURL(
        this.targetUrlForAccount(this.activeAccountProjectId || detectedProject),
      );
    }

    // Auto-hide onboarding drawer once signed in, paired, AND project_id is bound!
    const hasBoundProject = Boolean(this.activeAccountProjectId || detectedProject);
    if (
      this.state.drawerOpen &&
      this.state.drawerMode === "auto-onboarding" &&
      nextAuth === "authenticated" &&
      this.state.paired &&
      hasBoundProject &&
      !this.autoCloseTimer
    ) {
      this.autoCloseTimer = setTimeout(() => {
        this.autoCloseTimer = null;
        if (
          this.state.drawerOpen &&
          this.state.drawerMode === "auto-onboarding" &&
          this.state.authState === "authenticated" &&
          this.state.paired
        ) {
          this.lastDrawerBounds = {
            x: -10000,
            y: -10000,
            width: 1280,
            height: 800,
            visible: false,
          };
          this.updateState({
            drawerOpen: false,
            notice: "Google Flow 已完成登录与配对，自动转入内层后台静默运行。",
          });
          this.applyViewVisibilityAndBounds();
        }
      }, 450);
    }
  }

  private async autoBindProject(accountId: string, projectId: string): Promise<void> {
    this.autoBindingInFlight = true;
    try {
      const res = await fetch(
        `${getAgentBaseUrl()}/api/flow-accounts/${encodeURIComponent(accountId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Host: `127.0.0.1:${getAgentHttpPort()}`,
          },
          body: JSON.stringify({ project_id: projectId }),
        },
      );
      if (res.ok) {
        this.activeAccountProjectId = projectId;
        this.updateState({
          projectIdDetected: projectId,
          notice: `已自动绑定 Flow 项目 ${projectId.slice(0, 8)}…`,
        });
      }
    } catch {
      // ignore
    } finally {
      this.autoBindingInFlight = false;
    }
  }

  // ── Loopback WebSocket Bridge (:8355) & Zero-Click Auto-Pairing ──────────

  private ensureWebSocket(accountId: string): void {
    if (this.disposed) return;
    if (
      this.ws &&
      this.wsAccountId === accountId &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.closeWebSocket();
    this.wsAccountId = accountId;

    const socket = new WebSocket(getAgentWsUrl());
    this.ws = socket;

    socket.on("open", () => {
      if (this.ws !== socket || this.disposed) return;
      this.lastReportedPresence = null;
      this.updateState({ wsConnected: true });

      if (this.wsKeepaliveTimer) clearInterval(this.wsKeepaliveTimer);
      this.wsKeepaliveTimer = setInterval(() => {
        if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "ping" }));
          this.pushPresenceIfNeeded();
          void this.syncCreditsFromFlowView(false);
        }
      }, 20_000);

      const savedToken = this.tokens[accountId];
      if (savedToken) {
        socket.send(
          JSON.stringify({
            type: "profile_hello",
            profile_id: accountId,
            profile_token: savedToken,
          }),
        );
        this.updateState({ paired: true });
        this.pushPresenceIfNeeded(true);
      } else {
        this.updateState({ paired: false });
      }
    });

    socket.on("message", (rawData) => {
      if (this.ws !== socket || this.disposed) return;
      try {
        const msg = JSON.parse(rawData.toString("utf8")) as Record<string, unknown>;
        void this.handleWsMessage(accountId, socket, msg);
      } catch (err) {
        console.warn("[FlowEngine] Invalid WS JSON:", err);
      }
    });

    socket.on("close", () => {
      if (this.ws !== socket) return;
      if (this.wsKeepaliveTimer) {
        clearInterval(this.wsKeepaliveTimer);
        this.wsKeepaliveTimer = null;
      }
      this.ws = null;
      this.callbackSecret = null;
      this.lastReportedPresence = null;
      this.finishPendingPair({ ok: false, error: "内层桥接连接已断开，请重试。" });
      this.updateState({ wsConnected: false });

      if (!this.disposed && this.state.activeAccountId === accountId) {
        this.wsReconnectTimer = setTimeout(() => {
          if (!this.disposed && this.state.activeAccountId === accountId) {
            this.ensureWebSocket(accountId);
          }
        }, 2000);
      }
    });

    socket.on("error", () => {
      // handled by close event
    });
  }

  public async pairWithCode(rawCode: string): Promise<PairResult> {
    const code = (rawCode || "").trim();
    if (!code || code.length > 128) {
      return { ok: false, error: "请输入有效的配对码。" };
    }
    await this.syncAccountsNow();
    const accountId = this.state.activeAccountId;
    if (!accountId) {
      return { ok: false, error: "请先选择或创建一个 Flow 账号。" };
    }
    this.ensureWebSocket(accountId);

    // Wait up to 3s for WS to reach OPEN if still connecting
    const deadline = Date.now() + 3000;
    while (this.ws && this.ws.readyState === WebSocket.CONNECTING && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, error: "本地服务尚未连接，请稍后重试。" };
    }
    if (this.pendingPair) {
      return { ok: false, error: "正在配对中，请稍候。" };
    }

    // If re-pairing an already paired socket, reconnect fresh without profile_hello first
    // because ws_server rejects profile_pair when peer.profile_id is already set.
    if (this.tokens[accountId]) {
      delete this.tokens[accountId];
      this.saveTokens();
      this.closeWebSocket();
      this.ensureWebSocket(accountId);
      const reopenDeadline = Date.now() + 3000;
      while (
        (!this.ws || this.ws.readyState !== WebSocket.OPEN) &&
        Date.now() < reopenDeadline
      ) {
        await new Promise((r) => setTimeout(r, 80));
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return { ok: false, error: "重新建立配对通道超时，请重试。" };
      }
    }

    return new Promise<PairResult>((resolve) => {
      const timer = setTimeout(() => {
        this.finishPendingPair({
          ok: false,
          error: "本地服务未确认配对，请点击刷新配对码后重试。",
        });
      }, 8000);
      this.pendingPair = { resolve, timer };
      this.ws!.send(JSON.stringify({ type: "profile_pair", code }));
    });
  }

  private pushPresenceIfNeeded(force = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.state.paired) return;
    const ready = this.isFlowAuthenticatedAndReady();
    if (!force && this.lastReportedPresence === ready) return;
    this.lastReportedPresence = ready;
    this.ws.send(JSON.stringify({ type: "profile_presence", flow_tab_open: ready }));
    if (ready) {
      void this.syncCreditsFromFlowView(true);
    }
  }

  private async syncCreditsFromFlowView(force = false): Promise<void> {
    if (this.managedChromeMode || this.creditsSyncInFlight) return;
    if (
      !this.flowView ||
      this.flowView.webContents.isDestroyed() ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.state.paired ||
      this.state.authState !== "authenticated"
    ) {
      return;
    }
    const now = Date.now();
    if (!force && now - this.lastCreditsSyncAt < 45_000) return;

    this.creditsSyncInFlight = true;
    this.lastCreditsSyncAt = now;
    try {
      const res = (await this.flowView.webContents.executeJavaScript(
        `
        (async () => {
          try {
            const wiz = globalThis.WIZ_global_data || {};
            const at = wiz.SNlM0e;
            if (at) {
              const url =
                '/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=nzlxg' +
                '&source-path=' + encodeURIComponent(location.pathname || '/') +
                '&bl=' + encodeURIComponent(wiz.cfb2h || '') +
                '&f.sid=' + encodeURIComponent(wiz.FdrFJe || '') +
                '&hl=zh&_reqid=' + (Math.floor(Math.random() * 900000) + 100000) + '&rt=c';
              const resp = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                headers: {
                  'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
                  'x-same-domain': '1',
                },
                body: new URLSearchParams({
                  'f.req': JSON.stringify([[['nzlxg', '[]', null, 'generic']]]),
                  at,
                }),
              });
              if (resp.ok) {
                const text = await resp.text();
                const body = text.startsWith(")]}'") ? text.slice(text.indexOf('\\n') + 1) : text;
                for (const line of body.split('\\n')) {
                  const s = line.trim();
                  if (!s.startsWith('[')) continue;
                  try {
                    const chunk = JSON.parse(s);
                    for (const item of Array.isArray(chunk) ? chunk : []) {
                      if (Array.isArray(item) && item[0] === 'wrb.fr' && item[1] === 'nzlxg' && typeof item[2] === 'string') {
                        const arr = JSON.parse(item[2]);
                        if (Array.isArray(arr)) {
                          const coerce = (v) => {
                            if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
                            if (typeof v === 'string' && /^\\d+$/.test(v.trim())) return Number(v.trim());
                            return null;
                          };
                          const total = coerce(arr[0]);
                          const tierCode = coerce(arr[1]);
                          const topUp = coerce(arr[4]);
                          const sub = coerce(arr[5]);
                          const credits = total !== null ? total : ((sub ?? 0) + (topUp ?? 0));
                          const paygate_tier =
                            tierCode === 1 ? 'PAYGATE_TIER_ONE' : (tierCode === 2 || tierCode === 8) ? 'PAYGATE_TIER_TWO' : null;
                          if (typeof credits === 'number' && Number.isFinite(credits) && credits >= 0) {
                            return { credits, paygate_tier };
                          }
                        }
                      }
                    }
                  } catch {}
                }
              }
            }
            const el = document.querySelector('.credits-count, .credits-amount');
            if (el && el.textContent) {
              const digits = el.textContent.replace(/[^\\d]/g, '');
              if (digits) return { credits: Number(digits), paygate_tier: null };
            }
          } catch {}
          return null;
        })()
        `,
        true,
      )) as { credits?: number; paygate_tier?: string | null } | null;

      if (
        res &&
        typeof res.credits === "number" &&
        Number.isFinite(res.credits) &&
        res.credits >= 0 &&
        this.ws &&
        this.ws.readyState === WebSocket.OPEN &&
        this.state.paired
      ) {
        this.ws.send(
          JSON.stringify({
            type: "profile_credits",
            credits: Math.floor(res.credits),
            paygate_tier: res.paygate_tier ?? null,
          }),
        );
      }
    } catch {
      // ignore transient eval failures
    } finally {
      this.creditsSyncInFlight = false;
    }
  }

  private closeWebSocket(): void {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.wsKeepaliveTimer) {
      clearInterval(this.wsKeepaliveTimer);
      this.wsKeepaliveTimer = null;
    }
    const old = this.ws;
    this.ws = null;
    this.wsAccountId = null;
    this.callbackSecret = null;
    this.lastReportedPresence = null;
    if (old) {
      try {
        old.close();
      } catch {
        // ignore
      }
    }
  }

  private async sendResponseToAgent(payload: Record<string, unknown>): Promise<void> {
    if (payload.id) {
      try {
        const res = await fetch(getCallbackUrl(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Host: `127.0.0.1:${getAgentHttpPort()}`,
            "X-Callback-Secret": this.callbackSecret || "",
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) return;
      } catch {
        // fall through to WS
      }
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private async handleWsMessage(
    accountId: string,
    socket: WebSocket,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const type = msg.type;
    if (type === "profile_paired") {
      const profileId = msg.profile_id;
      const profileToken = msg.profile_token;
      if (typeof profileId === "string" && typeof profileToken === "string") {
        this.tokens[profileId] = profileToken;
        this.saveTokens();
        this.updateState({ paired: true });
        this.pushPresenceIfNeeded(true);
        this.finishPendingPair({ ok: true });
        void this.evaluatePageState();
      } else {
        this.finishPendingPair({ ok: false, error: "本地服务返回了无效的配对信息。" });
      }
      return;
    }

    if (type === "profile_pair_error") {
      const detail =
        typeof msg.detail === "string" ? msg.detail : "配对失败，请刷新配对码后重试。";
      this.finishPendingPair({ ok: false, error: detail });
      return;
    }

    if (type === "callback_secret" && typeof msg.secret === "string") {
      this.callbackSecret = msg.secret;
      return;
    }

    if (type === "pong" || type === "logout" || type === "please_resend_userinfo") {
      return;
    }

    const method = msg.method;
    if (method === "batch_rpc") {
      await this.handleBatchRpc(msg);
    } else if (method === "get_status") {
      await this.sendResponseToAgent({
        id: msg.id,
        result: {
          state: "idle",
          flowKeyPresent: false,
          manualDisconnect: false,
          tokenAge: null,
          metrics: this.metrics,
        },
      });
    } else if (method === "api_request") {
      await this.sendResponseToAgent({
        id: msg.id,
        status: 503,
        error: "NO_FLOW_KEY",
      });
    } else if (method === "trpc_request") {
      await this.handleTrpcRequest(msg);
    }

    void accountId;
    void socket;
  }

  private async handleBatchRpc(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as string | undefined;
    const params = (msg.params || {}) as {
      rpcid?: string;
      freq?: string;
      captchaAction?: string;
      match?: string;
    };

    if (!id) return;
    if (!params.rpcid || !params.freq) {
      await this.sendResponseToAgent({ id, status: 400, error: "INVALID_BATCH_RPC" });
      return;
    }

    if (!this.flowView || this.flowView.webContents.isDestroyed()) {
      await this.sendResponseToAgent({ id, status: 502, error: "NO_FLOW_TAB" });
      return;
    }

    const hasCaptcha = Boolean(params.captchaAction);
    if (hasCaptcha) this.metrics.requestCount += 1;

    try {
      let freq = params.freq;
      if (params.captchaAction) {
        const mintScript = `
          (async () => {
            if (typeof globalThis.__flowboardMintCaptcha !== 'function') {
              return { error: 'CAPTCHA_BRIDGE_NOT_READY' };
            }
            return await globalThis.__flowboardMintCaptcha(${JSON.stringify(params.captchaAction)});
          })()
        `;
        const solved = (await this.flowView.webContents.executeJavaScript(
          mintScript,
          true,
        )) as { token?: string; error?: string } | null;

        if (!solved?.token) {
          const err = `CAPTCHA_FAILED: ${solved?.error || "no token"}`;
          if (hasCaptcha) {
            this.metrics.failedCount += 1;
            this.metrics.lastError = err;
            this.pushMetricsUpdate();
          }
          await this.sendResponseToAgent({ id, status: 502, error: err });
          return;
        }
        freq = freq.split(CAPTCHA_SLOT).join(solved.token);
      }

      const rpcScript = `
        (async () => {
          const rpcid = ${JSON.stringify(params.rpcid)};
          const freqStr = ${JSON.stringify(freq)};
          const maxText = ${MAX_RPC_TEXT};
          const match = ${JSON.stringify(params.match ?? null)};

          const wiz = globalThis.WIZ_global_data || {};
          const at = wiz.SNlM0e;
          const sid = wiz.FdrFJe;
          const bl = wiz.cfb2h;
          if (!at) return { error: 'NO_AT_TOKEN' };

          const reqid = Math.floor(Math.random() * 900000) + 100000;
          const sourcePath = location.pathname || '/';
          const hl = (document.documentElement.lang || navigator.language || 'en').split('-')[0];
          const url =
            '/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=' + encodeURIComponent(rpcid) +
            '&source-path=' + encodeURIComponent(sourcePath) +
            '&bl=' + encodeURIComponent(bl || '') +
            '&f.sid=' + encodeURIComponent(sid || '') +
            '&hl=' + encodeURIComponent(hl) +
            '&_reqid=' + reqid +
            '&rt=c';

          const resp = await fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
              'x-same-domain': '1',
            },
            body: new URLSearchParams({ 'f.req': freqStr, at }),
          });
          const text = await resp.text();
          if (match) {
            const beforeWindow = 1024;
            const afterWindow = 4096;
            let entryHit = -1;
            let commaHit = -1;
            let firstHit = -1;
            let searchFrom = 0;
            while (searchFrom < text.length) {
              const idx = text.indexOf(match, searchFrom);
              if (idx === -1) break;
              if (firstHit === -1) firstHit = idx;
              const after = text.slice(idx + match.length, idx + match.length + 24);
              if (
                entryHit === -1 &&
                (after.startsWith('",null,null,[') || after.startsWith('\\\\",null,null,['))
              ) {
                entryHit = idx;
                break;
              }
              if (
                commaHit === -1 &&
                (after.startsWith('",') || after.startsWith('\\\\",'))
              ) {
                commaHit = idx;
              }
              searchFrom = idx + match.length;
            }
            const found = entryHit !== -1 ? entryHit : (commaHit !== -1 ? commaHit : firstHit);
            return {
              status: resp.status,
              matched: found !== -1,
              text: found === -1
                ? ''
                : text.slice(Math.max(0, found - beforeWindow), found + afterWindow),
            };
          }
          return { status: resp.status, text: text.slice(0, maxText) };
        })()
      `;

      const out = (await this.flowView.webContents.executeJavaScript(rpcScript, true)) as {
        status?: number;
        text?: string;
        error?: string;
      } | null;

      if (!out || out.error) {
        const err = out?.error || "NO_INJECTION_RESULT";
        if (hasCaptcha) {
          this.metrics.failedCount += 1;
          this.metrics.lastError = err;
          this.pushMetricsUpdate();
        }
        if (err === "NO_AT_TOKEN") {
          void this.evaluatePageState();
        }
        await this.sendResponseToAgent({ id, status: 502, error: err });
        return;
      }

      if (hasCaptcha) {
        this.metrics.successCount += 1;
        this.metrics.lastError = null;
        this.pushMetricsUpdate();
        setTimeout(() => void this.syncCreditsFromFlowView(true), 1200);
      }
      await this.sendResponseToAgent({
        id,
        status: out.status ?? 200,
        data: out.text ?? "",
      });
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      if (hasCaptcha) {
        this.metrics.failedCount += 1;
        this.metrics.lastError = msgText;
      }
      await this.sendResponseToAgent({ id, status: 500, error: msgText });
    }
  }

  private async handleTrpcRequest(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as string | undefined;
    if (!id) return;
    const params = (msg.params || {}) as {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    };
    if (!params.url || !params.url.startsWith("https://labs.google/fx/api/trpc/")) {
      await this.sendResponseToAgent({ id, error: "INVALID_TRPC_URL" });
      return;
    }
    if (!this.flowView || this.flowView.webContents.isDestroyed()) {
      await this.sendResponseToAgent({ id, error: "NO_FLOW_TAB" });
      return;
    }
    try {
      const script = `
        (async () => {
          const resp = await fetch(${JSON.stringify(params.url)}, {
            method: ${JSON.stringify(params.method || "POST")},
            headers: ${JSON.stringify({ "Content-Type": "application/json", ...(params.headers || {}) })},
            body: ${params.body ? JSON.stringify(JSON.stringify(params.body)) : "undefined"},
            credentials: 'include',
          });
          const data = await resp.json();
          return { status: resp.status, data };
        })()
      `;
      const out = (await this.flowView.webContents.executeJavaScript(script, true)) as {
        status: number;
        data: unknown;
      };
      await this.sendResponseToAgent({ id, status: out.status, data: out.data });
    } catch (err) {
      await this.sendResponseToAgent({
        id,
        error: err instanceof Error ? err.message : "TRPC_FETCH_FAILED",
      });
    }
  }

  // ── UI Drawer & Standalone Fallback Window Controls ──────────────────────

  public async openDrawer(opts?: OpenFlowDrawerOptions): Promise<FlowEngineState> {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
    await this.syncAccountsNow();
    if (this.managedChromeMode) {
      const targetAccountId = opts?.accountId || this.state.activeAccountId;
      this.updateState({
        drawerOpen: true,
        drawerMode: opts?.mode ?? "auto-onboarding",
      });
      if (targetAccountId) {
        await this.managedChrome.launch(targetAccountId, this.activeAccountProjectId, {
          minimized: false,
        });
      }
      return this.getState();
    }
    if (opts?.accountId && opts.accountId !== this.state.activeAccountId) {
      this.ensureFlowView(opts.accountId, this.activeAccountProjectId);
      this.ensureWebSocket(opts.accountId);
    }
    if (opts?.url && this.flowView && !this.flowView.webContents.isDestroyed()) {
      void this.flowView.webContents.loadURL(opts.url);
    }
    this.updateState({
      drawerOpen: true,
      drawerMode: opts?.mode ?? "auto-onboarding",
    });
    this.applyViewVisibilityAndBounds();
    return this.getState();
  }

  public closeDrawer(): FlowEngineState {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
    this.lastDrawerBounds = {
      x: -10000,
      y: -10000,
      width: 1280,
      height: 800,
      visible: false,
    };
    this.updateState({ drawerOpen: false });
    if (!this.managedChromeMode) {
      this.applyViewVisibilityAndBounds();
    }
    return this.getState();
  }

  public setDrawerBounds(bounds: FlowViewBounds): void {
    this.lastDrawerBounds = bounds;
    if (!this.managedChromeMode) {
      this.applyViewVisibilityAndBounds();
    }
  }

  public reloadFlow(): void {
    if (this.managedChromeMode) {
      if (this.state.activeAccountId) {
        void this.managedChrome.launch(this.state.activeAccountId, this.activeAccountProjectId, {
          minimized: false,
        });
      }
      return;
    }
    if (!this.flowView || this.flowView.webContents.isDestroyed()) return;
    const current = this.flowView.webContents.getURL();
    if (current) {
      this.flowView.webContents.reload();
    } else {
      void this.flowView.webContents.loadURL(
        this.targetUrlForAccount(this.activeAccountProjectId),
      );
    }
  }

  public openStandaloneAuthWindow(): void {
    if (!this.state.activeAccountId) return;
    if (this.managedChromeMode) {
      void this.managedChrome.launch(this.state.activeAccountId, this.activeAccountProjectId, {
        minimized: false,
      });
      return;
    }
    if (this.standaloneAuthWin && !this.standaloneAuthWin.isDestroyed()) {
      this.standaloneAuthWin.focus();
      return;
    }
    const ses = this.preparePartitionSession(this.state.activeAccountId);
    const authWin = new BrowserWindow({
      parent: this.mainWindow,
      width: 1020,
      height: 740,
      autoHideMenuBar: true,
      backgroundColor: "#09090b",
      title: "Google Flow 独立认证窗口（登录完成后可关闭）",
      webPreferences: {
        session: ses,
        preload: this.flowPreloadPath,
        contextIsolation: true,
        sandbox: true,
      },
    });
    authWin.webContents.setUserAgent(this.cleanUserAgent);
    this.standaloneAuthWin = authWin;
    this.updateState({ standaloneWindowOpen: true });
    this.applyViewVisibilityAndBounds();

    const target = this.targetUrlForAccount(this.activeAccountProjectId);
    void authWin.loadURL(target);

    authWin.on("closed", () => {
      if (this.standaloneAuthWin === authWin) {
        this.standaloneAuthWin = null;
      }
      this.updateState({ standaloneWindowOpen: false });
      this.applyViewVisibilityAndBounds();
      this.reloadFlow();
    });
  }

  private destroyStandaloneAuthWindow(): void {
    const win = this.standaloneAuthWin;
    this.standaloneAuthWin = null;
    if (win && !win.isDestroyed()) {
      try {
        win.close();
      } catch {
        // ignore
      }
    }
    if (this.state.standaloneWindowOpen) {
      this.updateState({ standaloneWindowOpen: false });
    }
  }
}
