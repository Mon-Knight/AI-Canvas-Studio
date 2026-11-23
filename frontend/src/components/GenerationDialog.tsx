import { useEffect, useId, useRef, useState } from "react";
import {
  collectUpstreamPromptText,
  collectUpstreamRefEntries,
  useGenerationStore,
} from "../store/generation";
import { type VideoRefFrameMode } from "../lib/videoFrame";
import { useFlowAccounts } from "../store/flowAccounts";
import { useBoardStore, type FlowboardNodeData, type StoryboardGrid, type StoryboardMode } from "../store/board";
import { displayNodeTitle } from "../constants/nodeLabels";
import {
  STORYBOARD_GRIDS,
  buildStoryboardPrompt,
  buildStoryboardVideoPrompt,
  normaliseStoryboardGrid,
  normaliseStoryboardMode,
  totalPanels,
} from "../lib/storyboardPrompt";
import {
  VIDEO_CAMERA_PRESETS,
  composeVideoPromptWithDirectives,
} from "../lib/promptMentions";
import {
  useSettingsStore,
  type ImageModelKey,
  type ImageResolutionKey,
  type ImageThinkingLevel,
  type MediaProviderKey,
  type OmniFlashDuration,
  type VideoResolutionKey,
} from "../store/settings";
import {
  CHINESE_PROMPT_PRESETS,
  IMAGE_ASPECT_OPTIONS,
  IMAGE_MODEL_CATALOG,
  IMAGE_RESOLUTION_OPTIONS,
  IMAGE_THINKING_OPTIONS,
  OMNI_1_1_CREDIT_COST,
  OMNI_1_2_CREDIT_COST,
  OMNI_1_2_DURATIONS,
  OUTPUT_COUNT_OPTIONS,
  VIDEO_ASPECT_OPTIONS,
  VIDEO_MODEL_CATALOG,
  VIDEO_RESOLUTION_OPTIONS,
  estimateImageCreditCost,
  estimateVideoCreditCost,
  findImageModelEntry,
  findVideoModelEntry,
  resolveVideoSelectionId,
  type VideoModelCatalogEntry,
} from "../constants/models";
import {
  autoPrompt as autoPromptApi,
  autoPromptBatch as autoPromptBatchApi,
  mediaUrl,
  patchEdge,
  patchNode,
} from "../api/client";
import {
  OFFICIAL_SUBJECT_TEMPLATES,
  SUBJECT_TEMPLATE_CATEGORIES,
  applySubjectTemplateText,
  useSubjectTemplatesStore,
  type CustomSubjectTemplate,
  type SubjectTemplateCategory,
} from "../constants/character";

const REF_SOURCE_TYPES = new Set([
  "character",
  "image",
  "visual_asset",
  // Storyboard outputs are first-class refs — they're composite images
  // that can feed downstream image / Omni-video / character nodes.
  "Storyboard",
  // Upstream video nodes can feed both video and image nodes (browser-side frame extraction).
  "video",
]);

const PROMPT_MAX_LENGTH = 2000;

const IMAGE_ASPECT_RATIOS = IMAGE_ASPECT_OPTIONS.map((a) => ({
  key: a.value,
  label: a.shortLabel,
  fullLabel: a.label,
}));

const VIDEO_ASPECT_RATIOS = VIDEO_ASPECT_OPTIONS.map((a) => ({
  key: a.value,
  label: a.label,
  shortLabel: a.shortLabel,
}));

const CAMERA_MOVEMENTS = VIDEO_CAMERA_PRESETS;
type CameraKey = string;

type ImageAspectKey = (typeof IMAGE_ASPECT_OPTIONS)[number]["value"];
type VideoAspectKey = (typeof VIDEO_ASPECT_OPTIONS)[number]["value"];
type AspectKey = ImageAspectKey | VideoAspectKey;

// Map an upstream image aspect onto the closest video aspect. Square has
// no direct video equivalent — fall back to portrait per the
// "default-to-9:16 on mismatch" rule.
function imageAspectToVideo(img: string | undefined): VideoAspectKey | null {
  if (img === "VIDEO_ASPECT_RATIO_LANDSCAPE" || img === "VIDEO_ASPECT_RATIO_PORTRAIT") {
    return img;
  }
  if (img === "IMAGE_ASPECT_RATIO_LANDSCAPE" || img === "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE") {
    return "VIDEO_ASPECT_RATIO_LANDSCAPE";
  }
  if (
    img === "IMAGE_ASPECT_RATIO_PORTRAIT" ||
    img === "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR" ||
    img === "IMAGE_ASPECT_RATIO_SQUARE"
  ) {
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  return null;
}

function videoAspectToImage(ar: string): ImageAspectKey | null {
  if (ar === "VIDEO_ASPECT_RATIO_LANDSCAPE") return "IMAGE_ASPECT_RATIO_LANDSCAPE";
  if (ar === "VIDEO_ASPECT_RATIO_PORTRAIT") return "IMAGE_ASPECT_RATIO_PORTRAIT";
  return IMAGE_ASPECT_RATIOS.some((p) => p.key === ar) ? (ar as ImageAspectKey) : null;
}

// Walk upstream of the target node, collect each upstream's aspectRatio,
// then apply the user's rule:
//   • single distinct aspect → match it
//   • multiple distinct aspects → fall back to 9:16
//   • zero upstream / unknown → caller's default
function pickDefaultAspect(
  rfId: string,
  targetType: string,
  nodes: ReturnType<typeof useBoardStore.getState>["nodes"],
  edges: ReturnType<typeof useBoardStore.getState>["edges"],
): AspectKey | null {
  const upstreamAspects: string[] = [];
  for (const e of edges) {
    if (e.target !== rfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src) continue;
    const ar = src.data.aspectRatio;
    if (typeof ar === "string" && ar.length > 0) upstreamAspects.push(ar);
  }
  if (upstreamAspects.length === 0) return null;

  if (targetType === "video") {
    const mapped = upstreamAspects
      .map(imageAspectToVideo)
      .filter((x): x is VideoAspectKey => x !== null);
    if (mapped.length === 0) return null;
    const unique = new Set(mapped);
    if (unique.size === 1) return mapped[0];
    return "VIDEO_ASPECT_RATIO_PORTRAIT";
  }
  // Image (and character — though character has its own opinionated
  // default; the caller short-circuits before reaching here).
  const validImg = upstreamAspects
    .map(videoAspectToImage)
    .filter((a): a is ImageAspectKey => a !== null);
  if (validImg.length === 0) return null;
  const unique = new Set(validImg);
  if (unique.size === 1) return validImg[0];
  return "IMAGE_ASPECT_RATIO_PORTRAIT";
}

// Small "ⓘ" affordance for moving static help-text out of the layout
// into a hover tooltip — keeps the dialog short while preserving the
// information for users who want it. Native `title` (plain text) is
// enough; we don't need rich markup in tooltips.
function InfoTip({ tip }: { tip: string }) {
  return (
    <span
      className="gen-dialog__info-tip"
      title={tip}
      aria-label={tip}
      role="img"
    >
      ⓘ
    </span>
  );
}

export function GenerationDialog() {
  const { rfId, prompt } = useGenerationStore((s) => s.openDialog);
  const close = useGenerationStore((s) => s.closeGenerationDialog);
  return rfId === null ? null : <GenerationComposer key={rfId} rfId={rfId} initialPrompt={prompt} onClose={close} />;
}

export function GenerationComposer({ rfId, initialPrompt, onClose, inline = false }: {
  rfId: string;
  initialPrompt: string;
  onClose?: () => void;
  inline?: boolean;
}) {
  const closeGenerationDialog = () => onClose?.();
  const promptId = useId();
  const titleId = useId();
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const nodes = useBoardStore((s) => s.nodes);

  const [prompt, setPrompt] = useState(initialPrompt);
  const [aspectRatio, setAspectRatio] = useState<AspectKey>("IMAGE_ASPECT_RATIO_LANDSCAPE");
  const [variants, setVariants] = useState(1);
  const [camera, setCamera] = useState<CameraKey>("static");
  // Storyboard layout. The node dispatches via the standard image
  // handler with a locked template prompt wrapping the user's topic
  // into a single composite NxN grid. See lib/storyboardPrompt.ts.
  const [storyboardGrid, setStoryboardGrid] = useState<StoryboardGrid>("2x2");
  const [storyboardMode, setStoryboardMode] = useState<StoryboardMode>("narrative");
  const [videoSubMode, setVideoSubMode] = useState<"auto" | "first_last" | "t2v">("auto");
  const [firstFrameId, setFirstFrameId] = useState("");
  const [lastFrameId, setLastFrameId] = useState("");
  const [audioOpen, setAudioOpen] = useState(false);
  const [dialogueText, setDialogueText] = useState("");
  const [sfxText, setSfxText] = useState("");
  const [atSuggestOpen, setAtSuggestOpen] = useState(false);

  // 主体（character）官方推荐模板 & 自定义模板选择器状态
  const customSubjectTemplates = useSubjectTemplatesStore((s) => s.customTemplates);
  const addCustomTemplate = useSubjectTemplatesStore((s) => s.addCustomTemplate);
  const updateCustomTemplate = useSubjectTemplatesStore((s) => s.updateCustomTemplate);
  const removeCustomTemplate = useSubjectTemplatesStore((s) => s.removeCustomTemplate);
  const [subjectTab, setSubjectTab] = useState<"official" | "custom">("official");
  const [subjectCategory, setSubjectCategory] = useState<SubjectTemplateCategory>("all");
  const [templateFormOpen, setTemplateFormOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [tplTitleDraft, setTplTitleDraft] = useState("");
  const [tplPromptDraft, setTplPromptDraft] = useState("");
  const lastAppliedTemplateRef = useRef<string | null>(null);

  // Auto-prompt state — set when AI polish or auto-synth produces text.
  // Always requires manual human confirmation (`pendingAiConfirm`) before dispatch.
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [autoPromptUsed, setAutoPromptUsed] = useState(false);
  const [pendingAiConfirm, setPendingAiConfirm] = useState(false);
  const [preAiPrompt, setPreAiPrompt] = useState<string | null>(null);
  const [pendingBatchPrompts, setPendingBatchPrompts] = useState<string[] | undefined>(undefined);
  const [videoRefFrame, setVideoRefFrame] = useState<VideoRefFrameMode>("last");

  // Per-variant selection for multi-source i2v. Default: all selected.
  // Stored as a Set of indices so the UI can toggle individual variants
  // and "All / None" without juggling parallel arrays.
  const [selectedSourceIdx, setSelectedSourceIdx] = useState<Set<number>>(new Set());
  // Tracks which Source-Reference chip's variant picker is currently
  // open. Holds the edge id the picker is anchored to (one open at a
  // time). Click another chip → swap; click the same chip → close;
  // click outside (handled inline) → close.
  const [openVariantPicker, setOpenVariantPicker] = useState<string | null>(null);

  const submitLock = useRef(false);
  const promptManuallyEditedRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLTextAreaElement>(null);

  const node = nodes.find((n) => n.id === rfId);
  const boardName = useBoardStore((s) => s.boardName);
  const nodeCount = nodes.length;
  const edges = useBoardStore((s) => s.edges);

  // Hooks MUST be called unconditionally on every render — pull
  // videoModel out first, derive the boolean after.
  const imageModel = useSettingsStore((s) => s.imageModel);
  const setImageModel = useSettingsStore((s) => s.setImageModel);
  const imageResolution = useSettingsStore((s) => s.imageResolution);
  const setImageResolution = useSettingsStore((s) => s.setImageResolution);
  const imageThinkingLevel = useSettingsStore((s) => s.imageThinkingLevel);
  const setImageThinkingLevel = useSettingsStore((s) => s.setImageThinkingLevel);
  const defaultImageAspect = useSettingsStore((s) => s.defaultImageAspect);
  const defaultImageCount = useSettingsStore((s) => s.defaultImageCount);
  const videoModelFamily = useSettingsStore((s) => s.videoModel);
  const videoQuality = useSettingsStore((s) => s.videoQuality);
  const setVideoModel = useSettingsStore((s) => s.setVideoModel);
  const setVideoQuality = useSettingsStore((s) => s.setVideoQuality);
  const omniVersion = useSettingsStore((s) => s.omniVersion);
  const setOmniVersion = useSettingsStore((s) => s.setOmniVersion);
  const omniFlashDuration = useSettingsStore((s) => s.omniFlashDuration);
  const setOmniFlashDuration = useSettingsStore(
    (s) => s.setOmniFlashDuration,
  );
  const videoResolution = useSettingsStore((s) => s.videoResolution);
  const setVideoResolution = useSettingsStore((s) => s.setVideoResolution);
  const defaultVideoAspect = useSettingsStore((s) => s.defaultVideoAspect);
  const defaultVideoCount = useSettingsStore((s) => s.defaultVideoCount);
  const [seedInput, setSeedInput] = useState("");
  // Generation backend — sticky choice; dispatch reads it from here.
  const mediaProvider = useSettingsStore((s) => s.mediaProvider);
  const setMediaProvider = useSettingsStore((s) => s.setMediaProvider);
  const accounts = useFlowAccounts(s => s.snapshot);
  const accountsError = useFlowAccounts(s => s.readError);
  const account = accounts?.accounts.find(a => a.id === accounts.active_account_id);
  const paygateTier = account?.paygate_tier;
  const videoDraft = useGenerationStore(s => s.videoDraft?.rfId === rfId ? s.videoDraft : null);

  const targetType = node?.data.type ?? "image";
  const isVideo = targetType === "video";
  const accountIssue = accountsError ? "账号状态未刷新，请检查本地服务。"
    : !accounts ? "正在读取当前账号…"
    : !account ? "请在右上角选择要用于生成的 Flow 账号。"
    : !account.project_id ? "请为当前账号绑定 Flow 项目。"
    : !account.connected ? "请连接当前账号的 Flow 扩展。"
    : !account.flow_tab_open ? "请在当前账号的浏览器窗口打开 Flow 网页。"
    : null;
  const isCharacter = targetType === "character";
  const isStoryboard = targetType === "Storyboard";
  // Omni Flash is a video model but with image-target semantics: it
  // takes ingredients (multi reference images), NOT a single i2v start
  // frame. So the dialog should show the same "Source references" chip
  // list that image targets use, and hide Veo's source-image selector.
  const isOmniVideo = isVideo && videoModelFamily === "omni_flash";
  // Prompt nodes are text-only — clicking Generate runs auto_prompt
  // synthesis from upstream context and writes the result back to
  // node.data.prompt. No image dispatch, no aspect/variants.
  const isPrompt = targetType === "prompt";

  // Find upstream source image for video nodes (including across prompt/note pass-through nodes).
  const sourceNode = isVideo
    ? (() => {
        const direct = edges
          .filter((e) => e.target === rfId)
          .map((e) => nodes.find((candidate) => candidate.id === e.source))
          .find(
            (source) =>
              source &&
              REF_SOURCE_TYPES.has(source.data.type) &&
              (source.data.mediaId || source.data.mediaIds?.some(Boolean)),
          );
        if (direct) return direct;
        return collectUpstreamRefEntries(rfId, nodes, edges)[0]?.node;
      })()
    : undefined;

  // Storyboard → video: when ANY upstream node is a Storyboard composite,
  // the motion prompt MUST follow a fixed template that asks Flow to
  // animate the panels in order. 2x2→4 frames; 2x3→6; 2x4→8. Other
  // refs (character / location / visual_asset) still flow as normal —
  // the prompt itself is what's locked. Pick the first storyboard
  // upstream's grid (multi-storyboard edges are an edge case we don't
  // optimize for).
  const storyboardUpstream = isVideo
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => nodes.find((n) => n.id === e.source))
        .find((n) => n?.data.type === "Storyboard")
    : undefined;
  const hasStoryboardUpstream = !!storyboardUpstream && !initialPrompt.trim() && !videoDraft?.prompt.trim();
  const storyboardUpstreamGrid = normaliseStoryboardGrid(
    storyboardUpstream?.data.storyboardGrid,
  );
  const sourceMediaId = sourceNode?.data.mediaId ?? null;
  // Drop null placeholders from the upstream variant list — partial-
  // batch results may carry them, but downstream dispatch needs a
  // dense array of valid mediaIds to feed into Flow.
  const sourceMediaIds: string[] = isVideo
    ? (sourceNode?.data.mediaIds ?? (sourceMediaId ? [sourceMediaId] : []))
        .filter((m): m is string => typeof m === "string" && m.length > 0)
    : [];

  // Image nodes: list every upstream ref edge feeding this target. We
  // walk edges (not just nodes) so we can read each edge's variant pin
  // and show the EXACT thumbnail Flow will receive — when an edge is
  // pinned to variant 2 of a 4-variant source, the chip shows variant 2,
  // not the source's "active" mediaId. Mirrors the resolution used by
  // `collectUpstreamRefMediaIds` at dispatch time so the preview can't
  // diverge from the actual API call.
  //
  // We also surface the full `allVariants` list + the edge id so the
  // chip can offer a per-source variant picker without re-querying
  // the store on click.
  // Prompt sources — text-only upstream nodes whose `prompt` feeds the
  // auto-prompt synth as context. They have no mediaId so they live in a
  // separate list from refSourceNodes; the dialog renders them as a
  // text-only chip alongside image refs so the user can SEE that a
  // Prompt node is influencing the gen.
  // Both image targets AND Omni-video targets use the ingredient chip
  // list (multi-ref upstream → one chip per edge). Veo i2v video has
  // its own single-source-with-variant-batch picker below.
  const promptSourceNodes = !isPrompt && rfId
    ? edges
        .filter((e) => e.target === rfId)
        .map((e) => {
          const n = nodes.find((node) => node.id === e.source);
          if (!n || n.data.type !== "prompt") return null;
          const text = typeof n.data.prompt === "string" ? n.data.prompt : "";
          return { edgeId: e.id, node: n, text };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    : [];

  const upstreamPromptText =
    !isPrompt && !isStoryboard && rfId
      ? collectUpstreamPromptText(rfId, nodes, edges)
      : "";

  const refSourceNodes = (!isVideo || isOmniVideo) && rfId
    ? collectUpstreamRefEntries(rfId, nodes, edges)
    : [];

  const allVideoRefEntries = isVideo && rfId
    ? collectUpstreamRefEntries(rfId, nodes, edges)
    : [];

  const videoCandidateFrames = (() => {
    const out: Array<{ mediaId: string; label: string; isVideo: boolean }> = [];
    const seen = new Set<string>();
    for (const entry of allVideoRefEntries) {
      const baseTitle = displayNodeTitle(entry.node.data.title, entry.node.data.type);
      const isVidSrc = entry.node.data.type === "video";
      const pool = entry.allVariants.length > 0 ? entry.allVariants : [entry.mediaId];
      pool.forEach((mid, vIdx) => {
        if (!mid || seen.has(mid)) return;
        seen.add(mid);
        out.push({
          mediaId: mid,
          label: pool.length > 1 ? `${baseTitle} #${entry.node.data.shortId} · v${vIdx + 1}` : `${baseTitle} #${entry.node.data.shortId}`,
          isVideo: isVidSrc,
        });
      });
    }
    return out;
  })();

  const hasVideoUpstream =
    sourceNode?.data.type === "video" ||
    refSourceNodes.some((r) => r.node.data.type === "video");

  // Reset form when dialog opens for a different node
  useEffect(() => {
    if (rfId !== null) {
      // Default: whatever prompt the caller seeded (last-saved on the node,
      // or inherited from upstream 文本 node if empty). Storyboard→video overrides
      // this below with the locked motion template.
      const boardEdges = useBoardStore.getState().edges;
      const boardNodes = useBoardStore.getState().nodes;
      const openNode = boardNodes.find((n) => n.id === rfId);
      const openNodeType = openNode?.data.type ?? "image";
      let nextPrompt = initialPrompt;
      let isStoryboardAuto = false;
      if (openNodeType === "video") {
        const sb = boardEdges
          .filter((e) => e.target === rfId)
          .map((e) => boardNodes.find((n) => n.id === e.source))
          .find((n) => n?.data.type === "Storyboard");
        if (sb && !initialPrompt.trim()) {
          const g = normaliseStoryboardGrid(sb.data.storyboardGrid);
          nextPrompt = buildStoryboardVideoPrompt(g);
          isStoryboardAuto = true;
        }
      }
      if (
        !nextPrompt.trim() &&
        openNodeType !== "prompt" &&
        openNodeType !== "Storyboard" &&
        !isStoryboardAuto
      ) {
        const inheritedText = collectUpstreamPromptText(rfId, boardNodes, boardEdges);
        if (inheritedText) {
          nextPrompt = inheritedText;
        }
      }
      promptManuallyEditedRef.current = !!initialPrompt.trim() && !isStoryboardAuto;
      setPrompt(nextPrompt);
      setPendingAiConfirm(false);
      setPreAiPrompt(null);
      setPendingBatchPrompts(undefined);
      setVideoRefFrame("last");
      // Character → preserve saved aspect, else match upstream ref aspect when linked, else 1:1.
      // Image / video → preserve node's saved aspectRatio first, else match
      // upstream aspect when available, else default landscape.
      const validAspects = openNodeType === "video" ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS;
      const savedAspect = openNode?.data.aspectRatio;
      let nextAspect: AspectKey;
      if (typeof savedAspect === "string" && validAspects.some((a) => a.key === savedAspect)) {
        nextAspect = savedAspect as AspectKey;
      } else {
        const inherited = pickDefaultAspect(
          rfId,
          openNodeType,
          nodes,
          useBoardStore.getState().edges,
        );
        if (inherited !== null) {
          nextAspect = inherited;
        } else if (openNodeType === "character") {
          nextAspect = "IMAGE_ASPECT_RATIO_SQUARE";
        } else if (openNodeType === "video") {
          nextAspect = (defaultVideoAspect || "VIDEO_ASPECT_RATIO_LANDSCAPE") as AspectKey;
        } else {
          nextAspect = (defaultImageAspect || "IMAGE_ASPECT_RATIO_LANDSCAPE") as AspectKey;
        }
      }
      setAspectRatio(nextAspect);
      const savedVariants = openNode?.data.variantCount;
      setVariants(
        typeof savedVariants === "number" && savedVariants >= 1 && savedVariants <= 4
          ? savedVariants
          : openNodeType === "video"
          ? defaultVideoCount
          : defaultImageCount,
      );
      setCamera("static");
      // Hydrate storyboard grid from existing node data when reopening.
      // Fresh nodes + legacy values ("3x3" from 1.2.15-1.2.18) → "2x2".
      const openNodeData = useBoardStore
        .getState()
        .nodes.find((n) => n.id === rfId)?.data;
      setStoryboardGrid(normaliseStoryboardGrid(openNodeData?.storyboardGrid));
      setStoryboardMode(normaliseStoryboardMode(openNodeData?.storyboardMode));
      setVideoSubMode("auto");
      setAudioOpen(false);
      setDialogueText("");
      setSfxText("");
      setAtSuggestOpen(false);
      setSeedInput(openNodeData?.seed != null ? String(openNodeData.seed) : "");
      setTemplateFormOpen(false);
      setEditingTemplateId(null);
      setTplTitleDraft("");
      setTplPromptDraft("");
      lastAppliedTemplateRef.current = null;
      setAutoBuilding(false);
      setAutoPromptUsed(false);
      // Default-select every upstream source variant for video targets so
      // the user just hits Generate when they want all videos.
      if (!inline) {
        const trigger = document.activeElement;
        const timer = window.setTimeout(() => (firstFocusRef.current ?? dialogRef.current)?.focus(), 50);
        return () => {
          window.clearTimeout(timer);
          if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
        };
      }
    }
  // Only reset the draft on a new session, not on canvas updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfId, inline]);

  // React to an explicit chat/quick-edit handoff even when this node was already selected.
  // Do not reset the draft on unrelated account polls or board updates.
  useEffect(() => {
    if (isVideo && inline && videoDraft && videoDraft.prompt.trim()) {
      promptManuallyEditedRef.current = true;
      setPrompt(videoDraft.prompt);
      setPendingAiConfirm(false);
      setPreAiPrompt(null);
    }
  }, [isVideo, inline, videoDraft]);

  // 文本 -> 图片 / 主体 / 视频：在用户未手动编辑且未点 AI 润色前，上游文本连线或编辑时自动同步继承。
  useEffect(() => {
    if (
      !isPrompt &&
      !isStoryboard &&
      !hasStoryboardUpstream &&
      !promptManuallyEditedRef.current &&
      upstreamPromptText &&
      upstreamPromptText !== prompt
    ) {
      setPrompt(upstreamPromptText);
    }
  }, [
    upstreamPromptText,
    isPrompt,
    isStoryboard,
    hasStoryboardUpstream,
    prompt,
  ]);

  // Veo 3.1 原生不支持 360p（Flow 接口会返回 [3]）；自动将残留 360p 升级到 720p。
  useEffect(() => {
    if (isVideo && !isOmniVideo && videoResolution === "360p") {
      setVideoResolution("720p");
    }
  }, [isVideo, isOmniVideo, videoResolution, setVideoResolution]);

  // Auto-expand textarea height with prompt content so longer Chinese/bilingual
  // descriptions remain comfortably readable without tight inner scrollbars.
  useEffect(() => {
    const el = firstFocusRef.current;
    if (!el) return;
    el.style.height = "auto";
    const minH = inline ? 104 : 136;
    const maxH = inline ? 220 : 280;
    const nextH = Math.min(maxH, Math.max(minH, el.scrollHeight));
    el.style.height = `${nextH}px`;
  }, [prompt, inline, rfId]);

  const sourceKey = JSON.stringify(sourceMediaIds);
  const candidateKey = JSON.stringify(videoCandidateFrames.map((c) => c.mediaId));
  useEffect(() => {
    const ids: string[] = JSON.parse(candidateKey);
    if (ids.length >= 2) {
      setFirstFrameId((prev) => (prev && ids.includes(prev) ? prev : ids[0]));
      setLastFrameId((prev) => (prev && ids.includes(prev) ? prev : ids[1]));
    } else {
      setFirstFrameId(ids[0] ?? "");
      setLastFrameId("");
      setVideoSubMode((prev) => (prev === "first_last" ? "auto" : prev));
    }
  }, [rfId, candidateKey]);

  const sourcePin = edges.find(e => e.target === rfId && e.source === sourceNode?.id)?.data?.sourceVariantIdx;
  const pinnedMedia = typeof sourcePin === "number" ? sourceNode?.data.mediaIds?.[sourcePin] : null;
  useEffect(() => {
    const ids: string[] = JSON.parse(sourceKey);
    const pin = pinnedMedia ? ids.indexOf(pinnedMedia) : -1;
    setSelectedSourceIdx(new Set(pin >= 0 ? [pin] : ids.map((_, i) => i)));
  }, [rfId, sourceKey, pinnedMedia]);

  // Keyboard handling
  useEffect(() => {
    if (inline) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // ESC closes the variant picker first if open, otherwise the
        // dialog. Lets the user back out of a stray picker click
        // without losing their prompt + form state.
        if (openVariantPicker !== null) {
          e.preventDefault();
          setOpenVariantPicker(null);
          return;
        }
        e.preventDefault();
        closeGenerationDialog();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!e.isComposing && canGenerate) void handleSubmit();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Click-outside to close the variant picker. We listen on
  // `mousedown` instead of `click` so the close fires BEFORE the chip's
  // `onClick` toggle would otherwise re-open it on the same gesture.
  // A click that lands inside any `.ref-source-chip-wrap` is ignored —
  // chip-internal handlers (toggle / swap / pick) own those.
  useEffect(() => {
    if (openVariantPicker === null) return;
    const onPointerDown = (e: Event) => {
      const node = e.target as Node | null;
      const target = node instanceof Element ? node : node?.parentElement ?? null;
      if (target?.closest(".ref-source-chip-wrap")) return;
      setOpenVariantPicker(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [openVariantPicker]);

  // Focus trap
  useEffect(() => {
    if (inline) return;
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
  }, [rfId, inline]);

  if (!node) return null;

  function persistNodeDraftPatch(patch: Partial<FlowboardNodeData>) {
    useBoardStore.getState().updateNodeData(rfId, patch);
    const dbId = parseInt(rfId, 10);
    if (!isNaN(dbId)) {
      patchNode(dbId, { data: patch }).catch(() => {});
    }
  }

  function updateAspectRatio(next: AspectKey) {
    setAspectRatio(next);
    persistNodeDraftPatch({ aspectRatio: next });
  }

  function updateVariants(next: number) {
    setVariants(next);
    persistNodeDraftPatch({ variantCount: next });
  }

  /** Pick a different variant on a Source Reference chip. PATCHes the
   * edge so the dispatch path picks the new variant, then mirrors the
   * change into the local store so the chip thumbnail updates without
   * waiting for a board refresh. The pick also surfaces on the canvas
   * via the `v{N}` chip on the edge. */
  async function pickVariantForEdge(edgeId: string, variantIdx: number) {
    setOpenVariantPicker(null);
    const edgeDbId = parseInt(edgeId, 10);
    if (isNaN(edgeDbId)) return;
    try {
      const updated = await patchEdge(edgeDbId, {
        source_variant_idx: variantIdx,
      });
      useBoardStore.getState().updateEdgeData(edgeId, {
        sourceVariantIdx: updated.source_variant_idx,
      });
    } catch (err) {
      useGenerationStore.setState({
        error: `切换参考变体失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  const selectedVideoId = resolveVideoSelectionId(
    videoModelFamily,
    omniVersion,
    videoQuality,
  );
  const selectedVideoEntry = findVideoModelEntry(selectedVideoId);
  const selectedImageEntry = findImageModelEntry(imageModel);

  function applyVideoSelection(id: VideoModelCatalogEntry["id"]) {
    const entry = findVideoModelEntry(id);
    setVideoModel(entry.videoModel);
    if (entry.omniVersion) setOmniVersion(entry.omniVersion);
    if (entry.videoQuality) setVideoQuality(entry.videoQuality);
    if (entry.videoModel === "veo" && videoResolution === "360p") {
      setVideoResolution("720p");
    }
  }

  const activeVideoDuration = isOmniVideo ? omniFlashDuration : 8;

  function handleSelectVideoDuration(nextSec: number) {
    const clamped = Math.min(15, Math.max(3, Math.round(nextSec))) as OmniFlashDuration;
    if (!isOmniVideo) {
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

  function parseOptionalSeed(): number | undefined {
    const raw = seedInput.trim();
    if (!raw || !/^\d+$/.test(raw)) return undefined;
    const val = Number(raw);
    return Number.isSafeInteger(val) ? val : undefined;
  }

  function handleAppendChinesePreset(snippet: string) {
    if (isWorking || queued || hasStoryboardUpstream) return;
    const base = prompt.trim();
    const next = base ? `${base}，${snippet}` : snippet;
    const clipped = next.slice(0, PROMPT_MAX_LENGTH);
    promptManuallyEditedRef.current = true;
    setPendingBatchPrompts(undefined);
    setPrompt(clipped);
    if (inline) persistNodeDraftPatch({ prompt: clipped });
  }

  function handleRevertPreAiPrompt() {
    if (preAiPrompt === null) return;
    const restored = preAiPrompt;
    setPrompt(restored);
    setPreAiPrompt(null);
    setPendingAiConfirm(false);
    setAutoPromptUsed(false);
    setPendingBatchPrompts(undefined);
    promptManuallyEditedRef.current = !!restored.trim();
    if (inline) persistNodeDraftPatch({ prompt: restored });
    window.requestAnimationFrame(() => firstFocusRef.current?.focus());
  }

  function handleApplySubjectTemplate(tpl: {
    prompt: string;
    recommendedAspect?: AspectKey;
  }) {
    if (isWorking || queued) return;
    if (prompt.trim() && prompt.trim() !== tpl.prompt.trim()) {
      setPreAiPrompt(prompt);
    }
    const nextPrompt = applySubjectTemplateText(
      prompt,
      tpl.prompt,
      lastAppliedTemplateRef.current,
      PROMPT_MAX_LENGTH,
    );
    lastAppliedTemplateRef.current = tpl.prompt;
    promptManuallyEditedRef.current = true;
    setPendingBatchPrompts(undefined);
    setAutoPromptUsed(false);
    setPrompt(nextPrompt);
    if (tpl.recommendedAspect && refSourceNodes.length === 0) {
      updateAspectRatio(tpl.recommendedAspect);
    }
    if (inline) persistNodeDraftPatch({ prompt: nextPrompt });
    window.requestAnimationFrame(() => firstFocusRef.current?.focus());
  }

  function handleOpenCreateTemplate() {
    setEditingTemplateId(null);
    setTplTitleDraft("");
    setTplPromptDraft(prompt.trim());
    setTemplateFormOpen(true);
  }

  function handleOpenEditTemplate(tpl: CustomSubjectTemplate) {
    setEditingTemplateId(tpl.id);
    setTplTitleDraft(tpl.title);
    setTplPromptDraft(tpl.prompt);
    setTemplateFormOpen(true);
  }

  function handleSaveTemplateDraft() {
    const cleanTitle = tplTitleDraft.trim();
    const cleanPrompt = tplPromptDraft.trim();
    if (!cleanTitle || !cleanPrompt) return;
    if (editingTemplateId) {
      updateCustomTemplate(editingTemplateId, cleanTitle, cleanPrompt);
    } else {
      const created = addCustomTemplate(cleanTitle, cleanPrompt);
      if (created && !prompt.trim()) {
        lastAppliedTemplateRef.current = created.prompt;
        promptManuallyEditedRef.current = true;
        setPrompt(created.prompt);
        if (inline) persistNodeDraftPatch({ prompt: created.prompt });
      }
    }
    setSubjectTab("custom");
    setTemplateFormOpen(false);
    setEditingTemplateId(null);
  }

  async function handleAiPolish() {
    if (isWorking || queued || hasStoryboardUpstream) return;
    const dbId = parseInt(rfId, 10);
    const seedText = prompt.trim();
    setPreAiPrompt(prompt);
    setPendingBatchPrompts(undefined);
    setAutoBuilding(true);
    if (!isNaN(dbId)) {
      useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "pending" });
    }
    try {
      if (!isNaN(dbId)) {
        const res = await autoPromptApi(dbId, {
          camera: isVideo ? camera : undefined,
          seedPrompt: seedText || undefined,
          allowFallback: true,
          durationSeconds: isVideo ? activeVideoDuration : undefined,
        });
        const nextPrompt = res.prompt.slice(0, PROMPT_MAX_LENGTH);
        promptManuallyEditedRef.current = true;
        setPrompt(nextPrompt);
        setAutoPromptUsed(true);
        setPendingAiConfirm(true);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
        if (inline) persistNodeDraftPatch({ prompt: nextPrompt });
        window.requestAnimationFrame(() => firstFocusRef.current?.focus());
      } else {
        throw new Error("unsaved node");
      }
    } catch {
      const localPatch = isVideo
        ? "主体动作连贯流畅，电影级自然光影流转，真实物理景深视差，画面稳定高清"
        : "电影级布光与自然通透色彩，材质与边缘细节清晰锐利，和谐比例构图，真实质感摄影";
      const nextPrompt = (seedText ? `${seedText}，${localPatch}` : localPatch).slice(0, PROMPT_MAX_LENGTH);
      promptManuallyEditedRef.current = true;
      setPrompt(nextPrompt);
      setAutoPromptUsed(true);
      setPendingAiConfirm(true);
      useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
      if (inline) persistNodeDraftPatch({ prompt: nextPrompt });
      window.requestAnimationFrame(() => firstFocusRef.current?.focus());
    } finally {
      setAutoBuilding(false);
    }
  }

  async function handleSubmit() {
    if (!canGenerate || submitLock.current) return;
    submitLock.current = true;
    try {
      await submitGeneration();
    } finally {
      submitLock.current = false;
    }
  }

  async function submitGeneration() {
    // Defense in depth — block submit if the LLM layer is still composing
    // for this node from a prior dialog session. The Generate button is
    // already `disabled` at this point, but the user could still trigger
    // ⌘↵ via keyboard.
    if (
      node?.data.autoPromptStatus === "pending"
      || node?.data.aiBriefStatus === "pending"
    ) {
      return;
    }
    const parsedSeed = parseOptionalSeed();
    if (isStoryboard) {
      // Storyboard is a thin image-node wrapper. The user's prompt
      // textarea is the TOPIC; we wrap it in the locked template and
      // dispatch via the standard image path — Flow renders a single
      // composite NxN grid that visually narrates the topic.
      const wrapped = buildStoryboardPrompt(
        prompt,
        storyboardGrid,
        aspectRatio,
        storyboardMode,
      );
      // Persist the chosen grid + mode + topic on the node so reload shows
      // the same settings and `StoryboardBody` can render the badges.
      useBoardStore.getState().updateNodeData(rfId, {
        storyboardGrid,
        storyboardMode,
        aiBrief: prompt,
      });
      const dbId = parseInt(rfId, 10);
      if (!isNaN(dbId)) {
        patchNode(dbId, {
          data: { storyboardGrid, storyboardMode, aiBrief: prompt },
        }).catch(() => {});
      }
      const dispatch = dispatchGeneration(rfId, {
        prompt: wrapped,
        aspectRatio,
        kind: "image",
        variantCount: variants,
        imageModel,
        imageResolution,
        thinkingLevel: imageThinkingLevel,
        seed: parsedSeed,
      });
      closeGenerationDialog();
      return dispatch;
    }
    if (isPrompt) {
      // Prompt nodes are user-authored seed text. The dialog is just
      // an editor — Save persists whatever the user typed (or cleared).
      // No auto-synth, no image/video dispatch. Downstream image/video
      // nodes pick up this prompt as upstream context at their own
      // dispatch time.
      const dbId = parseInt(rfId, 10);
      if (isNaN(dbId)) {
        closeGenerationDialog();
        return;
      }
      const status = prompt.trim() ? "done" : "idle";
      try {
        await patchNode(dbId, { status, data: { prompt } });
        useBoardStore.getState().updateNodeData(rfId, { prompt, status });
        closeGenerationDialog();
      } catch (err) {
        useGenerationStore.setState({ error: `保存文本失败：${err instanceof Error ? err.message : String(err)}` });
      }
      return;
    }
    // Image / Subject (character) / Video branch:
    // 1. If user typed/edited a prompt (or already confirmed AI output), dispatch directly.
    // 2. If empty and linked to upstream 文本 node(s), inherit upstream text verbatim (NO AI polish!).
    // 3. Otherwise ask AI to compose a draft prompt, populate textarea, and STOP for manual confirmation.
    let finalPrompt = prompt;
    const perVariantPrompts = pendingBatchPrompts;
    if (!finalPrompt.trim()) {
      if (upstreamPromptText) {
        finalPrompt = upstreamPromptText;
        setPrompt(finalPrompt);
      } else {
        const dbId = parseInt(rfId, 10);
        if (isNaN(dbId)) {
          return;
        }
        setPreAiPrompt(prompt);
        setAutoBuilding(true);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "pending" });
        try {
          if (!isVideo && variants > 1) {
            const res = await autoPromptBatchApi(dbId, variants, { allowFallback: true });
            const nextText = res.prompts.join("\n\n— 变体 —\n\n").slice(0, PROMPT_MAX_LENGTH);
            setPendingBatchPrompts(res.prompts);
            setPrompt(nextText);
          } else {
            const res = await autoPromptApi(dbId, {
              camera: isVideo ? camera : undefined,
              allowFallback: true,
              durationSeconds: isVideo ? activeVideoDuration : undefined,
            });
            setPendingBatchPrompts(undefined);
            setPrompt(res.prompt.slice(0, PROMPT_MAX_LENGTH));
          }
          promptManuallyEditedRef.current = true;
          setAutoPromptUsed(true);
          setPendingAiConfirm(true);
          useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
          setAutoBuilding(false);
          window.requestAnimationFrame(() => firstFocusRef.current?.focus());
          return;
        } catch (err) {
          setAutoBuilding(false);
          useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "failed" });
          useGenerationStore.setState({
            error: err instanceof Error
              ? `AI 润色提示词失败：${err.message}`
              : "AI 润色提示词失败",
          });
          return;
        }
      }
    }
    setPendingAiConfirm(false);
    setPreAiPrompt(null);
    setPendingBatchPrompts(undefined);
    closeGenerationDialog();
    if (isVideo) {
      const videoPrompt = composeVideoPromptWithDirectives({
        prompt: finalPrompt,
        cameraKey: camera,
        dialogue: dialogueText,
        sfx: sfxText,
      });
      const isT2v = videoCandidateFrames.length === 0 || videoSubMode === "t2v";
      const isFirstLast =
        videoSubMode === "first_last" &&
        Boolean(firstFrameId && lastFrameId && firstFrameId !== lastFrameId);
      const picked = sourceMediaIds.filter((_, i) => selectedSourceIdx.has(i));
      const useMulti = picked.length > 1;
      return dispatchGeneration(rfId, {
        prompt: videoPrompt,
        aspectRatio,
        kind: "video",
        flowAccountId: account?.id,
        flowProjectId: account?.project_id ?? undefined,
        videoSubMode: isFirstLast ? "first_last" : isT2v ? "t2v" : "auto",
        sourceMediaId: isFirstLast ? firstFrameId : useMulti ? undefined : picked[0],
        endMediaId: isFirstLast ? lastFrameId : undefined,
        sourceMediaIds: !isFirstLast && useMulti ? picked : undefined,
        variantCount: !isFirstLast && !isT2v && useMulti ? picked.length : variants,
        videoModel: videoModelFamily,
        videoQuality,
        omniVersion,
        durationSeconds: omniFlashDuration,
        videoResolution,
        videoRefFrame: hasVideoUpstream ? videoRefFrame : undefined,
      });
    } else {
      return dispatchGeneration(rfId, {
        prompt: finalPrompt,
        aspectRatio,
        variantCount: variants,
        prompts: perVariantPrompts,
        imageModel,
        imageResolution,
        thinkingLevel: imageThinkingLevel,
        seed: parsedSeed,
        videoRefFrame: hasVideoUpstream ? videoRefFrame : undefined,
      });
    }
  }

  function insertRefMentionTag(refIdxOneBased: number) {
    if (isWorking || queued || hasStoryboardUpstream) return;
    const tag = `@图${refIdxOneBased} `;
    const ta = firstFocusRef.current;
    let next = prompt;
    if (ta && typeof ta.selectionStart === "number") {
      const start = ta.selectionStart;
      const end = ta.selectionEnd ?? start;
      const before = prompt.slice(0, start).replace(/@(?:图\s*)?$/, "");
      const after = prompt.slice(end);
      next = `${before}${before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : ""}${tag}${after}`;
    } else {
      next = prompt.replace(/@(?:图\s*)?$/, "");
      next = next ? `${next.trimEnd()} ${tag}` : tag;
    }
    const clipped = next.slice(0, PROMPT_MAX_LENGTH);
    promptManuallyEditedRef.current = true;
    setPrompt(clipped);
    setAtSuggestOpen(false);
    if (inline) persistNodeDraftPatch({ prompt: clipped });
    window.requestAnimationFrame(() => ta?.focus());
  }

  const nodeLLMBusy =
    node?.data.autoPromptStatus === "pending"
    || node?.data.aiBriefStatus === "pending";
  const isWorking = autoBuilding || nodeLLMBusy;

  const isVideoTextMode = isVideo && (videoCandidateFrames.length === 0 || videoSubMode === "t2v");
  const isVideoFirstLastMode = isVideo && videoSubMode === "first_last" && videoCandidateFrames.length >= 2;
  const queued = node.data.status === "queued" || node.data.status === "running";
  const canGenerate = !queued && !isWorking && (!isVideo || !accountIssue) && (isCharacter
    ? prompt.trim().length > 0 || refSourceNodes.length > 0 || Boolean(upstreamPromptText)
    : isVideoFirstLastMode
    ? Boolean(firstFrameId && lastFrameId && firstFrameId !== lastFrameId)
    : isVideoTextMode
    ? prompt.trim().length > 0
    : isOmniVideo
    ? refSourceNodes.length > 0 && !isWorking
    : isVideo
    ? sourceMediaIds.some((_, idx) => selectedSourceIdx.has(idx))
    : true);

  const visibleOfficialTemplates =
    subjectCategory === "all"
      ? OFFICIAL_SUBJECT_TEMPLATES
      : OFFICIAL_SUBJECT_TEMPLATES.filter((t) => t.category === subjectCategory);

  const subjectTemplatesSection = isCharacter ? (
    <div className="gen-dialog__field jm-subject-tpl">
      <div className="jm-subject-tpl__header">
        <div className="jm-subject-tpl__tabs" role="tablist" aria-label="主体模板来源">
          <button
            type="button"
            role="tab"
            aria-selected={subjectTab === "official"}
            className={`jm-subject-tpl__tab${subjectTab === "official" ? " jm-subject-tpl__tab--active" : ""}`}
            onClick={() => setSubjectTab("official")}
          >
            官方推荐模板
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subjectTab === "custom"}
            className={`jm-subject-tpl__tab${subjectTab === "custom" ? " jm-subject-tpl__tab--active" : ""}`}
            onClick={() => setSubjectTab("custom")}
          >
            自定义模板 ({customSubjectTemplates.length})
          </button>
        </div>
        <button
          type="button"
          className="jm-subject-tpl__add-btn"
          onClick={handleOpenCreateTemplate}
          disabled={isWorking || queued}
          title="将当前提示词保存为自定义主体模板，或新建专属设定模板"
        >
          + {prompt.trim() ? "存为模板" : "新建模板"}
        </button>
      </div>

      {templateFormOpen && (
        <div className="jm-subject-tpl__editor" role="region" aria-label="编辑自定义主体模板">
          <input
            type="text"
            className="jm-subject-tpl__input"
            maxLength={40}
            value={tplTitleDraft}
            onChange={(e) => setTplTitleDraft(e.target.value)}
            placeholder="模板名称（如：赛博二次元女主立绘 / 品牌吉祥物设定）"
            aria-label="自定义模板名称"
          />
          <textarea
            className="jm-subject-tpl__textarea"
            rows={2}
            maxLength={PROMPT_MAX_LENGTH}
            value={tplPromptDraft}
            onChange={(e) => setTplPromptDraft(e.target.value)}
            placeholder="输入可复用的主体设定提示词（支持二次元、3D、写实、萌宠、道具等任意风格）…"
            aria-label="自定义模板提示词"
          />
          <div className="jm-subject-tpl__editor-actions">
            <button
              type="button"
              className="gen-dialog__revert-btn"
              onClick={() => {
                setTemplateFormOpen(false);
                setEditingTemplateId(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="jm-subject-tpl__save-btn"
              disabled={!tplTitleDraft.trim() || !tplPromptDraft.trim()}
              onClick={handleSaveTemplateDraft}
            >
              {editingTemplateId ? "保存修改" : "保存模板"}
            </button>
          </div>
        </div>
      )}

      {subjectTab === "official" ? (
        <>
          <div className="jm-subject-tpl__cats" aria-label="官方模板分类">
            {SUBJECT_TEMPLATE_CATEGORIES.map((cat) => (
              <button
                key={cat.key}
                type="button"
                className={`jm-subject-tpl__cat${subjectCategory === cat.key ? " jm-subject-tpl__cat--active" : ""}`}
                onClick={() => setSubjectCategory(cat.key)}
              >
                {cat.label}
              </button>
            ))}
          </div>
          <div className={`jm-subject-tpl__grid${inline ? " jm-subject-tpl__grid--inline" : ""}`}>
            {visibleOfficialTemplates.map((tpl) => {
              const isApplied = prompt.trim() === tpl.prompt.trim() || prompt.startsWith(tpl.prompt);
              return (
                <button
                  key={tpl.id}
                  type="button"
                  className={`jm-subject-tpl__card${isApplied ? " jm-subject-tpl__card--active" : ""}`}
                  onClick={() => handleApplySubjectTemplate(tpl)}
                  disabled={isWorking || queued}
                  title={`${tpl.summary}\n\n点击插入模板提示词，插入后可自由增删角色细节`}
                >
                  <div className="jm-subject-tpl__card-top">
                    <span className="jm-subject-tpl__card-title">{tpl.title}</span>
                    <span className="jm-subject-tpl__badge">{tpl.badge}</span>
                  </div>
                  {!inline && <p className="jm-subject-tpl__card-desc">{tpl.summary}</p>}
                </button>
              );
            })}
          </div>
        </>
      ) : customSubjectTemplates.length === 0 ? (
        <div className="jm-subject-tpl__empty">
          暂无自定义模板。可在下方输入常用动漫/角色/IP设定词后点击右上角「+ 存为模板」，方便随时一键复用。
        </div>
      ) : (
        <div className={`jm-subject-tpl__grid${inline ? " jm-subject-tpl__grid--inline" : ""}`}>
          {customSubjectTemplates.map((tpl) => {
            const isApplied = prompt.trim() === tpl.prompt.trim() || prompt.startsWith(tpl.prompt);
            return (
              <div
                key={tpl.id}
                className={`jm-subject-tpl__card jm-subject-tpl__card--custom${isApplied ? " jm-subject-tpl__card--active" : ""}`}
              >
                <button
                  type="button"
                  className="jm-subject-tpl__custom-pick"
                  onClick={() => handleApplySubjectTemplate(tpl)}
                  disabled={isWorking || queued}
                  title={tpl.prompt}
                >
                  <span className="jm-subject-tpl__card-title">{tpl.title}</span>
                  {!inline && (
                    <span className="jm-subject-tpl__card-desc">
                      {tpl.prompt.length > 54 ? `${tpl.prompt.slice(0, 54)}…` : tpl.prompt}
                    </span>
                  )}
                </button>
                <div className="jm-subject-tpl__custom-actions">
                  <button
                    type="button"
                    className="jm-subject-tpl__icon-btn"
                    onClick={() => handleOpenEditTemplate(tpl)}
                    title="编辑此自定义模板"
                    aria-label={`编辑模板 ${tpl.title}`}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="jm-subject-tpl__icon-btn jm-subject-tpl__icon-btn--del"
                    onClick={() => removeCustomTemplate(tpl.id)}
                    title="删除此自定义模板"
                    aria-label={`删除模板 ${tpl.title}`}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  const promptField = (
    <div className="gen-dialog__field">
      <div className="gen-dialog__label-row">
        <label className="gen-dialog__label" htmlFor={promptId}>
          {isVideo
            ? "动作与运镜提示词"
            : isStoryboard
            ? "故事主题与分镜描述"
            : isCharacter
            ? "主体设定提示词（支持动漫 / 3D / 真人 / 萌宠 / 道具）"
            : "画面提示词"}
          {autoPromptUsed && (
            <span className="gen-dialog__auto-badge" title="已根据上游参考节点自动合成中文提示词">
              ✨ 中文智绘
            </span>
          )}
        </label>
        <div className="gen-dialog__label-actions">
          {!hasStoryboardUpstream && preAiPrompt !== null && (
            <button
              type="button"
              className="gen-dialog__revert-btn"
              onClick={handleRevertPreAiPrompt}
              disabled={isWorking || queued}
              title="撤销上次润色或模板套用，恢复原提示词"
            >
              ↩ 还原原词
            </button>
          )}
          {!hasStoryboardUpstream && (
            <button
              type="button"
              className="gen-dialog__zh-btn"
              onClick={() => void handleAiPolish()}
              disabled={isWorking || queued}
              title="结合上游素材与当前关键词进行 AI 润色，润色后需人工确认再生成"
            >
              ✨ AI 润色
            </button>
          )}
          <span className="gen-dialog__char-count">
            {prompt.length}/{PROMPT_MAX_LENGTH}
          </span>
        </div>
      </div>
      {pendingAiConfirm && !isWorking && !hasStoryboardUpstream && (
        <div className="gen-dialog__confirm-banner" role="status">
          <span>✨ AI 已润色/生成提示词，请检查或微调后点击「确认生成」</span>
        </div>
      )}
      <textarea
        id={promptId}
        ref={firstFocusRef}
        className="gen-dialog__textarea"
        rows={inline ? 4 : 5}
        maxLength={PROMPT_MAX_LENGTH}
        value={prompt}
        onChange={(e) => {
          const val = e.target.value;
          const cursor = e.target.selectionStart ?? val.length;
          const beforeCursor = val.slice(0, cursor);
          setAtSuggestOpen(refSourceNodes.length > 0 && /@(?:图\s*)?$/.test(beforeCursor));
          promptManuallyEditedRef.current = true;
          setPrompt(val);
          if (pendingBatchPrompts) setPendingBatchPrompts(undefined);
          if (autoPromptUsed) setAutoPromptUsed(false);
        }}
        onBlur={() => {
          if (inline && !hasStoryboardUpstream && prompt !== (node?.data.prompt ?? "")) {
            persistNodeDraftPatch({ prompt });
          }
        }}
        placeholder={
          upstreamPromptText
            ? "已默认继承上游文本节点提示词，可直接生成，或点击「✨ AI 润色」"
            : isCharacter
            ? "点击上方官方/自定义模板一键插入，或自由描述动漫角色、3D/游戏人物、真人定妆、萌宠与核心道具特征（也可连线参考图提纯主体）…"
            : isVideo
            ? videoCandidateFrames.length === 0
              ? "当前无上游参考图，已自动启用 Flow 纯文生视频（YhhmEf）：请直接描述画面主体、动态与镜头运动…"
              : "输入中文运镜与动作描述（支持输入 @ 引用上游图1/图2），或留空生成 AI 润色草稿 ✨"
            : isPrompt
            ? "输入中文灵感描述，连线后自动继承给下游生图/生视频节点…"
            : isStoryboard
            ? "输入中文剧情脚本（如：清晨拆箱 → 试穿展示 → 街头漫步）…"
            : "输入中文关键词（有参考图时可输入 @ 引用 @图1/@图2），或留空先由 AI 润色草稿 ✨"
        }
        disabled={isWorking}
        readOnly={hasStoryboardUpstream}
        title={
          hasStoryboardUpstream
            ? "已锁定：故事板连线视频将自动按分镜顺序逐格演绎动画"
            : undefined
        }
      />
      {atSuggestOpen && refSourceNodes.length > 0 && !hasStoryboardUpstream && (
        <div className="gen-dialog__at-bar" role="listbox" aria-label="选择要引用的上游参考图">
          <span className="gen-dialog__at-hint">点选插入参考图标记：</span>
          {refSourceNodes.map((r, rIdx) => (
            <button
              key={r.edgeId}
              type="button"
              className="gen-dialog__preset-chip gen-dialog__at-chip"
              onMouseDown={(e) => {
                e.preventDefault();
                insertRefMentionTag(rIdx + 1);
              }}
            >
              @图{rIdx + 1} · #{r.node.data.shortId}
            </button>
          ))}
        </div>
      )}
      {isVideo && !hasStoryboardUpstream && (
        <div className="gen-dialog__audio-slot">
          <button
            type="button"
            className={`gen-dialog__preset-chip${audioOpen || dialogueText || sfxText ? " gen-dialog__preset-chip--active" : ""}`}
            onClick={() => setAudioOpen((v) => !v)}
            title="展开/收起角色原生对白台词与环境音效输入槽（适配 Veo / Omni 原生声画同步）"
          >
            {audioOpen ? "▾ 收起台词与音效" : "🎙️ + 台词与音效预设"}
            {(dialogueText.trim() || sfxText.trim()) ? "（已填写）" : ""}
          </button>
          {audioOpen && (
            <div className="gen-dialog__audio-fields">
              <input
                type="text"
                className="gen-dialog__seed-input"
                value={dialogueText}
                onChange={(e) => setDialogueText(e.target.value)}
                placeholder="角色口型对白台词（如：这束光终于照进来了）…"
                maxLength={300}
              />
              <input
                type="text"
                className="gen-dialog__seed-input"
                value={sfxText}
                onChange={(e) => setSfxText(e.target.value)}
                placeholder="环境音与音效（如：细雨落瓦、轻柔钢琴弦乐、城市车流低噪）…"
                maxLength={300}
              />
            </div>
          )}
        </div>
      )}
      {!hasStoryboardUpstream && (
        <div className="gen-dialog__preset-row" aria-label="中文快捷提示词补充">
          {CHINESE_PROMPT_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="gen-dialog__preset-chip"
              onClick={() => handleAppendChinesePreset(preset.snippet)}
              disabled={isWorking || queued}
              title={preset.snippet}
            >
              + {preset.label}
            </button>
          ))}
        </div>
      )}
      {hasStoryboardUpstream && (
        <p className="gen-dialog__hint gen-dialog__hint--locked">
          🎬 <strong>故事板动态演绎模板已启用</strong> —— 检测到上游连接了故事板节点，将按顺序串联演绎全部{" "}
          {totalPanels(storyboardUpstreamGrid)} 个分镜画面，其他角色与参考素材仍正常生效。
        </p>
      )}
      {isWorking && (
        <p className="gen-dialog__hint">
          {node?.data.aiBriefStatus === "pending"
            ? "✨ 正在解析上游参考图像…"
            : "✨ 正在结合上游上下文构思提示词…"}
        </p>
      )}
    </div>
  );

  const references = (<>
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

        {isVideo && !isOmniVideo && !isVideoFirstLastMode && !isVideoTextMode && (
          <div className="gen-dialog__field">
            <div className="gen-dialog__label-row">
              <span className="gen-dialog__label">
                {sourceNode?.data.type === "video" ? "源视频参考" : "源图像变体"}
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
                        <span className="source-thumb__check" aria-hidden="true">
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

        {(refSourceNodes.length > 0 || promptSourceNodes.length > 0)
          && (
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
                      <span className="ref-source-chip__prompt-icon" aria-hidden="true">✦</span>
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
                const refTitle = displayNodeTitle(r.node.data.title, r.node.data.type);
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
                                isCurrent ? " ref-source-chip__picker-item--current" : ""
                              }`}
                              onClick={() => void pickVariantForEdge(r.edgeId, i)}
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

  </>);

  const liveCredits = account?.credits ?? null;
  const showCreditsPill =
    !isPrompt && (isVideo || mediaProvider === "flow") && liveCredits !== null;

  const effectiveVideoCount = isOmniVideo
    ? variants
    : selectedSourceIdx.size > 1
      ? selectedSourceIdx.size
      : variants;
  const costEstimate =
    !isPrompt && (isVideo || mediaProvider === "flow")
      ? isVideo
        ? estimateVideoCreditCost({
            videoModel: videoModelFamily,
            omniVersion,
            videoQuality,
            durationSeconds: omniFlashDuration,
            videoResolution,
            count: effectiveVideoCount,
            paygateTier,
          })
        : estimateImageCreditCost({
            imageModel,
            imageResolution,
            count: variants,
          })
      : null;

  if (inline) {
    const unavailable = isCharacter
      ? "请选择推荐/自定义模板、填写主体特征描述，或连线参考图。"
      : isVideoFirstLastMode
        ? "请选择两个不同的首帧与尾帧参考。"
        : isVideoTextMode
          ? "请输入视频主体、动作与镜头描述以进行纯文生视频。"
          : isOmniVideo
            ? "请连线至少一张参考图或视频。"
            : isVideo
              ? "请连线并勾选至少一个图片或视频参考，或移除参考直接文生视频。"
              : undefined;
    const inlineHint = isVideo && accountIssue
      ? accountIssue
      : !canGenerate && !queued && !isWorking && unavailable
        ? unavailable
        : undefined;
    return (
      <section
        className="jm-context-generator nodrag nopan nowheel"
        aria-label="上下文生成控制栏"
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && openVariantPicker !== null) {
            event.stopPropagation();
            setOpenVariantPicker(null);
            return;
          }
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey &&
              ((!isVideo && event.target instanceof HTMLTextAreaElement) || event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat && canGenerate) void handleSubmit();
          }
          if (event.key === "Backspace" || event.key === "Delete") event.stopPropagation();
        }}
      >
        {references}
        {subjectTemplatesSection}
        {promptField}
        {inlineHint && (
          <p className="jm-context-generator__hint">{inlineHint}</p>
        )}
        <div className="jm-context-generator__tools">
          {mediaProvider === "flow" && !isVideo && !isPrompt && (
            <>
              <select
                aria-label="图片模型"
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value as ImageModelKey)}
              >
                {IMAGE_MODEL_CATALOG.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="图片清晰度"
                value={imageResolution}
                onChange={(e) => setImageResolution(e.target.value as ImageResolutionKey)}
              >
                {IMAGE_RESOLUTION_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              {imageModel === "NANO_BANANA_2_1" && (
                <select
                  aria-label="思考深度"
                  value={imageThinkingLevel}
                  onChange={(e) => setImageThinkingLevel(e.target.value as ImageThinkingLevel)}
                >
                  {IMAGE_THINKING_OPTIONS.map((t) => (
                    <option key={t.value} value={t.value}>
                      推理:{t.label}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          {isVideo && (
            <>
              <select
                aria-label="视频模型"
                value={selectedVideoId}
                onChange={(e) => applyVideoSelection(e.target.value as VideoModelCatalogEntry["id"])}
              >
                {VIDEO_MODEL_CATALOG.map((m) => {
                  const locked = !!m.ultraOnly && paygateTier !== "PAYGATE_TIER_TWO";
                  return (
                    <option key={m.id} value={m.id} disabled={locked}>
                      {m.label}
                      {m.deprecationNote ? " · 12/5停用" : m.ultraOnly ? " · Ultra 0积分" : ""}
                    </option>
                  );
                })}
              </select>
              <select
                aria-label="视频分辨率"
                value={!isOmniVideo && videoResolution === "360p" ? "720p" : videoResolution}
                onChange={(e) => setVideoResolution(e.target.value as VideoResolutionKey)}
              >
                {VIDEO_RESOLUTION_OPTIONS.map((r) => {
                  const unsupported = !!r.omniOnly && !isOmniVideo;
                  return (
                    <option key={r.value} value={r.value} disabled={unsupported}>
                      {unsupported ? `${r.label}（仅 Omni）` : r.label}
                    </option>
                  );
                })}
              </select>
            </>
          )}
          {!isPrompt && (
            <select
              aria-label="画幅比例"
              value={aspectRatio}
              onChange={(e) => updateAspectRatio(e.target.value as AspectKey)}
            >
              {(isVideo ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS).map(({ key, label }) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          )}
          {isVideo ? (
            <select aria-label="镜头运动" value={camera} onChange={(e) => setCamera(e.target.value as CameraKey)}>
              {CAMERA_MOVEMENTS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
          ) : !isPrompt && (
            <select aria-label="生成数量" value={variants} onChange={(e) => updateVariants(Number(e.target.value))}>
              {OUTPUT_COUNT_OPTIONS.map((count) => <option key={count} value={count}>x{count} 张</option>)}
            </select>
          )}
          {isStoryboard && (
            <>
              <select aria-label="分镜宫格" value={storyboardGrid} onChange={(e) => setStoryboardGrid(e.target.value as StoryboardGrid)}>
                {STORYBOARD_GRIDS.map((grid) => <option key={grid} value={grid}>{totalPanels(grid)} 格</option>)}
              </select>
              <select
                aria-label="分镜模式"
                value={storyboardMode}
                onChange={(e) => setStoryboardMode(e.target.value as StoryboardMode)}
                title="剧情连贯分镜按情节顺推，同场多机位锁定同人同景切换 9 种电影机位"
              >
                <option value="narrative">剧情连贯</option>
                <option value="multicam">同场多机位</option>
              </select>
            </>
          )}
          {isVideo && (isVideoFirstLastMode || isVideoTextMode) && (
            <span className="jm-context-generator__badge jm-context-generator__badge--cyan">
              {isVideoFirstLastMode ? "⇄ 首尾帧锁定" : "✦ 纯文生视频"}
            </span>
          )}
          {isVideo && (
            <select
              aria-label="生成时长"
              value={activeVideoDuration}
              onChange={(e) => handleSelectVideoDuration(Number(e.target.value))}
              title={
                isOmniVideo
                  ? "选择视频生成时长（3–15 秒，选择非常规档位将自动匹配 Omni 1.2）"
                  : "Veo 3.1 固定 8 秒；选择其他秒数将自动切换为 Omni 1.2 Flash"
              }
            >
              {OMNI_1_2_DURATIONS.map((duration) => {
                const label = !isOmniVideo
                  ? duration === 8
                    ? "8 秒"
                    : `${duration} 秒 · Omni 1.2`
                  : omniVersion === "1.1" && ![4, 6, 8, 10].includes(duration)
                    ? `${duration} 秒 · 升1.2`
                    : `${duration} 秒`;
                return (
                  <option key={duration} value={duration}>
                    {label}
                  </option>
                );
              })}
            </select>
          )}
          {isVideo && (isOmniVideo || selectedSourceIdx.size <= 1) && (
            <select
              aria-label="视频输出数量"
              value={variants}
              onChange={(e) => updateVariants(Number(e.target.value))}
            >
              {OUTPUT_COUNT_OPTIONS.map((count) => (
                <option key={count} value={count}>x{count} 条</option>
              ))}
            </select>
          )}
          {!isVideo && !isPrompt && (
            <select aria-label="渲染引擎" value={mediaProvider} onChange={(e) => setMediaProvider(e.target.value as MediaProviderKey)}>
              <option value="flow">Flow</option><option value="muse">Muse</option>
            </select>
          )}
          {costEstimate && (
            <span
              className={`jm-cost-pill${costEstimate.isZero ? " jm-cost-pill--zero" : ""}`}
              title={costEstimate.breakdown}
            >
              {costEstimate.displayText}
            </span>
          )}
          {showCreditsPill && (
            <button
              type="button"
              className="jm-credits-pill"
              onClick={() => void useFlowAccounts.getState().syncCredits()}
              title="点击刷新 Flow 实时积分余额"
            >
              积分余额 {liveCredits!.toLocaleString("zh-CN")}
            </button>
          )}
          <button
            type="button"
            className={`jm-context-generator__submit${pendingAiConfirm ? " jm-context-generator__submit--confirm" : ""}`}
            disabled={!canGenerate}
            onClick={() => void handleSubmit()}
            aria-label={isPrompt ? "保存文本" : pendingAiConfirm ? "确认生成" : "立即生成"}
            title={
              isPrompt
                ? "保存文本（回车）"
                : pendingAiConfirm
                  ? "确认 AI 润色后的提示词并提交生成"
                  : isVideo
                    ? "使用当前 Flow 账号生成（Ctrl / ⌘ + 回车）"
                    : "立即生成（回车）"
            }
          >
            {isWorking
              ? "构思中…"
              : queued
                ? node.data.status === "queued"
                  ? "排队中…"
                  : "生成中…"
                : isPrompt
                  ? "保存"
                  : pendingAiConfirm
                    ? "确认生成"
                    : isVideo
                      ? "生成视频"
                      : "↑"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeGenerationDialog();
      }}
    >
      <div
        className="gen-dialog"
        role="dialog"
        aria-labelledby={titleId}
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="gen-dialog__header">
          <div>
            <h2 id={titleId} className="gen-dialog__title">
              {isVideo
                ? "生成视频"
                : isCharacter
                ? "生成主体设定"
                : isStoryboard
                ? "生成分镜故事板"
                : isPrompt
                ? "编辑文本提示词"
                : "生成图片"}
            </h2>
            <span className="gen-dialog__subtitle">
              节点 #{node?.data.shortId ?? rfId}
            </span>
          </div>
          <button
            className="gen-dialog__close"
            onClick={closeGenerationDialog}
            aria-label="关闭窗口 (ESC)"
          >
            ✕
          </button>
        </div>

        <div className="gen-dialog__body">
        {subjectTemplatesSection}
        {promptField}
        {references}

        {isVideo && accountIssue && (
          <p className="gen-dialog__hint" role="status">{accountIssue}</p>
        )}
        {!isVideo && !isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              渲染引擎
              <InfoTip tip="Flow：通过 Chrome 扩展桥接 Google Flow 渲染；Muse：通过本地配置的 muse2api 网关或 worker 渲染。" />
            </span>
            <div className="aspect-chip-row">
              <button
                key="flow"
                type="button"
                className={`aspect-chip${mediaProvider === "flow" ? " aspect-chip--active" : ""}`}
                onClick={() => setMediaProvider("flow")}
              >
                Flow
              </button>
              <button
                key="muse"
                type="button"
                className={`aspect-chip${mediaProvider === "muse" ? " aspect-chip--active" : ""}`}
                onClick={() => setMediaProvider("muse")}
              >
                Muse
              </button>

            </div>
            </div>
        )}

        {!isVideo && !isPrompt && mediaProvider === "flow" && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              照片模型
              <InfoTip tip="切换后同步为默认照片模型。Pro 主力写实与汉字；2.1 支持思考深度；Lite 极速批量抽卡。" />
            </span>
            <select
              className="gen-dialog__select"
              value={imageModel}
              onChange={(e) => setImageModel(e.target.value as ImageModelKey)}
            >
              {IMAGE_MODEL_CATALOG.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}（{m.officialBadge}）
                </option>
              ))}
            </select>
            <div className="gen-dialog__model-note">
              {selectedImageEntry.deprecationNote && (
                <div className="gen-dialog__model-deprecation">{selectedImageEntry.deprecationNote}</div>
              )}
              <div>画质：{selectedImageEntry.qualityTier} · 速度：{selectedImageEntry.speedTier}</div>
              <div>积分：{selectedImageEntry.creditTag}</div>
              <div>适用：{selectedImageEntry.bestFor}</div>
            </div>
          </div>
        )}

        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">画幅比例</span>
            <div className="aspect-chip-row">
              {(isVideo ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS).map((ar) => (
                <button
                  key={ar.key}
                  className={`aspect-chip${aspectRatio === ar.key ? " aspect-chip--active" : ""}`}
                  onClick={() => updateAspectRatio(ar.key)}
                  type="button"
                >
                  {ar.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!isVideo && !isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              图片清晰度
              <InfoTip tip="1K 原生极速直出；2K/4K 将在生成完成后调用官方 SPrCad 超清重塑。" />
            </span>
            <div className="aspect-chip-row">
              {IMAGE_RESOLUTION_OPTIONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  className={`aspect-chip${imageResolution === r.value ? " aspect-chip--active" : ""}`}
                  onClick={() => setImageResolution(r.value)}
                  title={r.hint}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!isVideo && !isPrompt && imageModel === "NANO_BANANA_2_1" && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              思考深度（Nano Banana 2.1）
              <InfoTip tip="提升思考深度可显著改善多主体空间逻辑与文字构图精度。" />
            </span>
            <div className="aspect-chip-row">
              {IMAGE_THINKING_OPTIONS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  className={`aspect-chip${imageThinkingLevel === t.value ? " aspect-chip--active" : ""}`}
                  onClick={() => setImageThinkingLevel(t.value)}
                  title={t.hint}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              视频模型
              <InfoTip tip="含官方停用提示与场景画质建议；Omni 支持多参考图，Veo 3.1 适合首尾帧图生视频。" />
            </span>
            <select
              className="gen-dialog__select"
              value={selectedVideoId}
              onChange={(e) => applyVideoSelection(e.target.value as VideoModelCatalogEntry["id"])}
            >
              {VIDEO_MODEL_CATALOG.map((m) => {
                const locked = !!m.ultraOnly && paygateTier !== "PAYGATE_TIER_TWO";
                return (
                  <option key={m.id} value={m.id} disabled={locked}>
                    {m.label}
                    {m.deprecationNote ? `（${m.deprecationNote}）` : m.ultraOnly ? "（仅限 Ultra · 0 积分）" : ""}
                  </option>
                );
              })}
            </select>
            <div className="gen-dialog__model-note">
              {selectedVideoEntry.deprecationNote && (
                <div className="gen-dialog__model-deprecation">{selectedVideoEntry.deprecationNote}</div>
              )}
              <div>画质：{selectedVideoEntry.qualityTier} · {selectedVideoEntry.speedTier}</div>
              <div>积分：{selectedVideoEntry.creditTag}</div>
              <div>适用：{selectedVideoEntry.bestFor}</div>
            </div>
          </div>
        )}

        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              视频分辨率
              <InfoTip tip="360p/720p 为原生输出；1080p/4K 先出 720p 成片后再自动调用官方超分（需对应会员权限）。" />
            </span>
            <div className="aspect-chip-row">
              {VIDEO_RESOLUTION_OPTIONS.map((r) => {
                const unsupported = !!r.omniOnly && !isOmniVideo;
                return (
                  <button
                    key={r.value}
                    type="button"
                    className={`aspect-chip${videoResolution === r.value ? " aspect-chip--active" : ""}`}
                    onClick={() => setVideoResolution(r.value)}
                    disabled={unsupported}
                    title={unsupported ? "仅 Omni Flash 支持 360p，Veo 3.1 原生 720p 起" : r.hint}
                  >
                    {unsupported ? `${r.label} (仅Omni)` : r.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              {isOmniVideo ? `生成时长 (Omni ${omniVersion})` : "生成时长（支持 3–15 秒调节）"}
              <InfoTip
                tip={
                  isOmniVideo
                    ? omniVersion === "1.2"
                      ? "Omni 1.2 Flash 支持 3–15 秒连续时长（11–15 秒需 Plus/Ultra）。"
                      : "Omni 1.1 Flash 原生支持 4/6/8/10 秒；选其他秒数将自动升级至 Omni 1.2 Flash。"
                    : "Veo 3.1 官方固定 8 秒；拖动滑块或点选其他秒数将自动切换至支持 3–15 秒的 Omni 1.2 Flash。"
                }
              />
            </span>
            <div className="gen-dialog__duration-control">
              <div className="gen-dialog__duration-slider-row">
                <input
                  type="range"
                  className="gen-dialog__duration-slider"
                  min={3}
                  max={15}
                  step={1}
                  value={activeVideoDuration}
                  onChange={(e) => handleSelectVideoDuration(Number(e.target.value))}
                  aria-label="视频时长滑块"
                />
                <span className="gen-dialog__duration-readout">
                  {activeVideoDuration} 秒
                  {isOmniVideo && (omniVersion === "1.2" ? OMNI_1_2_CREDIT_COST[activeVideoDuration] : OMNI_1_1_CREDIT_COST[activeVideoDuration]) != null
                    ? ` · ${omniVersion === "1.2" ? OMNI_1_2_CREDIT_COST[activeVideoDuration] : OMNI_1_1_CREDIT_COST[activeVideoDuration]}积分/条`
                    : ""}
                </span>
              </div>
              <div className="aspect-chip-row">
                {OMNI_1_2_DURATIONS.map((d) => {
                  const active = activeVideoDuration === d;
                  const perClipCost = isOmniVideo
                    ? omniVersion === "1.2"
                      ? OMNI_1_2_CREDIT_COST[d]
                      : OMNI_1_1_CREDIT_COST[d]
                    : undefined;
                  const creditSuffix = perClipCost != null ? ` · ${perClipCost}积分` : "";
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`aspect-chip${active ? " aspect-chip--active" : ""}`}
                      onClick={() => handleSelectVideoDuration(d)}
                    >
                      {d}秒{creditSuffix}
                    </button>
                  );
                })}
              </div>
              {!isOmniVideo && (
                <p className="gen-dialog__hint">
                  Veo 3.1 官方固定 8 秒；选择任意非 8 秒时长将自动切换至 Omni 1.2 Flash。
                </p>
              )}
            </div>
          </div>
        )}

        {isVideo && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              镜头运动
              <InfoTip tip="固定机位：锁定画幅不推拉摇移，适合电商商品展示防止裁切；动态运镜：由 AI 根据场景自动设计推轨/摇移运镜。" />
            </span>
            <div className="aspect-chip-row">
              {CAMERA_MOVEMENTS.map((c) => (
                <button
                  key={c.key}
                  className={`aspect-chip${camera === c.key ? " aspect-chip--active" : ""}`}
                  onClick={() => setCamera(c.key)}
                  type="button"
                  title={c.instruction}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">输出数量</span>
            {isVideo && !isOmniVideo && selectedSourceIdx.size > 1 ? (
              <div className="aspect-chip-row">
                <span className="jm-context-generator__badge">
                  已选 {selectedSourceIdx.size} 张参考帧（每帧生成 1 条，共 {selectedSourceIdx.size} 条）
                </span>
              </div>
            ) : (
              <div className="aspect-chip-row">
                {OUTPUT_COUNT_OPTIONS.map((cnt) => (
                  <button
                    key={cnt}
                    type="button"
                    className={`aspect-chip${variants === cnt ? " aspect-chip--active" : ""}`}
                    onClick={() => updateVariants(cnt)}
                  >
                    x{cnt}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!isVideo && !isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              固定随机种子（Seed，可选）
              <InfoTip tip="填入正整数可复现相近构图与随机噪点分布；留空由 Flow 自动随机采样。" />
            </span>
            <input
              type="text"
              inputMode="numeric"
              className="gen-dialog__seed-input"
              value={seedInput}
              onChange={(e) => setSeedInput(e.target.value.replace(/[^\d]/g, "").slice(0, 12))}
              placeholder="留空随机生成（或输入如 421088 以复现种子）"
            />
          </div>
        )}

        {isStoryboard && (
          <>
            <div className="gen-dialog__field">
              <span className="gen-dialog__label">
                分镜模式
                <InfoTip tip="剧情连贯：按时间推进演绎前后情节；同场多机位：锁定同一人物与场景同步拍摄多机位角度，生成后可一键切分。" />
              </span>
              <div className="aspect-chip-row">
                <button
                  type="button"
                  className={`aspect-chip${storyboardMode === "narrative" ? " aspect-chip--active" : ""}`}
                  onClick={() => setStoryboardMode("narrative")}
                >
                  剧情连贯分镜
                </button>
                <button
                  type="button"
                  className={`aspect-chip${storyboardMode === "multicam" ? " aspect-chip--active" : ""}`}
                  onClick={() => setStoryboardMode("multicam")}
                >
                  同场多机位（可切分重用）
                </button>
              </div>
            </div>
            <div className="gen-dialog__field">
              <span className="gen-dialog__label">
                分镜宫格布局
                <InfoTip tip="故事板将以单张高清多宫格分镜图渲染输出，3×3 为九宫格标准方阵，生成后支持一键无损切分为独立节点。" />
              </span>
              <div className="aspect-chip-row">
                {STORYBOARD_GRIDS.map((g) => {
                  const total = totalPanels(g);
                  const isPortrait = aspectRatio.includes("PORTRAIT");
                  let dimsLabel = "2×2";
                  if (g === "3x3") {
                    dimsLabel = "3×3";
                  } else if (g !== "2x2") {
                    const big = g === "2x3" ? 3 : 4;
                    dimsLabel = isPortrait ? `${big}×2` : `2×${big}`;
                  }
                  return (
                    <button
                      key={g}
                      type="button"
                      className={`aspect-chip${storyboardGrid === g ? " aspect-chip--active" : ""}`}
                      onClick={() => setStoryboardGrid(g)}
                      title={`${total} 格分镜 (${dimsLabel})`}
                    >
                      {dimsLabel} · {total} 格
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
        </div>

        {/* Footer */}
        <div className="gen-dialog__footer">
          <span className="gen-dialog__board-ctx">
            {boardName === "Untitled" || !boardName ? "未命名项目" : boardName} · 共 {nodeCount} 个节点
          </span>
          {costEstimate && (
            <span
              className={`jm-cost-pill${costEstimate.isZero ? " jm-cost-pill--zero" : ""}`}
              title={costEstimate.breakdown}
            >
              {costEstimate.displayText}
            </span>
          )}
          {showCreditsPill && (
            <button
              type="button"
              className="jm-credits-pill"
              onClick={() => void useFlowAccounts.getState().syncCredits()}
              title="点击刷新 Flow 实时积分余额"
            >
              积分余额 {liveCredits!.toLocaleString("zh-CN")}
            </button>
          )}
          <button
            className="gen-dialog__cta"
            type="button"
            onClick={handleSubmit}
            disabled={!canGenerate}
            title={
              nodeLLMBusy && !autoBuilding
                ? "后台正在合成提示词，请稍候"
                : undefined
            }
          >
            {isWorking
              ? "构思中…"
              : isPrompt
              ? "保存文本 ⌘↵"
              : pendingAiConfirm
              ? "确认并生成 ⌘↵"
              : "立即生成 ⌘↵"}
          </button>
        </div>
      </div>
    </div>
  );
}
