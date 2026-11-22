import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  activateFlowAccount,
  createFlowAccount,
  editFlowAccount,
  getFlowAccounts,
  getGoogleFlowLoginConfig,
  getGoogleFlowLoginStatus,
  startGoogleFlowLogin,
  pairFlowAccount,
  restoreLegacyFlow,
  type FlowAccount,
  type FlowPaygateTier,
  type GoogleFlowLoginConfig,
} from "../api/flowAccounts";
import { useFlowAccounts } from "../store/flowAccounts";
import { useDesktopFlowStore } from "../store/desktopFlow";

const PROJECT_ID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const creditsFormat = new Intl.NumberFormat("zh-CN");
const LOGIN_TIMEOUT = 10 * 60_000;
const LOGIN_POLL_DELAY = 1500;

function waitForStatus(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, LOGIN_POLL_DELAY);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function accountDraft(account: FlowAccount): EditDraft {
  return { label: account.label, project: account.project_id ?? "", credits: String(account.credits ?? ""), tier: account.paygate_tier ?? "" };
}

function flowStatus(
  account: FlowAccount,
  isDesktop: boolean,
  managedChrome: boolean,
  isActive: boolean,
  desktopAuthState?: string,
) {
  if (isDesktop) {
    if (account.connected && account.flow_tab_open) {
      return managedChrome ? "Chrome 后台已就绪" : "内层引擎已就绪";
    }
    if (!isActive) return "待机（切换后激活）";
    if (desktopAuthState === "login_required") {
      return managedChrome ? "待在 Chrome 登录/配对" : "待登录 Google Flow";
    }
    if (desktopAuthState === "booting") {
      return managedChrome ? "正在后台唤起 Chrome…" : "内层加载中…";
    }
    if (desktopAuthState === "error") return "Chrome 启动异常";
    return managedChrome ? "正在连接 Chrome 伴侣…" : "正在连接内层桥接…";
  }
  if (!account.connected) return "扩展未连接";
  return account.flow_tab_open ? "Flow 网页已打开" : "等待 Flow 网页";
}

interface EditDraft { label: string; project: string; credits: string; tier: FlowPaygateTier | "" }
interface PairCode { accountId: string; code: string; expiresAt: number }

export function FlowAccountsSection({ compact = false }: { compact?: boolean } = {}) {
  const { snapshot, readError, refresh, apply } = useFlowAccounts();
  const isDesktop = useDesktopFlowStore((s) => s.isDesktop);
  const desktopState = useDesktopFlowStore((s) => s.state);
  const openDesktopDrawer = useDesktopFlowStore((s) => s.openDrawer);
  const syncDesktopAccounts = useDesktopFlowStore((s) => s.syncAccountsNow);
  const embeddedMode = isDesktop || Boolean(snapshot?.embedded_browser);
  const managedChrome = Boolean(desktopState?.managedChromeMode);
  const sectionId = useId();
  const titleId = `${sectionId}-title`;
  const setupId = `${sectionId}-setup`;
  const googleSetupId = `${sectionId}-google-setup`;
  const [view, setView] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft>({ label: "", project: "", credits: "", tier: "" });
  const [pair, setPair] = useState<PairCode | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [loginConfig, setLoginConfig] = useState<GoogleFlowLoginConfig | null>(null);
  const [loginConfigFailed, setLoginConfigFailed] = useState(false);
  const [showLoginConfig, setShowLoginConfig] = useState(false);
  const [loginConfigVersion, setLoginConfigVersion] = useState(0);
  const loginAttempt = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getGoogleFlowLoginConfig(controller.signal).then((config) => {
      setLoginConfig(config);
      setLoginConfigFailed(false);
    }).catch(() => {
      if (!controller.signal.aborted) setLoginConfigFailed(true);
    });
    return () => controller.abort();
  }, [loginConfigVersion]);

  useEffect(() => () => loginAttempt.current?.abort(), []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!pair) return;
    const id = window.setTimeout(() => {
      setPair(null);
      setNotice("配对码已过期，请重新获取。");
    }, Math.max(0, pair.expiresAt - Date.now()));
    return () => window.clearTimeout(id);
  }, [pair]);

  const pairedConnected = snapshot?.accounts.some((account) => account.id === pair?.accountId && account.connected);
  useEffect(() => {
    if (pairedConnected) {
      setPair(null);
      setNotice("扩展已连接。");
    }
  }, [pairedConnected]);

  async function perform(key: string, action: () => Promise<void>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败，请重试。");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  function openForm(account: FlowAccount) {
    const target = account.id;
    setView(view === target ? null : target);
    setDraft(accountDraft(account));
    setError(null);
    setNotice(null);
  }

  function addAndOpen() {
    void perform("add", async () => {
      const before = await getFlowAccounts();
      const labels = new Set(before.accounts.map((account) => account.label));
      let number = 1;
      while (labels.has(`Flow 账号 ${number}`)) number += 1;
      const label = `Flow 账号 ${number}`;
      const added = await createFlowAccount({ label });
      apply(added);
      if (!added.created_account_id) {
        setNotice("账号已添加。请在列表中打开此账号的 Flow 网页。");
        return;
      }
      try {
        apply(await activateFlowAccount(added.created_account_id, { skipLaunch: embeddedMode }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "请稍后重试。";
        throw new Error(`账号已添加，请通过账号卡片重试打开 Flow。${message}`);
      }
      setPair(null);
      setView(null);
      if (isDesktop) {
        await syncDesktopAccounts();
        await openDesktopDrawer({
          accountId: added.created_account_id,
          mode: "auto-onboarding",
        });
        setNotice(
          managedChrome
            ? "已为您打开官方 Chrome 窗口与连接向导：登录 Google Flow、加载扩展并粘贴配对码后，Chrome 将自动最小化后台运行。"
            : "请在左侧网页登录 Google Flow 并点开任意项目，再点击右侧「Flowboard 连接助手」中的「配对」，完成后将自动收起转入后台。",
        );
      } else {
        setNotice("请在打开的独立 Chrome 窗口登录 Flow 官网并加载扩展，再返回此处点击「获取配对码」完成绑定。");
      }
    });
  }

  function signIn() {
    if (pendingRef.current) return;
    const popup = window.open("about:blank", "_blank", "popup,width=540,height=700");
    if (!popup) {
      setNotice(null);
      setError("浏览器拦截了登录窗口。请为画布允许弹出窗口后重试。");
      return;
    }
    popup.opener = null;
    const controller = new AbortController();
    loginAttempt.current = controller;
    const timer = window.setTimeout(() => controller.abort("timeout"), LOGIN_TIMEOUT);
    void perform("google", async () => {
      try {
        const { authorization_url, attempt_id } = await startGoogleFlowLogin(controller.signal);
        const authorize = new URL(authorization_url);
        if (authorize.origin !== "https://accounts.google.com") throw new Error("Google 登录地址异常，请重试。");
        if (popup.closed) throw new Error("登录窗口已关闭，请重新登录。");
        popup.location.replace(authorize.href);
        setNotice("请在新窗口完成 Google 登录，返回后会自动添加账号。");
        while (!controller.signal.aborted) {
          const status = await getGoogleFlowLoginStatus(attempt_id, controller.signal);
          if (status.status === "error") throw new Error(status.detail || "Google 登录失败，请重试。");
          if (status.status === "success") {
            const next = await getFlowAccounts(controller.signal);
            const account = next.accounts.find((item) => item.id === status.account_id);
            apply(next);
            if (account) {
              if (!account.project_id) {
                setDraft(accountDraft(account));
                setView(account.id);
              } else {
                setView(null);
              }
              setNotice(account.project_id ? "Google 账号已关联，原有项目和设置已保留。" : "Google 账号已关联。请绑定现有 Flow 项目，或先到 Flow 新建项目。");
            } else {
              setNotice("Google 登录已完成，请刷新账号列表。");
            }
            return;
          }
          await waitForStatus(controller.signal);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setNotice(null);
          throw err;
        }
      } finally {
        window.clearTimeout(timer);
        loginAttempt.current = null;
        // A Google COOP response can detach our WindowProxy even though login
        // is still open. The status endpoint is authoritative after navigation.
        if (!popup.closed) popup.close();
        if (controller.signal.reason === "timeout") setNotice("等待登录超时，请重新打开 Google 登录窗口。");
        if (controller.signal.reason === "cancel") setNotice("已结束等待，可重新发起 Google 登录。");
      }
    });
  }

  function save(e: FormEvent<HTMLFormElement>, account: FlowAccount) {
    e.preventDefault();
    const label = draft.label.trim();
    const inputProject = draft.project.trim();
    const project_id = inputProject.match(PROJECT_ID)?.[0]?.toLowerCase() ?? null;
    const inputCredits = draft.credits.trim();
    const credits = inputCredits ? Number(inputCredits) : null;
    const paygate_tier = draft.tier || null;
    if (!label) return setError("请输入易于识别的账号名称。");
    if (inputProject && !project_id) return setError("请输入有效的 Flow 项目链接或项目 ID。");
    if (credits !== null && (!/^\d+$/.test(inputCredits) || !Number.isSafeInteger(credits) || credits > 1_000_000_000)) {
      return setError("积分应为 0–1,000,000,000 的整数；留空表示未记录。");
    }
    void perform("save", async () => {
      apply(await editFlowAccount(account.id, {
        ...(label !== account.label && { label }),
        ...(project_id !== account.project_id && { project_id }),
        ...(paygate_tier !== (account.paygate_tier ?? null) && { paygate_tier }),
        ...(credits !== account.credits && { credits }),
      }));
      setNotice("账号设置已保存。");
      setView(null);
    });
  }

  function activate(account: FlowAccount, isActive: boolean, createProject = false) {
    void perform(`activate:${account.id}`, async () => {
      apply(await activateFlowAccount(account.id, { skipLaunch: embeddedMode }));
      if (!isActive) setPair(null);
      if (isDesktop) {
        await syncDesktopAccounts();
        const incomplete = !account.connected || !account.flow_tab_open || !account.project_id || createProject;
        if (isActive || incomplete) {
          await openDesktopDrawer({
            accountId: account.id,
            mode: incomplete ? "auto-onboarding" : "manual-inspect",
          });
          setNotice(
            managedChrome
              ? incomplete
                ? "已唤出官方 Chrome 窗口与连接向导，完成登录、入项并配对后 Chrome 将自动最小化至后台运行。"
                : "已唤起官方 Chrome 窗口，查看积分或切换项目完毕后可最小化或在向导点击「收起向导」。"
              : incomplete
                ? "已唤出内嵌浏览器与连接助手插件，完成登录、进入项目并配对后将自动收起转入后台。"
                : "已打开当前账号的内层 Flow 视图，查看完毕后点击「收起并后台运行」即可。",
          );
        } else {
          setNotice(
            managedChrome
              ? `已切换至「${account.label}」，官方 Chrome 伴侣正在后台最小化就绪。`
              : `已切换至「${account.label}」，内层浏览器正在后台静默就绪。`,
          );
        }
        return;
      }
      setNotice(createProject ? "请在此账号的 Flow 窗口点击「新建项目」，然后复制项目链接回到画布。"
        : isActive ? "已请求打开 Chrome 中的 Flow 网页。"
          : `已切换至「${account.label}」，并请求打开对应的 Chrome 窗口。`);
    });
  }

  function issuePairCode(account: FlowAccount) {
    void perform(`pair:${account.id}`, async () => {
      const { code, expires_in } = await pairFlowAccount(account.id);
      setPair({ accountId: account.id, code, expiresAt: Date.now() + expires_in * 1000 });
      setShowSetup(true);
    });
  }

  function form(account: FlowAccount) {
    return (
      <form className="flow-accounts__form" onSubmit={(e) => save(e, account)}>
        <label>账号名称
          <input className="settings-panel__project-input" type="text" value={draft.label} required maxLength={80}
            placeholder="如：个人、工作室" disabled={pending !== null}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        </label>
        <label>Flow 项目
          <input className="settings-panel__project-input" type="text" value={draft.project} spellCheck={false}
            placeholder="粘贴项目链接或项目 ID" disabled={pending !== null}
            onChange={(e) => setDraft({ ...draft, project: e.target.value })} />
        </label>
        <label>生成套餐（手动配置）
          <select className="settings-panel__project-input" value={draft.tier} disabled={pending !== null}
            onChange={(e) => setDraft({ ...draft, tier: e.target.value as EditDraft["tier"] })}>
            <option value="">跟随全局配置</option>
            <option value="PAYGATE_TIER_ONE">Pro</option>
            <option value="PAYGATE_TIER_TWO">Ultra</option>
          </select>
        </label>
        <label>积分余额（手动）
          <input className="settings-panel__project-input" type="text" inputMode="numeric" maxLength={16}
            value={draft.credits} placeholder="留空则不记录" disabled={pending !== null}
            onChange={(e) => setDraft({ ...draft, credits: e.target.value })} />
        </label>
        {!account.project_id && (
          <div className="flow-accounts__form-note">
            <span>没有项目？先在 Flow 中新建，再粘贴项目链接。</span>
            <button className="flow-accounts__button" type="button" disabled={pending !== null}
              onClick={() => activate(account, snapshot?.active_account_id === account.id, true)}>前往 Flow 新建项目</button>
          </div>
        )}
        <div className="flow-accounts__actions">
          <button className="flow-accounts__button" type="button" disabled={pending !== null} onClick={() => setView(null)}>取消</button>
          <button className="settings-panel__project-btn" type="submit" disabled={pending !== null}>
            {pending === "save" ? "保存中…" : "保存设置"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <section className={`settings-panel__section flow-accounts${compact ? " flow-accounts--compact" : ""}`} aria-labelledby={titleId}>
      <div className="flow-accounts__head">
        <div>
          <h3 className="settings-panel__label" id={titleId}>Flow 账号与积分</h3>
          <p className="settings-panel__hint">
            {embeddedMode
              ? managedChrome
                ? "正版 Chrome 伴侣引擎：彻底规避 Google 内嵌浏览器安全拦截；首次配对后日常启动自动后台最小化静默连接。"
                : "内置浏览器与连接助手：免手动装扩展，首次登录进入项目并在右侧点击「配对」后即自动转入后台运行。"
              : "每个账号使用独立 Chrome 会话目录，登录 Flow 官网并配对扩展后即可持续复用。"}
          </p>
        </div>
        {snapshot && (
          <div className="flow-accounts__entry-actions">
            <button className="settings-panel__project-btn" type="button" disabled={pending !== null}
              onClick={addAndOpen}>{pending === "add" ? "正在打开…" : compact ? "添加账号" : embeddedMode ? "添加并连接账号" : "添加账号并打开 Flow"}</button>
            {!compact && loginConfig?.configured && (
              <button className="flow-accounts__button" type="button" disabled={pending !== null}
                onClick={signIn}>{pending === "google" ? "等待 Google 登录…" : "导入 Google 账号资料"}</button>
            )}
          </div>
        )}
      </div>
      {pending === "google" && (
        <button className="flow-accounts__button" type="button" onClick={() => loginAttempt.current?.abort("cancel")}>结束等待 Google 登录</button>
      )}
      {readError && (
        <div className="settings-panel__project-feedback" role="status">
          <div><strong>{snapshot ? "账号连接状态尚未刷新" : "读取 Flow 账号失败"}</strong>
            <div className="settings-panel__hint">请确认本地服务已运行。{readError}</div></div>
          <button className="settings-panel__retry" type="button" onClick={() => void refresh()}>重试</button>
        </div>
      )}
      {!snapshot && !readError && <p className="settings-panel__hint" role="status">正在读取账号…</p>}
      {error && <p className="settings-panel__project-error" role="alert">{error}</p>}
      {notice && <p className="settings-panel__hint" role="status">{notice}</p>}
      {snapshot?.accounts.length === 0 && (
        <p className="flow-accounts__empty">
          {embeddedMode
            ? managedChrome
              ? "还没有添加账号。点击上方「添加账号」将自动打开官方 Chrome 与安全连接向导，登录并配对后即转入后台静默运行。"
              : "还没有添加账号。点击上方「添加账号」将弹出内嵌 Flow 网页与右侧「Flowboard 连接助手」，登录、进入项目并点击「配对」后自动转入后台运行。"
            : "还没有独立账号。点击上方「添加账号」将启动独立 Chrome 窗口，登录 Flow、加载扩展并获取配对码完成绑定。"}
        </p>
      )}
      {snapshot && snapshot.accounts.length > 0 && (
        <ul className="flow-accounts__list" aria-label="Flow 账号列表">
          {snapshot.accounts.slice().sort((a, b) => Number(b.id === snapshot.active_account_id) - Number(a.id === snapshot.active_account_id)).map((account) => {
            const active = account.id === snapshot.active_account_id;
            const syncDate = account.credits_updated_at ? new Date(account.credits_updated_at) : null;
            const timestamp = syncDate && Number.isFinite(syncDate.getTime())
              ? syncDate.toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null;
            const needsEmbeddedOnboarding =
              embeddedMode && active && (!account.connected || !account.flow_tab_open || !account.project_id);
            const activeActionLabel = embeddedMode
              ? managedChrome
                ? !account.connected
                  ? "唤起 Chrome 并配对"
                  : needsEmbeddedOnboarding
                    ? "打开 Chrome 登录并绑定"
                    : "查看 Chrome 网页"
                : !account.connected
                  ? "打开并配对"
                  : needsEmbeddedOnboarding
                    ? "登录并绑定项目"
                    : "查看内层网页"
              : "打开 Flow";
            return (
              <li className={`flow-accounts__card${active ? " flow-accounts__card--active" : ""}`} key={account.id}>
                <div className="flow-accounts__summary">
                  <div className="flow-accounts__identity">
                    <div className="flow-accounts__name"><strong>{account.label}</strong>{active && <span>当前账号</span>}</div>
                    {account.google_email && <p className="flow-accounts__email" title="已关联 Google 身份；Flow 登录状态需单独确认。">{account.google_email}</p>}
                    <div className="flow-accounts__meta">
                      <span className={`flow-accounts__status${account.connected && account.flow_tab_open ? " flow-accounts__status--online" : ""}`}>
                        {flowStatus(account, embeddedMode, managedChrome, active, desktopState?.authState)}
                      </span>
                      <span>{account.project_id ? "已绑定项目" : "未绑定项目"}</span>
                      <span>{account.paygate_tier === "PAYGATE_TIER_TWO" ? "配置：Ultra" : account.paygate_tier === "PAYGATE_TIER_ONE" ? "配置：Pro" : "跟随默认套餐"}</span>
                    </div>
                  </div>
                  <div className="flow-accounts__balance">
                    {account.credits === null ? <strong>等待同步</strong> : <strong>{creditsFormat.format(account.credits)} 积分</strong>}
                    <span>{account.credits === null ? "打开 Flow 自动获取" : timestamp ? `自动同步 · ${timestamp}` : "实时余额"}</span>
                  </div>
                </div>
                <div className="flow-accounts__actions">
                  <button className="flow-accounts__button" type="button" disabled={pending !== null}
                    aria-label={`编辑${account.label}的项目与积分`} aria-expanded={view === account.id}
                    onClick={() => openForm(account)}>编辑项目与积分</button>
                  {active && account.connected && account.flow_tab_open && (
                    <button className="flow-accounts__button" type="button" disabled={pending !== null}
                      onClick={() => void useFlowAccounts.getState().syncCredits()}>刷新积分</button>
                  )}
                  {!embeddedMode && active && !account.connected && <button className="flow-accounts__button" type="button" disabled={pending !== null}
                    onClick={() => issuePairCode(account)}>{pending === `pair:${account.id}` ? "获取中…" : "获取配对码"}</button>}
                  <button className="settings-panel__project-btn" type="button" disabled={pending !== null}
                    onClick={() => activate(account, active)}>{pending === `activate:${account.id}` ? "正在处理…" : active ? activeActionLabel : embeddedMode ? "切换至此账号" : "切换并打开"}</button>
                </div>
                {!embeddedMode && active && pair?.accountId === account.id && (
                  <div className="flow-accounts__code" role="status">
                    <span>在此账号的 Chrome 窗口中打开扩展，填入配对码：</span>
                    <code>{pair.code}</code>
                    <button className="flow-accounts__button" type="button" onClick={() => {
                      void Promise.resolve().then(() => navigator.clipboard.writeText(pair.code)).then(() => setNotice("已复制配对码。")).catch(() => setNotice("请选中并复制上方配对码。"));
                    }}>复制</button>
                  </div>
                )}
                {view === account.id && form(account)}
              </li>
            );
          })}
        </ul>
      )}
      {snapshot && (
        <div className="flow-accounts__setup">
          <button type="button" className="flow-accounts__button" aria-expanded={showSetup}
            aria-controls={setupId} onClick={() => setShowSetup((old) => !old)}>账号导入与连接指引</button>
          {!embeddedMode && snapshot.active_account_id !== null && (
            <button className="flow-accounts__button" type="button" disabled={pending !== null}
              onClick={() => void perform("legacy", async () => {
                apply(await restoreLegacyFlow());
                setPair(null);
                setNotice("已恢复默认浏览器连接。独立账号及其记录仍保留。");
              })}>{pending === "legacy" ? "正在恢复…" : "恢复旧版连接"}</button>
          )}
          {showSetup && (
            <div id={setupId} className="flow-accounts__guide-card">
              <div className="flow-accounts__guide-title">
                {embeddedMode
                  ? managedChrome
                    ? "桌面端 · 官方 Chrome 托管静默引擎（推荐）"
                    : "桌面端 · 内置引擎导入流程"
                  : "Web 模式 · 外部独立 Chrome 导入流程"}
              </div>
              {embeddedMode ? (
                managedChrome ? (
                  <ol className="settings-panel__hint">
                    <li><strong>为什么使用官方 Chrome：</strong>Google 官方安全策略会拒绝内嵌浏览器登录（<code>accounts.google.com/v3/signin/rejected</code>）。桌面端采用独立官方 Chrome 目录托管登录，账号密码、2FA 与 Passkey 均 100% 稳定支持。</li>
                    <li><strong>首次添加与加载扩展：</strong>点击上方「添加账号」（或「唤起 Chrome 并配对」），系统打开官方 Chrome 窗口与 3 步向导；在 Chrome 打开 <code>chrome://extensions</code> → 开启「开发者模式」→ 加载扩展目录：<code className="flow-accounts__path">{snapshot.extension_path}</code>。</li>
                    <li><strong>登录、入项与配对：</strong>在 Chrome 登录 <code>Pro</code>/<code>Ultra</code> Google Flow 账号并打开任意项目，向导生成的配对码填入扩展弹窗点「配对」；项目 ID 会自动识别绑定。</li>
                    <li><strong>日常静默运行与退出：</strong>配对过的账号在每次启动桌面端时会自动在任务栏最小化静默连接，不弹窗打扰；点击右上角 <code>⏻ 关闭本地服务</code> 会同步优雅退出所有组件。</li>
                    <li><strong>自动同步套餐与积分：</strong>连接成功后系统将自动获取实时积分余额与 <strong>Pro</strong> / <strong>Ultra</strong> 套餐等级；如需手动微调可点「编辑项目与积分」。</li>
                  </ol>
                ) : (
                  <ol className="settings-panel__hint">
                    <li><strong>添加或唤出内嵌窗口：</strong>点击上方「添加账号」（或已有账号的「打开并配对」），左侧加载 <code>flow.google.com</code>，右侧自动显示内置 <strong>「Flowboard 连接助手」</strong> 插件面板。</li>
                    <li><strong>登录已有 Flow 账号：</strong>在左侧网页登录已开通 <code>Pro</code> 或 <code>Ultra</code> 的 Google 账号；如遇通行密钥（Passkey）弹窗受阻，点击右上角「独立窗口登录」，完成后会话自动同步。</li>
                    <li><strong>导入现有项目（自动捕获）：</strong>在左侧点击进入任意现有项目（或新建项目），系统自动从 <code>flow.google.com/project/&lt;uuid&gt;</code> 识别并绑定项目 ID；也可在「编辑项目与积分」中手动粘贴链接。</li>
                    <li><strong>一键配对并静默运行：</strong>右侧「Flowboard 连接助手」已自动预填配对码，点击 <strong>「配对」</strong> 完成绑定；满足「已登录 + 已绑定项目 + 已配对」后窗口自动收起至后台静默运行，会话持久化保存于本地。</li>
                    <li><strong>自动同步套餐与积分：</strong>连接后系统将自动读取实时积分余额与套餐等级；若需手动改写可点账号卡片的「编辑项目与积分」。</li>
                  </ol>
                )
              ) : (
                <ol className="settings-panel__hint">
                  <li><strong>启动独立 Chrome 会话：</strong>点击上方「添加账号」（或「打开 Flow」），系统为该账号启动独立 Chrome 配置目录并打开 <code>flow.google.com</code>，在其中登录已开通 <code>Pro</code> 或 <code>Ultra</code> 的 Google 账号。</li>
                  <li><strong>加载桥接扩展（每个独立账号仅首次需要）：</strong>在该 Chrome 窗口打开 <code>chrome://extensions</code>，开启「开发者模式」，点击「加载已解压的扩展程序」并选择目录：<code className="flow-accounts__path">{snapshot.extension_path}</code>。</li>
                  <li><strong>配对连接：</strong>回到此处点击当前账号卡片的「获取配对码」，填入该 Chrome 窗口的「Flowboard 连接助手」扩展弹窗点击「配对」。</li>
                  <li><strong>自动同步项目与积分：</strong>在 Flow 网页进入任意项目后，项目 ID 与实时积分余额会自动识别同步；必要时也可在「编辑项目与积分」中手动修改。</li>
                </ol>
              )}

              <div className="flow-accounts__guide-oauth">
                <p className="settings-panel__hint">
                  可选：通过本地 Google OAuth 导入邮箱名称仅用于画布身份展示，不能替代上方 Flow 网页登录与请求签名。
                </p>
                {loginConfig?.configured ? (
                  <button className="flow-accounts__button" type="button" disabled={pending !== null} onClick={signIn}>
                    {pending === "google" ? "等待 Google 登录…" : "导入 Google 账号资料"}
                  </button>
                ) : (
                  <>
                    {loginConfig && (
                      <button
                        className="flow-accounts__button"
                        type="button"
                        aria-expanded={showLoginConfig}
                        aria-controls={googleSetupId}
                        onClick={() => setShowLoginConfig((old) => !old)}
                      >
                        {showLoginConfig ? "收起 OAuth 配置方法" : "查看 OAuth 配置方法"}
                      </button>
                    )}
                    {showLoginConfig && loginConfig && !loginConfig.configured && (
                      <div className="flow-accounts__setup-card" id={googleSetupId}>
                        <p>在 Google Cloud 创建「Web 应用」OAuth 客户端，添加已获授权的重定向 URI：</p>
                        <code className="flow-accounts__path">{loginConfig.redirect_uri}</code>
                        <p>在项目根目录 <code>.env</code> 中填写 <code>FLOWBOARD_GOOGLE_CLIENT_ID</code> 与 <code>FLOWBOARD_GOOGLE_CLIENT_SECRET</code> 后重启本地服务。</p>
                        <button type="button" className="flow-accounts__button" onClick={() => setLoginConfigVersion((old) => old + 1)}>
                          重新检查
                        </button>
                      </div>
                    )}
                  </>
                )}
                {loginConfigFailed && (
                  <div className="settings-panel__project-feedback" role="status">
                    <span>暂未读取到 Google 登录配置。</span>
                    <button className="settings-panel__retry" type="button" onClick={() => setLoginConfigVersion((old) => old + 1)}>
                      重试
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
