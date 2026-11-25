import { useEffect, useRef, useState } from "react";
import { estimateVideoUpscaleCreditCost } from "../constants/models";
import { displayNodeTitle } from "../constants/nodeLabels";
import { mediaUrl, type MediaStatus } from "../api/client";
import { useBoardStore, type FlowNode, type FlowboardNodeData } from "../store/board";
import { useGenerationStore, type UpstreamRefEntry } from "../store/generation";
import { switchNodeHistoryVersion } from "../lib/quickDerive";
import {
  exportVideoUrlAsGif270p,
  extractVideoFilmstripFrames,
  formatVideoTimecode,
} from "../lib/videoGifExport";
import "./FlowVideoShowcase.css";

export interface FlowVideoShowcaseProps {
  rfId: string;
  node: FlowNode;
  data: FlowboardNodeData;
  nodeTitle: string;
  mediaIds: (string | null)[];
  slotErrors: (string | null)[];
  activeIdx: number;
  setActiveIdx: (idx: number) => void;
  currentMediaId: string | undefined;
  currentSlotError: string | null;
  mediaReady: boolean;
  setMediaReady: (ready: boolean) => void;
  cacheKey: number;
  onRetryMedia: () => void;
  status: MediaStatus | null;
  refSourceNodes: UpstreamRefEntry[];
  metadataModel: { label: string; isBadge: boolean };
  aspectLabel: string;
  relativeTimeLabel: string;
  llmBusy: boolean;
  projectId: string | null;
  savedFlash: boolean;
  saving: boolean;
  upscalingRes: string | null;
  upscaleError: string | null;
  onUpscale: (target: "1080p" | "4K") => Promise<void>;
  onClose: () => void;
  onEditPrompt: () => void;
  onRegenerate: () => void;
  onNewVariant: () => void;
  onSaveToLibrary: () => void;
}

export function FlowVideoShowcase({
  rfId,
  node,
  data,
  nodeTitle,
  mediaIds,
  slotErrors,
  activeIdx,
  setActiveIdx,
  currentMediaId,
  currentSlotError,
  mediaReady,
  setMediaReady,
  cacheKey,
  onRetryMedia,
  status,
  refSourceNodes,
  metadataModel,
  aspectLabel,
  relativeTimeLabel,
  llmBusy,
  projectId,
  savedFlash,
  saving,
  upscalingRes,
  upscaleError,
  onUpscale,
  onClose,
  onEditPrompt,
  onRegenerate,
  onNewVariant,
  onSaveToLibrary,
}: FlowVideoShowcaseProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dlMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [looping, setLooping] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(
    typeof data.durationSeconds === "number" && data.durationSeconds > 0
      ? data.durationSeconds
      : 8,
  );
  const [zoomLevel, setZoomLevel] = useState(1);
  const [hideHistory, setHideHistory] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [gifProgress, setGifProgress] = useState<number | null>(null);
  const [gifError, setGifError] = useState<string | null>(null);
  const [filmstripFrames, setFilmstripFrames] = useState<string[]>([]);
  const [scrubbing, setScrubbing] = useState(false);
  const [extending, setExtending] = useState(false);

  const srcUrl = currentMediaId
    ? `${mediaUrl(currentMediaId)}${cacheKey ? `?t=${cacheKey}` : ""}`
    : "";

  const currentResRaw = String(
    data.videoResolution ?? data.resolution ?? "720p",
  ).toLowerCase();
  const isAlready1080OrHigher = currentResRaw === "1080p" || currentResRaw === "4k";
  const isAlready4k = currentResRaw === "4k";
  const durSecForCost = Math.max(
    1,
    Math.round(
      typeof data.durationSeconds === "number" && data.durationSeconds > 0
        ? data.durationSeconds
        : duration || 8,
    ),
  );
  const cost1080 = estimateVideoUpscaleCreditCost("1080p", durSecForCost);
  const cost4k = estimateVideoUpscaleCreditCost("4k", durSecForCost);

  const historyList = Array.isArray(data.history) ? data.history : [];

  // Close popovers when clicking outside
  useEffect(() => {
    if (!downloadMenuOpen && !moreMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (downloadMenuOpen && dlMenuRef.current && !dlMenuRef.current.contains(target)) {
        setDownloadMenuOpen(false);
      }
      if (moreMenuOpen && moreMenuRef.current && !moreMenuRef.current.contains(target)) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [downloadMenuOpen, moreMenuOpen]);

  // Reset player state when switching clips
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setGifError(null);
    setFilmstripFrames([]);
    if (!currentMediaId) return;
    let cancelled = false;
    void extractVideoFilmstripFrames(mediaUrl(currentMediaId), 12, 64)
      .then((frames) => {
        if (!cancelled) setFilmstripFrames(frames);
      })
      .catch(() => {
        if (!cancelled) setFilmstripFrames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentMediaId, cacheKey]);

  // Space bar play/pause inside showcase
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "button") return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  function togglePlay() {
    const v = videoRef.current;
    if (!v || !currentMediaId) return;
    if (v.paused) {
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  }

  function stepFrame(deltaFrames: number) {
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    const step = deltaFrames / 24;
    const next = Math.max(0, Math.min(v.duration || duration || 8, v.currentTime + step));
    v.currentTime = next;
    setCurrentTime(next);
  }

  function toggleMute() {
    const v = videoRef.current;
    const next = !muted;
    setMuted(next);
    if (v) v.muted = next;
  }

  function handleFullscreen() {
    const target = stageRef.current ?? videoRef.current;
    if (!target) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else if (typeof target.requestFullscreen === "function") {
      void target.requestFullscreen().catch(() => {});
    }
  }

  function scrubToClientX(clientX: number) {
    const track = trackRef.current;
    const v = videoRef.current;
    if (!track || !v) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const total = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : duration || 8;
    const nextSec = ratio * total;
    v.currentTime = nextSec;
    setCurrentTime(nextSec);
  }

  useEffect(() => {
    if (!scrubbing) return;
    const onMove = (e: PointerEvent) => scrubToClientX(e.clientX);
    const onUp = () => setScrubbing(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [scrubbing, duration]);

  function triggerOriginalDownload() {
    if (!currentMediaId) return;
    setDownloadMenuOpen(false);
    const safeTitle = (data.title || "video").replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]+/g, "_");
    const a = document.createElement("a");
    a.href = mediaUrl(currentMediaId);
    a.download = `${safeTitle}-${data.shortId}-${currentResRaw}.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function triggerGif270pDownload() {
    if (!currentMediaId || gifProgress !== null) return;
    setDownloadMenuOpen(false);
    setGifError(null);
    setGifProgress(5);
    const safeTitle = (data.title || "video").replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]+/g, "_");
    try {
      await exportVideoUrlAsGif270p(
        mediaUrl(currentMediaId),
        `${safeTitle}-${data.shortId}-270p.gif`,
        (pct) => setGifProgress(pct),
      );
    } catch (err) {
      setGifError(err instanceof Error ? err.message : "导出 270p GIF 失败");
    } finally {
      window.setTimeout(() => setGifProgress(null), 500);
    }
  }

  async function handleCopyPrompt() {
    const txt = (data.prompt ?? "").trim();
    if (!txt) return;
    try {
      await navigator.clipboard.writeText(txt);
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 1600);
    } catch {
      // Clipboard blocked in non-HTTPS context — silent ignore
    }
  }

  async function handleExtendNextClip() {
    if (extending) return;
    setExtending(true);
    try {
      const store = useBoardStore.getState();
      const newPos = {
        x: Math.round(node.position.x + 340),
        y: Math.round(node.position.y),
      };
      const newRfId = await store.addNodeOfType("video", newPos);
      if (newRfId) {
        await store.addEdgeFromConnection(rfId, newRfId);
        onClose();
        useGenerationStore.getState().openGenerationDialog(newRfId, "");
      }
    } finally {
      setExtending(false);
    }
  }

  const effectiveDuration = Number.isFinite(duration) && duration > 0 ? duration : 8;
  const playheadPct = Math.max(0, Math.min(100, (currentTime / effectiveDuration) * 100));
  const rulerSeconds = Math.max(4, Math.min(16, Math.round(effectiveDuration)));

  return (
    <div
      className="flow-showcase"
      role="dialog"
      aria-modal="true"
      aria-labelledby="flow-showcase-title"
    >
      {/* Top Bar — Official Google Flow Video Detail Layout */}
      <header className="flow-showcase__topbar">
        <div className="flow-showcase__top-left">
          <button
            type="button"
            className="flow-showcase__icon-btn"
            onClick={onClose}
            aria-label="返回画布"
            title="返回画布 (ESC)"
          >
            ←
          </button>
          <div className="flow-showcase__title-wrap">
            <h2 id="flow-showcase-title" className="flow-showcase__title">
              {nodeTitle}
            </h2>
            <span className="flow-showcase__short-id">#{data.shortId}</span>
          </div>
        </div>

        {/* Center mini version/variant strip */}
        <div className="flow-showcase__thumb-strip" role="tablist" aria-label="视频片段与变体列表">
          {mediaIds.map((mid, i) => {
            const active = i === activeIdx;
            const blocked = !mid && Boolean(slotErrors[i]);
            return (
              <button
                key={`${i}:${mid ?? "empty"}`}
                type="button"
                role="tab"
                aria-selected={active}
                className={`flow-showcase__strip-item${active ? " flow-showcase__strip-item--active" : ""}${blocked ? " flow-showcase__strip-item--blocked" : ""}`}
                onClick={() => setActiveIdx(i)}
                title={blocked ? `片段 ${i + 1} 未生成：${slotErrors[i]}` : `片段 ${i + 1}`}
              >
                {mid ? (
                  <video
                    src={mediaUrl(mid)}
                    muted
                    playsInline
                    preload="metadata"
                  />
                ) : (
                  <span>{blocked ? "!" : i + 1}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Right official Flow action cluster */}
        <div className="flow-showcase__top-right">
          <button
            type="button"
            className={`flow-showcase__icon-btn${savedFlash ? " flow-showcase__icon-btn--saved" : ""}`}
            onClick={onSaveToLibrary}
            disabled={!currentMediaId || saving}
            aria-label={savedFlash ? "已收藏至资产库" : "收藏至资产库"}
            title={savedFlash ? "已收藏至跨画布资产库" : "收藏至跨画布资产库"}
          >
            {savedFlash ? "♥" : "♡"}
          </button>

          {/* Download & Upscale Dropdown — matching Screenshot 2 */}
          <div className="flow-showcase__menu-wrap" ref={dlMenuRef}>
            <button
              type="button"
              className={`flow-showcase__icon-btn flow-showcase__icon-btn--dl${downloadMenuOpen ? " flow-showcase__icon-btn--active" : ""}`}
              onClick={() => {
                setMoreMenuOpen(false);
                setDownloadMenuOpen((v) => !v);
              }}
              disabled={!currentMediaId}
              aria-haspopup="menu"
              aria-expanded={downloadMenuOpen}
              title="下载视频 / 高清重塑导出"
            >
              <span>↓</span>
              <span className="flow-showcase__caret">▾</span>
            </button>
            {downloadMenuOpen && (
              <div className="flow-showcase__dropdown" role="menu" aria-label="下载与清晰度重塑">
                <button
                  type="button"
                  role="menuitem"
                  className="flow-showcase__dropdown-item"
                  disabled={gifProgress !== null}
                  onClick={() => void triggerGif270pDownload()}
                >
                  <span className="flow-showcase__res-col">270p</span>
                  <span className="flow-showcase__desc-col">
                    <strong>GIF 动画</strong>
                    <span>{gifProgress !== null ? `正在编码 ${gifProgress}%…` : "轻量动图导出"}</span>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flow-showcase__dropdown-item"
                  onClick={triggerOriginalDownload}
                >
                  <span className="flow-showcase__res-col">
                    {currentResRaw === "720p" ? "720p" : currentResRaw.toUpperCase()}
                  </span>
                  <span className="flow-showcase__desc-col">
                    <strong>原始尺寸</strong>
                    <span>立即下载 MP4 成片</span>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flow-showcase__dropdown-item"
                  disabled={upscalingRes !== null}
                  onClick={() => {
                    if (isAlready1080OrHigher) {
                      triggerOriginalDownload();
                    } else {
                      setDownloadMenuOpen(false);
                      void onUpscale("1080p");
                    }
                  }}
                >
                  <span className="flow-showcase__res-col">1080p</span>
                  <span className="flow-showcase__desc-col">
                    <strong>{isAlready1080OrHigher ? "已高清重塑" : "高清重塑"}</strong>
                    <span>
                      {upscalingRes === "1080p"
                        ? "正在重塑 1080p…"
                        : isAlready1080OrHigher
                          ? "点击直接下载高清 MP4"
                          : cost1080 > 0
                            ? `消耗 ${cost1080} 个点数`
                            : "1–10 秒 0 积分"}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flow-showcase__dropdown-item"
                  disabled={upscalingRes !== null}
                  onClick={() => {
                    if (isAlready4k) {
                      triggerOriginalDownload();
                    } else {
                      setDownloadMenuOpen(false);
                      void onUpscale("4K");
                    }
                  }}
                >
                  <span className="flow-showcase__res-col">4K</span>
                  <span className="flow-showcase__desc-col">
                    <strong>{isAlready4k ? "已高清重塑" : "高清重塑"}</strong>
                    <span>
                      {upscalingRes === "4K"
                        ? "正在重塑 4K…"
                        : isAlready4k
                          ? "点击直接下载 4K MP4"
                          : `消耗 ${cost4k} 个点数`}
                    </span>
                  </span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className="flow-showcase__icon-btn"
            onClick={onNewVariant}
            disabled={llmBusy}
            aria-label="克隆新变体节点"
            title="在画布克隆同配置新视频节点"
          >
            ❐
          </button>

          <button
            type="button"
            className={`flow-showcase__pill-btn${!hideHistory ? " flow-showcase__pill-btn--active" : ""}`}
            onClick={() => setHideHistory((v) => !v)}
            title={hideHistory ? "展开右侧历史与提示词面板" : "隐藏右侧历史记录，全屏沉浸预览"}
          >
            {hideHistory ? "显示历史记录" : "隐藏历史记录"}
          </button>

          <div className="flow-showcase__menu-wrap" ref={moreMenuRef}>
            <button
              type="button"
              className="flow-showcase__icon-btn"
              onClick={() => {
                setDownloadMenuOpen(false);
                setMoreMenuOpen((v) => !v);
              }}
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen}
              aria-label="更多操作"
              title="更多操作"
            >
              ⋮
            </button>
            {moreMenuOpen && (
              <div className="flow-showcase__dropdown flow-showcase__dropdown--compact" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="flow-showcase__dropdown-item"
                  disabled={llmBusy}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    onEditPrompt();
                  }}
                >
                  修改参数与提示词
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flow-showcase__dropdown-item"
                  disabled={llmBusy}
                  onClick={() => {
                    setMoreMenuOpen(false);
                    onRegenerate();
                  }}
                >
                  重新生成当前视频
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flow-showcase__dropdown-item"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    void handleCopyPrompt();
                  }}
                >
                  {copiedPrompt ? "✓ 已复制提示词" : "复制完整提示词"}
                </button>
                {projectId && (
                  <a
                    role="menuitem"
                    className="flow-showcase__dropdown-item"
                    href="https://flow.google.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => setMoreMenuOpen(false)}
                  >
                    在 Google Flow 中查看 ↗
                  </a>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            className="flow-showcase__done-btn"
            onClick={onClose}
          >
            完成
          </button>
        </div>
      </header>

      {/* Main Workspace: Stage + Collapsible Right History/Prompt Sidebar */}
      <div className="flow-showcase__body">
        <div className="flow-showcase__stage-col">
          <div className="flow-showcase__stage" ref={stageRef}>
            {(upscalingRes || gifProgress !== null) && (
              <div className="flow-showcase__floating-toast" role="status">
                {upscalingRes
                  ? `✨ 正在调用 Flow 重塑 ${upscalingRes} 高清版本…`
                  : `🎞️ 正在导出 270p GIF 动画（${gifProgress}%）…`}
              </div>
            )}
            {(upscaleError || gifError) && (
              <div className="flow-showcase__floating-toast flow-showcase__floating-toast--err" role="alert">
                {upscaleError || gifError}
              </div>
            )}

            {currentMediaId ? (
              <div
                className="flow-showcase__video-box"
                style={{ transform: `scale(${zoomLevel})` }}
                onClick={togglePlay}
              >
                <video
                  ref={videoRef}
                  key={`${currentMediaId}-${cacheKey}`}
                  className="flow-showcase__video"
                  src={srcUrl}
                  playsInline
                  loop={looping}
                  muted={muted}
                  preload="auto"
                  onLoadedMetadata={(e) => {
                    const d = e.currentTarget.duration;
                    if (Number.isFinite(d) && d > 0) setDuration(d);
                  }}
                  onLoadedData={() => setMediaReady(true)}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                  onError={() => setMediaReady(false)}
                />
                {!mediaReady && (
                  <div className="flow-showcase__placeholder" role="status">
                    <span>
                      {status?.reason === "unavailable"
                        ? "未在本地缓存中找到视频文件"
                        : "正在载入高清视频…"}
                    </span>
                    <button
                      type="button"
                      className="flow-showcase__retry-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRetryMedia();
                      }}
                    >
                      重新加载
                    </button>
                  </div>
                )}
              </div>
            ) : currentSlotError ? (
              <div className="flow-showcase__blocked" role="alert">
                <div className="flow-showcase__blocked-icon">⚠</div>
                <div className="flow-showcase__blocked-title">
                  片段 {activeIdx + 1} 未通过安全审核或生成失败
                </div>
                <div className="flow-showcase__blocked-code">{currentSlotError}</div>
                <p className="flow-showcase__blocked-hint">
                  可使用「修改参数 → AI 润色」自动优化安全词后重新生成。
                </p>
              </div>
            ) : (
              <div className="flow-showcase__blocked">暂无可播放的视频成片</div>
            )}
          </div>

          {/* Official Google Flow Transport Bar */}
          <div className="flow-showcase__transport" role="toolbar" aria-label="视频播放控制条">
            <div className="flow-showcase__transport-left">
              <button
                type="button"
                className="flow-showcase__tbtn"
                onClick={toggleMute}
                aria-label={muted ? "取消静音" : "静音"}
                title={muted ? "取消静音" : "静音"}
              >
                {muted ? "🔇" : "🔊"}
              </button>
              <span className="flow-showcase__timecode">
                {formatVideoTimecode(currentTime)}
              </span>
            </div>

            <div className="flow-showcase__transport-center">
              <button
                type="button"
                className="flow-showcase__tbtn"
                onClick={() => stepFrame(-1)}
                disabled={!currentMediaId}
                aria-label="上一帧"
                title="后退 1 帧"
              >
                ⏮
              </button>
              <button
                type="button"
                className="flow-showcase__play-circle"
                onClick={togglePlay}
                disabled={!currentMediaId}
                aria-label={playing ? "暂停" : "播放"}
                title={playing ? "暂停 (Space)" : "播放 (Space)"}
              >
                {playing ? "❚❚" : "▶"}
              </button>
              <button
                type="button"
                className="flow-showcase__tbtn"
                onClick={() => stepFrame(1)}
                disabled={!currentMediaId}
                aria-label="下一帧"
                title="前进 1 帧"
              >
                ⏭
              </button>
            </div>

            <div className="flow-showcase__transport-right">
              <span className="flow-showcase__timecode">
                {formatVideoTimecode(effectiveDuration)}
              </span>
              <button
                type="button"
                className="flow-showcase__tbtn"
                onClick={handleFullscreen}
                aria-label="全屏播放"
                title="全屏播放"
              >
                ⛶
              </button>
              <button
                type="button"
                className={`flow-showcase__tbtn${looping ? " flow-showcase__tbtn--active" : ""}`}
                onClick={() => setLooping((v) => !v)}
                aria-pressed={looping}
                aria-label="循环播放"
                title={looping ? "循环播放：已开启" : "循环播放：已关闭"}
              >
                ↻
              </button>
              <div className="flow-showcase__zoom-group">
                <button
                  type="button"
                  className="flow-showcase__tbtn"
                  onClick={() => setZoomLevel((z) => Math.max(1, Number((z - 0.25).toFixed(2))))}
                  disabled={zoomLevel <= 1}
                  aria-label="缩小画面"
                  title="缩小画面"
                >
                  −
                </button>
                <span className="flow-showcase__zoom-val">
                  {Math.round(zoomLevel * 100)}%
                </span>
                <button
                  type="button"
                  className="flow-showcase__tbtn"
                  onClick={() => setZoomLevel((z) => Math.min(2, Number((z + 0.25).toFixed(2))))}
                  disabled={zoomLevel >= 2}
                  aria-label="放大画面"
                  title="放大画面"
                >
                  +
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Collapsible History & Inspector Panel */}
        {!hideHistory && (
          <aside className="flow-showcase__sidebar" aria-label="生成历史与提示词详情">
            <div className="flow-showcase__side-card">
              <div className="flow-showcase__side-head">
                <span className="flow-showcase__side-label">当前视频信息</span>
                <span className="flow-showcase__res-badge">
                  {currentResRaw.toUpperCase()} · {Math.round(effectiveDuration)}s
                </span>
              </div>

              {refSourceNodes.length > 0 && (
                <div className="flow-showcase__refs">
                  <span className="flow-showcase__sub-label">
                    上游参考 ({refSourceNodes.length})
                  </span>
                  <div className="flow-showcase__ref-row">
                    {refSourceNodes.map((r) => {
                      const refTitle = displayNodeTitle(r.node.data.title, r.node.data.type);
                      return (
                        <div key={r.edgeId} className="flow-showcase__ref-thumb" title={refTitle}>
                          {r.node.data.type === "video" ? (
                            <video src={mediaUrl(r.mediaId)} muted playsInline preload="metadata" />
                          ) : (
                            <img src={mediaUrl(r.mediaId)} alt={refTitle} />
                          )}
                          <span>#{r.node.data.shortId}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flow-showcase__prompt-section">
                <div className="flow-showcase__side-head">
                  <span className="flow-showcase__sub-label">提示词</span>
                  <button
                    type="button"
                    className="flow-showcase__link-btn"
                    onClick={() => void handleCopyPrompt()}
                  >
                    {copiedPrompt ? "✓ 已复制" : "复制"}
                  </button>
                </div>
                <p
                  className={`flow-showcase__prompt-text${promptExpanded ? " flow-showcase__prompt-text--expanded" : ""}`}
                >
                  {data.prompt || "（未填写提示词）"}
                </p>
                {(data.prompt?.length ?? 0) > 100 && (
                  <button
                    type="button"
                    className="flow-showcase__link-btn"
                    onClick={() => setPromptExpanded((v) => !v)}
                  >
                    {promptExpanded ? "收起提示词" : "展开完整提示词"}
                  </button>
                )}
              </div>

              <dl className="flow-showcase__meta">
                <dt>模型</dt>
                <dd>{metadataModel.label}</dd>
                <dt>画幅</dt>
                <dd>{aspectLabel}</dd>
                <dt>清晰度</dt>
                <dd>{currentResRaw.toUpperCase()}</dd>
                <dt>生成时间</dt>
                <dd>{relativeTimeLabel}</dd>
              </dl>

              <div className="flow-showcase__side-actions">
                <button
                  type="button"
                  className="flow-showcase__side-btn"
                  onClick={onEditPrompt}
                  disabled={llmBusy}
                >
                  修改参数
                </button>
                <button
                  type="button"
                  className="flow-showcase__side-btn flow-showcase__side-btn--primary"
                  onClick={onRegenerate}
                  disabled={llmBusy}
                >
                  重新生成
                </button>
              </div>
            </div>

            {historyList.length >= 2 && (
              <div className="flow-showcase__side-card">
                <div className="flow-showcase__side-head">
                  <span className="flow-showcase__side-label">
                    历史生成版本 ({historyList.length})
                  </span>
                </div>
                <div className="flow-showcase__history-list">
                  {historyList.map((entry, hIdx) => {
                    const isCurrent = entry.mediaId === data.mediaId;
                    return (
                      <button
                        key={`${hIdx}:${entry.mediaId}`}
                        type="button"
                        className={`flow-showcase__history-item${isCurrent ? " flow-showcase__history-item--active" : ""}`}
                        onClick={() => {
                          switchNodeHistoryVersion(rfId, hIdx);
                          setActiveIdx(0);
                        }}
                      >
                        <video
                          className="flow-showcase__history-thumb"
                          src={mediaUrl(entry.mediaId)}
                          muted
                          playsInline
                          preload="metadata"
                        />
                        <div className="flow-showcase__history-info">
                          <strong>第 {hIdx + 1} 版{isCurrent ? " · 当前" : ""}</strong>
                          <span>{(entry.prompt ?? "").slice(0, 46) || "视频版本"}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Bottom Interactive Filmstrip Timeline — Matching Screenshot 2 */}
      <footer className="flow-showcase__timeline">
        <div className="flow-showcase__timeline-main">
          <div className="flow-showcase__ruler" aria-hidden="true">
            {Array.from({ length: rulerSeconds }, (_, idx) => (
              <span key={idx} className="flow-showcase__ruler-tick">
                {String(idx + 1).padStart(2, "0")}
              </span>
            ))}
          </div>
          <div
            ref={trackRef}
            className="flow-showcase__filmstrip"
            role="slider"
            aria-label="视频帧时间轴"
            aria-valuemin={0}
            aria-valuemax={Math.round(effectiveDuration)}
            aria-valuenow={Math.round(currentTime)}
            tabIndex={0}
            onPointerDown={(e) => {
              setScrubbing(true);
              scrubToClientX(e.clientX);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                stepFrame(-6);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                stepFrame(6);
              }
            }}
          >
            {filmstripFrames.length > 0 ? (
              filmstripFrames.map((frameUrl, idx) => (
                <img
                  key={idx}
                  src={frameUrl}
                  alt=""
                  className="flow-showcase__frame-cell"
                  draggable={false}
                />
              ))
            ) : (
              <div className="flow-showcase__filmstrip-loading">
                {currentMediaId ? "正在提取胶片帧缩略图…" : "暂无时间轴帧"}
              </div>
            )}
            <div
              className="flow-showcase__playhead"
              style={{ left: `${playheadPct}%` }}
              aria-hidden="true"
            />
          </div>
        </div>

        <button
          type="button"
          className="flow-showcase__extend-btn"
          onClick={() => void handleExtendNextClip()}
          disabled={extending || !currentMediaId}
          title="基于当前视频续拍下一镜（在画布右侧自动创建并连线新视频节点）"
          aria-label="延伸续拍下一镜"
        >
          {extending ? "…" : "+"}
        </button>
      </footer>
    </div>
  );
}
