import { useEffect, useRef, useState } from "react";
import { Handle, NodeResizeControl, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { useBoardStore, type FlowboardNodeData, type FlowNode } from "../store/board";
import { displayNodeTitle } from "../constants/nodeLabels";
import { useGenerationStore } from "../store/generation";
import { mediaUrl, patchEdge, patchNode, uploadImage, uploadImageFromUrl } from "../api/client";
import { requestAutoBrief } from "../api/autoBrief";
import { useReferencesStore } from "../store/references";
import { pickImageFiles } from "../lib/filePicker";
import {
  normaliseStoryboardGrid,
  normaliseStoryboardMode,
  resolveStoryboardLayout,
} from "../lib/storyboardPrompt";
import { splitStoryboardToShotNodes } from "../lib/storyboardSplit";
import { switchNodeHistoryVersion } from "../lib/quickDerive";

import {
  IconImage, IconNote, IconStoryboard, IconSubject, IconText, IconVideo, IconVisualAsset,
} from "../components/JimengIcons";
import "./NodeCard.css";

const NODE_ICONS = {
  character: IconSubject,
  image: IconImage,
  video: IconVideo,
  prompt: IconText,
  note: IconNote,
  visual_asset: IconVisualAsset,
  Storyboard: IconStoryboard,
  merge: IconVisualAsset,
};

const STATUS_LABELS = {
  queued: "排队中",
  running: "生成中",
  done: "已完成",
  error: "失败",
} as const;

const ACCEPT_MIME = "image/png,image/jpeg,image/webp,image/gif";

function BriefHint({ data }: { data: FlowboardNodeData }) {
  if (data.autoPromptStatus === "pending") {
    return <p className="brief-hint brief-hint--pending">✨ 正在构思提示词…</p>;
  }
  if (data.aiBriefStatus === "pending") {
    return <p className="brief-hint brief-hint--pending">✨ 正在解析画面内容…</p>;
  }
  if (data.aiBrief) {
    return <p className="brief-hint" title={data.aiBrief}>✨ {data.aiBrief}</p>;
  }
  return null;
}

/**
 * True while the LLM layer is doing work on this node — composing an
 * auto-prompt or describing media for an aiBrief. Used to add a busy
 * treatment + disable Generate so the user can't double-fire.
 */
function isLLMBusy(data: FlowboardNodeData): boolean {
  return (
    data.autoPromptStatus === "pending"
    || data.aiBriefStatus === "pending"
  );
}

function pickSingleImage(
  title: string,
  onFile: (file: File) => void | Promise<void>,
  setError: (msg: string | null) => void,
) {
  void pickImageFiles({ multiple: false, accept: ACCEPT_MIME, title })
    .then((picked) => {
      const file = picked[0];
      if (file) void onFile(file);
    })
    .catch((err) => {
      setError(err instanceof Error ? err.message : "选择图片失败");
    });
}

function CharacterBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  return (
    <div className="node-body--subject-wrap">
      <ImageBody rfId={rfId} data={data} />
    </div>
  );
}

// ── Reference-library save helpers ────────────────────────────────────────
//
// Maps a FlowboardNodeData.type → the `kind` enum stored on a Reference
// row. Storyboard nodes are containers — each saved tile is one *shot*
// of the board, so we use the "storyboard_shot" kind there to leave
// room for shot-specific UX in the library later (e.g. surfacing the
// shot index, or grouping by parent storyboard).
type ReferenceKind = "image" | "character" | "visual_asset" | "storyboard_shot";

function referenceKindFor(nodeType: string): ReferenceKind {
  if (nodeType === "Storyboard") return "storyboard_shot";
  if (nodeType === "character") return "character";
  if (nodeType === "visual_asset") return "visual_asset";
  return "image";
}

/** Fire-and-forget save of a tile's media into the reference library.
 * Errors surface via useReferencesStore.error; UI doesn't need to
 * await for the save to succeed before letting the user keep working. */
function saveTileToLibrary(opts: {
  mediaId: string;
  nodeType: string;
  data: FlowboardNodeData;
}) {
  const { mediaId, nodeType, data } = opts;
  const label =
    typeof data.aiBrief === "string" && data.aiBrief.trim().length > 0
      ? data.aiBrief.slice(0, 80)
      : `#${data.shortId}`;
  void useReferencesStore.getState().save({
    media_id: mediaId,
    kind: referenceKindFor(nodeType),
    ai_brief: typeof data.aiBrief === "string" ? data.aiBrief : null,
    aspect_ratio: typeof data.aspectRatio === "string" ? data.aspectRatio : null,
    label,
    source_board_id: useBoardStore.getState().boardId ?? null,
    source_node_short_id:
      typeof data.shortId === "string" ? data.shortId : null,
  });
}

const MAX_IMG_RETRIES = 5;

function tileCountFor(data: FlowboardNodeData): number {
  const fromVariants = data.variantCount;
  const fromMedia = data.mediaIds?.length;
  const n = fromVariants && fromVariants > 0 ? fromVariants : fromMedia ?? 1;
  return Math.max(1, Math.min(n, 4));
}

function ImageTile({
  rfId,
  mediaId,
  isProcessing,
  alt,
  onClick,
  onUseAsRef,
  onSaveToLibrary,
}: {
  rfId: string;
  mediaId: string | undefined;
  isProcessing: boolean;
  alt: string;
  onClick?: () => void;
  /** When provided, render an overlay button on hover that pins this
   * variant to a downstream edge and triggers Generate on the target.
   * The parent only sets this when the node has multi-variant output
   * AND has a downstream image/video target — keeps the affordance
   * scoped to cases where it actually does something. */
  onUseAsRef?: () => void;
  /** When provided, render a "★" overlay (top-right corner, opposite
   * the "Use →" affordance) that snapshots this tile's media + aiBrief
   * into the cross-board reference library. Parents only pass this when
   * the tile has a real mediaId — saving a placeholder makes no sense. */
  onSaveToLibrary?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLoaded(false);
    setAttempt(0);
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [mediaId, rfId]);

  if (!mediaId) {
    return (
      <div
        className={`thumbnail-tile${isProcessing ? " thumbnail-tile--processing" : ""}`}
        aria-hidden="true"
      >
        <span className="thumbnail-tile__icon">▣</span>
      </div>
    );
  }

  const givenUp = attempt >= MAX_IMG_RETRIES;
  const src = attempt > 0 ? `${mediaUrl(mediaId)}?retry=${attempt}` : mediaUrl(mediaId);
  const cls =
    `thumbnail-tile thumbnail-tile--filled` +
    (onClick ? " thumbnail-tile--clickable" : "");

  return (
    <div
      className={cls}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `查看变体 ${alt}` : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {!loaded && (
        <div className="thumbnail-tile__placeholder" aria-hidden="true" />
      )}
      {!givenUp && (
        <img
          key={attempt}
          className="thumbnail-tile__img"
          src={src}
          alt={alt}
          style={loaded ? undefined : { display: "none" }}
          onLoad={() => setLoaded(true)}
          onError={() => {
            retryTimerRef.current = setTimeout(() => {
              setAttempt((a) => a + 1);
            }, 2000);
          }}
        />
      )}
      {onUseAsRef && (
        <button
          type="button"
          className="thumbnail-tile__use-btn nodrag"
          onClick={(e) => {
            e.stopPropagation();
            onUseAsRef();
          }}
          title="将此变体指定为下游节点的参考源并生成"
          aria-label="指定此变体为下游参考"
        >
          引用 →
        </button>
      )}
      {onSaveToLibrary && (
        <button
          type="button"
          className="thumbnail-tile__save-btn nodrag"
          onClick={(e) => {
            e.stopPropagation();
            onSaveToLibrary();
          }}
          title="收藏至资产库"
          aria-label="收藏至资产库"
        >
          ★
        </button>
      )}
    </div>
  );
}

// ── Variant-click → bind upstream variant to a downstream edge ───────────
//
// Workflow: user clicks "Use →" on a specific variant tile of an
// upstream multi-variant node. We find the downstream image/video
// targets connected to it, pin the chosen variant index on the right
// edge (PATCH /api/edges/{id}), refresh the local edge.data so the
// `v{N+1}` chip surfaces immediately, and then dispatch Generate on
// the target. One click → one pinned ref → one Flow API call.
//
// Multi-target case: when the upstream has 2+ outgoing edges to gen
// targets, we surface a small picker so the user disambiguates which
// downstream this variant should feed.

interface VariantTarget {
  edgeId: string;
  targetRfId: string;
  title: string;
  kind: "image" | "video";
  hasPrompt: boolean;
}

interface VariantPickerState {
  variantIdx: number;
  targets: VariantTarget[];
}

function collectGenTargets(srcRfId: string): VariantTarget[] {
  const { nodes, edges } = useBoardStore.getState();
  const out: VariantTarget[] = [];
  for (const e of edges) {
    if (e.source !== srcRfId) continue;
    const t = nodes.find((n) => n.id === e.target);
    if (!t) continue;
    if (t.data.type !== "image" && t.data.type !== "video") continue;
    out.push({
      edgeId: e.id,
      targetRfId: t.id,
      title: t.data.title || `#${t.data.shortId}`,
      kind: t.data.type as "image" | "video",
      hasPrompt: typeof t.data.prompt === "string" && t.data.prompt.trim().length > 0,
    });
  }
  return out;
}

async function applyVariantToTarget(variantIdx: number, target: VariantTarget) {
  const edgeDbId = parseInt(target.edgeId, 10);
  if (!isNaN(edgeDbId)) {
    try {
      const updated = await patchEdge(edgeDbId, {
        source_variant_idx: variantIdx,
      });
      useBoardStore.getState().updateEdgeData(target.edgeId, {
        sourceVariantIdx: updated.source_variant_idx,
      });
    } catch (err) {
      useGenerationStore.setState({
        error: `绑定参考变体失败：${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  }
  // If the target doesn't have a prompt yet, we open the GenerationDialog
  // instead of dispatching blind — the dialog gives the user the
  // auto-prompt path or a place to type. The pin we just persisted will
  // apply to whichever Generate is fired from the dialog.
  const targetNode = useBoardStore
    .getState()
    .nodes.find((n) => n.id === target.targetRfId);
  if (!targetNode) return;
  const prompt = (targetNode.data.prompt ?? "").trim();
  if (!prompt || target.kind === "video") {
    useGenerationStore.getState().openGenerationDialog(target.targetRfId, prompt);
    return;
  }
  await useGenerationStore.getState().dispatchGeneration(target.targetRfId, {
    prompt,
    kind: target.kind,
    aspectRatio: targetNode.data.aspectRatio,
    variantCount: targetNode.data.variantCount,
  });
}

function VariantPicker({
  state,
  onPick,
  onCancel,
}: {
  state: VariantPickerState;
  onPick(target: VariantTarget): void;
  onCancel(): void;
}) {
  return (
    <div className="variant-picker nodrag" role="dialog" aria-label="选择下游目标节点">
      <div className="variant-picker__heading">
        将变体 v{state.variantIdx + 1} 传递至：
      </div>
      <ul className="variant-picker__list">
        {state.targets.map((t) => (
          <li key={t.edgeId}>
            <button
              type="button"
              className="variant-picker__btn"
              onClick={() => onPick(t)}
            >
              {t.title}
              <span className="variant-picker__kind">
                {t.kind === "video" ? "视频" : "图片"}
                {!t.hasPrompt ? " · 待填词" : ""}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="variant-picker__cancel"
        onClick={onCancel}
      >
        取消
      </button>
    </div>
  );
}

function ImageBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const tileCount = tileCountFor(data);
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const hasMedia = ids.length > 0;
  const isProcessing = data.status === "queued" || data.status === "running";

  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // Variant-picker state for the multi-downstream "Use →" flow. MUST be
  // declared above the empty-state early-return below — Rules of Hooks
  // require the same call order on every render, and the empty/filled
  // branches change which JSX renders but not which hooks run.
  const [picker, setPicker] = useState<VariantPickerState | null>(null);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      mediaIds: undefined,
      variantCount: 1,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      // Backend merges `data`. `null` is the explicit "delete this key"
      // sentinel — used here to drop stale variant arrays + cached brief
      // when the user replaces a generated set with a single uploaded image.
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          mediaIds: null,
          variantCount: 1,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding) {
        setError("尚未绑定 Flow 项目，请先在右上角绑定项目");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, binding.flow_project_id, isNaN(dbId) ? undefined : dbId, binding.flow_account_id);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片上传失败");
    } finally {
      setUploading(false);
    }
  }

  function onPick(e?: React.MouseEvent | React.KeyboardEvent) {
    e?.stopPropagation();
    if (uploading) return;
    pickSingleImage("上传图片到节点", uploadOwn, setError);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) uploadOwn(f);
  }

  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!dragOver) setDragOver(true);
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function openGenerate(e?: React.MouseEvent) {
    e?.stopPropagation();
    const initialPrompt =
      (data.type === "Storyboard" ? data.aiBrief : data.prompt) ?? "";
    useGenerationStore.getState().openGenerationDialog(rfId, initialPrompt);
  }

  // Empty state — same action-bar UX as character/visual_asset so users
  // can drop a reference image directly onto an image node instead of
  // having to wire one up via a separate visual_asset node.
  if (!hasMedia && !isProcessing) {
    return (
      <div
        className="node-body node-body--image"
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
      >
        <div className={`character-empty${dragOver ? " character-empty--over" : ""}`}>
          {dragOver ? (
            <span className="visual-asset__hint">松开上传图片</span>
          ) : (
            <>
              <button
                type="button"
                className="visual-asset__action nodrag"
                onClick={onPick}
                disabled={uploading}
              >
                {uploading ? "上传中…" : "上传"}
              </button>
              <button
                type="button"
                className="visual-asset__action nodrag"
                onClick={openGenerate}
                disabled={uploading}
              >
                生成
              </button>
            </>
          )}
        </div>
        <BriefHint data={data} />
        {error && <p className="character-drop__error" role="alert">{error}</p>}
      </div>
    );
  }

  // Variant-click flow: when this node is multi-variant AND has a
  // downstream image/video target, each tile gets a "Use →" overlay
  // button. Clicking it pins this variant on the appropriate edge and
  // dispatches Generate on the target. See `applyVariantToTarget` above.
  const isMultiVariant = ids.length >= 2;

  function onUseVariantClick(variantIdx: number) {
    const targets = collectGenTargets(rfId);
    if (targets.length === 0) {
      useGenerationStore.setState({
        error: "请先将此图片节点连线至下游图片或视频节点。",
      });
      return;
    }
    if (targets.length === 1) {
      void applyVariantToTarget(variantIdx, targets[0]);
      return;
    }
    setPicker({ variantIdx, targets });
  }

  const tiles: JSX.Element[] = [];
  for (let i = 0; i < tileCount; i++) {
    const rawMid = ids[i];
    const mid = typeof rawMid === "string" && rawMid ? rawMid : undefined;
    // Single-click selects/highlights/drags the node cleanly without opening
    // modals; double-click opens detailed parameters, and the header/overlay
    // preview button opens the full-screen viewer.
    tiles.push(
      <ImageTile
        key={i}
        rfId={rfId}
        mediaId={mid}
        isProcessing={isProcessing && !mid}
        alt={data.title}
        onUseAsRef={
          isMultiVariant && mid && !isProcessing
            ? () => onUseVariantClick(i)
            : undefined
        }
        onSaveToLibrary={
          mid
            ? () =>
                saveTileToLibrary({
                  mediaId: mid,
                  nodeType: data.type,
                  data,
                })
            : undefined
        }
      />
    );
  }

  const rawAspect = (data.aspectRatio ?? "").toUpperCase();
  const gridAspectAttr =
    rawAspect.includes("PORTRAIT") || rawAspect === "9:16" || rawAspect === "3:4"
      ? "portrait"
      : rawAspect.includes("SQUARE") || rawAspect === "1:1"
        ? "square"
        : undefined;

  return (
    <div
      className={`node-body node-body--image${dragOver ? " node-body--image--over" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className={`thumbnail-grid thumbnail-grid--${tileCount}`} data-aspect={gridAspectAttr}>
        {tiles}
      </div>
      {picker && (
        <VariantPicker
          state={picker}
          onPick={(target) => {
            void applyVariantToTarget(picker.variantIdx, target);
            setPicker(null);
          }}
          onCancel={() => setPicker(null)}
        />
      )}
      <BriefHint data={data} />
      {data.type === "character" && hasMedia && !isProcessing && (
        <div className="jm-subject-card-bar nodrag">
          <button
            type="button"
            className="visual-asset__action"
            onClick={onPick}
            disabled={uploading}
            title="上传本地动漫/人物/道具设定图替换当前主体"
          >
            {uploading ? "上传中…" : "替换主体图"}
          </button>
        </div>
      )}
      {error && <p className="character-drop__error" role="alert">{error}</p>}
      {(data.status === "error" || (data.status === "done" && Boolean(data.error))) && data.error && (
        <p
          className={`node-error${data.status === "done" ? " node-error--partial" : ""}`}
          role={data.status === "done" ? "status" : "alert"}
        >
          {data.error}
        </p>
      )}
    </div>
  );
}

// Media availability can lag the completed task. Retrying playback only reloads
// the local media URL; it never creates a generation request.
function VideoPreviewTile({ mediaId, label, onDetails }: {
  mediaId: string; label: string; onDetails: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!failed || attempt >= 3) return;
    const timer = window.setTimeout(() => { setFailed(false); setAttempt(a => a + 1); }, 2000);
    return () => window.clearTimeout(timer);
  }, [failed, attempt]);

  function toggleInlinePlay(e: React.MouseEvent) {
    e.stopPropagation();
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }

  return (
    <div className="video-tile jm-video-preview">
      <video
        ref={videoRef}
        key={attempt}
        playsInline
        loop
        preload="metadata"
        src={mediaUrl(mediaId) + (attempt ? `?preview=${attempt}` : "")}
        aria-label={label}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => setFailed(true)}
      />
      {failed && (
        <div className="jm-video-preview__fallback nodrag" role="status">
          {attempt < 3 ? "正在读取视频…" :
            <button type="button" onClick={(e) => { e.stopPropagation(); setAttempt(0); setFailed(false); }}>重新加载预览</button>}
        </div>
      )}
      {!failed && (
        <button
          type="button"
          className="jm-video-preview__play nodrag"
          onClick={toggleInlinePlay}
          onDoubleClick={(e) => e.stopPropagation()}
          aria-label={playing ? `暂停 ${label}` : `预览播放 ${label}`}
          title={playing ? "暂停画布预览" : "画布内快速播放"}
        >
          {playing ? "⏸ 暂停" : "▶ 播放"}
        </button>
      )}
      <button
        type="button"
        className="jm-video-preview__details nodrag"
        onClick={(e) => {
          e.stopPropagation();
          onDetails();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        aria-label={`${label}：打开视频展示页`}
        title="进入官方风格视频展示页与时间轴播控"
      >
        ⛶ 展示页
      </button>
    </div>
  );
}

function VideoBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const ids = data.mediaIds ?? (data.mediaId ? [data.mediaId] : []);
  const count = Math.max(tileCountFor(data), ids.length);
  const processing = data.status === "queued" || data.status === "running";
  const partial = data.status === "done" && Boolean(data.error);
  const open = (idx: number) => useGenerationStore.getState().openResultViewer(rfId, idx);
  return (
    <div className="node-body node-body--video">
      {processing && <div className="jm-video-stage" role="status">
        <span className="jm-video-stage__dot" aria-hidden="true" />
        {data.status === "queued" ? "已加入队列，等待开始" : "正在生成，完成后在此预览"}
        {ids.some(Boolean) ? " · 下方为上次结果" : ""}
      </div>}
      <div className={`video-grid video-grid--${count}`} data-portrait={data.aspectRatio?.includes("PORTRAIT") || undefined}>
        {Array.from({ length: count }, (_, i) => {
          const id = ids[i];
          const label = `${displayNodeTitle(data.title, "video")} · 片段 ${i + 1}`;
          return id ? <VideoPreviewTile key={`${i}:${id}`} mediaId={id} label={label} onDetails={() => open(i)} /> :
            <div key={i} className="video-tile jm-video-empty">
              {partial && (data.slotErrors?.[i] || ids[i] === null) ?
                <button type="button" className="nodrag" onClick={(e) => { e.stopPropagation(); open(i); }}>此片段未生成 · 查看原因</button>
                : processing ? "等待视频" : data.status === "error" ? "暂无可播放的视频" : "双击节点，配置视频参数与提示词"}
            </div>;
        })}
      </div>
      {(data.status === "error" || partial) && data.error && (
        <p className={`node-error${partial ? " node-error--partial" : ""}`} role={partial ? "status" : "alert"}>{data.error}</p>
      )}
    </div>
  );
}

function VisualAssetBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const mediaId = data.mediaId;
  const isProcessing = data.status === "queued" || data.status === "running";
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refinePrompt, setRefinePrompt] = useState("");
  const [refRefreshKey, setRefRefreshKey] = useState(0);
  const [refMediaId, setRefMediaId] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [linkValue, setLinkValue] = useState("");

  useEffect(() => {
    const onOpenRefine = (e: Event) => {
      if (e instanceof CustomEvent && e.detail?.rfId === rfId && mediaId) {
        setRefineOpen(true);
      }
    };
    window.addEventListener("flowboard:open-node-refine", onOpenRefine);
    return () => window.removeEventListener("flowboard:open-node-refine", onOpenRefine);
  }, [rfId, mediaId]);

  function persistMedia(newMediaId: string, aspectRatio?: string) {
    useBoardStore.getState().updateNodeData(rfId, {
      mediaId: newMediaId,
      mediaIds: [newMediaId],
      variantCount: 1,
      status: "done",
      aiBrief: undefined,
      aspectRatio,
    });
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      // Backend merges `data`, so we only need to send the deltas.
      // `null` clears aiBrief explicitly (undefined would be dropped
      // by JSON.stringify and leave the stale brief in place).
      patchNode(dbId, {
        status: "done",
        data: {
          mediaId: newMediaId,
          mediaIds: [newMediaId],
          variantCount: 1,
          aiBrief: null,
          aspectRatio,
          renderedAt: new Date().toISOString(),
        },
      }).catch(() => {});
    }
    requestAutoBrief(rfId, newMediaId);
  }

  async function uploadOwn(file: File) {
    setError(null);
    setUploading(true);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding) {
        setError("尚未绑定 Flow 项目，请先在右上角绑定项目");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImage(file, binding.flow_project_id, isNaN(dbId) ? undefined : dbId, binding.flow_account_id);
      persistMedia(resp.media_id, resp.aspect_ratio);
    } catch (err) {
      setError(err instanceof Error ? err.message : "图片上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function uploadFromLink(url: string) {
    const trimmed = url.trim();
    if (!trimmed) return;
    setError(null);
    setUploading(true);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding) {
        setError("尚未绑定 Flow 项目，请先在右上角绑定项目");
        return;
      }
      const dbId = parseInt(rfId, 10);
      const resp = await uploadImageFromUrl(
        trimmed,
        binding.flow_project_id,
        isNaN(dbId) ? undefined : dbId,
        binding.flow_account_id,
      );
      persistMedia(resp.media_id, resp.aspect_ratio);
      setLinkMode(false);
      setLinkValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "链接拉取图片失败");
    } finally {
      setUploading(false);
    }
  }

  async function uploadRef(file: File) {
    setError(null);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding) {
        setError("尚未绑定 Flow 项目，请先在右上角绑定项目");
        return;
      }
      const resp = await uploadImage(file, binding.flow_project_id, undefined, binding.flow_account_id);
      setRefMediaId(resp.media_id);
      setRefRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "参考图上传失败");
    }
  }

  async function submitRefine() {
    if (!mediaId) return;
    if (!refinePrompt.trim()) return;
    await useGenerationStore.getState().refineImage(rfId, {
      prompt: refinePrompt.trim(),
      refMediaIds: refMediaId ? [refMediaId] : [],
    });
    setRefineOpen(false);
    setRefinePrompt("");
    setRefMediaId(null);
  }

  function openGenerate(e?: React.MouseEvent) {
    e?.stopPropagation();
    useGenerationStore.getState().openGenerationDialog(rfId, data.prompt ?? "");
  }

  if (!mediaId) {
    return (
      <div className="node-body node-body--visual-asset">
        <div
          className={`visual-asset__empty${isProcessing ? " visual-asset__empty--processing" : ""}`}
        >
          {isProcessing ? (
            <span className="visual-asset__hint">生成中…</span>
          ) : linkMode ? (
            <div className="visual-asset__link-row nodrag">
              <input
                type="url"
                className="visual-asset__link-input"
                placeholder="https://… (图片链接)"
                value={linkValue}
                onChange={(e) => setLinkValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") uploadFromLink(linkValue);
                  if (e.key === "Escape") {
                    setLinkMode(false);
                    setLinkValue("");
                    setError(null);
                  }
                }}
                disabled={uploading}
                autoFocus
              />
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => uploadFromLink(linkValue)}
                disabled={uploading || !linkValue.trim()}
              >
                {uploading ? "拉取中…" : "确定"}
              </button>
              <button
                type="button"
                className="visual-asset__action"
                onClick={() => {
                  setLinkMode(false);
                  setLinkValue("");
                  setError(null);
                }}
                disabled={uploading}
              >
                ×
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="visual-asset__action nodrag"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!uploading) pickSingleImage("上传物品素材图片", uploadOwn, setError);
                }}
                disabled={uploading}
              >
                {uploading ? "上传中…" : "上传"}
              </button>
              <button
                type="button"
                className="visual-asset__action nodrag"
                onClick={() => {
                  setError(null);
                  setLinkMode(true);
                }}
                disabled={uploading}
              >
                链接
              </button>
              <button
                type="button"
                className="visual-asset__action nodrag"
                onClick={openGenerate}
                disabled={uploading}
              >
                生成
              </button>
            </>
          )}
        </div>
        {error && <p className="visual-asset__error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="node-body node-body--visual-asset node-body--visual-asset-with-media">
      <div className="visual-asset__media">
        <img
          className="visual-asset__image"
          src={mediaUrl(mediaId)}
          alt={data.title}
        />
        {!isProcessing && (
          <button
            type="button"
            className="visual-asset__refine-btn nodrag"
            onClick={() => setRefineOpen((o) => !o)}
            aria-label="图像精修"
          >
            精修
          </button>
        )}
      </div>
      <BriefHint data={data} />
      {!isProcessing && (
        <button
          type="button"
          className="visual-asset__action nodrag"
          onClick={(e) => {
            e.stopPropagation();
            saveTileToLibrary({
              mediaId,
              nodeType: data.type,
              data,
            });
          }}
          title="收藏此素材至资产库"
          aria-label="收藏至资产库"
        >
          ★ 收藏
        </button>
      )}
      {refineOpen && (
        <div className="visual-asset__refine-panel nodrag" role="region" aria-label="图像精修">
          <textarea
            className="visual-asset__refine-textarea nodrag nowheel"
            placeholder="输入修改指令（例如：更换背景、调整光影细节）…"
            rows={2}
            value={refinePrompt}
            onChange={(e) => setRefinePrompt(e.target.value)}
          />
          <div className="visual-asset__refine-actions">
            <button
              type="button"
              className="visual-asset__refine-ref nodrag"
              onClick={(e) => {
                e.stopPropagation();
                pickSingleImage("选择精修参考图", uploadRef, setError);
              }}
            >
              {refMediaId ? `参考图 ✓ (${refRefreshKey})` : "添加参考图"}
            </button>
            <button
              type="button"
              className="visual-asset__refine-submit nodrag"
              disabled={!refinePrompt.trim()}
              onClick={submitRefine}
            >
              开始精修 →
            </button>
          </div>
        </div>
      )}
      {error && <p className="visual-asset__error">{error}</p>}
    </div>
  );
}

// Shared editable body for prompt + note nodes. Both store free-form text
// in `data.prompt`; only display markup differs. Double-click swaps to a
// textarea; blur or Cmd/Ctrl+Enter saves; Esc cancels.
function EditableTextBody({
  rfId,
  data,
  variant,
}: {
  rfId: string;
  data: FlowboardNodeData;
  variant: "prompt" | "note";
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.prompt ?? "");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(data.prompt ?? "");
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(ta.value.length, ta.value.length);
        }
      });
    }
  }, [editing]);

  function save() {
    const next = draft;
    if (next !== (data.prompt ?? "")) {
      useBoardStore.getState().updateNodeData(rfId, { prompt: next });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) {
        // Backend merges `data`, so only the prompt delta needs shipping.
        patchNode(dbId, { data: { prompt: next } }).catch(() => {});
      }
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <div className={`node-body node-body--${variant} node-body--${variant}-edit`}>
        <textarea
          ref={taRef}
          className={`${variant}-editor nodrag nowheel`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder={
            variant === "prompt"
              ? "输入风格或提示词方向（如：电影暖调光影、街头纪实感），连线至下游图片/视频节点可自动融合。"
              : "输入便签备注、分镜说明…"
          }
        />
      </div>
    );
  }

  const text = data.prompt ?? "";
  const placeholder =
    variant === "prompt"
      ? "双击输入提示词或脚本…"
      : "双击输入便签内容…";

  return (
    <div
      className={`node-body node-body--${variant}`}
      onDoubleClick={() => setEditing(true)}
      title="双击编辑内容"
    >
      {variant === "prompt" ? (
        <pre className="prompt-text">{text || placeholder}</pre>
      ) : (
        <p className="note-text">{text || placeholder}</p>
      )}
    </div>
  );
}

// ── Storyboard ────────────────────────────────────────────────────────────
// Storyboard is a thin image-node wrapper. It dispatches via the standard
// `gen_image` handler with a locked prompt template that asks Flow to render
// the user's topic as a single composite NxN grid (see
// frontend/src/lib/storyboardPrompt.ts). Rendering reuses `ImageBody` — up
// to 4 composite variants in the tile grid — with a small `2×2`/`2×3`/`2×4`
// corner badge (flipped for portrait composites) reminding the user of
// the active layout.

function StoryboardBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  const g = normaliseStoryboardGrid(data.storyboardGrid);
  const mode = normaliseStoryboardMode(data.storyboardMode);
  const { rows, cols, total } = resolveStoryboardLayout(g, data.aspectRatio);
  const label = `${rows}×${cols}`;
  const isProcessing = data.status === "queued" || data.status === "running";
  const hasMedia =
    Boolean(data.mediaId) ||
    Boolean(data.mediaIds?.some((m) => typeof m === "string" && m.length > 0));
  const [splitting, setSplitting] = useState<{ done: number; total: number } | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);

  async function handleSplit(e: React.MouseEvent) {
    e.stopPropagation();
    if (splitting || isProcessing || !hasMedia) return;
    setSplitError(null);
    setSplitting({ done: 0, total });
    try {
      await splitStoryboardToShotNodes(rfId, 0, (done, sum) => {
        setSplitting({ done, total: sum });
      });
    } catch (err) {
      setSplitError(err instanceof Error ? err.message : "宫格切分失败");
    } finally {
      setSplitting(null);
    }
  }

  return (
    <div className="storyboard-wrap">
      <span
        className="storyboard-grid-badge"
        title={`分镜布局：${label}（${total} 格 · ${mode === "multicam" ? "同场多机位" : "剧情连贯"}）`}
      >
        {label}
        {mode === "multicam" ? " · 多机位" : ""}
      </span>
      <ImageBody rfId={rfId} data={data} />
      {hasMedia && !isProcessing && (
        <div className="jm-storyboard-split-bar nodrag">
          <button
            type="button"
            className="visual-asset__action jm-storyboard-split-btn"
            onClick={(e) => void handleSplit(e)}
            disabled={splitting !== null}
            title={`将 ${label} 故事板无损切分为 ${total} 个独立图片节点并自动上传注册到当前 Flow 项目`}
          >
            {splitting
              ? `✂️ 切分注册中 ${splitting.done}/${splitting.total}…`
              : `✂️ 一键切分 ${total} 个独立镜头`}
          </button>
          {splitError && <p className="character-drop__error" role="alert">{splitError}</p>}
        </div>
      )}
    </div>
  );
}

function NodeBody({ rfId, data }: { rfId: string; data: FlowboardNodeData }) {
  switch (data.type) {
    case "character":
      return <CharacterBody rfId={rfId} data={data} />;
    case "image":
      return <ImageBody rfId={rfId} data={data} />;
    case "video":
      return <VideoBody rfId={rfId} data={data} />;
    case "prompt":
      return <EditableTextBody rfId={rfId} data={data} variant="prompt" />;
    case "note":
      return <EditableTextBody rfId={rfId} data={data} variant="note" />;
    case "visual_asset":
      return <VisualAssetBody rfId={rfId} data={data} />;
    case "Storyboard":
      return <StoryboardBody rfId={rfId} data={data} />;
  }
}

function downloadExt(type: string): string {
  if (type === "video") return "mp4";
  return "png";
}

export function NodeCard(props: NodeProps<FlowNode>) {
  const data = props.data;
  const isNote = data.type === "note";
  const isGenerable = ["image", "prompt", "video", "visual_asset", "character", "Storyboard"].includes(data.type);
  const status = data.status ?? "idle";
  const isProcessing = status === "queued" || status === "running";
  const NodeIcon = NODE_ICONS[data.type];
  const title = displayNodeTitle(data.title, data.type);
  const llmBusy = isLLMBusy(data);
  const downloadable = !!data.mediaId && data.type !== "prompt" && data.type !== "note";
  const historyList = Array.isArray(data.history) ? data.history : [];
  const activeHistoryIdx = data.mediaId
    ? Math.max(0, historyList.findIndex((h) => h.mediaId === data.mediaId))
    : Math.max(0, historyList.length - 1);
  const showHistoryBar = historyList.length >= 2 && !isProcessing;
  const hasCustomSize = useBoardStore((s) => {
    const cur = s.nodes.find((it) => it.id === props.id);
    if (!cur) return false;
    return (
      (typeof cur.width === "number" && cur.width > 0 && typeof cur.height === "number" && cur.height > 0) ||
      (typeof cur.data.customW === "number" && typeof cur.data.customH === "number")
    );
  });

  function handleGenerate(e: React.MouseEvent) {
    e.stopPropagation();
    if (llmBusy || isProcessing) return;
    const initialPrompt =
      (data.type === "Storyboard" ? data.aiBrief : data.prompt) ?? "";
    useGenerationStore.getState().openGenerationDialog(props.id, initialPrompt);
  }

  function handlePreview(e: React.MouseEvent) {
    e.stopPropagation();
    if (!downloadable) return;
    useGenerationStore.getState().openResultViewer(props.id, 0);
  }

  function handleDownload(e: React.MouseEvent) {
    e.stopPropagation();
    // Download every variant, not just the first. `mediaIds` is the full
    // list — `mediaId` is just the active variant — so a 4-variant image
    // node was previously losing 3 of its 4 outputs. Filter out null
    // placeholders that the partial-batch path may leave in `mediaIds`.
    const rawIds =
      data.mediaIds && data.mediaIds.length > 0
        ? data.mediaIds
        : data.mediaId
          ? [data.mediaId]
          : [];
    const ids = rawIds.filter((m): m is string => typeof m === "string" && m.length > 0);
    if (ids.length === 0) return;
    const safeTitle = (data.title || data.type).replace(/[^A-Za-z0-9_-]+/g, "_");
    const ext = downloadExt(data.type);
    // `<a download>` only honours the suggested filename when the resource
    // is same-origin — `/media/<id>` *is* same-origin (proxied by FastAPI),
    // so the title-based filename sticks.
    ids.forEach((mid, i) => {
      const a = document.createElement("a");
      a.href = mediaUrl(mid);
      const suffix = ids.length > 1 ? `-${i + 1}` : "";
      a.download = `${safeTitle}-${data.shortId}${suffix}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  }

  return (
    <div
      className={`node-card jm-node-card${isNote ? " node-card--note" : ""}${
        props.selected ? " node-card--selected" : ""
      }${hasCustomSize ? " node-card--resized" : ""}${
        llmBusy ? " node-card--llm-busy" : ""
      }${data.groupId ? " node-card--grouped" : ""}`}
      data-status={status}
    >
      <NodeResizer
        isVisible={Boolean(props.selected)}
        minWidth={180}
        minHeight={120}
        maxWidth={1800}
        maxHeight={1800}
        lineClassName="jm-node-resizer-line"
        handleClassName="jm-node-resizer-handle"
        onResizeEnd={(_event, params) => {
          void useBoardStore.getState().persistNodeDimensions(props.id, params);
        }}
      />
      {!props.selected && (
        <NodeResizeControl
          position="bottom-right"
          minWidth={180}
          minHeight={120}
          maxWidth={1800}
          maxHeight={1800}
          className="jm-node-corner-grip nodrag"
          onResizeEnd={(_event, params) => {
            void useBoardStore.getState().persistNodeDimensions(props.id, params);
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path d="M8.5 2.5L2.5 8.5M8.5 6L6 8.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
          </svg>
        </NodeResizeControl>
      )}
      {data.groupId && (
        <div className="jm-node-group-badge" title={`所属分镜组：${data.groupTitle || "分镜组"}`}>
          📦 {data.groupTitle || "分镜组"}
        </div>
      )}
      <div className="node-header">
        <NodeIcon className="node-icon" size={15} />
        <span className="node-title" title={`${title} · #${data.shortId}`}>{title}</span>
        {(llmBusy || status !== "idle") && (
          <span
            className="jm-node-status"
            data-tone={llmBusy ? "running" : status}
            title={status === "error" ? data.error : undefined}
            aria-live="polite"
          >
            <span className="jm-node-status__dot" aria-hidden="true" />
            {llmBusy
              ? (data.autoPromptStatus === "pending" ? "构思中" : "解析中")
              : status !== "idle" && STATUS_LABELS[status]}
          </span>
        )}
        {(hasCustomSize || downloadable || isGenerable) && (
          <div className="node-header__actions nodrag">
            {hasCustomSize && (
              <button
                type="button"
                className="node-header__btn"
                onClick={(e) => {
                  e.stopPropagation();
                  void useBoardStore.getState().resetNodeDimensions(props.id);
                }}
                aria-label="恢复原始比例尺寸"
                title="恢复原始比例尺寸"
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 9V5h4M16 11v4h-4M15.5 5.5 11.5 9.5M4.5 14.5l4-4" />
                </svg>
              </button>
            )}
            {downloadable && (
              <button
                type="button"
                className="node-header__btn"
                onClick={handlePreview}
                aria-label={data.type === "video" ? "打开视频展示页" : "全屏预览成品"}
                title={data.type === "video" ? "进入官方风格视频展示页" : "全屏预览成品与高清重塑"}
              >
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3.5 8V4.5H7M13 4.5h3.5V8M16.5 12v3.5H13M7 15.5H3.5V12" />
                </svg>
              </button>
            )}
            {downloadable && (
              <button
                type="button"
                className="node-header__btn"
                onClick={handleDownload}
                aria-label="下载媒体文件"
                title="下载到本地"
              >
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 3.5v9m-3.2-3 3.2 3.2 3.2-3.2M4 13.5v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" />
                </svg>
              </button>
            )}
            {isGenerable && (
              <button
                type="button"
                className="node-header__btn"
                onClick={handleGenerate}
                aria-label="打开详细参数"
                title="打开详细参数与提示词（也可双击节点）"
                disabled={llmBusy || isProcessing}
              >
                <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                  <path d="M4 6h4m4 0h4M4 14h8" />
                  <circle cx="10" cy="6" r="2" /><circle cx="14" cy="14" r="2" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="jm-node-surface" aria-busy={isProcessing || llmBusy}>
        <div className="jm-node-content">
          <NodeBody rfId={props.id} data={data} />
        </div>
        <Handle type="target" position={Position.Left} className="node-handle" />
        <Handle type="source" position={Position.Right} className="node-handle" />
      </div>

      {showHistoryBar && (
        <div
          className="jm-node-history-bar nodrag nopan"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="jm-node-history-btn"
            disabled={activeHistoryIdx <= 0}
            onClick={(e) => {
              e.stopPropagation();
              switchNodeHistoryVersion(props.id, activeHistoryIdx - 1);
            }}
            title="切换至上一历史版本"
            aria-label="上一历史版本"
          >
            ‹
          </button>
          <span className="jm-node-history-label" title="单节点历史生成版本（不覆盖旧图）">
            第 {activeHistoryIdx + 1}/{historyList.length} 版
          </span>
          <button
            type="button"
            className="jm-node-history-btn"
            disabled={activeHistoryIdx >= historyList.length - 1}
            onClick={(e) => {
              e.stopPropagation();
              switchNodeHistoryVersion(props.id, activeHistoryIdx + 1);
            }}
            title="切换至下一历史版本"
            aria-label="下一历史版本"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}
