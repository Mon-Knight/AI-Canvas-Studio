import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  cancelActivity,
  getAuthMe,
  getHealth,
  getLlmConfig,
  getLlmProviders,
  logoutExtension,
  mediaUrl,
  scanExtension,
  type AuthMe,
  type HealthResponse,
  type LLMConfig,
  type LLMProviderInfo,
} from "../api/client";
import { useBoardStore } from "../store/board";
import { displayNodeTitle } from "../constants/nodeLabels";
import {
  CURRENT_APP_VERSION,
  dismissReleaseTag,
  getDismissedReleaseTag,
  getLatestRelease,
  isNewerVersion,
  type LatestRelease,
} from "../api/github";
import { useFlowAccounts } from "../store/flowAccounts";
import { useDesktopFlowStore } from "../store/desktopFlow";
import { useGenerationStore } from "../store/generation";
import { useShutdownStore } from "../store/shutdown";
import { ActivityDropdown } from "./activity/ActivityDropdown";
import { ActivityDetailModal } from "./activity/ActivityDetailModal";
import { useActivityFeed } from "./activity/useActivityFeed";
import { AiProviderDialog } from "./AiProviderDialog";
import { SettingsPanel } from "./SettingsPanel";
import { FlowAccountsSection } from "./FlowAccountsSection";
import "./TopRightAccountPopover.css";
import {
  IconClock,
  IconMoreHorizontal,
  IconPower,
  IconSearch,
  IconShareExport,
  IconSubject,
} from "./JimengIcons";

/**
 * 即梦风格右上角悬浮毛玻璃胶囊群：
 * 1. [🔍 节点搜索 | 🕒 任务与历史记录]
 * 2. [↗ 导出成片]
 * 3. [··· 更多与模型配置]
 * 4. [● ✦ Ultra/Pro + 用户头像]（统一承接原 StatusBar + AccountPanel + AiProviderBadge 状态同步）
 */
export function TopRightCapsuleBar() {
  const { fitView } = useReactFlow();
  const nodes = useBoardStore((s) => s.nodes);
  const setNodes = useBoardStore((s) => s.setNodes);
  const setStorePaygateTier = useGenerationStore.setState;
  const accounts = useFlowAccounts((s) => s.snapshot);
  const refreshAccounts = useFlowAccounts((s) => s.refresh);
  const syncCredits = useFlowAccounts((s) => s.syncCredits);
  const isDesktop = useDesktopFlowStore((s) => s.isDesktop);
  const desktopState = useDesktopFlowStore((s) => s.state);
  const openDesktopDrawer = useDesktopFlowStore((s) => s.openDrawer);
  const reloadDesktopFlow = useDesktopFlowStore((s) => s.reloadFlow);
  const syncDesktopAccounts = useDesktopFlowStore((s) => s.syncAccountsNow);
  const openShutdownConfirm = useShutdownStore((s) => s.openConfirm);
  const embeddedMode = isDesktop || Boolean(accounts?.embedded_browser);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) void refreshAccounts(); };
    refresh();
    const timer = window.setInterval(refresh, 8000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshAccounts]);
  const activeAccount = accounts?.accounts.find((a) => a.id === accounts.active_account_id);
  const exportCurrentBoardHuabu = useBoardStore((s) => s.exportCurrentBoardHuabu);
  const importHuabuFile = useBoardStore((s) => s.importHuabuFile);

  // ── Popover states ──
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountVisited, setAccountVisited] = useState(false);
  const [accountDetails, setAccountDetails] = useState(false);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ── In-canvas new release reminder ──
  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null);
  const [dismissedTag, setDismissedTag] = useState<string | null>(() => getDismissedReleaseTag());
  const [updateOpen, setUpdateOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);

  const searchWrapRef = useRef<HTMLDivElement>(null);
  const activityWrapRef = useRef<HTMLDivElement>(null);
  const exportWrapRef = useRef<HTMLDivElement>(null);
  const updateWrapRef = useRef<HTMLDivElement>(null);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const accountWrapRef = useRef<HTMLDivElement>(null);
  const accountButtonRef = useRef<HTMLButtonElement>(null);
  const huabuInputRef = useRef<HTMLInputElement>(null);
  const appendHuabuInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const pollRelease = (force = false) => {
      void getLatestRelease(force).then((rel) => {
        if (alive && rel) setLatestRelease(rel);
      });
    };
    pollRelease(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") pollRelease(false);
    }, 60 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const hasNewVersion = Boolean(
    latestRelease?.tagName && isNewerVersion(latestRelease.tagName, CURRENT_APP_VERSION),
  );
  const showUpdateCapsule =
    hasNewVersion && dismissedTag !== (latestRelease?.tagName ?? null);

  useEffect(() => {
    const open = () => {
      setSearchOpen(false);
      setExportOpen(false);
      setUpdateOpen(false);
      setMoreOpen(false);
      setActivityOpen(false);
      setAccountVisited(true);
      setAccountDetails(true);
      setAccountOpen(true);
      accountButtonRef.current?.focus();
    };
    window.addEventListener("flowboard:open-flow-accounts", open);
    return () => window.removeEventListener("flowboard:open-flow-accounts", open);
  }, []);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ── Activity feed ──
  const feed = useActivityFeed(activityOpen);

  const handleToggleActivity = () => {
    if (!activityOpen) {
      feed.markRead();
    }
    setSearchOpen(false);
    setExportOpen(false);
    setUpdateOpen(false);
    setMoreOpen(false);
    setAccountOpen(false);
    setActivityOpen((v) => !v);
  };

  const handleCancelActivity = useCallback(
    async (id: number) => {
      try {
        await cancelActivity(id);
      } catch {
        // ignore
      }
      void feed.refresh();
    },
    [feed],
  );

  // ── Health & Extension polling (replaces StatusBar) ──
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [agentOk, setAgentOk] = useState(true);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const h = await getHealth();
        if (!alive) return;
        setAgentOk(h.ok);
        setHealth(h);
      } catch {
        if (!alive) return;
        setAgentOk(false);
        setHealth(null);
      }
    };
    void poll();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // ── Auth & Paygate Tier sync (replaces AccountPanel) ──
  const [profile, setProfile] = useState<AuthMe | null>(null);
  const [pollsWithoutTier, setPollsWithoutTier] = useState(0);
  const [scanBusy, setScanBusy] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [pollNonce, setPollNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const me = await getAuthMe();
        if (!alive) return;
        setProfile(me);
        if (me?.paygate_tier) {
          setStorePaygateTier({ paygateTier: me.paygate_tier });
          setPollsWithoutTier(0);
        } else if (me) {
          setStorePaygateTier({ paygateTier: null });
          setPollsWithoutTier((n) => n + 1);
        }
        const identitySettled = !!me?.email || me?.identity_available === false;
        const tierSettled = !!me?.paygate_tier;
        if (me && identitySettled && tierSettled) return;
      } catch {
        // retry on next tick
      }
      timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [setStorePaygateTier, pollNonce, activeAccount?.id, activeAccount?.paygate_tier]);

  // ── LLM Provider status (replaces AiProviderBadge) ──
  const [llmConfig, setLlmConfig] = useState<LLMConfig | null>(null);
  const [llmProviders, setLlmProviders] = useState<LLMProviderInfo[] | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const [c, p] = await Promise.all([getLlmConfig(), getLlmProviders()]);
        if (!alive) return;
        setLlmConfig(c);
        setLlmProviders(p);
      } catch {
        // keep stale
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 30_000);
    const onConfigChange = () => void refresh();
    window.addEventListener("flowboard:llm-config-changed", onConfigChange);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("flowboard:llm-config-changed", onConfigChange);
    };
  }, []);

  // ── Close popovers on outside click / ESC ──
  useEffect(() => {
    if (!moreOpen) {
      setShortcutsOpen(false);
      setUpdateNotice(null);
    }
  }, [moreOpen]);

  useEffect(() => {
    if (!searchOpen && !activityOpen && !exportOpen && !updateOpen && !moreOpen && !accountOpen) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (searchOpen && searchWrapRef.current && !searchWrapRef.current.contains(target)) {
        setSearchOpen(false);
      }
      if (activityOpen && activityWrapRef.current && !activityWrapRef.current.contains(target)) {
        setActivityOpen(false);
      }
      if (exportOpen && exportWrapRef.current && !exportWrapRef.current.contains(target)) {
        setExportOpen(false);
      }
      if (updateOpen && updateWrapRef.current && !updateWrapRef.current.contains(target)) {
        setUpdateOpen(false);
      }
      if (moreOpen && moreWrapRef.current && !moreWrapRef.current.contains(target)) {
        setMoreOpen(false);
      }
      if (accountOpen && accountWrapRef.current && !accountWrapRef.current.contains(target)) {
        setAccountOpen(false);
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSearchOpen(false);
        setActivityOpen(false);
        setExportOpen(false);
        setUpdateOpen(false);
        setMoreOpen(false);
        if (accountOpen) {
          setAccountOpen(false);
          accountButtonRef.current?.focus();
        }
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onEsc);
    };
  }, [searchOpen, activityOpen, exportOpen, updateOpen, moreOpen, accountOpen]);

  // ── Search filtering ──
  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n) => {
      const title = displayNodeTitle(n.data.title, n.data.type).toLowerCase();
      const shortId = (n.data.shortId ?? "").toLowerCase();
      const prompt = (n.data.prompt ?? "").toLowerCase();
      return title.includes(q) || shortId.includes(q) || prompt.includes(q);
    });
  }, [nodes, searchQuery]);

  function focusNode(rfId: string) {
    setNodes(
      nodes.map((n) => ({
        ...n,
        selected: n.id === rfId,
      })),
    );
    void fitView({ nodes: [{ id: rfId }], duration: 320, padding: 0.6 });
    setSearchOpen(false);
  }

  // ── Batch export rendered media on current board ──
  function handleExportBoardMedia() {
    const renderedNodes = nodes.filter(
      (n) =>
        n.data.type !== "prompt" &&
        n.data.type !== "note" &&
        (Boolean(n.data.mediaId) || (n.data.mediaIds?.some(Boolean) ?? false)),
    );
    if (renderedNodes.length === 0) {
      useGenerationStore.setState({
        error: "当前画布暂无可导出的已生成图片或视频。",
      });
      return;
    }
    renderedNodes.forEach((n) => {
      const rawIds =
        n.data.mediaIds && n.data.mediaIds.length > 0
          ? n.data.mediaIds
          : n.data.mediaId
            ? [n.data.mediaId]
            : [];
      const ids = rawIds.filter((m): m is string => typeof m === "string" && m.length > 0);
      const ext = n.data.type === "video" ? "mp4" : "png";
      const safeTitle = (n.data.title || n.data.type).replace(/[^\w\u4e00-\u9fa5-]+/g, "_");
      ids.forEach((mid, i) => {
        const a = document.createElement("a");
        a.href = mediaUrl(mid);
        const suffix = ids.length > 1 ? `-${i + 1}` : "";
        a.download = `${safeTitle}-${n.data.shortId}${suffix}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      });
    });
  }

  async function handleScanExtension() {
    if (scanBusy) return;
    setScanBusy(true);
    try {
      if (isDesktop) {
        await reloadDesktopFlow();
        await syncDesktopAccounts();
      }
      await refreshAccounts();
      const res = await scanExtension();
      if (!res.extension_connected) {
        useGenerationStore.setState({
          error: embeddedMode
            ? "内层 Flow 引擎尚未就绪，请在右上角账号菜单中完成登录验证。"
            : "未检测到浏览器扩展连接，请保持已登录的 flow.google.com 标签页开启并刷新扩展。",
        });
      } else {
        setPollNonce((n) => n + 1);
      }
    } catch {
      // ignore
    } finally {
      setScanBusy(false);
      setMoreOpen(false);
    }
  }

  async function handleLogout() {
    if (logoutPending) return;
    setLogoutPending(true);
    try {
      await logoutExtension();
      setStorePaygateTier({ paygateTier: null });
      setPollNonce((n) => n + 1);
      setSettingsOpen(false);
    } finally {
      setLogoutPending(false);
    }
  }

  // ── Derived statuses ──
  const extConnected = activeAccount ? activeAccount.connected && activeAccount.flow_tab_open : health?.extension_connected ?? false;
  const connTone = !agentOk
    ? "offline"
    : extConnected
      ? "online"
      : "standby";
  const connTooltip = !agentOk
    ? "本地 Agent 未连接 (:8434)"
    : embeddedMode
      ? extConnected
        ? "内层 Flow 浏览器引擎已静默就绪"
        : desktopState?.authState === "login_required"
          ? "内层 Flow 引擎需要 Google 登录验证"
          : "等待内层 Flow 账号连接"
      : activeAccount
        ? !activeAccount.connected ? "等待当前账号扩展连接" : activeAccount.flow_tab_open ? "当前账号的 Flow 网页已打开" : "等待当前账号打开 Flow 网页"
        : extConnected
        ? "本地 Agent 与 Flow 浏览器扩展均在线"
        : "本地 Agent 在线 · 等待 Flow 扩展连接";

  const tier = activeAccount?.paygate_tier ?? profile?.paygate_tier ?? null;
  const tierLabel =
    tier === "PAYGATE_TIER_TWO"
      ? "Ultra"
      : tier === "PAYGATE_TIER_ONE"
        ? "Pro"
        : "未配置";
  const tierSourceNote =
    activeAccount?.paygate_tier
      ? "账号指定"
      : profile?.paygate_tier_source === "extension"
        ? "实时识别"
        : profile?.paygate_tier
          ? "默认配置"
          : "待设置";

  const credits = activeAccount ? activeAccount.credits : profile?.credits ?? null;
  const badgeNumber = credits !== null ? new Intl.NumberFormat("zh-CN").format(credits) : "—";
  const accountName = activeAccount?.label || profile?.name || profile?.email || "Flow 账号";
  const avatarInitial = (activeAccount?.label.trim().slice(0, 1) || profile?.name?.trim().slice(0, 1) || profile?.email?.slice(0, 1) || "").toUpperCase();
  const accountTitle = activeAccount
    ? `${activeAccount.label} · ${connTooltip}${credits !== null ? ` · 积分余额 ${badgeNumber}` : ""}（管理账号）`
    : `${connTooltip} · 当前套餐：${tierLabel}（管理账号）`;

  useEffect(() => {
    const canSync =
      activeAccount
        ? activeAccount.connected && activeAccount.flow_tab_open
        : extConnected;
    if (!canSync) return;
    if (credits === null) {
      void syncCredits();
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) void syncCredits();
    }, 90_000);
    const onStale = () => {
      if (!document.hidden) void syncCredits();
    };
    window.addEventListener("flowboard:credits-stale", onStale);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("flowboard:credits-stale", onStale);
    };
  }, [activeAccount?.id, activeAccount?.connected, activeAccount?.flow_tab_open, extConnected, credits, syncCredits]);

  const llmHealthy = useMemo(() => {
    if (!llmConfig || !llmConfig.configured) return false;
    const pinned = [
      llmConfig.auto_prompt.provider,
      llmConfig.vision.provider,
      llmConfig.planner.provider,
    ].filter((x): x is NonNullable<typeof x> => x !== null);
    if (!llmProviders) return true;
    return !llmProviders.some((p) => pinned.includes(p.name) && !p.available);
  }, [llmConfig, llmProviders]);

  const badgeCount = feed.unreadCount > 9 ? "9+" : String(feed.unreadCount);

  async function handleManualCheckUpdate() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    setUpdateNotice(null);
    try {
      const rel = await getLatestRelease(true);
      if (rel) setLatestRelease(rel);
      if (rel?.tagName && isNewerVersion(rel.tagName, CURRENT_APP_VERSION)) {
        setMoreOpen(false);
        setUpdateOpen(true);
      } else {
        setUpdateNotice("已是最新");
      }
    } finally {
      setCheckingUpdate(false);
    }
  }

  return (
    <>
      <div className="jm-topright">
        {/* 胶囊 1：搜索 + 历史记录 */}
        <div ref={searchWrapRef} className="jm-capsule jm-capsule--pair">
          <button
            type="button"
            className={`jm-capsule__icon-btn${searchOpen ? " jm-capsule__icon-btn--active" : ""}`}
            onClick={() => {
              setActivityOpen(false);
              setExportOpen(false);
              setUpdateOpen(false);
              setMoreOpen(false);
              setAccountOpen(false);
              setSearchOpen((v) => {
                const next = !v;
                if (next) requestAnimationFrame(() => searchInputRef.current?.focus());
                return next;
              });
            }}
            title="搜索画布节点"
            aria-label="搜索画布节点"
          >
            <IconSearch size={15} />
          </button>

          <span className="jm-capsule__sep" aria-hidden="true" />

          <div ref={activityWrapRef} className="activity-bell-wrap">
            <button
              type="button"
              className={`jm-capsule__icon-btn${
                activityOpen ? " jm-capsule__icon-btn--active" : ""
              }${feed.runningCount > 0 ? " activity-bell--pulse" : ""}`}
              onClick={handleToggleActivity}
              title={
                feed.unreadCount === 0
                  ? "任务与历史记录"
                  : feed.hasFailed
                    ? `${feed.unreadCount} 条异常记录 — 点击查看`
                    : `${feed.runningCount} 个任务运行中`
              }
              aria-label="任务与历史记录"
            >
              <IconClock size={15} />
              {feed.unreadCount > 0 && (
                <span
                  className={
                    feed.hasFailed
                      ? "activity-bell__badge activity-bell__badge--fail"
                      : "activity-bell__badge"
                  }
                >
                  {badgeCount}
                </span>
              )}
            </button>
            {activityOpen && (
              <ActivityDropdown
                items={feed.items}
                loading={feed.loading}
                nextBeforeId={feed.nextBeforeId}
                onLoadMore={feed.loadMore}
                onClose={() => setActivityOpen(false)}
                onSelect={(id) => setDetailId(id)}
                onCancel={handleCancelActivity}
              />
            )}
          </div>

          {searchOpen && (
            <div className="jm-search-popover" role="dialog" aria-label="搜索节点">
              <div className="jm-search-popover__input-wrap">
                <IconSearch size={14} />
                <input
                  ref={searchInputRef}
                  type="text"
                  className="jm-search-popover__input"
                  placeholder="搜索节点标题、#ID 或提示词…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <ul className="jm-search-popover__list">
                {filteredNodes.length === 0 ? (
                  <li className="jm-search-popover__empty">未找到匹配的节点</li>
                ) : (
                  filteredNodes.slice(0, 12).map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        className="jm-search-popover__item"
                        onClick={() => focusNode(n.id)}
                      >
                        <span className="jm-search-popover__title">
                          {displayNodeTitle(n.data.title, n.data.type) || "节点"}
                        </span>
                        <span className="jm-search-popover__id">
                          #{n.data.shortId}
                        </span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </div>
          )}
        </div>

        {/* 新版本自动提醒胶囊（仅检测到新 Release 且未忽略时展示） */}
        {(showUpdateCapsule || updateOpen) && latestRelease && hasNewVersion && (
          <div ref={updateWrapRef} className="jm-more-wrap">
            <button
              type="button"
              className={`jm-capsule jm-capsule--btn jm-capsule--update${
                updateOpen ? " jm-capsule--active" : ""
              }`}
              onClick={() => {
                setSearchOpen(false);
                setActivityOpen(false);
                setExportOpen(false);
                setMoreOpen(false);
                setAccountOpen(false);
                setUpdateOpen((v) => !v);
              }}
              title={`发现新版本 ${latestRelease.tagName}，点击查看更新`}
            >
              <span className="jm-update-dot" aria-hidden="true" />
              <span>新版 {latestRelease.tagName}</span>
            </button>

            {updateOpen && (
              <div className="jm-update-popover" role="dialog" aria-label="发现新版本">
                <div className="jm-update-popover__head">
                  <span className="jm-update-popover__badge">发现新版本</span>
                  <span className="jm-update-popover__ver">
                    v{CURRENT_APP_VERSION} → {latestRelease.tagName}
                  </span>
                </div>
                {latestRelease.notes && (
                  <p className="jm-update-popover__notes">{latestRelease.notes}</p>
                )}
                <div className="jm-update-popover__actions">
                  <a
                    className="jm-update-popover__primary"
                    href={latestRelease.setupUrl || latestRelease.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setUpdateOpen(false)}
                  >
                    {latestRelease.setupUrl ? "下载安装版 (.exe)" : "前往 GitHub 下载"}
                  </a>
                  {latestRelease.portableUrl && (
                    <a
                      className="jm-update-popover__secondary"
                      href={latestRelease.portableUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setUpdateOpen(false)}
                    >
                      便携版 (.zip)
                    </a>
                  )}
                </div>
                <div className="jm-update-popover__foot">
                  <a
                    className="jm-update-popover__link"
                    href={latestRelease.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看更新说明
                  </a>
                  <button
                    type="button"
                    className="jm-update-popover__dismiss"
                    onClick={() => {
                      dismissReleaseTag(latestRelease.tagName);
                      setDismissedTag(latestRelease.tagName);
                      setUpdateOpen(false);
                    }}
                  >
                    忽略此版本
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 胶囊 2：分享 .huabu 创作配方 & 批量导出成片 */}
        <div ref={exportWrapRef} className="jm-more-wrap">
          <button
            type="button"
            className={`jm-capsule jm-capsule--btn${exportOpen ? " jm-capsule--active" : ""}`}
            onClick={() => {
              setSearchOpen(false);
              setActivityOpen(false);
              setUpdateOpen(false);
              setMoreOpen(false);
              setAccountOpen(false);
              setExportOpen((v) => !v);
            }}
            title="分享 / 导出 .huabu 创作配方或批量下载成片"
          >
            <IconShareExport size={14} />
            <span>分享 / 导出</span>
          </button>

          {exportOpen && (
            <div className="jm-more-menu jm-export-menu" role="menu" aria-label="分享与导出">
              <button
                type="button"
                className="jm-more-menu__item"
                onClick={() => {
                  setExportOpen(false);
                  void exportCurrentBoardHuabu(true);
                }}
              >
                <span>导出 .huabu 配方包（含素材）</span>
                <span className="jm-more-menu__sub">分享推荐</span>
              </button>
              <button
                type="button"
                className="jm-more-menu__item"
                onClick={() => {
                  setExportOpen(false);
                  void exportCurrentBoardHuabu(false);
                }}
              >
                <span>导出轻量纯参数配方</span>
                <span className="jm-more-menu__sub">仅连线与词</span>
              </button>
              <button
                type="button"
                className="jm-more-menu__item"
                onClick={() => huabuInputRef.current?.click()}
              >
                <span>导入 .huabu 新建画布…</span>
              </button>
              <button
                type="button"
                className="jm-more-menu__item"
                onClick={() => appendHuabuInputRef.current?.click()}
              >
                <span>追加 .huabu 到当前画布…</span>
                <span className="jm-more-menu__sub">不覆盖</span>
              </button>
              <div className="jm-more-menu__divider" />
              <button
                type="button"
                className="jm-more-menu__item"
                onClick={() => {
                  setExportOpen(false);
                  handleExportBoardMedia();
                }}
              >
                <span>批量下载当前成片</span>
                <span className="jm-more-menu__sub">图/视频</span>
              </button>
            </div>
          )}

          <input
            ref={huabuInputRef}
            type="file"
            accept=".huabu,application/zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setExportOpen(false);
              void importHuabuFile(file, false);
            }}
          />
          <input
            ref={appendHuabuInputRef}
            type="file"
            accept=".huabu,application/zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setExportOpen(false);
              void importHuabuFile(file, true);
            }}
          />
        </div>

        {/* 胶囊 3：更多与 AI 配置菜单 */}
        <div ref={moreWrapRef} className="jm-more-wrap">
          <button
            type="button"
            className={`jm-capsule jm-capsule--icon${moreOpen ? " jm-capsule--active" : ""}`}
            onClick={() => {
              setSearchOpen(false);
              setActivityOpen(false);
              setExportOpen(false);
              setUpdateOpen(false);
              setAccountOpen(false);
              setMoreOpen((v) => !v);
            }}
            title="AI 模型与系统设置"
            aria-label="更多设置"
          >
            <IconMoreHorizontal size={16} />
            {!llmHealthy && <span className="jm-more-warn-dot" aria-hidden="true" />}
          </button>

          {moreOpen && (
            <div className="jm-more-menu" role="menu">
              <button
                type="button"
                className="jm-more-menu__item"
                onClick={() => {
                  setMoreOpen(false);
                  setAiDialogOpen(true);
                }}
              >
                <span>AI 模型与提供商</span>
                <span
                  className={`jm-more-menu__tag ${
                    llmHealthy ? "jm-more-menu__tag--ok" : "jm-more-menu__tag--warn"
                  }`}
                >
                  {llmHealthy ? "已就绪" : "待配置"}
                </span>
              </button>
              <button
                type="button"
                className="jm-more-menu__item"
                onClick={() => {
                  setMoreOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <span>生成引擎与项目设置</span>
                <span className="jm-more-menu__sub">{tierLabel}</span>
              </button>
              <div className="jm-more-menu__divider" />
              <button
                type="button"
                className="jm-more-menu__item"
                disabled={scanBusy}
                onClick={() => void handleScanExtension()}
              >
                <span>
                  {scanBusy
                    ? embeddedMode ? "正在刷新内层引擎…" : "正在扫描扩展…"
                    : embeddedMode ? "刷新内层 Flow 引擎" : "重新检测浏览器扩展"}
                </span>
                <span className={`jm-conn-dot jm-conn-dot--${connTone}`} />
              </button>
              <div className="jm-more-menu__divider" />
              <button
                type="button"
                className="jm-more-menu__item"
                aria-expanded={shortcutsOpen}
                onClick={() => setShortcutsOpen((v) => !v)}
              >
                <span>快捷键指南</span>
                <span className="jm-more-menu__sub">{shortcutsOpen ? "收起" : "展开"}</span>
              </button>
              {shortcutsOpen && (
                <div className="jm-shortcuts-panel" role="region" aria-label="快捷键指南">
                  <div className="jm-shortcuts-panel__row">
                    <span>创建节点</span>
                    <kbd>双击画布</kbd>
                  </div>
                  <div className="jm-shortcuts-panel__row">
                    <span>连线创建下游</span>
                    <kbd>拖线松开</kbd>
                  </div>
                  <div className="jm-shortcuts-panel__row">
                    <span>生成 / 预览节点</span>
                    <kbd>G</kbd>
                  </div>
                  <div className="jm-shortcuts-panel__row">
                    <span>切换资产库</span>
                    <kbd>L</kbd>
                  </div>
                  <div className="jm-shortcuts-panel__row">
                    <span>删除选中项</span>
                    <kbd>Delete</kbd>
                  </div>
                </div>
              )}
              <div className="jm-more-menu__divider" />
              <button
                type="button"
                className="jm-more-menu__item"
                disabled={checkingUpdate}
                onClick={() => void handleManualCheckUpdate()}
              >
                <span>版本与更新（v{CURRENT_APP_VERSION}）</span>
                <span
                  className={
                    hasNewVersion
                      ? "jm-more-menu__tag jm-more-menu__tag--warn"
                      : "jm-more-menu__sub"
                  }
                >
                  {checkingUpdate
                    ? "检查中…"
                    : hasNewVersion && latestRelease
                      ? `新版 ${latestRelease.tagName}`
                      : updateNotice || "检查更新"}
                </span>
              </button>
              <div className="jm-more-menu__divider" />
              <button
                type="button"
                className="jm-more-menu__item jm-more-menu__item--danger"
                onClick={() => {
                  setMoreOpen(false);
                  openShutdownConfirm();
                }}
              >
                <span>关闭本地服务</span>
                <IconPower size={13} />
              </button>
            </div>
          )}
        </div>

        {/* 头像菜单：账号与 Flow 连接均在画布上就地管理 */}
        <div className="jm-account-wrap" ref={accountWrapRef}>
          <button
            type="button"
            ref={accountButtonRef}
            className={`jm-capsule jm-capsule--account${accountOpen ? " jm-capsule--active" : ""}`}
            onClick={() => {
              setSearchOpen(false);
              setActivityOpen(false);
              setMoreOpen(false);
              if (!accountVisited) {
                setAccountVisited(true);
                setAccountDetails(!accounts?.accounts.length);
              }
              setAccountOpen((v) => !v);
            }}
            title={accountTitle}
            aria-label="Flow 账号菜单"
            aria-expanded={accountOpen}
            aria-controls={accountVisited ? "jm-account-popover" : undefined}
          >
            <span className="jm-account-spark" aria-hidden="true">✦</span>
            <span className="jm-account-tier">{badgeNumber}</span>
            <AccountAvatar picture={!activeAccount ? profile?.picture : undefined} initial={avatarInitial} />
          </button>
          {accountVisited && (
            <section id="jm-account-popover" className="jm-account-popover" aria-label="Flow 账号菜单" hidden={!accountOpen}>
              <header className="jm-account-popover__profile">
                <AccountAvatar picture={!activeAccount ? profile?.picture : undefined} initial={avatarInitial} />
                <div className="jm-account-popover__identity">
                  <h2 title={accountName}>{accountName}</h2>
                  <p><span className={`jm-conn-dot jm-conn-dot--${connTone}`} aria-hidden="true" />
                    {!agentOk
                      ? "本地服务未连接"
                      : embeddedMode
                        ? extConnected
                          ? desktopState?.managedChromeMode
                            ? "Chrome 伴侣引擎已就绪"
                            : "内层 Flow 引擎已就绪"
                          : desktopState?.authState === "login_required"
                            ? desktopState?.managedChromeMode
                              ? "需在 Chrome 登录 / 配对"
                              : "需登录 Google Flow"
                            : activeAccount
                              ? desktopState?.managedChromeMode
                                ? "正在后台唤起 Chrome…"
                                : "内层引擎初始化中…"
                              : "尚未添加 Flow 账号"
                        : extConnected
                          ? "Flow 网页已连接"
                          : activeAccount?.connected
                            ? "等待打开 Flow 网页"
                            : "等待 Flow 扩展连接"}
                    {isDesktop && activeAccount && !extConnected && (
                      <button
                        type="button"
                        className="jm-account-popover__inline-btn"
                        onClick={() => {
                          setAccountOpen(false);
                          void openDesktopDrawer({
                            accountId: activeAccount.id,
                            mode: "auto-onboarding",
                          });
                        }}
                      >
                        {desktopState?.managedChromeMode ? "打开连接向导" : "立即登录"}
                      </button>
                    )}
                  </p>
                </div>
              </header>
              <button
                type="button"
                className="jm-account-popover__row"
                aria-expanded={accountDetails}
                aria-controls="jm-account-details"
                onClick={() => setAccountDetails((v) => !v)}
              >
                <IconSubject size={18} />
                <span>Flow 账号与积分</span>
                <span className="jm-more-menu__sub" title={`当前视频档位来源：${tierSourceNote}`}>
                  ✦ {tierLabel}
                </span>
                <svg className="jm-account-popover__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
              </button>
              <div id="jm-account-details" className="jm-account-popover__details" hidden={!accountDetails}>
                <FlowAccountsSection compact />
              </div>
              <a className="jm-account-popover__row" href="https://support.google.com/flow/" target="_blank" rel="noreferrer">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 1.7-2.9 2.4-2.9 4m0 3h.01" /></svg>
                <span>Flow 帮助中心</span>
                <IconShareExport className="jm-account-popover__chevron" size={14} />
              </a>
            </section>
          )}
        </div>

        {/* 胶囊 5：关闭本地服务 */}
        <button
          id="btn-open-shutdown"
          type="button"
          className="jm-capsule jm-capsule--icon jm-capsule--power"
          onClick={() => {
            setSearchOpen(false);
            setActivityOpen(false);
            setMoreOpen(false);
            setAccountOpen(false);
            openShutdownConfirm();
          }}
          title="关闭本地服务"
          aria-label="关闭本地服务"
        >
          <IconPower size={15} />
        </button>
      </div>

      {/* 套餐未配置告警浮条 */}
      {(Boolean(activeAccount) || Boolean(profile?.paygate_tier_error)) && !tier && pollsWithoutTier >= 2 && (
        <div className="jm-tier-banner" role="alert">
          <span>⚠ 尚未配置有效套餐等级：</span>
          <span>
            {activeAccount
              ? "请在账号设置里选择实际套餐等级（Pro / Ultra）。"
              : profile?.paygate_tier_error ??
                "请在 .env 中将 FLOWBOARD_PAYGATE_TIER 设为 PAYGATE_TIER_ONE (Pro) 或 PAYGATE_TIER_TWO (Ultra)。"}
          </span>
          <button
            type="button"
            className="jm-tier-banner__btn"
            onClick={() => {
              if (!activeAccount) {
                setSettingsOpen(true);
                return;
              }
              setSearchOpen(false);
              setActivityOpen(false);
              setMoreOpen(false);
              setAccountVisited(true);
              setAccountDetails(true);
              setAccountOpen(true);
              accountButtonRef.current?.focus();
            }}
          >
            查看设置
          </button>
        </div>
      )}

      <ActivityDetailModal
        activityId={detailId}
        onClose={() => setDetailId(null)}
      />
      <AiProviderDialog
        open={aiDialogOpen}
        onClose={() => setAiDialogOpen(false)}
      />
      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLogout={profile?.email ? handleLogout : undefined}
        logoutPending={logoutPending}
        hideFlowAccounts
      />
    </>
  );
}

function AccountAvatar({ picture, initial }: { picture?: string | null; initial: string }) {
  const [failedPicture, setFailedPicture] = useState<string | null>(null);
  return (
    <span className="jm-account-avatar" aria-hidden="true">
      {picture && picture !== failedPicture ? (
        <img src={picture} alt="" referrerPolicy="no-referrer" onError={() => setFailedPicture(picture)} />
      ) : initial || <IconSubject size={16} />}
    </span>
  );
}
