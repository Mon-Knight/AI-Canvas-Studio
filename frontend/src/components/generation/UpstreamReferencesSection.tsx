import type { Dispatch, SetStateAction } from "react";
import { mediaUrl } from "../../api/client";
import { displayNodeTitle } from "../../constants/nodeLabels";
import type { FlowNode } from "../../store/board";
import type { UpstreamRefEntry } from "../../store/generation";
import type { VideoRefFrameMode } from "../../lib/videoFrame";

interface PromptSourceNodeItem {
  edgeId: string;
  node: FlowNode;
  text: string;
}

interface VideoCandidateFrame {
  mediaId: string;
  label: string;
}

interface UpstreamReferencesSectionProps {
  isVideo: boolean;
  isOmniVideo: boolean;
  isVideoFirstLastMode: boolean;
  isVideoTextMode: boolean;
  videoSubMode: "auto" | "first_last" | "t2v";
  setVideoSubMode: (mode: "auto" | "first_last" | "t2v") => void;
  videoCandidateFrames: VideoCandidateFrame[];
  firstFrameId: string;
  setFirstFrameId: (id: string) => void;
  lastFrameId: string;
  setLastFrameId: (id: string) => void;
  sourceNode: FlowNode | null;
  sourceMediaIds: string[];
  selectedSourceIdx: Set<number>;
  setSelectedSourceIdx: Dispatch<SetStateAction<Set<number>>>;
  refSourceNodes: UpstreamRefEntry[];
  promptSourceNodes: PromptSourceNodeItem[];
  openVariantPicker: string | null;
  setOpenVariantPicker: (edgeId: string | null) => void;
  pickVariantForEdge: (edgeId: string, idx: number) => Promise<void>;
  insertRefMentionTag: (index1Based: number) => void;
  hasVideoUpstream: boolean;
  videoRefFrame: VideoRefFrameMode;
  setVideoRefFrame: (mode: VideoRefFrameMode) => void;
}

export function UpstreamReferencesSection({
  isVideo,
  isOmniVideo,
  isVideoFirstLastMode,
  isVideoTextMode,
  videoSubMode,
  setVideoSubMode,
  videoCandidateFrames,
  firstFrameId,
  setFirstFrameId,
  lastFrameId,
  setLastFrameId,
  sourceNode,
  sourceMediaIds,
  selectedSourceIdx,
  setSelectedSourceIdx,
  refSourceNodes,
  promptSourceNodes,
  openVariantPicker,
  setOpenVariantPicker,
  pickVariantForEdge,
  insertRefMentionTag,
  hasVideoUpstream,
  videoRefFrame,
  setVideoRefFrame,
}: UpstreamReferencesSectionProps) {
  return (
    <>
      {isVideo && videoCandidateFrames.length >= 2 && (
        <div className="gen-dialog__field">
          <div className="gen-dialog__label-row">
            <span className="gen-dialog__label">视频驱动方式</span>
            <div className="aspect-chip-row">
              <button
                type="button"
                className={`aspect-chip${videoSubMode === "auto" ? " aspect-chip--active" : ""}`}
                onClick={() => setVideoSubMode("auto")}
              >
                {isOmniVideo ? "多图参考驱动" : "首帧/变体生视频"}
              </button>
              <button
                type="button"
                className={`aspect-chip${videoSubMode === "first_last" ? " aspect-chip--active" : ""}`}
                onClick={() => setVideoSubMode("first_last")}
                title="调用 Flow 原生首尾帧锁定接口（nprQif），精准控制视频起始与结束画面"
              >
                ⇄ 首尾帧锁定
              </button>
              <button
                type="button"
                className={`aspect-chip${videoSubMode === "t2v" ? " aspect-chip--active" : ""}`}
                onClick={() => setVideoSubMode("t2v")}
                title="忽略参考图，调用 Flow 纯文生视频（YhhmEf）"
              >
                纯文生视频
              </button>
            </div>
          </div>
          {videoSubMode === "first_last" && (
            <div className="gen-dialog__first-last-row">
              <div className="gen-dialog__first-last-slot">
                <span className="gen-dialog__first-last-tag">首帧（Start）</span>
                <select
                  aria-label="选择首帧参考图"
                  value={firstFrameId}
                  onChange={(e) => setFirstFrameId(e.target.value)}
                >
                  {videoCandidateFrames.map((c) => (
                    <option key={`start-${c.mediaId}`} value={c.mediaId}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="source-select-mini"
                onClick={() => {
                  const prevStart = firstFrameId;
                  setFirstFrameId(lastFrameId);
                  setLastFrameId(prevStart);
                }}
                title="互换首帧与尾帧"
              >
                ⇄ 互换
              </button>
              <div className="gen-dialog__first-last-slot">
                <span className="gen-dialog__first-last-tag">尾帧（End）</span>
                <select
                  aria-label="选择尾帧参考图"
                  value={lastFrameId}
                  onChange={(e) => setLastFrameId(e.target.value)}
                >
                  {videoCandidateFrames.map((c) => (
                    <option key={`end-${c.mediaId}`} value={c.mediaId}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      {isVideo &&
        !isOmniVideo &&
        !isVideoFirstLastMode &&
        !isVideoTextMode && (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <span className="gen-dialog__label">
                {sourceNode?.data.type === "video"
                  ? "源视频参考"
                  : "源图像变体"}
                {sourceMediaIds.length > 1 ? ` (${sourceMediaIds.length})` : ""}
              </span>
              {sourceMediaIds.length > 1 && (
                <div className="source-select-actions">
                  <button
                    type="button"
                    className="source-select-mini"
                    onClick={() =>
                      setSelectedSourceIdx(
                        new Set(sourceMediaIds.map((_, i) => i)),
                      )
                    }
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    className="source-select-mini"
                    onClick={() => setSelectedSourceIdx(new Set())}
                  >
                    清空
                  </button>
                </div>
              )}
            </div>
            {sourceMediaIds.length > 0 && sourceNode ? (
              <>
                <div className="source-image-row">
                  {sourceMediaIds.map((mid, i) => {
                    const checked = selectedSourceIdx.has(i);
                    const isVideoSrc = sourceNode.data.type === "video";
                    return (
                      <button
                        key={mid}
                        type="button"
                        className={`source-thumb${checked ? " source-thumb--checked" : ""}`}
                        onClick={() => {
                          setSelectedSourceIdx((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          });
                        }}
                        aria-pressed={checked}
                        aria-label={`变体 ${i + 1}${checked ? " 已选中" : ""}`}
                      >
                        {isVideoSrc ? (
                          <video
                            className="source-image-row__thumb"
                            src={mediaUrl(mid)}
                            muted
                            playsInline
                            preload="metadata"
                          />
                        ) : (
                          <img
                            className="source-image-row__thumb"
                            src={mediaUrl(mid)}
                            alt={sourceNode.data.title}
                          />
                        )}
                        <span
                          className="source-thumb__check"
                          aria-hidden="true"
                        >
                          {checked ? "✓" : ""}
                        </span>
                      </button>
                    );
                  })}
                  <span className="source-image-row__label">
                    #{sourceNode.data.shortId}
                  </span>
                </div>
                <p className="gen-dialog__hint">
                  {selectedSourceIdx.size === 0 ? (
                    <span style={{ color: "#f87171" }}>
                      请至少勾选 1 个源参考以生成视频。
                    </span>
                  ) : (
                    <>
                      将批量生成 <strong>{selectedSourceIdx.size} 条视频</strong>
                      {selectedSourceIdx.size === sourceMediaIds.length
                        ? "（全部变体）"
                        : `（已选 ${selectedSourceIdx.size}/${sourceMediaIds.length} 个变体）`}
                      {sourceNode.data.type === "video"
                        ? "，提交时自动截取参考视频帧作为起始参考。"
                        : "，共享当前提示词与镜头设置。"}
                    </>
                  )}
                </p>
              </>
            ) : (
              <div className="source-image-row source-image-row--empty">
                {videoCandidateFrames.length === 0
                  ? "当前未连线参考图 —— 可直接输入视频提示词走 Flow 原生纯文生视频（YhhmEf）"
                  : "请先勾选至少一个用于生成的源参考"}
              </div>
            )}
          </div>
        )}

      {(refSourceNodes.length > 0 || promptSourceNodes.length > 0) && (
        <div className="gen-dialog__field">
          <span className="gen-dialog__label">
            已连线上游参考 ({refSourceNodes.length + promptSourceNodes.length})
          </span>
          <div className="ref-source-row">
            {promptSourceNodes.map((p) => {
              const preview = p.text.trim() || "空白文本";
              return (
                <div
                  key={p.edgeId}
                  className="ref-source-chip ref-source-chip--prompt"
                  title={`${displayNodeTitle(p.node.data.title, p.node.data.type) || "文本"} — ${preview}`}
                >
                  <div className="ref-source-chip__prompt-body">
                    <span
                      className="ref-source-chip__prompt-icon"
                      aria-hidden="true"
                    >
                      ✦
                    </span>
                    <span className="ref-source-chip__prompt-text">
                      {preview}
                    </span>
                  </div>
                  <span className="ref-source-chip__id">
                    #{p.node.data.shortId}
                  </span>
                </div>
              );
            })}
            {refSourceNodes.map((r, rIdx) => {
              const refTitle = displayNodeTitle(
                r.node.data.title,
                r.node.data.type,
              );
              const isMulti = r.allVariants.length >= 2;
              const isPickerOpen = openVariantPicker === r.edgeId;
              const isVideoChip = r.node.data.type === "video";
              const tooltip = isMulti
                ? `${refTitle} — 变体 ${(r.variantIdx ?? 0) + 1} · 点击切换`
                : refTitle;
              return (
                <div key={r.edgeId} className="ref-source-chip-wrap">
                  <button
                    type="button"
                    className="ref-source-chip__at-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      insertRefMentionTag(rIdx + 1);
                    }}
                    title={`点击在提示词中插入 @图${rIdx + 1} 引用此参考素材`}
                  >
                    @图{rIdx + 1}
                  </button>
                  {isMulti ? (
                    <button
                      type="button"
                      className={`ref-source-chip ref-source-chip--switchable${
                        isPickerOpen ? " ref-source-chip--active" : ""
                      }`}
                      title={tooltip}
                      onClick={() =>
                        setOpenVariantPicker(isPickerOpen ? null : r.edgeId)
                      }
                    >
                      {isVideoChip ? (
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
                      <span className="ref-source-chip__variant">
                        v{(r.variantIdx ?? 0) + 1}
                      </span>
                      <span className="ref-source-chip__id">
                        #{r.node.data.shortId}
                      </span>
                    </button>
                  ) : (
                    <div className="ref-source-chip" title={tooltip}>
                      {isVideoChip ? (
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
                      <span className="ref-source-chip__id">
                        #{r.node.data.shortId}
                      </span>
                    </div>
                  )}
                  {isMulti && isPickerOpen && (
                    <div
                      className="ref-source-chip__picker"
                      role="dialog"
                      aria-label={`为 ${refTitle} 选择变体`}
                    >
                      {r.allVariants.map((mid, i) => {
                        if (!mid) return null;
                        const isCurrent = i === (r.variantIdx ?? 0);
                        return (
                          <button
                            key={i}
                            type="button"
                            className={`ref-source-chip__picker-item${
                              isCurrent
                                ? " ref-source-chip__picker-item--current"
                                : ""
                            }`}
                            onClick={() =>
                              void pickVariantForEdge(r.edgeId, i)
                            }
                            title={`变体 ${i + 1}`}
                            aria-current={isCurrent ? "true" : undefined}
                          >
                            {isVideoChip ? (
                              <video
                                className="ref-source-chip__picker-img"
                                src={mediaUrl(mid)}
                                muted
                                playsInline
                                preload="metadata"
                              />
                            ) : (
                              <img
                                className="ref-source-chip__picker-img"
                                src={mediaUrl(mid)}
                                alt={`变体 ${i + 1}`}
                              />
                            )}
                            <span className="ref-source-chip__picker-label">
                              v{i + 1}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {hasVideoUpstream && (
        <div className="gen-dialog__field">
          <div className="gen-dialog__video-ref-row">
            <span className="gen-dialog__label">视频参考抽帧</span>
            <div className="aspect-chip-row">
              <button
                type="button"
                className={`aspect-chip${videoRefFrame === "last" ? " aspect-chip--active" : ""}`}
                onClick={() => setVideoRefFrame("last")}
                title="截取上游视频尾帧作为画面参考（适合镜头续接）"
              >
                尾帧续接（默认）
              </button>
              <button
                type="button"
                className={`aspect-chip${videoRefFrame === "first" ? " aspect-chip--active" : ""}`}
                onClick={() => setVideoRefFrame("first")}
                title="截取上游视频首帧作为画面参考（适合首帧定调/风格延展）"
              >
                首帧参考
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
