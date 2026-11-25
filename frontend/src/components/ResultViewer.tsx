import { useEffect, useRef, useState } from "react";
import { collectUpstreamRefEntries, useGenerationStore } from "../store/generation";
import { estimateVideoUpscaleCreditCost } from "../constants/models";
import { useBoardStore } from "../store/board";
import { displayNodeTitle } from "../constants/nodeLabels";
import { useSettingsStore } from "../store/settings";
import { useReferencesStore } from "../store/references";
import {
  getMediaStatus,
  mediaUrl,
  upscaleMedia,
  type MediaStatus,
} from "../api/client";
import { countryLabel, vibeLabel } from "../constants/character";
import { deriveNextScene, derivePrevScene, switchNodeHistoryVersion } from "../lib/quickDerive";
import { FlowVideoShowcase } from "./FlowVideoShowcase";

const ICON: Record<string, string> = {
  character: "◎",
  image: "▣",
  video: "▶",
  prompt: "✦",
  note: "✎",
  merge: "⧉",
};

const IMAGE_MODEL_LABELS: Record<string, string> = {
  NANO_BANANA_PRO: "Nano Banana Pro",
  NANO_BANANA_2_1: "Nano Banana 2.1",
  NANO_BANANA_2_1_LOW: "Nano Banana 2.1（低思考）",
  NANO_BANANA_2_1_MED: "Nano Banana 2.1（中思考）",
  NANO_BANANA_2_1_HIGH: "Nano Banana 2.1（高思考）",
  NANO_BANANA_2_LITE: "Nano Banana 2 Lite",
  NANO_BANANA_2: "Nano Banana 2（兼容）",
};

function formatVideoQualityLabel(key: string): string {
  const staticLabels: Record<string, string> = {
    lite: "Veo 3.1 - Lite",
    fast: "Veo 3.1 - Fast",
    quality: "Veo 3.1 - Quality",
    lite_relaxed: "Veo 3.1 - Lite（Ultra 0 积分）",
  };
  if (staticLabels[key]) return staticLabels[key];
  const mFL = /^first_last_(\d+)s$/.exec(key);
  if (mFL) return `Omni 首尾帧锁定 · ${mFL[1]}秒`;
  const mT2v = /^t2v_(\d+)s$/.exec(key);
  if (mT2v) return `Flow 纯文生视频 · ${mT2v[1]}秒`;
  const m12 = /^(?:omni_1\.2_|abra_1_2_r2v_)(\d+)s$/.exec(key);
  if (m12) return `Omni 1.2 Flash · ${m12[1]}秒`;
  const m11 = /^abra_r2v_(\d+)s$/.exec(key);
  if (m11) return `Omni 1.1 Flash · ${m11[1]}秒`;
  return key;
}

/** Format Flow's aspect-ratio enum to the human label shown on the node card. */
function formatAspectRatio(value: string | undefined): string {
  switch (value) {
    case "IMAGE_ASPECT_RATIO_LANDSCAPE":
    case "VIDEO_ASPECT_RATIO_LANDSCAPE":
      return "16:9";
    case "IMAGE_ASPECT_RATIO_PORTRAIT":
    case "VIDEO_ASPECT_RATIO_PORTRAIT":
      return "9:16";
    case "IMAGE_ASPECT_RATIO_SQUARE":
      return "1:1";
    case "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE":
    case "4:3":
      return "4:3";
    case "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR":
    case "3:4":
      return "3:4";
    default:
      return "—";
  }
}

function formatRelativeTime(iso: string | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 60) return "刚刚";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

export function ResultViewer() {
  const openViewer = useGenerationStore((s) => s.openViewer);
  const closeResultViewer = useGenerationStore((s) => s.closeResultViewer);
  const openGenerationDialog = useGenerationStore((s) => s.openGenerationDialog);
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const projectId = useGenerationStore((s) => s.projectId);
  const nodes = useBoardStore((s) => s.nodes);
  const edges = useBoardStore((s) => s.edges);
  const settingsImageModel = useSettingsStore((s) => s.imageModel);
  const settingsVideoQuality = useSettingsStore((s) => s.videoQuality);

  const [activeIdx, setActiveIdx] = useState(0);
  const [mediaReady, setMediaReady] = useState(false);
  const [cacheKey, setCacheKey] = useState(0);
  const [status, setStatus] = useState<MediaStatus | null>(null);
  // Save-to-library state. MUST live above the `if (!data) return null`
  // early-return below — React's Rules of Hooks require all hooks to be
  // called unconditionally on every render in the same order.
  const [savedFlash, setSavedFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  const [upscalingRes, setUpscalingRes] = useState<string | null>(null);
  const [upscaleError, setUpscaleError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const rfId = openViewer.rfId;
  const node = nodes.find((n) => n.id === rfId);
  const data = node?.data;
  const mediaIds = data?.mediaIds ?? (data?.mediaId ? [data.mediaId] : []);

  const metadataModel: { label: string; isBadge: boolean } = (() => {
    if (data?.type === "video") {
      if (data.videoQuality) {
        return {
          label: formatVideoQualityLabel(data.videoQuality),
          isBadge: true,
        };
      }
      return {
        label: formatVideoQualityLabel(settingsVideoQuality),
        isBadge: false,
      };
    }
    if (data && ["image", "character", "visual_asset", "Storyboard"].includes(data.type)) {
      if (data.imageModel) {
        return {
          label: IMAGE_MODEL_LABELS[data.imageModel] ?? data.imageModel,
          isBadge: true,
        };
      }
      return {
        label: IMAGE_MODEL_LABELS[settingsImageModel] ?? settingsImageModel,
        isBadge: false,
      };
    }
    return { label: "—", isBadge: false };
  })();

  const refSourceNodes = rfId
    ? collectUpstreamRefEntries(rfId, nodes, edges)
    : [];

  // Slot-aware mediaId resolution. When the node has a per-variant
  // `mediaIds` array, slot index activeIdx is authoritative even if
  // its value is `null` — the null means "this variant got blocked",
  // which is semantically distinct from "no per-variant array exists,
  // fall back to the legacy single mediaId". Using `??` chained the
  // two together and made every blocked slot silently render the
  // primary mediaId from slot 0 — i.e. clicking tile 4 played
  // tile 1's video.
  const slotMediaId = data?.mediaIds?.[activeIdx];
  const currentMediaId = rfId && data
    ? (data.mediaIds !== undefined
        ? (typeof slotMediaId === "string" && slotMediaId ? slotMediaId : null)
        : (data.mediaId ?? null))
    : null;
  const slotError = data?.slotErrors?.[activeIdx] ?? null;

  // Reset active variant index and media state when viewer opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      // Honor the idx the caller passed via openResultViewer(rfId, idx)
      // so clicking a specific tile in the node card opens at that
      // variant. Bound by current mediaIds length (best-effort).
      setActiveIdx(openViewer.idx ?? 0);
      setMediaReady(false);
      setStatus(null);
      triggerRef.current = document.activeElement;
    } else {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (triggerRef.current instanceof HTMLElement) {
        triggerRef.current.focus();
      }
    }
  }, [rfId]);

  // Reset media state when active variant changes
  useEffect(() => {
    setMediaReady(false);
    setStatus(null);
    setUpscaleError(null);
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, [currentMediaId]);

  // Keyboard handling
  useEffect(() => {
    if (rfId === null) return;
    const isVid = data?.type === "video";
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeResultViewer();
        return;
      }
      if (isVid) return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % Math.max(mediaIds.length, 1));
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + Math.max(mediaIds.length, 1)) % Math.max(mediaIds.length, 1));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Focus trap
  useEffect(() => {
    if (rfId === null) return;
    const el = dialogRef.current;
    if (!el) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = el.querySelectorAll<HTMLElement>(
        "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    el.addEventListener("keydown", onKeyDown);
    return () => el.removeEventListener("keydown", onKeyDown);
  }, [rfId]);

  if (rfId === null || !data) return null;

  const nodeTitle = displayNodeTitle(data.title, data.type);
  const isVideo = data.type === "video";
  const shortMediaId = currentMediaId ? `${currentMediaId.slice(0, 12)}…` : "待生成";

  const cacheBust = cacheKey > 0 ? `?t=${cacheKey}` : "";

  function onImgLoad() {
    setMediaReady(true);
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  function onImgError() {
    if (!currentMediaId) return;
    setMediaReady(false);
    if (pollTimerRef.current !== null) return; // already polling
    const mid = currentMediaId;
    pollTimerRef.current = setInterval(async () => {
      try {
        const s = await getMediaStatus(mid);
        setStatus(s);
        if (s.available) {
          setCacheKey((k) => k + 1);
          setMediaReady(true);
          if (pollTimerRef.current !== null) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
        }
      } catch {
        // ignore transient errors; keep polling
      }
    }, 2000);
  }

  function handleRefresh() {
    setCacheKey((k) => k + 1);
  }

  let hintText: string;
  if (status === null) {
    hintText = "正在加载媒体…";
  } else if (!status.has_url) {
    hintText = "请保持 flow.google.com 项目页面开启以同步媒体资源。";
  } else {
    hintText = "正在从 Google 缓存高清媒体数据…";
  }

  // Blocks the three generation-flow buttons (Edit prompt, Regenerate,
  // New variant) while the LLM layer is mid-flight on this node — same
  // signal as the canvas-side .node-card--llm-busy treatment so the user
  // can't fire a duplicate dispatch via the detail panel either.
  const llmBusy =
    data?.autoPromptStatus === "pending"
    || data?.aiBriefStatus === "pending";

  function handleRegenerate() {
    if (!rfId || !data || llmBusy) return;
    // Carry forward the node's persisted setup so regenerate matches the
    // original generation. Without this we silently snap to LANDSCAPE / 1
    // variant — wrong for portrait/square shots, character refs (square),
    // and multi-variant batches.
    const aspectRatio =
      typeof data.aspectRatio === "string" ? data.aspectRatio : undefined;
    const variantCount =
      typeof data.variantCount === "number" && data.variantCount > 0
        ? data.variantCount
        : 1;

    // Critical: video nodes must dispatch with `kind: "video"` AND the
    // upstream source(s). Without `kind`, the store falls back to
    // gen_image — silently produces a still image, overwriting the
    // actual video result on the node.
    if (data.type === "video") {
      // Retrying a paid video must return to the account-labelled node for confirmation.
      handleEditPrompt();
      return;
    }
    dispatchGeneration(rfId, {
      prompt: data.prompt ?? "",
      aspectRatio,
      variantCount,
    });
  }

  function handleEditPrompt() {
    if (!rfId || !data || llmBusy) return;
    closeResultViewer();
    openGenerationDialog(rfId, data.prompt ?? "");
  }

  async function handleNewVariant() {
    if (!rfId || llmBusy) return;
    const newRfId = await useBoardStore
      .getState()
      .cloneNodeWithUpstream(rfId);
    if (!newRfId) return;
    closeResultViewer();
    // Open the gen dialog on the fresh sibling so the user can hit
    // Generate immediately (or tweak prompt first) — that's the natural
    // next step after cloning.
    openGenerationDialog(newRfId, data?.prompt ?? "");
  }

  // Save the currently-viewed variant to the cross-board Reference
  // library. Backend POST is idempotent on media_id, so multi-clicking
  // is safe — we still flip the button to "Saved" for 1.5s for feedback.
  // (State declared at the top of the component to satisfy Rules of Hooks.)

  async function handleSaveToLibrary() {
    if (!rfId || !data || !currentMediaId || saving) return;
    setSaving(true);
    try {
      const kind: "image" | "character" | "visual_asset" | "storyboard_shot" =
        data.type === "Storyboard"
          ? "storyboard_shot"
          : data.type === "character"
            ? "character"
            : data.type === "visual_asset"
              ? "visual_asset"
              : "image";
      await useReferencesStore.getState().save({
        media_id: currentMediaId,
        kind,
        ai_brief: typeof data.aiBrief === "string" ? data.aiBrief : null,
        aspect_ratio:
          typeof data.aspectRatio === "string" ? data.aspectRatio : null,
        label:
          typeof data.aiBrief === "string"
            ? data.aiBrief.slice(0, 80)
            : `#${data.shortId}`,
        source_board_id: useBoardStore.getState().boardId,
        source_node_short_id:
          typeof data.shortId === "string" ? data.shortId : null,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch {
      // Surfaced via store.error
    } finally {
      setSaving(false);
    }
  }

  async function handleUpscale(targetRes: "2K" | "4K" | "1080p") {
    if (!rfId || !data || !currentMediaId || upscalingRes !== null) return;
    setUpscalingRes(targetRes);
    setUpscaleError(null);
    try {
      const dbNodeId = parseInt(rfId, 10);
      const res = await upscaleMedia(currentMediaId, {
        resolution: targetRes,
        kind: isVideo ? "video" : "image",
        projectId: projectId ?? undefined,
        aspectRatio: data.aspectRatio,
        nodeId: isNaN(dbNodeId) ? undefined : dbNodeId,
      });
      const patch: Record<string, unknown> = isVideo
        ? { videoResolution: res.resolution.toLowerCase() }
        : { imageResolution: res.resolution };
      if (res.media_id && res.media_id !== currentMediaId) {
        const nextIds = mediaIds.map((m) => (m === currentMediaId ? res.media_id : m));
        patch.mediaIds = nextIds;
        if (data.mediaId === currentMediaId || !data.mediaId) {
          patch.mediaId = res.media_id;
        }
      }
      useBoardStore.getState().updateNodeData(rfId, patch);
      setCacheKey((k) => k + 1);
    } catch (err) {
      setUpscaleError(err instanceof Error ? err.message : "高清重塑失败，请确认账号套餐与网络状态");
    } finally {
      setUpscalingRes(null);
    }
  }

  if (isVideo && node) {
    return (
      <div
        className="result-viewer-backdrop"
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) closeResultViewer();
        }}
      >
        <div ref={dialogRef}>
          <FlowVideoShowcase
            rfId={rfId}
            node={node}
            data={data}
            nodeTitle={nodeTitle}
            mediaIds={mediaIds}
            slotErrors={data.slotErrors ?? []}
            activeIdx={activeIdx}
            setActiveIdx={setActiveIdx}
            currentMediaId={currentMediaId ?? undefined}
            currentSlotError={slotError}
            mediaReady={mediaReady}
            setMediaReady={setMediaReady}
            cacheKey={cacheKey}
            onRetryMedia={handleRefresh}
            status={status}
            refSourceNodes={refSourceNodes}
            metadataModel={metadataModel}
            aspectLabel={formatAspectRatio(data.aspectRatio)}
            relativeTimeLabel={formatRelativeTime(data.renderedAt)}
            llmBusy={llmBusy}
            projectId={projectId}
            savedFlash={savedFlash}
            saving={saving}
            upscalingRes={upscalingRes}
            upscaleError={upscaleError}
            onUpscale={(target) => handleUpscale(target)}
            onClose={closeResultViewer}
            onEditPrompt={handleEditPrompt}
            onRegenerate={handleRegenerate}
            onNewVariant={() => void handleNewVariant()}
            onSaveToLibrary={() => void handleSaveToLibrary()}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className="result-viewer-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeResultViewer();
      }}
    >
      <div
        className="result-viewer"
        role="dialog"
        aria-labelledby="result-viewer-title"
        aria-modal="true"
        ref={dialogRef}
      >
        {/* Left panel — media tile */}
        <div className="result-viewer__left">
          <div
            className="media-placeholder"
            role={mediaReady ? undefined : "img"}
            aria-label={mediaReady ? undefined : `${nodeTitle} — 媒体加载中`}
          >
            {currentMediaId ? (
              <>
                {/* Single media element — always mounted so load/error fires once and
                    there's no flicker from mount/unmount on state flip. */}
                {isVideo ? (
                  <video
                    className="media-placeholder__video"
                    style={mediaReady ? undefined : { display: "none" }}
                    src={mediaUrl(currentMediaId) + cacheBust}
                    controls
                    preload="metadata"
                    onError={onImgError}
                    onLoadedData={onImgLoad}
                  />
                ) : (
                  <img
                    className="media-placeholder__img"
                    style={mediaReady ? undefined : { display: "none" }}
                    src={mediaUrl(currentMediaId) + cacheBust}
                    alt={nodeTitle}
                    onError={onImgError}
                    onLoad={onImgLoad}
                  />
                )}
                {!mediaReady && (
                  <div className="media-placeholder__content">
                    <span className="media-placeholder__icon" aria-hidden="true">
                      {ICON[data.type] ?? "□"}
                    </span>
                    <span className="media-placeholder__title">{nodeTitle}</span>
                    <span className="media-placeholder__id">媒体标识：{shortMediaId}</span>
                  </div>
                )}
              </>
            ) : slotError ? (
              // Blocked variant — Veo's safety classifier rejected this
              // specific clip while the rest of the batch rendered.
              // Show the exact filter reason so the user can decide
              // whether to retry, change inputs, or accept the loss.
              <div className="media-placeholder__content media-placeholder__content--blocked">
                <span className="media-placeholder__icon media-placeholder__icon--warn" aria-hidden="true">⚠</span>
                <span className="media-placeholder__title">该变体已被拦截</span>
                <span className="media-placeholder__error-code">{slotError}</span>
                <span className="media-placeholder__error-hint">
                  该变体未通过 Google 内容安全审核，批次内其余变体已正常生成。可尝试调整上游参考图或提示词后重新生成。
                </span>
              </div>
            ) : (
              <div className="media-placeholder__content">
                <span className="media-placeholder__icon" aria-hidden="true">
                  {ICON[data.type] ?? "□"}
                </span>
                <span className="media-placeholder__title">{nodeTitle}</span>
                <span className="media-placeholder__id">媒体标识：{shortMediaId}</span>
              </div>
            )}
          </div>

          {currentMediaId && !mediaReady && (
            <p className="media-placeholder__hint">{hintText}</p>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {currentMediaId && (
              <button className="media-placeholder__refresh" onClick={handleRefresh}>
                刷新预览
              </button>
            )}
            {mediaIds.length > 0 && (
              <div className="variant-switcher" role="group" aria-label="切换变体">
                {mediaIds.map((_id, idx) => {
                  const chipError = data?.slotErrors?.[idx] ?? null;
                  const blocked = chipError !== null && chipError !== undefined;
                  return (
                    <button
                      key={idx}
                      className={`variant-switcher__chip${idx === activeIdx ? " variant-switcher__chip--active" : ""}${blocked ? " variant-switcher__chip--blocked" : ""}`}
                      onClick={() => setActiveIdx(idx)}
                      aria-label={blocked ? `变体 ${idx + 1} — 被拦截: ${chipError}` : `变体 ${idx + 1}`}
                      title={blocked ? `内容安全拦截: ${chipError}` : `变体 ${idx + 1}`}
                      aria-pressed={idx === activeIdx}
                    >
                      {blocked ? "⚠" : idx + 1}
                    </button>
                  );
                })}
              </div>
            )}
            {Array.isArray(data.history) && data.history.length >= 2 && rfId && (
              <div className="variant-switcher" role="group" aria-label="切换历史版本">
                {data.history.map((h, hIdx) => {
                  const isCurrent = h.mediaId === data.mediaId;
                  return (
                    <button
                      key={h.mediaId}
                      type="button"
                      className={`variant-switcher__chip${isCurrent ? " variant-switcher__chip--active" : ""}`}
                      onClick={() => {
                        switchNodeHistoryVersion(rfId, hIdx);
                        setActiveIdx(0);
                      }}
                      title={h.prompt ? `第 ${hIdx + 1} 版：${h.prompt.slice(0, 60)}` : `第 ${hIdx + 1} 版`}
                    >
                      v{hIdx + 1}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right panel — metadata */}
        <div className="result-viewer__right">
          <div className="result-viewer__status-pill">已生成</div>

          <h2 id="result-viewer-title" className="result-viewer__node-title">
            {nodeTitle}
          </h2>
          <span className="result-viewer__node-id">#{data.shortId}</span>

          <hr className="result-viewer__divider" />

          <span className="result-viewer__section-label">生成提示词</span>
          <p className="result-viewer__prompt">{data.prompt ?? "（未填写提示词）"}</p>
          <button
            className="result-viewer__edit-prompt"
            onClick={handleEditPrompt}
            disabled={llmBusy}
            title={llmBusy ? "正在合成提示词，请稍候" : undefined}
          >
            修改参数与提示词 →
          </button>

          {refSourceNodes.length > 0 && (
            <>
              <hr className="result-viewer__divider" />
              <span className="result-viewer__section-label">
                上游参考素材 ({refSourceNodes.length})
              </span>
              <div className="ref-source-row">
                {refSourceNodes.map((r) => {
                  const refTitle = displayNodeTitle(r.node.data.title, r.node.data.type);
                  return (
                    <div
                      key={r.node.id}
                      className="ref-source-chip"
                      title={
                        r.variantIdx !== null
                          ? `${refTitle} — 变体 ${r.variantIdx + 1}`
                          : refTitle
                      }
                    >
                      {r.node.data.type === "video" ? (
                        <video
                          className="ref-source-chip__img"
                          src={mediaUrl(r.mediaId)}
                          muted
                          playsInline
                          preload="metadata"
                        />
                      ) : (
                        <img
                          className="ref-source-chip__img"
                          src={mediaUrl(r.mediaId)}
                          alt={refTitle}
                        />
                      )}
                      {r.variantIdx !== null && (
                        <span className="ref-source-chip__variant">
                          v{r.variantIdx + 1}
                        </span>
                      )}
                      <span className="ref-source-chip__id">
                        #{r.node.data.shortId}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <hr className="result-viewer__divider" />

          <span className="result-viewer__section-label">创作信息</span>
          <dl className="result-viewer__metadata-grid">
            <dt>模型</dt>
            <dd>
              {metadataModel.isBadge ? (
                <span className="model-badge">{metadataModel.label}</span>
              ) : (
                metadataModel.label
              )}
            </dd>
            {data?.type === "character" && countryLabel(data.charCountry) && (
              <>
                <dt>地区</dt>
                <dd>
                  <span className="model-badge">{countryLabel(data.charCountry)}</span>
                </dd>
              </>
            )}
            {data?.type === "character" && vibeLabel(data.charVibe) && (
              <>
                <dt>风格</dt>
                <dd>
                  <span className="model-badge">{vibeLabel(data.charVibe)}</span>
                </dd>
              </>
            )}
            <dt>比例</dt>
            <dd>{formatAspectRatio(data?.aspectRatio)}</dd>
            {(() => {
              const rawRes =
                data?.imageResolution ?? data?.videoResolution ?? data?.resolution;
              if (!rawRes) return null;
              return (
                <>
                  <dt>清晰度</dt>
                  <dd>
                    <span className="model-badge">{String(rawRes).toUpperCase()}</span>
                  </dd>
                </>
              );
            })()}
            {typeof data?.seed === "number" && (
              <>
                <dt>种子</dt>
                <dd>{data.seed}</dd>
              </>
            )}
            {data?.type === "video" && (data.mediaProvider === "flow" || data.mediaProvider === "google_video") && (
              <><dt>引擎</dt><dd>{data.mediaProvider === "flow" ? "Flow 账号" : "Google API（历史结果）"}</dd></>
            )}
            {data?.type === "video" && typeof data.durationSeconds === "number" && (
              <><dt>时长</dt><dd>{data.durationSeconds} 秒</dd></>
            )}
            <dt>时间</dt>
            <dd>{formatRelativeTime(data?.renderedAt)}</dd>
          </dl>

          <div className="result-viewer__actions">
            {llmBusy && (
              <div className="result-viewer__busy-banner" role="status">
                <span className="node-header__llm-spinner" aria-hidden="true" />
                {data?.autoPromptStatus === "pending"
                  ? "正在构思提示词，请稍候…"
                  : "正在解析画面内容，请稍候…"}
              </div>
            )}
            {upscaleError && (
              <div className="result-viewer__upscale-error" role="alert">
                {upscaleError}
              </div>
            )}
            {currentMediaId &&
              (isVideo ? (
                (() => {
                  const durSec =
                    typeof data?.durationSeconds === "number" && data.durationSeconds > 0
                      ? data.durationSeconds
                      : 8;
                  const cost1080 = estimateVideoUpscaleCreditCost("1080p", durSec);
                  const cost4k = estimateVideoUpscaleCreditCost("4k", durSec);
                  return (
                    <div className="result-viewer__upscale-row">
                      <button
                        type="button"
                        className="result-viewer__btn result-viewer__btn--upscale"
                        onClick={() => void handleUpscale("1080p")}
                        disabled={upscalingRes !== null}
                        title={
                          cost1080 > 0
                            ? `将当前 ${durSec} 秒视频超分重塑为 1080p（需 Plus/Pro/Ultra · 消耗 ${cost1080} 积分）`
                            : "将当前视频超分重塑为 1080p 高清版（需 Plus / Pro / Ultra · 1–10秒 0 积分）"
                        }
                      >
                        {upscalingRes === "1080p"
                          ? "1080p 处理中…"
                          : cost1080 > 0
                            ? `✨ 1080p 高清 (+${cost1080}积分)`
                            : "✨ 1080p 高清 (0积分)"}
                      </button>
                      <button
                        type="button"
                        className="result-viewer__btn result-viewer__btn--upscale"
                        onClick={() => void handleUpscale("4K")}
                        disabled={upscalingRes !== null}
                        title={`将当前 ${durSec} 秒视频超分重塑为 4K 超清版（仅 Ultra · 消耗 ${cost4k} 积分）`}
                      >
                        {upscalingRes === "4K"
                          ? "4K 处理中…"
                          : `✨ 4K 超清 (+${cost4k}积分)`}
                      </button>
                    </div>
                  );
                })()
              ) : (
                ["image", "character", "visual_asset", "Storyboard"].includes(data.type) && (
                  <>
                    <div className="result-viewer__upscale-row">
                      <button
                        type="button"
                        className="result-viewer__btn result-viewer__btn--upscale"
                        onClick={() => void handleUpscale("2K")}
                        disabled={upscalingRes !== null}
                        title="调用官方 SPrCad 将当前图片高清重塑为 2K（Free 即可使用）"
                      >
                        {upscalingRes === "2K" ? "2K 处理中…" : "✨ 2K 高清重塑"}
                      </button>
                      <button
                        type="button"
                        className="result-viewer__btn result-viewer__btn--upscale"
                        onClick={() => void handleUpscale("4K")}
                        disabled={upscalingRes !== null}
                        title="调用官方 SPrCad 将当前图片超清重塑为 4K（需 Ultra）"
                      >
                        {upscalingRes === "4K" ? "4K 处理中…" : "✨ 4K 超清重塑"}
                      </button>
                    </div>
                    {data.type !== "Storyboard" && (
                      <div className="result-viewer__upscale-row">
                        <button
                          type="button"
                          className="result-viewer__btn"
                          onClick={() => {
                            closeResultViewer();
                            void derivePrevScene(rfId);
                          }}
                          title="基于当前画面倒推 5 秒前镜头"
                        >
                          ⏮ 前一幕
                        </button>
                        <button
                          type="button"
                          className="result-viewer__btn"
                          onClick={() => {
                            closeResultViewer();
                            void deriveNextScene(rfId);
                          }}
                          title="基于当前画面推演 3 秒后下一幕"
                        >
                          ⏭ 下一幕
                        </button>
                        <button
                          type="button"
                          className="result-viewer__btn"
                          onClick={() => {
                            closeResultViewer();
                            window.dispatchEvent(
                              new CustomEvent("flowboard:open-layer-editor", {
                                detail: { rfId, tab: "inpaint" },
                              }),
                            );
                          }}
                          title="打开图层精修画板（局部涂抹重绘 / 消除笔 / 比例扩图）"
                        >
                          ❖ 局部精修
                        </button>
                      </div>
                    )}
                  </>
                )
              ))}
            <button
              className="result-viewer__btn result-viewer__btn--primary"
              onClick={handleRegenerate}
              disabled={llmBusy}
              title={llmBusy ? "后台正在处理该节点" : undefined}
            >
              重新生成
            </button>
            <button
              className="result-viewer__btn"
              onClick={handleNewVariant}
              disabled={llmBusy}
              title="在画布上克隆具有相同上游参考连接的新节点"
            >
              克隆新变体节点 +
            </button>
            <button
              className={
                "result-viewer__btn result-viewer__btn--save"
                + (savedFlash ? " result-viewer__btn--saved" : "")
              }
              onClick={handleSaveToLibrary}
              disabled={!currentMediaId || saving}
              title={
                !currentMediaId
                  ? "请等待媒体加载完成"
                  : "将当前画面收藏至跨画布资产库"
              }
            >
              {savedFlash ? "✓ 已收藏至资产库" : saving ? "…" : "★ 收藏至资产库"}
            </button>
            {projectId ? (
              <a
                className="result-viewer__btn result-viewer__btn--link"
                href="https://flow.google.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                在 Google Flow 中查看 ↗
              </a>
            ) : (
              <button className="result-viewer__btn" disabled>
                在 Google Flow 中查看 ↗
              </button>
            )}
          </div>
        </div>

        {/* Footer hint */}
        <div className="result-viewer__footer-hint">
          ESC 关闭 · ←/→ 切换变体
        </div>

        {/* Close button */}
        <button
          className="result-viewer__close"
          onClick={closeResultViewer}
          aria-label="关闭预览窗口"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
