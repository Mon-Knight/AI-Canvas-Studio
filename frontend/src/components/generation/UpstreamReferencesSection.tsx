import type { Dispatch, SetStateAction } from "react";
import { mediaUrl } from "../../api/client";
import { displayNodeTitle } from "../../constants/nodeLabels";
import type { FlowNode } from "../../store/board";
import type { UpstreamRefEntry, VideoSubMode } from "../../store/generation";
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
  videoSubMode: VideoSubMode;
  onSelectVideoSubMode: (mode: VideoSubMode) => void;
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
  onSelectVideoSubMode,
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
  const effectiveVideoMode: "t2v" | "ingredients" | "first_frame" | "first_last" =
    videoCandidateFrames.length === 0 || videoSubMode === "t2v"
      ? "t2v"
      : videoSubMode === "first_last" && videoCandidateFrames.length >= 2
        ? "first_last"
        : videoSubMode === "ingredients"
          ? "ingredients"
          : videoSubMode === "first_frame"
            ? "first_frame"
            : isOmniVideo
              ? "ingredients"
              : "first_frame";

  const hasAnyFrame = videoCandidateFrames.length >= 1;
  const hasTwoFrames = videoCandidateFrames.length >= 2;

  return (
    <>
      {isVideo && (
        <div className="gen-dialog__field">
          <div className="gen-dialog__label-row">
            <span className="gen-dialog__label">视频生成模式（首帧锁定为可选项）</span>
            <div className="aspect-chip-row">
              <button
                type="button"
                className={`aspect-chip${effectiveVideoMode === "t2v" ? " aspect-chip--active" : ""}`}
                onClick={() => onSelectVideoSubMode("t2v")}
                title="纯文生视频（YhhmEf）：不锁定首帧，完全按文本自由生成开场构图与运镜"
              >
                ✦ 纯文生视频
              </button>
              <button
                type="button"
                className={`aspect-chip${effectiveVideoMode === "ingredients" ? " aspect-chip--active" : ""}`}
                disabled={!hasAnyFrame}
                onClick={() => onSelectVideoSubMode("ingredients")}
                title={
                  hasAnyFrame
                    ? "参考元素生视频（Flow Ingredients / Omni）：将连线图片作为角色/服饰/场景成分参考，不强制首帧像素一致，运镜更自由"
                    : "连线至少 1 张参考图后可用"
                }
              >
                ❖ 参考元素（不锁首帧）
              </button>
              <button
                type="button"
                className={`aspect-chip${effectiveVideoMode === "first_frame" ? " aspect-chip--active" : ""}`}
                disabled={!hasAnyFrame}
                onClick={() => onSelectVideoSubMode("first_frame")}
                title={
                  hasAnyFrame
                    ? "首帧一致图生视频（Veo 3.1 i2v · 可选）：以选定参考图作为视频第 0 帧严格起拍"
                    : "连线至少 1 张参考图后可用"
                }
              >
                ▣ 首帧一致（可选）
              </button>
              {hasTwoFrames && (
                <button
                  type="button"
                  className={`aspect-chip${effectiveVideoMode === "first_last" ? " aspect-chip--active" : ""}`}
                  onClick={() => onSelectVideoSubMode("first_last")}
                  title="首尾帧锁定（nprQif）：精准控制视频起始帧与结束帧画面过渡"
                >
                  ⇄ 首尾帧锁定
                </button>
              )}
            </div>
          </div>

          <p className="gen-dialog__hint">
            {effectiveVideoMode === "t2v" &&
              (hasAnyFrame
                ? "当前已忽略上游参考图作为首帧，将调用 Flow 纯文生视频（YhhmEf）自由演绎开场构图。"
                : "当前未连线参考图，已自动采用 Flow 纯文生视频（YhhmEf）。连线图片后可按需启用「参考元素」或「首帧一致」。")}
            {effectiveVideoMode === "ingredients" &&
              "官方参考元素模式（Omni Flash）：上游图片仅作为主体外貌/服装/场景参考（可用 @图1 引用），不再强制第 0 帧与原图像素锁死，适合自由运镜与全新构图。"}
            {effectiveVideoMode === "first_frame" &&
              "已显式启用「首帧一致」：视频第 0 帧将从下方勾选的图片无缝起拍；若希望角色保留特征但自由换构图，可随时切回「参考元素（不锁首帧）」。"}
            {effectiveVideoMode === "first_last" &&
              "已启用「首尾帧锁定」：视频将从选定首帧平滑过渡至指定尾帧。"}
          </p>

          {effectiveVideoMode === "first_last" && (
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
        effectiveVideoMode === "first_frame" &&
        !isVideoFirstLastMode &&
        !isVideoTextMode && (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <span className="gen-dialog__label">
                {sourceNode?.data.type === "video"
                  ? "首帧来源（上游视频抽帧）"
                  : "已启用首帧锁定 · 选择起始帧"}
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
                      请至少勾选 1 张起始首帧，或切换到上方「纯文生视频 / 参考元素」模式。
                    </span>
                  ) : (
                    <>
                      将以选定画面作为首帧生成 <strong>{selectedSourceIdx.size} 条视频</strong>
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
                  ? "当前未连线参考图 —— 已采用 Flow 原生纯文生视频（YhhmEf）"
                  : "请先勾选至少一个用于首帧生成的源参考"}
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
