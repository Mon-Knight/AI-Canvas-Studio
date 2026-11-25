import { useEffect, useRef, useState } from "react";
import { useGenerationStore } from "../store/generation";
import {
  useSettingsStore,
  type OutputCountOption,
} from "../store/settings";
import {
  IMAGE_ASPECT_OPTIONS,
  IMAGE_MODEL_CATALOG,
  IMAGE_RESOLUTION_OPTIONS,
  IMAGE_THINKING_OPTIONS,
  OMNI_1_2_DURATIONS,
  OUTPUT_COUNT_OPTIONS,
  VIDEO_ASPECT_OPTIONS,
  VIDEO_MODEL_CATALOG,
  VIDEO_RESOLUTION_OPTIONS,
  estimateImageCreditCost,
  estimateVideoCreditCost,
  resolveVideoSelectionId,
} from "../constants/models";
import {
  CURRENT_APP_VERSION as APP_VERSION,
  getLatestRelease,
  isNewerVersion,
  type LatestRelease,
} from "../api/github";
import {
  getPinnedFlowProject,
  setPinnedFlowProject,
  type PinnedFlowProject,
} from "../api/client";
import { useFlowAccounts } from "../store/flowAccounts";
import { FlowAccountsSection } from "./FlowAccountsSection";
import "./SettingsPanel.css";

const UUID_ANYWHERE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

interface SettingsPanelProps {
  open: boolean;
  onClose(): void;
  onLogout?: () => Promise<void> | void;
  logoutPending?: boolean;
  hideFlowAccounts?: boolean;
  onFlowProjectChange?: () => void;
}

export function SettingsPanel({
  open,
  onClose,
  onLogout,
  logoutPending,
  hideFlowAccounts = false,
  onFlowProjectChange,
}: SettingsPanelProps) {
  const snapshot = useFlowAccounts((s) => s.snapshot);
  const legacyAccount = snapshot?.active_account_id === null;
  const currentAccount = snapshot?.accounts.find((account) => account.id === snapshot.active_account_id);
  const tier = useGenerationStore((s) => s.paygateTier);
  const imageModel = useSettingsStore((s) => s.imageModel);
  const setImageModel = useSettingsStore((s) => s.setImageModel);
  const imageResolution = useSettingsStore((s) => s.imageResolution);
  const setImageResolution = useSettingsStore((s) => s.setImageResolution);
  const imageThinkingLevel = useSettingsStore((s) => s.imageThinkingLevel);
  const setImageThinkingLevel = useSettingsStore((s) => s.setImageThinkingLevel);
  const defaultImageAspect = useSettingsStore((s) => s.defaultImageAspect);
  const setDefaultImageAspect = useSettingsStore((s) => s.setDefaultImageAspect);
  const defaultImageCount = useSettingsStore((s) => s.defaultImageCount);
  const setDefaultImageCount = useSettingsStore((s) => s.setDefaultImageCount);

  const videoQuality = useSettingsStore((s) => s.videoQuality);
  const setVideoQuality = useSettingsStore((s) => s.setVideoQuality);
  const videoModel = useSettingsStore((s) => s.videoModel);
  const setVideoModel = useSettingsStore((s) => s.setVideoModel);
  const omniVersion = useSettingsStore((s) => s.omniVersion);
  const setOmniVersion = useSettingsStore((s) => s.setOmniVersion);
  const omniFlashDuration = useSettingsStore((s) => s.omniFlashDuration);
  const setOmniFlashDuration = useSettingsStore((s) => s.setOmniFlashDuration);
  const videoResolution = useSettingsStore((s) => s.videoResolution);
  const setVideoResolution = useSettingsStore((s) => s.setVideoResolution);
  const defaultVideoAspect = useSettingsStore((s) => s.defaultVideoAspect);
  const setDefaultVideoAspect = useSettingsStore((s) => s.setDefaultVideoAspect);
  const defaultVideoCount = useSettingsStore((s) => s.defaultVideoCount);
  const setDefaultVideoCount = useSettingsStore((s) => s.setDefaultVideoCount);
  const confirmBeforeVideoGen = useSettingsStore((s) => s.confirmBeforeVideoGen);
  const setConfirmBeforeVideoGen = useSettingsStore((s) => s.setConfirmBeforeVideoGen);

  const selectedVideoId = resolveVideoSelectionId(videoModel, omniVersion, videoQuality);
  const activeDefaultVideoDuration = videoModel === "omni_flash" ? omniFlashDuration : 8;

  function handleSelectDefaultVideoDuration(nextSec: number) {
    const clamped = Math.min(15, Math.max(3, Math.round(nextSec)));
    if (videoModel !== "omni_flash") {
      if (clamped !== 8) {
        setVideoModel("omni_flash");
        setOmniVersion("1.2");
      }
      setOmniFlashDuration(clamped);
      return;
    }
    if (omniVersion === "1.1" && ![4, 6, 8, 10].includes(clamped)) {
      setOmniVersion("1.2");
    }
    setOmniFlashDuration(clamped);
  }
  const activeVideoResHint =
    VIDEO_RESOLUTION_OPTIONS.find((r) => r.value === videoResolution)?.hint ?? "";
  const activeImageResHint =
    IMAGE_RESOLUTION_OPTIONS.find((r) => r.value === imageResolution)?.hint ?? "";

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]',
        ) ?? []).filter((item) => {
          if (!(item instanceof HTMLInputElement) || item.type !== "radio" || item.checked) return true;
          return !panelRef.current?.querySelector(`input[name="${item.name}"]:checked:not([disabled])`) &&
            panelRef.current?.querySelector(`input[name="${item.name}"]:not([disabled])`) === item;
        });
        const edge = e.shiftKey ? focusable[0] : focusable.at(-1);
        if (edge === document.activeElement || !panelRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          (e.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  const [latestRelease, setLatestRelease] = useState<LatestRelease | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    getLatestRelease().then((r) => {
      if (alive) setLatestRelease(r);
    });
    return () => {
      alive = false;
    };
  }, [open]);
  const updateAvailable =
    !!latestRelease?.tagName &&
    isNewerVersion(latestRelease.tagName, APP_VERSION);

  const [flowProject, setFlowProject] = useState<PinnedFlowProject | null>(null);
  const [flowProjectError, setFlowProjectError] = useState<string | null>(null);
  const [projectReadAttempt, setProjectReadAttempt] = useState(0);
  const [projectDraft, setProjectDraft] = useState("");
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectSaveError, setProjectSaveError] = useState<string | null>(null);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !legacyAccount) return;
    let alive = true;
    setFlowProject(null);
    setFlowProjectError(null);
    setProjectSaveError(null);
    setProjectNotice(null);
    getPinnedFlowProject()
      .then((p) => {
        if (!alive) return;
        setFlowProject(p);
        setProjectDraft(p.flow_project_id ?? "");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setFlowProjectError(
          err instanceof Error ? err.message : "读取绑定项目失败",
        );
      });
    return () => {
      alive = false;
    };
  }, [open, legacyAccount, projectReadAttempt]);

  async function saveFlowProject(next: string | null) {
    if (projectSaving) return;
    setProjectSaving(true);
    setProjectSaveError(null);
    setProjectNotice(null);
    try {
      const res = await setPinnedFlowProject(next);
      setFlowProject({
        flow_project_id: res.flow_project_id,
        source: res.source,
        env_project_id: res.env_project_id,
      });
      setProjectDraft(res.flow_project_id ?? "");
      useGenerationStore.setState({ projectId: null });
      setProjectNotice(
        res.rebound_boards > 0
          ? `已保存 —— 已同步更新 ${res.rebound_boards} 个画布的项目指向`
          : "已保存",
      );
      onFlowProjectChange?.();
    } catch (err) {
      setProjectSaveError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setProjectSaving(false);
    }
  }

  const trimmedDraft = projectDraft.trim();
  const draftUuid = trimmedDraft.match(UUID_ANYWHERE)?.[0]?.toLowerCase() ?? null;
  const canSaveProject =
    !!draftUuid &&
    (flowProject?.source !== "override" || draftUuid !== flowProject.flow_project_id);
  const legacyEnvId =
    flowProject?.source === "env" &&
    !!flowProject.flow_project_id &&
    !UUID_ANYWHERE.test(flowProject.flow_project_id);

  if (!open) return null;

  const tierLabel = tier === "PAYGATE_TIER_TWO"
    ? "Ultra"
    : tier === "PAYGATE_TIER_ONE"
      ? "Pro"
      : "未检测到配置";

  const videoCostEstimate = estimateVideoCreditCost({
    videoModel,
    omniVersion,
    videoQuality,
    durationSeconds: omniFlashDuration,
    videoResolution,
    count: defaultVideoCount,
    paygateTier: tier,
  });

  const imageCostEstimate = estimateImageCreditCost({
    imageModel,
    imageResolution,
    count: defaultImageCount,
  });

  return (
    <div
      className="settings-panel-backdrop settings-panel-backdrop--canvas"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="settings-panel settings-panel--canvas"
        role="dialog"
        aria-modal="true"
        aria-labelledby="generation-settings-title"
      >
        <div className="settings-panel__header">
          <h2 className="settings-panel__title" id="generation-settings-title">生成引擎与项目设置</h2>
          <button
            type="button"
            className="settings-panel__close"
            ref={closeRef}
            onClick={onClose}
            aria-label="关闭设置"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="settings-panel__body">
          {!hideFlowAccounts && <FlowAccountsSection />}
          <section className="settings-panel__section settings-panel__section--tier" aria-labelledby="generation-settings-tier">
            <div className="settings-panel__tier-head">
              <h3 className="settings-panel__label" id="generation-settings-tier">当前生成套餐</h3>
              {hideFlowAccounts && (
                <button
                  type="button"
                  className="flow-accounts__button"
                  onClick={() => {
                    onClose();
                    window.requestAnimationFrame(() => {
                      window.dispatchEvent(new CustomEvent("flowboard:open-flow-accounts"));
                    });
                  }}
                >
                  管理 Flow 账号与导入指引 →
                </button>
              )}
            </div>
            <div className="settings-panel__value settings-panel__value--readonly">
              {tierLabel}
            </div>
            <div className="settings-panel__hint">
              {currentAccount?.paygate_tier ? "使用当前账号的套餐设置。这不是 Google 订阅状态。" : (
                <>沿用根目录 <code>.env</code> 中的 <code>FLOWBOARD_PAYGATE_TIER</code>；也可按账号设置实际套餐等级。</>
              )}
            </div>
          </section>

          {legacyAccount && <section className="settings-panel__section" aria-labelledby="generation-settings-project">
            <h3 className="settings-panel__label" id="generation-settings-project">默认浏览器的 Flow 项目</h3>
            <div className="settings-panel__hint">仅在未切换到独立账号时生效。</div>
            {flowProjectError ? (
              <div className="settings-panel__project-feedback" role="status">
                <div>
                  <strong>读取绑定项目失败</strong>
                  <div className="settings-panel__hint">
                    请确认本地服务已启动，再试一次。
                    <span className="settings-panel__error-detail">（{flowProjectError}）</span>
                  </div>
                </div>
                <button type="button" className="settings-panel__retry" onClick={() => setProjectReadAttempt((n) => n + 1)}>
                  重试
                </button>
              </div>
            ) : !flowProject ? (
              <div className="settings-panel__value settings-panel__value--readonly" role="status">
                正在读取…
              </div>
            ) : (
              <>
                {flowProject.source === "none" ? (
                  <div className="settings-panel__project-error">
                    尚未绑定 Flow 项目。请前往{" "}
                    <a
                      className="settings-panel__about-link"
                      href="https://flow.google.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      flow.google.com
                    </a>{" "}
                    打开一个项目，将地址栏链接或项目 ID 粘贴至下方。
                  </div>
                ) : (
                  <>
                    <div className="settings-panel__value settings-panel__value--readonly">
                      <code>{flowProject.flow_project_id}</code>
                    </div>
                    <div className="settings-panel__hint">
                      {flowProject.source === "override"
                        ? "当前使用面板内手动覆盖配置（优先于 .env）。"
                        : "当前读取自 .env 中的 FLOWBOARD_FLOW_PROJECT_ID。"}
                    </div>
                  </>
                )}

                <div className="settings-panel__project-row">
                  <input
                    type="text"
                    className="settings-panel__project-input"
                    value={projectDraft}
                    placeholder="粘贴项目链接或项目 ID"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={projectSaving}
                    aria-label="Flow 项目 UUID"
                    onChange={(e) => setProjectDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canSaveProject) {
                        void saveFlowProject(trimmedDraft);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="settings-panel__project-btn"
                    disabled={projectSaving || !canSaveProject}
                    onClick={() => void saveFlowProject(trimmedDraft)}
                  >
                    {projectSaving ? "保存中…" : "保存"}
                  </button>
                </div>

                {legacyEnvId && (
                  <div className="settings-panel__hint">
                    当前 <code>.env</code> 中的项目标识不是标准 UUID 格式；如需在此覆盖，请粘贴完整 UUID。
                  </div>
                )}

                {flowProject.source === "override" && (
                  <button
                    type="button"
                    className="settings-panel__project-clear"
                    disabled={projectSaving}
                    onClick={() => void saveFlowProject(null)}
                  >
                    清除手动覆盖 ——{" "}
                    {flowProject.env_project_id
                      ? `恢复使用 .env 中的 ${flowProject.env_project_id}`
                      : "恢复后将无绑定项目"}
                  </button>
                )}

                {projectSaveError && (
                  <div className="settings-panel__project-error">{projectSaveError}</div>
                )}
                {projectNotice && !projectSaveError && (
                  <div className="settings-panel__project-ok">{projectNotice}</div>
                )}
              </>
            )}
          </section>}

          <section className="settings-panel__section" aria-labelledby="generation-settings-confirm">
            <div className="settings-panel__tier-head">
              <h3 className="settings-panel__label" id="generation-settings-confirm">生成前先确认（视频消耗积分保护）</h3>
              <div className="settings-panel__segmented" role="group" aria-label="视频生成前确认策略">
                <button
                  type="button"
                  className={`settings-panel__seg-btn${confirmBeforeVideoGen === "always" ? " settings-panel__seg-btn--active" : ""}`}
                  onClick={() => setConfirmBeforeVideoGen("always")}
                >
                  始终
                </button>
                <button
                  type="button"
                  className={`settings-panel__seg-btn${confirmBeforeVideoGen === "never" ? " settings-panel__seg-btn--active" : ""}`}
                  onClick={() => setConfirmBeforeVideoGen("never")}
                >
                  永不
                </button>
              </div>
            </div>
            <div className="settings-panel__hint">
              参考 Google Flow 官方策略：设为「始终」时，每次提交消耗积分的视频任务前会展示模式、模型、清晰度、预估积分与最终提示词供确认，避免误触扣点；设为「永不」则点击后直接提交。
            </div>
          </section>

          <div className="settings-panel__models">
            <section className="settings-panel__section" aria-labelledby="generation-settings-video">
              <h3 className="settings-panel__label" id="generation-settings-video">视频默认设置（模型与参数）</h3>
              <div className="settings-panel__radio-group" role="radiogroup" aria-labelledby="generation-settings-video">
                {VIDEO_MODEL_CATALOG.map((m) => {
                  const locked = !!m.ultraOnly && tier !== "PAYGATE_TIER_TWO";
                  const checked = selectedVideoId === m.id;
                  return (
                    <label
                      key={m.id}
                      className={`settings-panel__radio${checked ? " settings-panel__radio--active" : ""}${locked ? " settings-panel__radio--locked" : ""}`}
                    >
                      <input
                        type="radio"
                        name="video-model"
                        value={m.id}
                        checked={checked}
                        disabled={locked}
                        onChange={() => {
                          setVideoModel(m.videoModel);
                          if (m.omniVersion) {
                            setOmniVersion(m.omniVersion);
                          }
                          if (m.videoQuality) {
                            setVideoQuality(m.videoQuality);
                          }
                          if (m.videoModel === "veo" && videoResolution === "360p") {
                            setVideoResolution("720p");
                          }
                        }}
                      />
                      <div>
                        <div className="settings-panel__radio-label">
                          {m.label}
                          <span className="model-badge">{m.officialBadge}</span>
                          <span className="model-badge model-badge--credit">{m.creditTag}</span>
                        </div>
                        {m.deprecationNote && (
                          <div className="settings-panel__deprecation">{m.deprecationNote}</div>
                        )}
                        <div className="settings-panel__radio-meta">
                          画质：{m.qualityTier} · {m.speedTier}
                        </div>
                        <div className="settings-panel__radio-hint">适用：{m.bestFor}</div>
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="settings-panel__param-group">
                <div className="settings-panel__param-row">
                  <span className="settings-panel__param-label">宽高比</span>
                  <div className="settings-panel__segmented" role="group" aria-label="默认视频宽高比">
                    {VIDEO_ASPECT_OPTIONS.map((ar) => (
                      <button
                        key={ar.value}
                        type="button"
                        className={`settings-panel__seg-btn${defaultVideoAspect === ar.value ? " settings-panel__seg-btn--active" : ""}`}
                        onClick={() => setDefaultVideoAspect(ar.value)}
                      >
                        {ar.shortLabel}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-panel__param-row">
                  <span className="settings-panel__param-label">默认清晰度</span>
                  <div className="settings-panel__segmented" role="group" aria-label="默认视频分辨率">
                    {VIDEO_RESOLUTION_OPTIONS.map((r) => {
                      const unsupported = !!r.omniOnly && videoModel !== "omni_flash";
                      return (
                        <button
                          key={r.value}
                          type="button"
                          className={`settings-panel__seg-btn${videoResolution === r.value ? " settings-panel__seg-btn--active" : ""}`}
                          onClick={() => setVideoResolution(r.value)}
                          disabled={unsupported}
                          title={unsupported ? "仅 Omni Flash 支持 360p，Veo 3.1 原生 720p 起" : r.hint}
                        >
                          {unsupported ? `${r.label} (Omni)` : r.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="settings-panel__param-hint">{activeVideoResHint}</div>
                </div>

                <div className="settings-panel__param-row">
                  <span className="settings-panel__param-label">生成时长</span>
                  <div className="gen-dialog__duration-control">
                    <div className="gen-dialog__duration-slider-row">
                      <input
                        type="range"
                        className="gen-dialog__duration-slider"
                        min={3}
                        max={15}
                        step={1}
                        value={activeDefaultVideoDuration}
                        onChange={(e) => handleSelectDefaultVideoDuration(Number(e.target.value))}
                        aria-label="默认视频时长滑块"
                      />
                      <span className="gen-dialog__duration-readout">
                        {activeDefaultVideoDuration} 秒
                      </span>
                    </div>
                    <div className="settings-panel__segmented settings-panel__segmented--wrap" role="group" aria-label="默认视频时长">
                      {OMNI_1_2_DURATIONS.map((d) => (
                        <button
                          key={d}
                          type="button"
                          className={`settings-panel__seg-btn${activeDefaultVideoDuration === d ? " settings-panel__seg-btn--active" : ""}`}
                          onClick={() => handleSelectDefaultVideoDuration(d)}
                        >
                          {d}s
                        </button>
                      ))}
                    </div>
                    {videoModel !== "omni_flash" && (
                      <div className="settings-panel__param-hint">
                        当前 Veo 3.1 固定 8 秒；调整为其他秒数将自动切换默认模型为 Omni 1.2 Flash
                      </div>
                    )}
                  </div>
                </div>

                <div className="settings-panel__param-row">
                  <span className="settings-panel__param-label">输出数量</span>
                  <div className="settings-panel__segmented" role="group" aria-label="默认视频输出数量">
                    {OUTPUT_COUNT_OPTIONS.map((cnt) => (
                      <button
                        key={cnt}
                        type="button"
                        className={`settings-panel__seg-btn${defaultVideoCount === cnt ? " settings-panel__seg-btn--active" : ""}`}
                        onClick={() => setDefaultVideoCount(cnt as OutputCountOption)}
                      >
                        x{cnt}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-panel__credit-summary" role="status">
                  <span className={`jm-cost-pill${videoCostEstimate.isZero ? " jm-cost-pill--zero" : ""}`}>
                    {videoCostEstimate.displayText}
                  </span>
                  <span className="settings-panel__credit-detail">{videoCostEstimate.breakdown}</span>
                </div>
              </div>
            </section>

            <section className="settings-panel__section" aria-labelledby="generation-settings-image">
              <h3 className="settings-panel__label" id="generation-settings-image">照片默认设置（模型与参数）</h3>
              <div className="settings-panel__radio-group" role="radiogroup" aria-labelledby="generation-settings-image">
                {IMAGE_MODEL_CATALOG.map((m) => (
                  <label
                    key={m.id}
                    className={`settings-panel__radio${imageModel === m.id ? " settings-panel__radio--active" : ""}`}
                  >
                    <input
                      type="radio"
                      name="image-model"
                      value={m.id}
                      checked={imageModel === m.id}
                      onChange={() => setImageModel(m.id)}
                    />
                    <div>
                      <div className="settings-panel__radio-label">
                        {m.label}
                        <span className="model-badge">{m.officialBadge}</span>
                        <span className="model-badge model-badge--credit">{m.creditTag}</span>
                      </div>
                      {m.deprecationNote && (
                        <div className="settings-panel__deprecation">{m.deprecationNote}</div>
                      )}
                      <div className="settings-panel__radio-meta">
                        画质：{m.qualityTier} · 速度：{m.speedTier}
                      </div>
                      <div className="settings-panel__radio-hint">适用：{m.bestFor}</div>
                    </div>
                  </label>
                ))}
              </div>

              <div className="settings-panel__param-group">
                <div className="settings-panel__param-row">
                  <span className="settings-panel__param-label">宽高比</span>
                  <div className="settings-panel__segmented settings-panel__segmented--wrap" role="group" aria-label="默认图片宽高比">
                    {IMAGE_ASPECT_OPTIONS.map((ar) => (
                      <button
                        key={ar.value}
                        type="button"
                        className={`settings-panel__seg-btn${defaultImageAspect === ar.value ? " settings-panel__seg-btn--active" : ""}`}
                        onClick={() => setDefaultImageAspect(ar.value)}
                      >
                        {ar.shortLabel}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-panel__param-row">
                  <span className="settings-panel__param-label">默认清晰度</span>
                  <div className="settings-panel__segmented" role="group" aria-label="默认图片清晰度">
                    {IMAGE_RESOLUTION_OPTIONS.map((r) => (
                      <button
                        key={r.value}
                        type="button"
                        className={`settings-panel__seg-btn${imageResolution === r.value ? " settings-panel__seg-btn--active" : ""}`}
                        onClick={() => setImageResolution(r.value)}
                        title={r.hint}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <div className="settings-panel__param-hint">{activeImageResHint}</div>
                </div>

                {imageModel === "NANO_BANANA_2_1" && (
                  <div className="settings-panel__param-row">
                    <span className="settings-panel__param-label">思考深度（2.1 专属）</span>
                    <div className="settings-panel__segmented" role="group" aria-label="Nano Banana 2.1 思考深度">
                      {IMAGE_THINKING_OPTIONS.map((t) => (
                        <button
                          key={t.value}
                          type="button"
                          className={`settings-panel__seg-btn${imageThinkingLevel === t.value ? " settings-panel__seg-btn--active" : ""}`}
                          onClick={() => setImageThinkingLevel(t.value)}
                          title={t.hint}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="settings-panel__param-row">
                  <span className="settings-panel__param-label">输出数量</span>
                  <div className="settings-panel__segmented" role="group" aria-label="默认图片输出数量">
                    {OUTPUT_COUNT_OPTIONS.map((cnt) => (
                      <button
                        key={cnt}
                        type="button"
                        className={`settings-panel__seg-btn${defaultImageCount === cnt ? " settings-panel__seg-btn--active" : ""}`}
                        onClick={() => setDefaultImageCount(cnt as OutputCountOption)}
                      >
                        x{cnt}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="settings-panel__credit-summary" role="status">
                  <span className={`jm-cost-pill${imageCostEstimate.isZero ? " jm-cost-pill--zero" : ""}`}>
                    {imageCostEstimate.displayText}
                  </span>
                  <span className="settings-panel__credit-detail">{imageCostEstimate.breakdown}</span>
                </div>
              </div>
            </section>
          </div>

          <section className="settings-panel__section" aria-labelledby="generation-settings-about">
            <h3 className="settings-panel__label" id="generation-settings-about">关于工作台</h3>
            <div className="settings-panel__about-row">
              <span className="settings-panel__about-key">当前版本</span>
              <span className="settings-panel__about-value">
                <code>v{APP_VERSION}</code>
                {updateAvailable && latestRelease && (
                  <a
                    className="settings-panel__update-badge"
                    href={latestRelease.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    发现新版本 {latestRelease.tagName} →
                  </a>
                )}
              </span>
            </div>
          </section>

          {legacyAccount && onLogout && (
            <div className="settings-panel__section settings-panel__section--logout">
              <button
                type="button"
                className="settings-panel__logout-btn"
                onClick={onLogout}
                disabled={logoutPending}
              >
                {logoutPending ? "正在退出…" : "清除当前缓存账号状态"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
