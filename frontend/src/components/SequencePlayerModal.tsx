import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mediaUrl } from "../api/client";
import { displayBoardName, displayNodeTitle } from "../constants/nodeLabels";
import {
  exportTimelineSequenceVideo,
  type TimelineExportProgress,
} from "../lib/timelineExporter";
import { useBoardStore } from "../store/board";
import {
  resolveOrderedTimelineShots,
  useTimelineAudioStore,
} from "../store/timelineAudio";

interface SequenceShot {
  key: string;
  rfId: string;
  shortId: string;
  title: string;
  kind: "image" | "video";
  mediaId: string;
  variantLabel: string | null;
}

interface SequencePlayerModalProps {
  open: boolean;
  onClose(): void;
}

/**
 * 即梦风格「时间线 / 成片剪辑合成工作舱」居中毛玻璃播放器：
 * - 按画布横坐标串联已生成的图片与视频镜头，支持勾选删减、◀ / ▶ 重排镜序、图片停留时长调节
 * - 支持挂载本地 BGM / 旁白音轨并同步试听混音
 * - 支持纯浏览器原生 Canvas + WebAudio + MediaRecorder 一键合成导出完整视频成片（无需本机 ffmpeg）
 */
export function SequencePlayerModal({ open, onClose }: SequencePlayerModalProps) {
  const nodes = useBoardStore((s) => s.nodes);
  const boardName = useBoardStore((s) => s.boardName);
  const bgmName = useTimelineAudioStore((s) => s.bgmName);
  const bgmUrl = useTimelineAudioStore((s) => s.bgmUrl);
  const bgmMediaId = useTimelineAudioStore((s) => s.bgmMediaId);
  const bgmVolume = useTimelineAudioStore((s) => s.bgmVolume);
  const bgmFadeOutSec = useTimelineAudioStore((s) => s.bgmFadeOutSec);
  const videoAudioMuted = useTimelineAudioStore((s) => s.videoAudioMuted);
  const shotOverrides = useTimelineAudioStore((s) => s.shotOverrides);
  const customOrderKeys = useTimelineAudioStore((s) => s.customOrderKeys);
  const setBgmMediaAsset = useTimelineAudioStore((s) => s.setBgmMediaAsset);
  const toggleShotExcluded = useTimelineAudioStore((s) => s.toggleShotExcluded);
  const setShotImageDuration = useTimelineAudioStore((s) => s.setShotImageDuration);
  const moveShotKey = useTimelineAudioStore((s) => s.moveShotKey);
  const resetTimelineOverrides = useTimelineAudioStore((s) => s.resetTimelineOverrides);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<TimelineExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const canvasAudioOptions = useMemo(() => {
    const out: Array<{ mediaId: string; label: string }> = [];
    for (const node of nodes) {
      if (node.data.type !== "audio") continue;
      const baseTitle = node.data.musicTitle || displayNodeTitle(node.data.title, "audio");
      const mid = node.data.mediaId || node.data.mediaIds?.find(Boolean);
      if (mid) {
        out.push({ mediaId: mid, label: `${baseTitle} (#${node.data.shortId})` });
      }
      if (node.data.musicStems && typeof node.data.musicStems === "object") {
        for (const [stemKey, stemMid] of Object.entries(node.data.musicStems)) {
          if (typeof stemMid === "string" && stemMid) {
            out.push({ mediaId: stemMid, label: `${baseTitle} · ${stemKey}` });
          }
        }
      }
    }
    return out;
  }, [nodes]);

  const rawShots = useMemo<SequenceShot[]>(() => {
    const ordered = [...nodes].sort((a, b) => {
      if (a.position.x !== b.position.x) return a.position.x - b.position.x;
      return a.position.y - b.position.y;
    });
    const list: SequenceShot[] = [];
    for (const node of ordered) {
      if (
        node.data.type === "prompt" ||
        node.data.type === "note" ||
        node.data.type === "audio"
      ) {
        continue;
      }
      const fromArray = (node.data.mediaIds ?? []).filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      );
      const mediaList =
        fromArray.length > 0
          ? fromArray
          : typeof node.data.mediaId === "string" && node.data.mediaId
            ? [node.data.mediaId]
            : [];
      if (mediaList.length === 0) continue;

      const title = displayNodeTitle(node.data.title, node.data.type);
      const kind: "image" | "video" = node.data.type === "video" ? "video" : "image";
      mediaList.forEach((mediaId, i) => {
        list.push({
          key: `${node.id}-${i}-${mediaId}`,
          rfId: node.id,
          shortId: node.data.shortId,
          title,
          kind,
          mediaId,
          variantLabel: mediaList.length > 1 ? `v${i + 1}` : null,
        });
      });
    }
    return list;
  }, [nodes]);

  const orderedEntries = useMemo(
    () => resolveOrderedTimelineShots(rawShots, customOrderKeys, shotOverrides, 3),
    [rawShots, customOrderKeys, shotOverrides],
  );

  const enabledEntries = useMemo(
    () => orderedEntries.filter((e) => !e.excluded),
    [orderedEntries],
  );

  const orderedKeys = useMemo(
    () => orderedEntries.map((e) => e.shot.key),
    [orderedEntries],
  );

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }
    setIndex(0);
    setPlaying(true);
    setExportError(null);
  }, [open]);

  useEffect(() => {
    if (index >= enabledEntries.length && enabledEntries.length > 0) {
      setIndex(0);
    }
  }, [index, enabledEntries.length]);

  const currentEntry = enabledEntries[index] ?? null;
  const current = currentEntry?.shot ?? null;

  const goPrev = useCallback(() => {
    if (enabledEntries.length === 0) return;
    setIndex((i) => (i - 1 + enabledEntries.length) % enabledEntries.length);
  }, [enabledEntries.length]);

  const goNext = useCallback(() => {
    if (enabledEntries.length === 0) return;
    setIndex((i) => (i + 1) % enabledEntries.length);
  }, [enabledEntries.length]);

  // 预览全局配乐轨与连播状态联动
  useEffect(() => {
    const el = bgmAudioRef.current;
    if (!el) return;
    el.volume = bgmVolume;
    if (open && playing && !exporting && bgmUrl && enabledEntries.length > 0) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [open, playing, exporting, bgmUrl, bgmVolume, enabledEntries.length]);

  // 图片镜头开启连播时按该镜头设定秒数自动切下一镜
  useEffect(() => {
    if (
      !open ||
      !playing ||
      exporting ||
      !currentEntry ||
      currentEntry.shot.kind !== "image" ||
      enabledEntries.length <= 1
    ) {
      return;
    }
    const timer = window.setTimeout(goNext, Math.max(1000, currentEntry.imageDurationSec * 1000));
    return () => window.clearTimeout(timer);
  }, [open, playing, exporting, currentEntry, enabledEntries.length, goNext]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (exporting) {
          abortRef.current?.abort();
        } else {
          onClose();
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === " " && enabledEntries.length > 0 && !exporting) {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, exporting, onClose, goPrev, goNext, enabledEntries.length]);

  async function handleExportMasterVideo() {
    if (exporting || enabledEntries.length === 0) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPlaying(false);
    setExporting(true);
    setExportError(null);
    setExportProgress({
      shotIndex: 0,
      totalShots: enabledEntries.length,
      percent: 0,
      label: "正在准备合成时间线成片…",
    });

    try {
      const result = await exportTimelineSequenceVideo({
        shots: enabledEntries.map((entry) => ({
          key: entry.shot.key,
          title: entry.shot.title,
          kind: entry.shot.kind,
          mediaUrl: mediaUrl(entry.shot.mediaId),
          imageDurationSec: entry.imageDurationSec,
        })),
        bgmUrl,
        bgmVolume,
        bgmFadeOutSec,
        videoAudioMuted,
        signal: ctrl.signal,
        onProgress: (p) => setExportProgress(p),
      });

      const safeBoard = displayBoardName(boardName).replace(/[\\/:*?"<>|\s]+/g, "_") || "成片";
      const dlUrl = URL.createObjectURL(result.blob);
      const a = document.createElement("a");
      a.href = dlUrl;
      a.download = `AI-Canvas-Studio-成片-${safeBoard}.${result.ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(dlUrl), 3000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "时间线合成导出失败";
      if (!msg.includes("已取消")) {
        setExportError(msg);
      }
    } finally {
      abortRef.current = null;
      setExporting(false);
    }
  }

  function handleOpenBgmSettings() {
    onClose();
    window.dispatchEvent(
      new CustomEvent("flowboard:open-audio-director", { detail: { tab: "bgm" } }),
    );
  }

  const hasCustomOverrides =
    customOrderKeys.length > 0 || Object.keys(shotOverrides).length > 0;

  if (!open) return null;

  return (
    <div
      className="jm-seq-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !exporting) onClose();
      }}
    >
      <div className="jm-seq-modal" role="dialog" aria-modal="true" aria-label="时间线成片剪辑与合成">
        {bgmUrl && <audio ref={bgmAudioRef} src={bgmUrl} loop style={{ display: "none" }} />}

        <div className="jm-seq-modal__header">
          <div className="jm-seq-modal__heading">
            <span className="jm-seq-modal__title">时间线 · 成片剪辑与导出</span>
            {current && (
              <span className="jm-seq-modal__meta">
                第 {index + 1} / {enabledEntries.length} 启用镜 · {current.title} #{current.shortId}
                {current.variantLabel ? ` · ${current.variantLabel}` : ""}
              </span>
            )}
          </div>

          <div className="jm-seq-header-actions">
            {canvasAudioOptions.length > 0 && (
              <select
                className="jm-seq-bgm-select"
                aria-label="快捷切换画布配乐轨"
                disabled={exporting}
                value={bgmMediaId ?? ""}
                onChange={(e) => {
                  const chosenId = e.target.value;
                  if (!chosenId) {
                    setBgmMediaAsset(null);
                    return;
                  }
                  const hit = canvasAudioOptions.find((o) => o.mediaId === chosenId);
                  if (hit) {
                    setBgmMediaAsset({
                      mediaId: hit.mediaId,
                      name: hit.label,
                      url: mediaUrl(hit.mediaId),
                    });
                  }
                }}
              >
                <option value="">{bgmName && !bgmMediaId ? `自定义：${bgmName.slice(0, 12)}` : "无全局配乐"}</option>
                {canvasAudioOptions.map((opt) => (
                  <option key={opt.mediaId} value={opt.mediaId}>
                    🎵 {opt.label}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="jm-seq-ctrl-btn"
              disabled={exporting}
              onClick={handleOpenBgmSettings}
              title="挂载、AI 生成或调节全局配乐/旁白音轨"
            >
              🎵 {bgmName ? `配乐：${bgmName.slice(0, 14)}` : "配乐轨"}
            </button>
            {hasCustomOverrides && !exporting && (
              <button
                type="button"
                className="jm-seq-ctrl-btn"
                onClick={() => resetTimelineOverrides()}
                title="恢复画布从左至右默认镜序"
              >
                ↺ 重置镜序
              </button>
            )}
            {exporting ? (
              <button
                type="button"
                className="jm-seq-ctrl-btn jm-seq-ctrl-btn--danger"
                onClick={() => abortRef.current?.abort()}
              >
                ⏹ 取消合成
              </button>
            ) : (
              <button
                type="button"
                className="jm-seq-ctrl-btn jm-seq-ctrl-btn--cyan"
                disabled={enabledEntries.length === 0}
                onClick={() => void handleExportMasterVideo()}
                title="无需安装 ffmpeg，浏览器原生合成所有启用镜头并混音导出完整视频"
              >
                🎬 合成导出成片
              </button>
            )}
            <button
              type="button"
              className="jm-seq-modal__close"
              onClick={() => !exporting && onClose()}
              aria-label="关闭时间线序列预览"
            >
              ✕
            </button>
          </div>
        </div>

        {exportProgress && exporting && (
          <div className="jm-seq-export-bar" role="status" aria-live="polite">
            <div className="jm-seq-export-bar__meta">
              <span>{exportProgress.label}</span>
              <span>{exportProgress.percent}%</span>
            </div>
            <div className="jm-seq-export-bar__track">
              <div
                className="jm-seq-export-bar__fill"
                style={{ width: `${Math.max(4, exportProgress.percent)}%` }}
              />
            </div>
          </div>
        )}

        {exportError && (
          <div className="jm-seq-export-error" role="alert">
            {exportError}
          </div>
        )}

        {orderedEntries.length === 0 ? (
          <div className="jm-seq-empty">
            <p className="jm-seq-empty__title">当前画布暂无可串联预览的媒体镜头</p>
            <p className="jm-seq-empty__desc">
              请先在画布中上传或生成图片、角色主体、故事板或视频节点，系统将按画布从左至右的顺序自动串联播放与合成导出。
            </p>
            <button type="button" className="jm-seq-empty__btn" onClick={onClose}>
              返回画布
            </button>
          </div>
        ) : (
          <>
            <div className="jm-seq-stage">
              {current ? (
                current.kind === "video" ? (
                  <video
                    key={current.key}
                    className="jm-seq-stage__media"
                    src={mediaUrl(current.mediaId)}
                    controls
                    muted={videoAudioMuted}
                    autoPlay={playing}
                    playsInline
                    onEnded={() => {
                      if (playing && enabledEntries.length > 1) goNext();
                    }}
                  />
                ) : (
                  <img
                    key={current.key}
                    className="jm-seq-stage__media"
                    src={mediaUrl(current.mediaId)}
                    alt={`${current.title} #${current.shortId}`}
                  />
                )
              ) : (
                <div className="jm-seq-empty__desc">
                  所有镜头均已取消勾选，请在下方胶片轨中至少勾选 1 个镜头。
                </div>
              )}
            </div>

            <div className="jm-seq-controls">
              <button
                type="button"
                className="jm-seq-ctrl-btn"
                onClick={goPrev}
                disabled={enabledEntries.length <= 1 || exporting}
              >
                ← 上一镜
              </button>
              <button
                type="button"
                className="jm-seq-ctrl-btn jm-seq-ctrl-btn--primary"
                disabled={enabledEntries.length === 0 || exporting}
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? "暂停连播" : "自动连播"}
              </button>
              <button
                type="button"
                className="jm-seq-ctrl-btn"
                onClick={goNext}
                disabled={enabledEntries.length <= 1 || exporting}
              >
                下一镜 →
              </button>

              {currentEntry && currentEntry.shot.kind === "image" && (
                <div className="jm-seq-duration-group" aria-label="图片定格时长">
                  <span>定格</span>
                  {[2, 3, 5, 8].map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      className={`jm-seq-dur-btn${currentEntry.imageDurationSec === sec ? " jm-seq-dur-btn--active" : ""}`}
                      disabled={exporting}
                      onClick={() => setShotImageDuration(currentEntry.shot.key, sec)}
                    >
                      {sec}s
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="jm-seq-strip" role="listbox" aria-label="分镜胶片序列">
              {orderedEntries.map((entry, i) => {
                const { shot, excluded, imageDurationSec } = entry;
                const enabledIdx = enabledEntries.findIndex((e) => e.shot.key === shot.key);
                const active = !excluded && enabledIdx === index;
                return (
                  <div
                    key={shot.key}
                    className={`jm-seq-thumb-card${excluded ? " jm-seq-thumb-card--excluded" : ""}`}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`jm-seq-thumb${active ? " jm-seq-thumb--active" : ""}`}
                      onClick={() => {
                        if (excluded) {
                          toggleShotExcluded(shot.key);
                        } else if (enabledIdx >= 0) {
                          setIndex(enabledIdx);
                        }
                      }}
                      title={`${i + 1}. ${shot.title} #${shot.shortId}`}
                    >
                      {shot.kind === "video" ? (
                        <video
                          src={mediaUrl(shot.mediaId)}
                          preload="metadata"
                          muted
                          playsInline
                        />
                      ) : (
                        <img src={mediaUrl(shot.mediaId)} alt={shot.title} loading="lazy" />
                      )}
                      <span className="jm-seq-thumb__idx">
                        {shot.kind === "video" ? "▶ " : ""}
                        {i + 1}
                      </span>
                      {shot.kind === "image" && (
                        <span className="jm-seq-thumb__dur">{imageDurationSec}s</span>
                      )}
                    </button>

                    <div className="jm-seq-thumb-actions">
                      <button
                        type="button"
                        className="jm-seq-thumb-mini"
                        disabled={i === 0 || exporting}
                        onClick={() => moveShotKey(orderedKeys, i, -1)}
                        aria-label="前移一镜"
                        title="前移"
                      >
                        ◀
                      </button>
                      <button
                        type="button"
                        className={`jm-seq-thumb-mini${!excluded ? " jm-seq-thumb-mini--checked" : ""}`}
                        disabled={exporting}
                        onClick={() => toggleShotExcluded(shot.key)}
                        aria-label={excluded ? "恢复纳入成片" : "从成片中跳过此镜"}
                        title={excluded ? "点击恢复纳入" : "点击跳过此镜"}
                      >
                        {excluded ? "○" : "✓"}
                      </button>
                      <button
                        type="button"
                        className="jm-seq-thumb-mini"
                        disabled={i === orderedEntries.length - 1 || exporting}
                        onClick={() => moveShotKey(orderedKeys, i, 1)}
                        aria-label="后移一镜"
                        title="后移"
                      >
                        ▶
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
