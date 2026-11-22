import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { editFlowAccount, pairFlowAccount } from "../api/flowAccounts";
import { useDesktopFlowStore } from "../store/desktopFlow";
import { useFlowAccounts } from "../store/flowAccounts";

function formatShortUrl(raw: string): string {
  if (!raw) return "flow.google.com";
  try {
    const u = new URL(raw);
    const p = u.pathname === "/" ? "" : u.pathname;
    const text = `${u.host}${p}`;
    return text.length > 48 ? `${text.slice(0, 45)}…` : text;
  } catch {
    return raw.slice(0, 48);
  }
}

/**
 * 即梦画布风格 · 内层浏览器按需浮现抽屉 + 内置「Flowboard 连接助手」插件侧栏
 *
 * 1. 左侧为真实内层 WebContentsView（flow.google.com），右侧自动浮现内置连接助手插件面板。
 * 2. 无需手动安装 Chrome 扩展：未配对时自动生成并预填配对码，用户点击「配对」即可绑定。
 * 3. 当「已登录 + 已进入项目 + 已配对」三项齐备时，抽屉自动丝滑收起转入后台内层静默运行。
 */
export function EmbeddedFlowModal() {
  const isDesktop = useDesktopFlowStore((s) => s.isDesktop);
  const state = useDesktopFlowStore((s) => s.state);
  const closeDrawer = useDesktopFlowStore((s) => s.closeDrawer);
  const setDrawerBounds = useDesktopFlowStore((s) => s.setDrawerBounds);
  const reloadFlow = useDesktopFlowStore((s) => s.reloadFlow);
  const openStandaloneAuthWindow = useDesktopFlowStore((s) => s.openStandaloneAuthWindow);
  const syncAccountsNow = useDesktopFlowStore((s) => s.syncAccountsNow);
  const pairWithCode = useDesktopFlowStore((s) => s.pairWithCode);

  const snapshot = useFlowAccounts((s) => s.snapshot);
  const applyAccounts = useFlowAccounts((s) => s.apply);
  const slotRef = useRef<HTMLDivElement>(null);

  const [bindingProject, setBindingProject] = useState(false);
  const [pairCodeInput, setPairCodeInput] = useState("");
  const [pairLoading, setPairLoading] = useState(false);
  const [codeIssuing, setCodeIssuing] = useState(false);
  const [pairFeedback, setPairFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const [showRePairForm, setShowRePairForm] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState<"ext" | "code" | null>(null);
  const autoIssuedForAccountRef = useRef<string | null>(null);

  const open = Boolean(isDesktop && state?.drawerOpen);
  const activeAccountId = state?.activeAccountId ?? snapshot?.active_account_id ?? null;
  const activeAccount = snapshot?.accounts.find((a) => a.id === activeAccountId);
  const isManagedChrome = Boolean(state?.managedChromeMode);

  const copyText = useCallback(async (text: string, target: "ext" | "code") => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
      window.setTimeout(() => {
        setCopiedTarget((cur) => (cur === target ? null : cur));
      }, 1800);
    } catch {
      setPairFeedback({
        text: "请选中上方文本框内容后按 Ctrl+C 复制。",
        isError: false,
      });
    }
  }, []);

  const issueFreshCode = useCallback(
    async (accountId: string) => {
      if (codeIssuing) return;
      setCodeIssuing(true);
      try {
        const res = await pairFlowAccount(accountId);
        setPairCodeInput(res.code);
        setPairFeedback({
          text: "已为您自动生成配对码，点击「配对」即可连接。",
          isError: false,
        });
      } catch (err) {
        setPairFeedback({
          text: err instanceof Error ? err.message : "生成配对码失败，请点击刷新重试。",
          isError: true,
        });
      } finally {
        setCodeIssuing(false);
      }
    },
    [codeIssuing],
  );

  // Automatically pre-fill a fresh pairing code whenever the modal opens for an unpaired account!
  useEffect(() => {
    if (!open || !activeAccountId) {
      autoIssuedForAccountRef.current = null;
      return;
    }
    if (!state?.paired && autoIssuedForAccountRef.current !== activeAccountId) {
      autoIssuedForAccountRef.current = activeAccountId;
      void issueFreshCode(activeAccountId);
    }
  }, [open, activeAccountId, state?.paired, issueFreshCode]);

  const syncSlotBounds = useCallback(() => {
    const el = slotRef.current;
    if (!el || !open || isManagedChrome) return;
    const rect = el.getBoundingClientRect();
    const visible = !state?.standaloneWindowOpen && rect.width > 20 && rect.height > 20;
    void setDrawerBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      visible,
    });
  }, [open, isManagedChrome, setDrawerBounds, state?.standaloneWindowOpen]);

  useEffect(() => {
    if (!open) {
      if (!isManagedChrome) {
        void setDrawerBounds({ x: -10000, y: -10000, width: 1280, height: 800, visible: false });
      }
      return;
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void closeDrawer();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    if (isManagedChrome) {
      return () => {
        document.removeEventListener("keydown", onKeyDown);
      };
    }

    const raf = requestAnimationFrame(syncSlotBounds);
    const timer = window.setTimeout(syncSlotBounds, 120);
    const el = slotRef.current;
    const ro = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncSlotBounds) : null;
    if (ro && el) ro.observe(el);
    window.addEventListener("resize", syncSlotBounds);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      ro?.disconnect();
      window.removeEventListener("resize", syncSlotBounds);
      document.removeEventListener("keydown", onKeyDown);
      void setDrawerBounds({ x: -10000, y: -10000, width: 1280, height: 800, visible: false });
    };
  }, [open, isManagedChrome, syncSlotBounds, setDrawerBounds, closeDrawer]);

  if (!open || !state) return null;

  const authState = state.authState;
  const effectiveProjectId = activeAccount?.project_id || state.projectIdDetected;
  const allReady = authState === "authenticated" && state.paired && Boolean(effectiveProjectId);
  const dotTone = allReady ? "online" : "standby";

  const statusGuidance =
    authState === "login_required"
      ? "第 1 步：请在左侧登录 Google Flow 并进入项目 · 第 2 步：在右侧连接助手点击「配对」"
      : !effectiveProjectId
        ? "已登录 Google 账号 · 请在左侧点击进入一个现有项目或新建项目（自动捕获项目 ID）"
        : !state.paired
          ? "已登录并识别项目 · 请在右侧内置插件点击「配对」，完成后将自动收起转入后台"
          : `内层引擎已全部就绪 · 项目 ${effectiveProjectId.slice(0, 8)}…`;

  const canBindDetectedProject = Boolean(
    activeAccount &&
      state.projectIdDetected &&
      state.projectIdDetected !== activeAccount.project_id,
  );

  async function handleBindDetectedProject() {
    if (!activeAccount || !state?.projectIdDetected || bindingProject) return;
    setBindingProject(true);
    try {
      const updated = await editFlowAccount(activeAccount.id, {
        project_id: state.projectIdDetected,
      });
      applyAccounts(updated);
      await syncAccountsNow();
    } catch {
      // ignore
    } finally {
      setBindingProject(false);
    }
  }

  async function handleSubmitPair(e: FormEvent) {
    e.preventDefault();
    if (pairLoading || !pairCodeInput.trim()) return;
    setPairLoading(true);
    setPairFeedback({ text: "正在配对连接…", isError: false });
    try {
      const res = await pairWithCode(pairCodeInput.trim());
      if (res.ok) {
        setPairCodeInput("");
        setShowRePairForm(false);
        setPairFeedback({
          text: "✓ 配对成功！登录并进入项目后窗口将自动收起至内层运行。",
          isError: false,
        });
      } else {
        setPairFeedback({
          text: res.error || "配对未成功，请点击刷新配对码后重试。",
          isError: true,
        });
      }
    } finally {
      setPairLoading(false);
    }
  }

  const metrics = state.metrics ?? {
    requestCount: 0,
    successCount: 0,
    failedCount: 0,
    lastError: null,
  };

  if (isManagedChrome) {
    const extPath = snapshot?.extension_path || state.extensionPath || "extension";
    const chromeConnected = Boolean(activeAccount?.connected || state.wsConnected);
    const wizardStatus =
      allReady
        ? "正版 Chrome 伴侣引擎已就绪"
        : chromeConnected && authState === "login_required"
          ? "扩展已连接 · 请在已打开的官方 Chrome 中登录 Google Flow 并点开项目"
          : state.paired
            ? "已配对 · 正在等待正版 Chrome 伴侣窗口连接…"
            : "请按下方 3 步在官方 Chrome 窗口完成登录与扩展配对（首次配对后即可后台最小化运行）";

    return (
      <div
        className="jm-embedded-flow-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="Google Chrome 官方安全连接向导"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) void closeDrawer();
        }}
      >
        <div className="jm-embedded-flow-modal jm-embedded-flow-modal--chrome-wizard">
          <header className="jm-embedded-flow__header">
            <div className="jm-embedded-flow__status">
              <span className={`jm-conn-dot jm-conn-dot--${dotTone}`} aria-hidden="true" />
              <div className="jm-embedded-flow__titles">
                <strong>{activeAccount?.label || "Google Flow"} · 官方 Chrome 安全连接向导</strong>
                <span>{wizardStatus}</span>
              </div>
            </div>

            <div className="jm-embedded-flow__actions">
              <button
                id="btn-launch-managed-chrome"
                type="button"
                className="jm-embedded-flow__btn jm-embedded-flow__btn--accent"
                onClick={() => void reloadFlow()}
              >
                唤起 Chrome 窗口
              </button>
              <button
                type="button"
                className="jm-embedded-flow__cta"
                onClick={() => void closeDrawer()}
              >
                收起向导
              </button>
            </div>
          </header>

          <div className="jm-chrome-wizard__body">
            <div className="jm-chrome-wizard__notice">
              Google 官方安全策略会拦截任何内置网页视图中的账号登录（<code>accounts.google.com/v3/signin/rejected</code>）。
              桌面端已自动由受支持的正版 <strong>Google Chrome</strong> 独立配置目录托管账号登录与请求签名；首次完成配对后，日常启动将自动在任务栏最小化静默运行。
            </div>

            {state.lastError && (
              <div className="jm-chrome-wizard__error" role="alert">
                {state.lastError}
              </div>
            )}

            <div className="jm-chrome-wizard__pills">
              <span className={`jm-chrome-wizard__pill ${chromeConnected ? "is-ok" : state.paired ? "is-warn" : ""}`}>
                扩展桥接：{chromeConnected ? "● 已连接 · 已配对" : state.paired ? "○ 已配对（启动中…）" : "○ 待配对"}
              </span>
              <span className={`jm-chrome-wizard__pill ${authState === "authenticated" ? "is-ok" : ""}`}>
                Flow 页面：{authState === "authenticated" ? "● flow.google.com 已就绪" : "○ 请在 Chrome 登录并打开项目"}
              </span>
              <span className={`jm-chrome-wizard__pill ${effectiveProjectId ? "is-ok" : ""}`}>
                绑定项目：{effectiveProjectId ? `● 已绑定 ${effectiveProjectId.slice(0, 8)}…` : "○ 打开项目后自动识别"}
              </span>
            </div>

            <div className="jm-chrome-wizard__steps">
              <div className="jm-chrome-wizard__step">
                <div className="jm-chrome-wizard__step-head">
                  <strong>第 1 步 · 在官方 Chrome 登录 Google Flow 并点开项目</strong>
                  <button
                    type="button"
                    className="jm-embedded-flow__btn"
                    onClick={() => void openStandaloneAuthWindow()}
                  >
                    重新打开 Chrome 窗口
                  </button>
                </div>
                <p>
                  请在已打开的正版 Chrome 窗口登录开通了 <code>Pro</code> 或 <code>Ultra</code> 的 Google 账号（支持账号密码、2FA 与通行密钥），然后进入任意 Flow 项目（或新建项目），扩展将自动识别并绑定项目 UUID。
                </p>
              </div>

              <div className="jm-chrome-wizard__step">
                <div className="jm-chrome-wizard__step-head">
                  <strong>第 2 步 · 加载「Flowboard Bridge」扩展（新账号目录仅首次需要）</strong>
                  <button
                    type="button"
                    className="jm-embedded-flow__btn"
                    onClick={() => void copyText(extPath, "ext")}
                  >
                    {copiedTarget === "ext" ? "✓ 已复制扩展目录" : "复制扩展目录路径"}
                  </button>
                </div>
                <p>
                  在该 Chrome 窗口地址栏打开 <code>chrome://extensions</code> → 开启右上角「开发者模式」→ 点击「加载已解压的扩展程序」并选择目录：
                </p>
                <code className="jm-chrome-wizard__codebox">{extPath}</code>
              </div>

              <div className="jm-chrome-wizard__step">
                <div className="jm-chrome-wizard__step-head">
                  <strong>第 3 步 · 在 Chrome 扩展弹窗粘贴配对码</strong>
                  {activeAccountId && (
                    <button
                      type="button"
                      className="jm-embedded-flow__btn"
                      disabled={codeIssuing}
                      onClick={() => {
                        setShowRePairForm(true);
                        void issueFreshCode(activeAccountId);
                      }}
                    >
                      {codeIssuing ? "生成中…" : !state.paired || showRePairForm ? "刷新配对码" : "重新生成配对码"}
                    </button>
                  )}
                </div>

                {!state.paired || showRePairForm ? (
                  <>
                    <p>打开该 Chrome 窗口右上角「Flowboard Bridge」扩展弹窗，粘贴下方一次性配对码并点击「配对」；完成登录、入项与配对后向导会自动收起并将 Chrome 最小化至后台：</p>
                    <div className="jm-chrome-wizard__pair-row">
                      <code id="wizard-pair-code" className="jm-chrome-wizard__pair-code">
                        {pairCodeInput || (codeIssuing ? "生成中…" : "点击右侧刷新生成")}
                      </code>
                      <button
                        id="btn-copy-wizard-code"
                        type="button"
                        className="jm-embedded-flow__cta"
                        disabled={!pairCodeInput}
                        onClick={() => void copyText(pairCodeInput, "code")}
                      >
                        {copiedTarget === "code" ? "✓ 已复制配对码" : "复制配对码"}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="jm-plugin__feedback jm-plugin__feedback--ok">
                    {chromeConnected
                      ? "✓ 此账号已完成 Chrome 扩展配对与连接！如需查看官方积分余额或切换项目，可随时点击上方「唤起 Chrome 窗口」。"
                      : "✓ 此账号已完成配对记录，正在等待 Chrome 伴侣进程接入本地服务（也可点击上方「重新生成配对码」重新绑定）。"}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="jm-embedded-flow-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Google Flow 内层浏览器与连接助手"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void closeDrawer();
      }}
    >
      <div className="jm-embedded-flow-modal">
        <header className="jm-embedded-flow__header">
          <div className="jm-embedded-flow__status">
            <span className={`jm-conn-dot jm-conn-dot--${dotTone}`} aria-hidden="true" />
            <div className="jm-embedded-flow__titles">
              <strong>{activeAccount?.label || "Google Flow 内置浏览器"}</strong>
              <span>{statusGuidance}</span>
            </div>
          </div>

          <div className="jm-embedded-flow__actions">
            <span className="jm-embedded-flow__url" title={state.currentUrl}>
              {formatShortUrl(state.currentUrl)}
            </span>
            <button
              type="button"
              className="jm-embedded-flow__btn"
              onClick={() => void reloadFlow()}
              title="刷新内层 Flow 页面"
            >
              ↻ 刷新网页
            </button>

            {canBindDetectedProject && (
              <button
                type="button"
                className="jm-embedded-flow__btn jm-embedded-flow__btn--accent"
                disabled={bindingProject}
                onClick={() => void handleBindDetectedProject()}
                title={`将当前打开的项目 ${state.projectIdDetected} 绑定到此账号`}
              >
                {bindingProject ? "绑定中…" : "切换绑定当前项目"}
              </button>
            )}

            <button
              type="button"
              className="jm-embedded-flow__btn"
              onClick={() => void openStandaloneAuthWindow()}
              title="如遇通行密钥 (Passkey) 或安全密钥弹窗受阻，可在共享会话的独立窗口中完成登录"
            >
              独立窗口登录
            </button>

            <button
              type="button"
              className="jm-embedded-flow__cta"
              onClick={() => void closeDrawer()}
            >
              收起并后台运行
            </button>
          </div>
        </header>

        <div className="jm-embedded-flow__body">
          {/* 左侧：真实内嵌 flow.google.com 视图映射槽 */}
          <div ref={slotRef} className="jm-embedded-flow__slot">
            {state.standaloneWindowOpen && (
              <div className="jm-embedded-flow__placeholder">
                <p>正在独立认证窗口中完成 Google 登录…</p>
                <span>登录完成后独立窗口会自动关闭，会话将直接同步至当前内层引擎。</span>
              </div>
            )}
          </div>

          {/* 右侧：自动出现的内置「Flowboard 连接助手」插件面板 */}
          <aside className="jm-embedded-flow__plugin" aria-label="Flowboard 连接助手内置插件">
            <div className="jm-plugin__head">
              <div>
                <h4>Flowboard 连接助手</h4>
                <span>内置扩展桥接 · 免手动安装</span>
              </div>
              <span className="jm-plugin__badge">内置</span>
            </div>

            <div className="jm-plugin__rows">
              <div className="jm-plugin__row">
                <span className="jm-plugin__label">桥接状态</span>
                <span
                  className={`jm-plugin__val ${
                    !state.wsConnected
                      ? "jm-plugin__val--muted"
                      : state.paired
                        ? "jm-plugin__val--ok"
                        : "jm-plugin__val--warn"
                  }`}
                >
                  {!state.wsConnected
                    ? "○ 连接本地服务中…"
                    : state.paired
                      ? "● 已连接 · 已配对"
                      : "● 已连接 · 待配对"}
                </span>
              </div>

              <div className="jm-plugin__row">
                <span className="jm-plugin__label">Flow 签名</span>
                <span
                  className={`jm-plugin__val ${
                    authState === "authenticated" ? "jm-plugin__val--ok" : "jm-plugin__val--muted"
                  }`}
                >
                  {authState === "authenticated"
                    ? "● 已获取签名令牌"
                    : authState === "login_required"
                      ? "○ 待左侧登录"
                      : "○ 页面加载中…"}
                </span>
              </div>

              <div className="jm-plugin__row">
                <span className="jm-plugin__label">目标项目</span>
                <span
                  className={`jm-plugin__val ${
                    effectiveProjectId ? "jm-plugin__val--ok" : "jm-plugin__val--muted"
                  }`}
                  title={effectiveProjectId || "尚未打开项目"}
                >
                  {effectiveProjectId ? `● ${effectiveProjectId.slice(0, 8)}…` : "○ 请点开项目"}
                </span>
              </div>

              <div className="jm-plugin__row">
                <span className="jm-plugin__label">请求统计</span>
                <span className="jm-plugin__val">
                  {metrics.requestCount} · ✓ {metrics.successCount} · ✗ {metrics.failedCount}
                </span>
              </div>

              {metrics.lastError && (
                <div className="jm-plugin__row">
                  <span className="jm-plugin__label">最近异常</span>
                  <span className="jm-plugin__val jm-plugin__val--err" title={metrics.lastError}>
                    {metrics.lastError}
                  </span>
                </div>
              )}
            </div>

            {(!state.paired || showRePairForm) ? (
              <form className="jm-plugin__pair-box" onSubmit={(e) => void handleSubmitPair(e)}>
                <div className="jm-plugin__pair-head">
                  <strong>配对当前画布账号</strong>
                  {activeAccountId && (
                    <button
                      type="button"
                      className="jm-plugin__link-btn"
                      disabled={codeIssuing || pairLoading}
                      onClick={() => void issueFreshCode(activeAccountId)}
                    >
                      {codeIssuing ? "生成中…" : "刷新配对码"}
                    </button>
                  )}
                </div>
                <p className="jm-plugin__pair-hint">
                  已自动填入当前账号配对码，直接点击「配对」即可绑定内层浏览器。
                </p>
                <div className="jm-plugin__pair-controls">
                  <input
                    id="embedded-pair-code"
                    type="text"
                    value={pairCodeInput}
                    onChange={(e) => setPairCodeInput(e.target.value)}
                    placeholder="输入或自动获取配对码"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={pairLoading}
                  />
                  <button
                    id="btn-embedded-pair"
                    type="submit"
                    disabled={pairLoading || !pairCodeInput.trim()}
                  >
                    {pairLoading ? "配对中…" : "配对"}
                  </button>
                </div>
                {pairFeedback && (
                  <p
                    className={`jm-plugin__feedback ${
                      pairFeedback.isError ? "jm-plugin__feedback--err" : "jm-plugin__feedback--ok"
                    }`}
                  >
                    {pairFeedback.text}
                  </p>
                )}
              </form>
            ) : (
              <div className="jm-plugin__paired-card">
                <div className="jm-plugin__paired-status">
                  <span>✓ 此账号已完成插件配对</span>
                  <button
                    type="button"
                    className="jm-plugin__link-btn"
                    onClick={() => {
                      setShowRePairForm(true);
                      if (activeAccountId) void issueFreshCode(activeAccountId);
                    }}
                  >
                    重新配对
                  </button>
                </div>
                <p>
                  {allReady
                    ? "登录、项目与插件配对均已就绪，点击「收起并后台运行」即可无感创作。"
                    : "完成左侧 Google Flow 登录并点开任意项目后，窗口将自动收起转入后台。"}
                </p>
                {pairFeedback && (
                  <p className="jm-plugin__feedback jm-plugin__feedback--ok">{pairFeedback.text}</p>
                )}
              </div>
            )}

            <div className="jm-plugin__footer">
              <button
                type="button"
                className="jm-plugin__action-btn"
                onClick={() => void reloadFlow()}
              >
                重新加载 Flow 页面
              </button>
              <button
                type="button"
                className="jm-plugin__action-btn jm-plugin__action-btn--primary"
                onClick={() => void closeDrawer()}
              >
                隐藏至内层后台运行
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
