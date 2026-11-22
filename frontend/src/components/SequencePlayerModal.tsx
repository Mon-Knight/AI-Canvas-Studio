import { useCallback, useEffect, useMemo, useState } from "react";
import { mediaUrl } from "../api/client";
import { displayNodeTitle } from "../constants/nodeLabels";
import { useBoardStore } from "../store/board";

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
 * 即梦风格「时间线 / 全局序列预览」居中毛玻璃播放器：
 * 按画布横坐标从左到右串联所有已生成图片与视频镜头，支持自动连播、方向键切镜与缩略图跳帧。
 */
export function SequencePlayerModal({ open, onClose }: SequencePlayerModalProps) {
  const nodes = useBoardStore((s) => s.nodes);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);

  const shots = useMemo<SequenceShot[]>(() => {
    const ordered = [...nodes].sort((a, b) => {
      if (a.position.x !== b.position.x) return a.position.x - b.position.x;
      return a.position.y - b.position.y;
    });
    const list: SequenceShot[] = [];
    for (const node of ordered) {
      if (node.data.type === "prompt" || node.data.type === "note") continue;
      const fromArray = (node.data.mediaIds ?? []).filter(
        (m): m is string => typeof m === "string" && m.length > 0,
      );
      const mediaList = fromArray.length > 0
        ? fromArray
        : (typeof node.data.mediaId === "string" && node.data.mediaId ? [node.data.mediaId] : []);
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

  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setPlaying(true);
  }, [open]);

  useEffect(() => {
    if (index >= shots.length && shots.length > 0) {
      setIndex(0);
    }
  }, [index, shots.length]);

  const current = shots[index] ?? null;

  const goPrev = useCallback(() => {
    if (shots.length === 0) return;
    setIndex((i) => (i - 1 + shots.length) % shots.length);
  }, [shots.length]);

  const goNext = useCallback(() => {
    if (shots.length === 0) return;
    setIndex((i) => (i + 1) % shots.length);
  }, [shots.length]);

  // 图片镜头开启连播时每 3 秒自动切下一镜；视频镜头通过 <video onEnded> 触发切镜
  useEffect(() => {
    if (!open || !playing || !current || current.kind !== "image" || shots.length <= 1) return;
    const timer = window.setTimeout(goNext, 3000);
    return () => window.clearTimeout(timer);
  }, [open, playing, current, shots.length, goNext]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      } else if (e.key === " " && shots.length > 0) {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, goPrev, goNext, shots.length]);

  if (!open) return null;

  return (
    <div
      className="jm-seq-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="jm-seq-modal" role="dialog" aria-modal="true" aria-label="时间线序列预览">
        <div className="jm-seq-modal__header">
          <div className="jm-seq-modal__heading">
            <span className="jm-seq-modal__title">时间线序列预览</span>
            {current && (
              <span className="jm-seq-modal__meta">
                第 {index + 1} / {shots.length} 镜 · {current.title} #{current.shortId}
                {current.variantLabel ? ` · ${current.variantLabel}` : ""}
              </span>
            )}
          </div>
          <button
            type="button"
            className="jm-seq-modal__close"
            onClick={onClose}
            aria-label="关闭时间线序列预览"
          >
            ✕
          </button>
        </div>

        {shots.length === 0 || !current ? (
          <div className="jm-seq-empty">
            <p className="jm-seq-empty__title">当前画布暂无可串联预览的媒体镜头</p>
            <p className="jm-seq-empty__desc">
              请先在画布中上传或生成图片、角色主体、故事板或视频节点，系统将按画布从左至右的顺序自动串联播放。
            </p>
            <button type="button" className="jm-seq-empty__btn" onClick={onClose}>
              返回画布
            </button>
          </div>
        ) : (
          <>
            <div className="jm-seq-stage">
              {current.kind === "video" ? (
                <video
                  key={current.key}
                  className="jm-seq-stage__media"
                  src={mediaUrl(current.mediaId)}
                  controls
                  autoPlay={playing}
                  playsInline
                  onEnded={() => {
                    if (playing && shots.length > 1) goNext();
                  }}
                />
              ) : (
                <img
                  key={current.key}
                  className="jm-seq-stage__media"
                  src={mediaUrl(current.mediaId)}
                  alt={`${current.title} #${current.shortId}`}
                />
              )}
            </div>

            <div className="jm-seq-controls">
              <button
                type="button"
                className="jm-seq-ctrl-btn"
                onClick={goPrev}
                disabled={shots.length <= 1}
              >
                ← 上一镜
              </button>
              <button
                type="button"
                className="jm-seq-ctrl-btn jm-seq-ctrl-btn--primary"
                onClick={() => setPlaying((p) => !p)}
              >
                {playing ? "暂停连播" : "自动连播"}
              </button>
              <button
                type="button"
                className="jm-seq-ctrl-btn"
                onClick={goNext}
                disabled={shots.length <= 1}
              >
                下一镜 →
              </button>
            </div>

            <div className="jm-seq-strip" role="listbox" aria-label="分镜胶片序列">
              {shots.map((shot, i) => {
                const active = i === index;
                return (
                  <button
                    key={shot.key}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`jm-seq-thumb${active ? " jm-seq-thumb--active" : ""}`}
                    onClick={() => setIndex(i)}
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
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
