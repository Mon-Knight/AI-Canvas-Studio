import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  collectUpstreamPromptText,
  collectUpstreamRefEntries,
  useGenerationStore,
  type VideoSubMode,
} from "../store/generation";
import { type VideoRefFrameMode } from "../lib/videoFrame";
import { useFlowAccounts } from "../store/flowAccounts";
import { useBoardStore, type FlowboardNodeData, type StoryboardGrid, type StoryboardMode } from "../store/board";
import { useReferencesStore } from "../store/references";
import { displayNodeTitle } from "../constants/nodeLabels";
import {
  STORYBOARD_GRIDS,
  buildStoryboardPrompt,
  buildStoryboardVideoPrompt,
  normaliseStoryboardGrid,
  normaliseStoryboardMode,
  totalPanels,
} from "../lib/storyboardPrompt";
import { composeVideoPromptWithDirectives } from "../lib/promptMentions";
import { sanitizePromptForFlowSafetyClient } from "../lib/promptSafety";
import { pickImageFiles } from "../lib/filePicker";
import { filterDirectorSkills, type DirectorSkillEntry } from "../constants/directorSkills";
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
  IMAGE_MODEL_CATALOG,
  IMAGE_RESOLUTION_OPTIONS,
  IMAGE_THINKING_OPTIONS,
  OMNI_1_2_DURATIONS,
  OUTPUT_COUNT_OPTIONS,
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
  uploadImage,
} from "../api/client";
import { requestAutoBrief } from "../api/autoBrief";
import { applySubjectTemplateText } from "../constants/character";
import {
  CHARACTER_VOICE_PRESETS,
  collectUpstreamCharacterVoices,
  resolveCharacterVoiceDirective,
  resolveCharacterVoiceLabel,
} from "../constants/characterVoice";
import {
  CAMERA_MOVEMENTS,
  IMAGE_ASPECT_RATIOS,
  PROMPT_MAX_LENGTH,
  VIDEO_ASPECT_RATIOS,
  pickDefaultAspect,
  type AspectKey,
  type CameraKey,
} from "./generation/aspectHelpers";
import { SubjectTemplatesPanel } from "./generation/SubjectTemplatesPanel";
import { UpstreamReferencesSection } from "./generation/UpstreamReferencesSection";
import { ModalParameterControls } from "./generation/ModalParameterControls";
import { MusicComposerPanel } from "./generation/MusicComposerPanel";

const REF_SOURCE_TYPES = new Set([
  "character",
  "image",
  "visual_asset",
  "Storyboard",
  "video",
]);

interface PendingVideoConfirmPayload {
  modeLabel: string;
  modelLabel: string;
  resolutionLabel: string;
  durationSec: number;
  clipCount: number;
  audioModeLabel: string;
  costDisplay: string;
  costBreakdown: string;
  costTotal: number | null;
  accountLabel: string;
  finalPrompt: string;
  dispatchOpts: Parameters<
    ReturnType<typeof useGenerationStore.getState>["dispatchGeneration"]
  >[1];
}

export type GenerationComposerVariant = "dropdown" | "sidebar" | "modal";

export function GenerationDialog() {
  const { rfId, prompt } = useGenerationStore((s) => s.openDialog);
  const close = useGenerationStore((s) => s.closeGenerationDialog);
  const targetNode = useBoardStore((s) => (rfId ? s.nodes.find((n) => n.id === rfId) : undefined));
  if (rfId === null) return null;
  if (targetNode?.data.type === "audio") {
    return <MusicComposerPanel key={rfId} rfId={rfId} initialPrompt={prompt} onClose={close} />;
  }
  return <GenerationComposer key={rfId} rfId={rfId} initialPrompt={prompt} onClose={close} variant="modal" />;
}

export function GenerationComposer({
  rfId,
  initialPrompt,
  onClose,
  inline = false,
  variant,
}: {
  rfId: string;
  initialPrompt: string;
  onClose?: () => void;
  inline?: boolean;
  variant?: GenerationComposerVariant;
}) {
  const resolvedVariant: GenerationComposerVariant =
    variant ?? (inline ? "dropdown" : "modal");
  const isDropdown = resolvedVariant === "dropdown";
  const isSidebar = resolvedVariant === "sidebar";
  const isEmbedded = resolvedVariant !== "modal";
  const closeGenerationDialog = () => onClose?.();
  const promptId = useId();
  const titleId = useId();
  const dispatchGeneration = useGenerationStore((s) => s.dispatchGeneration);
  const openResultViewer = useGenerationStore((s) => s.openResultViewer);
  const nodes = useBoardStore((s) => s.nodes);

  const [prompt, setPrompt] = useState(initialPrompt);
  const [aspectRatio, setAspectRatio] = useState<AspectKey>("IMAGE_ASPECT_RATIO_LANDSCAPE");
  const [variants, setVariants] = useState(1);
  const [camera, setCamera] = useState<CameraKey>("dynamic");
  // Storyboard layout. The node dispatches via the standard image
  // handler with a locked template prompt wrapping the user's topic
  // into a single composite NxN grid. See lib/storyboardPrompt.ts.
  const [storyboardGrid, setStoryboardGrid] = useState<StoryboardGrid>("2x2");
  const [storyboardMode, setStoryboardMode] = useState<StoryboardMode>("narrative");
  const [videoSubMode, setVideoSubMode] = useState<VideoSubMode>("auto");
  const [firstFrameId, setFirstFrameId] = useState("");
  const [lastFrameId, setLastFrameId] = useState("");
  const [audioOpen, setAudioOpen] = useState(false);
  const [dialogueText, setDialogueText] = useState("");
  const [sfxText, setSfxText] = useState("");
  const [silentVideo, setSilentVideo] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voicePreset, setVoicePreset] = useState("");
  const [voiceCustom, setVoiceCustom] = useState("");
  const [atSuggestOpen, setAtSuggestOpen] = useState(false);
  const [slashSkillOpen, setSlashSkillOpen] = useState(false);
  const [shelfCollapsed, setShelfCollapsed] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [subjectTplOpen, setSubjectTplOpen] = useState(false);
  const [addRefMenuOpen, setAddRefMenuOpen] = useState(false);
  const [uploadingRef, setUploadingRef] = useState(false);

  const lastAppliedTemplateRef = useRef<string | null>(null);

  // Auto-prompt state — set when AI polish or auto-synth produces text.
  // Always requires manual human confirmation (`pendingAiConfirm`) before dispatch.
  const [autoBuilding, setAutoBuilding] = useState(false);
  const [autoPromptUsed, setAutoPromptUsed] = useState(false);
  const [pendingAiConfirm, setPendingAiConfirm] = useState(false);
  const [safetyAuditNotes, setSafetyAuditNotes] = useState<string[]>([]);
  const [preAiPrompt, setPreAiPrompt] = useState<string | null>(null);
  const [pendingBatchPrompts, setPendingBatchPrompts] = useState<string[] | undefined>(undefined);
  const [videoRefFrame, setVideoRefFrame] = useState<VideoRefFrameMode>("last");
  const [pendingVideoConfirm, setPendingVideoConfirm] = useState<PendingVideoConfirmPayload | null>(null);
  const [rememberNeverConfirm, setRememberNeverConfirm] = useState(false);

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
  const confirmBeforeVideoGen = useSettingsStore((s) => s.confirmBeforeVideoGen);
  const setConfirmBeforeVideoGen = useSettingsStore((s) => s.setConfirmBeforeVideoGen);
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

  const effectiveVideoMode: "t2v" | "ingredients" | "first_frame" | "first_last" =
    !isVideo
      ? "t2v"
      : videoCandidateFrames.length === 0 || videoSubMode === "t2v"
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

  const effectiveVideoOmni = isVideo && effectiveVideoMode === "ingredients";

  const refSourceNodes = (!isVideo || effectiveVideoOmni) && rfId
    ? collectUpstreamRefEntries(rfId, nodes, edges)
    : [];

  const hasVideoUpstream =
    sourceNode?.data.type === "video" ||
    allVideoRefEntries.some((r) => r.node.data.type === "video") ||
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
      setSafetyAuditNotes([]);
      setPreAiPrompt(null);
      setPendingBatchPrompts(undefined);
      setPendingVideoConfirm(null);
      setRememberNeverConfirm(false);
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
      setCamera("dynamic");
      // Hydrate storyboard grid from existing node data when reopening.
      // Fresh nodes + legacy values ("3x3" from 1.2.15-1.2.18) → "2x2".
      const openNodeData = useBoardStore
        .getState()
        .nodes.find((n) => n.id === rfId)?.data;
      setStoryboardGrid(normaliseStoryboardGrid(openNodeData?.storyboardGrid));
      setStoryboardMode(normaliseStoryboardMode(openNodeData?.storyboardMode));
      const savedSubMode = openNodeData?.videoSubMode;
      const upstreamEntriesAtOpen =
        openNodeType === "video"
          ? collectUpstreamRefEntries(rfId, boardNodes, boardEdges)
          : [];
      if (
        savedSubMode === "t2v" ||
        savedSubMode === "ingredients" ||
        savedSubMode === "first_frame" ||
        savedSubMode === "first_last"
      ) {
        setVideoSubMode(savedSubMode);
      } else if (openNodeType === "video") {
        // First-frame locking is optional: when upstream images exist, default
        // to non-locked Ingredients mode if Omni is active or multiple upstream
        // nodes are connected; single-image Veo starts in first_frame with 1-click
        // switching to Ingredients or pure T2V right at the top of the panel.
        if (upstreamEntriesAtOpen.length === 0) {
          setVideoSubMode("t2v");
        } else if (videoModelFamily === "omni_flash" || upstreamEntriesAtOpen.length >= 2) {
          setVideoSubMode("ingredients");
        } else {
          setVideoSubMode("first_frame");
        }
      } else {
        setVideoSubMode("auto");
      }
      setAudioOpen(false);
      setDialogueText("");
      setSfxText("");
      setSilentVideo(Boolean(openNodeData?.silentVideo));
      setVoiceOpen(false);
      setVoicePreset(typeof openNodeData?.voicePreset === "string" ? openNodeData.voicePreset : "");
      setVoiceCustom(typeof openNodeData?.voiceCustom === "string" ? openNodeData.voiceCustom : "");
      setAtSuggestOpen(false);
      setSlashSkillOpen(false);
      setPresetsOpen(false);
      setSubjectTplOpen(false);
      setAddRefMenuOpen(false);
      setSeedInput(openNodeData?.seed != null ? String(openNodeData.seed) : "");
      lastAppliedTemplateRef.current = null;
      setAutoBuilding(false);
      setAutoPromptUsed(false);
      if (resolvedVariant === "modal" || resolvedVariant === "dropdown") {
        const trigger = document.activeElement;
        const timer = window.setTimeout(() => (firstFocusRef.current ?? dialogRef.current)?.focus(), 40);
        return () => {
          window.clearTimeout(timer);
          if (resolvedVariant === "modal" && trigger instanceof HTMLElement && trigger.isConnected) {
            trigger.focus();
          }
        };
      }
    }
  // Only reset the draft on a new session, not on canvas updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfId, resolvedVariant]);

  // React to an explicit chat/quick-edit handoff even when this node was already selected.
  // Do not reset the draft on unrelated account polls or board updates.
  useEffect(() => {
    if (isVideo && isEmbedded && videoDraft && videoDraft.prompt.trim()) {
      promptManuallyEditedRef.current = true;
      setPrompt(videoDraft.prompt);
      setPendingAiConfirm(false);
      setPreAiPrompt(null);
    }
  }, [isVideo, isEmbedded, videoDraft]);

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
    const minH = isDropdown ? 56 : isSidebar ? 96 : 136;
    const maxH = isDropdown ? 168 : isSidebar ? 220 : 280;
    const nextH = Math.min(maxH, Math.max(minH, el.scrollHeight));
    el.style.height = `${nextH}px`;
  }, [prompt, isDropdown, isSidebar, rfId]);

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

  // Capture-phase keyboard handling for Video Confirmation Portal (works across dropdown/sidebar/modal)
  useEffect(() => {
    if (!pendingVideoConfirm) return;
    const onCaptureKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPendingVideoConfirm(null);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void confirmPendingVideoDispatch();
      }
    };
    document.addEventListener("keydown", onCaptureKey, true);
    return () => document.removeEventListener("keydown", onCaptureKey, true);
  });

  // Keyboard handling for modal & anchored dropdown
  useEffect(() => {
    if (isSidebar) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pendingVideoConfirm !== null) {
          e.preventDefault();
          setPendingVideoConfirm(null);
          return;
        }
        if (openVariantPicker !== null) {
          e.preventDefault();
          setOpenVariantPicker(null);
          return;
        }
        if (addRefMenuOpen) {
          e.preventDefault();
          setAddRefMenuOpen(false);
          return;
        }
        if (presetsOpen) {
          e.preventDefault();
          setPresetsOpen(false);
          return;
        }
        e.preventDefault();
        closeGenerationDialog();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (e.isComposing) return;
        if (pendingVideoConfirm) {
          void confirmPendingVideoDispatch();
        } else if (canGenerate) {
          void handleSubmit();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Click-outside to close variant picker and '+' add-ref mini-menu.
  useEffect(() => {
    if (openVariantPicker === null && !addRefMenuOpen) return;
    const onPointerDown = (e: Event) => {
      const node = e.target as Node | null;
      const target = node instanceof Element ? node : node?.parentElement ?? null;
      if (openVariantPicker !== null && !target?.closest(".ref-source-chip-wrap")) {
        setOpenVariantPicker(null);
      }
      if (addRefMenuOpen && !target?.closest(".jm-drop-add-wrap")) {
        setAddRefMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [openVariantPicker, addRefMenuOpen]);

  // Focus trap (modal only)
  useEffect(() => {
    if (isEmbedded) return;
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
  }, [rfId, isEmbedded]);

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

  const upstreamCharacterVoices = isVideo
    ? collectUpstreamCharacterVoices(rfId, nodes, edges)
    : [];
  const boundVoiceLabel = isCharacter
    ? resolveCharacterVoiceLabel(voicePreset, voiceCustom)
    : null;
  const boundVoiceDirective = isCharacter
    ? resolveCharacterVoiceDirective(voicePreset, voiceCustom)
    : "";

  function handleToggleSilentVideo(nextVal?: boolean) {
    const next = typeof nextVal === "boolean" ? nextVal : !silentVideo;
    setSilentVideo(next);
    persistNodeDraftPatch({ silentVideo: next });
  }

  function handleSelectVoicePreset(nextPreset: string) {
    setVoicePreset(nextPreset);
    if (!nextPreset) {
      setVoiceCustom("");
      persistNodeDraftPatch({ voicePreset: "", voiceCustom: "" });
      return;
    }
    persistNodeDraftPatch({ voicePreset: nextPreset });
  }

  function handleChangeVoiceCustom(nextCustom: string) {
    setVoiceCustom(nextCustom);
    const nextPreset = voicePreset || (nextCustom.trim() ? "custom" : "");
    if (nextPreset !== voicePreset) setVoicePreset(nextPreset);
  }

  function handleBlurVoiceCustom() {
    const trimmed = voiceCustom.trim();
    const nextPreset = voicePreset || (trimmed ? "custom" : "");
    persistNodeDraftPatch({ voicePreset: nextPreset, voiceCustom: trimmed });
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

  const effectiveVideoModelFamily =
    effectiveVideoMode === "ingredients"
      ? "omni_flash"
      : effectiveVideoMode === "first_frame"
        ? "veo"
        : videoModelFamily;

  const selectedVideoId = resolveVideoSelectionId(
    effectiveVideoModelFamily,
    omniVersion,
    videoQuality,
  );
  const selectedVideoEntry = findVideoModelEntry(selectedVideoId);
  const selectedImageEntry = findImageModelEntry(imageModel);

  function handleSelectVideoSubMode(nextMode: VideoSubMode) {
    setVideoSubMode(nextMode);
    persistNodeDraftPatch({ videoSubMode: nextMode });
    if (nextMode === "ingredients" && videoModelFamily !== "omni_flash") {
      setVideoModel("omni_flash");
      setOmniVersion("1.2");
    } else if (nextMode === "first_frame" && videoModelFamily !== "veo") {
      setVideoModel("veo");
      if (videoResolution === "360p") setVideoResolution("720p");
    }
  }

  function applyVideoSelection(id: VideoModelCatalogEntry["id"]) {
    const entry = findVideoModelEntry(id);
    setVideoModel(entry.videoModel);
    if (entry.omniVersion) setOmniVersion(entry.omniVersion);
    if (entry.videoQuality) setVideoQuality(entry.videoQuality);
    if (entry.videoModel === "veo" && videoResolution === "360p") {
      setVideoResolution("720p");
    }
    if (isVideo && videoCandidateFrames.length > 0) {
      if (entry.videoModel === "omni_flash" && effectiveVideoMode === "first_frame") {
        setVideoSubMode("ingredients");
        persistNodeDraftPatch({ videoSubMode: "ingredients" });
      } else if (entry.videoModel === "veo" && effectiveVideoMode === "ingredients") {
        setVideoSubMode("first_frame");
        persistNodeDraftPatch({ videoSubMode: "first_frame" });
      }
    }
  }

  const activeVideoDuration = effectiveVideoModelFamily === "omni_flash" ? omniFlashDuration : 8;

  function handleSelectVideoDuration(nextSec: number) {
    const clamped = Math.min(15, Math.max(3, Math.round(nextSec))) as OmniFlashDuration;
    if (effectiveVideoModelFamily !== "omni_flash") {
      if (clamped !== 8) {
        setVideoModel("omni_flash");
        setOmniVersion("1.2");
        if (videoCandidateFrames.length > 0 && effectiveVideoMode === "first_frame") {
          setVideoSubMode("ingredients");
          persistNodeDraftPatch({ videoSubMode: "ingredients" });
        }
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
    if (isEmbedded) persistNodeDraftPatch({ prompt: clipped });
  }

  function handleRevertPreAiPrompt() {
    if (preAiPrompt === null) return;
    const restored = preAiPrompt;
    setPrompt(restored);
    setPreAiPrompt(null);
    setPendingAiConfirm(false);
    setSafetyAuditNotes([]);
    setAutoPromptUsed(false);
    setPendingBatchPrompts(undefined);
    promptManuallyEditedRef.current = !!restored.trim();
    if (isEmbedded) persistNodeDraftPatch({ prompt: restored });
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
    if (isEmbedded) persistNodeDraftPatch({ prompt: nextPrompt });
    window.requestAnimationFrame(() => firstFocusRef.current?.focus());
  }

  function handleAutoFillCreatedTemplatePrompt(createdPrompt: string) {
    lastAppliedTemplateRef.current = createdPrompt;
    promptManuallyEditedRef.current = true;
    setPrompt(createdPrompt);
    if (isEmbedded) persistNodeDraftPatch({ prompt: createdPrompt });
  }

  async function handleAiPolish() {
    if (isWorking || queued || hasStoryboardUpstream) return;
    const dbId = parseInt(rfId, 10);
    const seedText = prompt.trim();
    setPreAiPrompt(prompt);
    setPendingBatchPrompts(undefined);
    setSafetyAuditNotes([]);
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
          silentVideo: isVideo ? silentVideo : undefined,
        });
        const nextPrompt = res.prompt.slice(0, PROMPT_MAX_LENGTH);
        promptManuallyEditedRef.current = true;
        setPrompt(nextPrompt);
        setAutoPromptUsed(true);
        setPendingAiConfirm(true);
        setSafetyAuditNotes(
          res.safety_rewritten
            ? (res.safety_notes?.length ? res.safety_notes : ["已自动优化敏感表达，降低审核拦截风险"])
            : [],
        );
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
        if (isEmbedded) persistNodeDraftPatch({ prompt: nextPrompt });
        window.requestAnimationFrame(() => firstFocusRef.current?.focus());
      } else {
        throw new Error("unsaved node");
      }
    } catch {
      const localPatch = isVideo
        ? silentVideo
          ? "主体动作连贯流畅，电影级自然光影流转，画面稳定高清，全程完全静音无声"
          : "主体动作连贯流畅，电影级自然光影流转，真实物理景深视差，画面稳定高清"
        : "电影级布光与自然通透色彩，材质与边缘细节清晰锐利，和谐比例构图，真实质感摄影";
      const rawLocal = seedText ? `${seedText}，${localPatch}` : localPatch;
      const audited = sanitizePromptForFlowSafetyClient(rawLocal);
      const nextPrompt = audited.text.slice(0, PROMPT_MAX_LENGTH);
      promptManuallyEditedRef.current = true;
      setPrompt(nextPrompt);
      setAutoPromptUsed(true);
      setPendingAiConfirm(true);
      setSafetyAuditNotes(audited.rewritten ? audited.notes : []);
      useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: undefined });
      if (isEmbedded) persistNodeDraftPatch({ prompt: nextPrompt });
      window.requestAnimationFrame(() => firstFocusRef.current?.focus());
    } finally {
      setAutoBuilding(false);
    }
  }

  async function confirmPendingVideoDispatch() {
    if (!pendingVideoConfirm || submitLock.current) return;
    const payload = pendingVideoConfirm;
    submitLock.current = true;
    try {
      if (rememberNeverConfirm) {
        setConfirmBeforeVideoGen("never");
      }
      setPendingVideoConfirm(null);
      setRememberNeverConfirm(false);
      setPendingAiConfirm(false);
      setPreAiPrompt(null);
      setPendingBatchPrompts(undefined);
      closeGenerationDialog();
      await dispatchGeneration(rfId, payload.dispatchOpts);
    } finally {
      submitLock.current = false;
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
        setSafetyAuditNotes([]);
        setAutoBuilding(true);
        useBoardStore.getState().updateNodeData(rfId, { autoPromptStatus: "pending" });
        try {
          if (!isVideo && variants > 1) {
            const res = await autoPromptBatchApi(dbId, variants, { allowFallback: true });
            const nextText = res.prompts.join("\n\n— 变体 —\n\n").slice(0, PROMPT_MAX_LENGTH);
            setPendingBatchPrompts(res.prompts);
            setPrompt(nextText);
            setSafetyAuditNotes(
              res.safety_rewritten
                ? (res.safety_notes?.length ? res.safety_notes : ["已自动优化敏感表达，降低审核拦截风险"])
                : [],
            );
          } else {
            const res = await autoPromptApi(dbId, {
              camera: isVideo ? camera : undefined,
              allowFallback: true,
              durationSeconds: isVideo ? activeVideoDuration : undefined,
              silentVideo: isVideo ? silentVideo : undefined,
            });
            setPendingBatchPrompts(undefined);
            setPrompt(res.prompt.slice(0, PROMPT_MAX_LENGTH));
            setSafetyAuditNotes(
              res.safety_rewritten
                ? (res.safety_notes?.length ? res.safety_notes : ["已自动优化敏感表达，降低审核拦截风险"])
                : [],
            );
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
    if (isVideo) {
      const videoPrompt = composeVideoPromptWithDirectives({
        prompt: finalPrompt,
        cameraKey: camera,
        dialogue: dialogueText,
        sfx: sfxText,
        silentVideo,
        characterVoices: upstreamCharacterVoices,
      });
      const isT2v = effectiveVideoMode === "t2v";
      const isIngredients = effectiveVideoMode === "ingredients";
      const isFirstLast =
        effectiveVideoMode === "first_last" &&
        Boolean(firstFrameId && lastFrameId && firstFrameId !== lastFrameId);
      const picked = sourceMediaIds.filter((_, i) => selectedSourceIdx.has(i));
      const useMulti = !isIngredients && !isT2v && !isFirstLast && picked.length > 1;
      const clipCount = !isFirstLast && !isT2v && !isIngredients && useMulti ? picked.length : variants;
      const effectiveRes: VideoResolutionKey =
        effectiveVideoModelFamily !== "omni_flash" && videoResolution === "360p"
          ? "720p"
          : videoResolution;
      const dispatchOpts: PendingVideoConfirmPayload["dispatchOpts"] = {
        prompt: videoPrompt,
        aspectRatio,
        kind: "video",
        flowAccountId: account?.id,
        flowProjectId: account?.project_id ?? undefined,
        videoSubMode: isFirstLast
          ? "first_last"
          : isT2v
            ? "t2v"
            : isIngredients
              ? "ingredients"
              : "first_frame",
        sourceMediaId: isFirstLast
          ? firstFrameId
          : isIngredients || isT2v || useMulti
            ? undefined
            : picked[0],
        endMediaId: isFirstLast ? lastFrameId : undefined,
        sourceMediaIds: !isFirstLast && !isIngredients && !isT2v && useMulti ? picked : undefined,
        variantCount: clipCount,
        videoModel: effectiveVideoModelFamily,
        videoQuality,
        omniVersion,
        durationSeconds: activeVideoDuration,
        videoResolution: effectiveRes,
        videoRefFrame: hasVideoUpstream ? videoRefFrame : undefined,
        silentVideo,
      };

      if (confirmBeforeVideoGen === "always") {
        const modeLabel = isT2v
          ? "纯文生视频（不锁首帧）"
          : isIngredients
            ? `参考元素生视频（不锁首帧 · ${refSourceNodes.length} 项参考）`
            : isFirstLast
              ? "首尾帧锁定"
              : `首帧一致图生视频（可选 · ${Math.max(1, picked.length)} 张首帧）`;
        const audioModeLabel = silentVideo
          ? "🔇 静音视频（无对话 / 无配乐 / 无环境音）"
          : upstreamCharacterVoices.length > 0
            ? `🎙️ 有声 · 绑定角色音色（${upstreamCharacterVoices.map((v) => `${v.title}:${v.label}`).join("、")}）`
            : (dialogueText.trim() || sfxText.trim())
              ? "🎙️ 有声（含自定义台词/音效指令）"
              : "🔊 默认原生有声";
        const videoEst = estimateVideoCreditCost({
          videoModel: effectiveVideoModelFamily,
          omniVersion,
          videoQuality,
          durationSeconds: activeVideoDuration,
          videoResolution: effectiveRes,
          count: clipCount,
          paygateTier,
        });
        setPendingVideoConfirm({
          modeLabel,
          modelLabel: selectedVideoEntry.label,
          resolutionLabel: effectiveRes.toUpperCase(),
          durationSec: activeVideoDuration,
          clipCount,
          audioModeLabel,
          costDisplay: videoEst.displayText,
          costBreakdown: videoEst.breakdown,
          costTotal: videoEst.total,
          accountLabel: account?.label || "当前 Flow 账号",
          finalPrompt: videoPrompt,
          dispatchOpts,
        });
        return;
      }

      setPendingAiConfirm(false);
      setPreAiPrompt(null);
      setPendingBatchPrompts(undefined);
      closeGenerationDialog();
      return dispatchGeneration(rfId, dispatchOpts);
    } else {
      setPendingAiConfirm(false);
      setPreAiPrompt(null);
      setPendingBatchPrompts(undefined);
      closeGenerationDialog();
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

  function handleApplyPromptSlashSkill(skill: DirectorSkillEntry) {
    setSlashSkillOpen(false);
    if (skill.action.kind === "open_director_stage") {
      setPrompt("");
      window.dispatchEvent(
        new CustomEvent("flowboard:open-director-stage", {
          detail: { tab: skill.action.tab },
        }),
      );
      return;
    }
    if (skill.action.kind === "open_audio_director") {
      setPrompt("");
      onClose?.();
      window.dispatchEvent(
        new CustomEvent("flowboard:open-audio-director", {
          detail: { tab: skill.action.tab },
        }),
      );
      return;
    }
    const clean = skill.action.snippet.slice(0, PROMPT_MAX_LENGTH);
    promptManuallyEditedRef.current = true;
    setPrompt(clean);
    if (isEmbedded) persistNodeDraftPatch({ prompt: clean });
    window.requestAnimationFrame(() => firstFocusRef.current?.focus());
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
    if (isEmbedded) persistNodeDraftPatch({ prompt: clipped });
    window.requestAnimationFrame(() => ta?.focus());
  }

  async function handleUploadAndWireRef() {
    if (uploadingRef || !node) return;
    setAddRefMenuOpen(false);
    let picked: File[];
    try {
      picked = await pickImageFiles({
        multiple: false,
        accept: "image/png,image/jpeg,image/webp,image/gif",
        title: "上传本地参考图并连线",
      });
    } catch (err) {
      useGenerationStore.setState({
        error: err instanceof Error ? err.message : "选择图片失败",
      });
      return;
    }
    const file = picked[0];
    if (!file) return;
    setUploadingRef(true);
    try {
      const binding = await useGenerationStore.getState().ensureProjectBinding();
      if (!binding) {
        useGenerationStore.setState({
          error: "尚未绑定 Flow 项目，无法上传参考图。",
        });
        return;
      }
      const boardStore = useBoardStore.getState();
      const refOffsetY = allVideoRefEntries.length * 48 + refSourceNodes.length * 48;
      const newRefId = await boardStore.addNodeOfType("visual_asset", {
        x: Math.round(node.position.x - 320),
        y: Math.round(node.position.y + refOffsetY),
      });
      if (!newRefId) return;
      const cleanTitle = file.name.replace(/\.[^.]+$/, "") || "参考素材";
      boardStore.updateNodeData(newRefId, { title: cleanTitle, status: "running" });
      const dbId = parseInt(newRefId, 10);
      const resp = await uploadImage(
        file,
        binding.flow_project_id,
        isNaN(dbId) ? undefined : dbId,
        binding.flow_account_id,
      );
      const renderedAt = new Date().toISOString();
      useBoardStore.getState().updateNodeData(newRefId, {
        title: cleanTitle,
        mediaId: resp.media_id,
        mediaIds: [resp.media_id],
        variantCount: 1,
        status: "done",
        aspectRatio: resp.aspect_ratio,
        renderedAt,
      });
      if (!isNaN(dbId)) {
        patchNode(dbId, {
          status: "done",
          data: {
            title: cleanTitle,
            mediaId: resp.media_id,
            mediaIds: [resp.media_id],
            variantCount: 1,
            aspectRatio: resp.aspect_ratio,
            renderedAt,
          },
        }).catch(() => {});
      }
      await useBoardStore.getState().addEdgeFromConnection(newRefId, rfId);
      requestAutoBrief(newRefId, resp.media_id);
      if (isVideo && videoSubMode === "t2v") {
        handleSelectVideoSubMode("ingredients");
      }
    } catch (err) {
      useGenerationStore.setState({
        error: err instanceof Error ? err.message : "上传参考图失败",
      });
    } finally {
      setUploadingRef(false);
    }
  }

  const nodeLLMBusy =
    node?.data.autoPromptStatus === "pending"
    || node?.data.aiBriefStatus === "pending";
  const isWorking = autoBuilding || nodeLLMBusy;

  const isVideoTextMode = isVideo && effectiveVideoMode === "t2v";
  const isVideoFirstLastMode = isVideo && effectiveVideoMode === "first_last";
  const queued = node.data.status === "queued" || node.data.status === "running";
  const canGenerate = !queued && !isWorking && (!isVideo || !accountIssue) && (isCharacter
    ? prompt.trim().length > 0 || refSourceNodes.length > 0 || Boolean(upstreamPromptText)
    : isVideoFirstLastMode
    ? Boolean(firstFrameId && lastFrameId && firstFrameId !== lastFrameId)
    : isVideoTextMode
    ? prompt.trim().length > 0
    : effectiveVideoOmni
    ? refSourceNodes.length > 0 && !isWorking
    : isVideo
    ? sourceMediaIds.some((_, idx) => selectedSourceIdx.has(idx))
    : true);

  const subjectTemplatesSection = isCharacter ? (
    <SubjectTemplatesPanel
      key={rfId}
      prompt={prompt}
      inline={isEmbedded}
      disabled={isWorking || queued}
      onApplyTemplate={handleApplySubjectTemplate}
      onAutoFillCreatedPrompt={handleAutoFillCreatedTemplatePrompt}
    />
  ) : null;

  const characterVoiceSection = isCharacter ? (
    <div className="jm-voice-binder" role="region" aria-label="角色固定音色绑定">
      <div className="jm-voice-binder__head">
        <span className="jm-voice-binder__title">
          🎙️ 固定音色绑定
          {boundVoiceLabel && (
            <span className="jm-voice-binder__active-pill">{boundVoiceLabel}</span>
          )}
        </span>
        {boundVoiceLabel && (
          <button
            type="button"
            className="jm-voice-binder__clear"
            onClick={() => handleSelectVoicePreset("")}
            title="解除此角色的固定音色绑定"
          >
            清除绑定
          </button>
        )}
      </div>
      <div className="jm-voice-binder__chips" role="radiogroup" aria-label="选择角色音色预设">
        {CHARACTER_VOICE_PRESETS.map((preset) => {
          const active = voicePreset === preset.key;
          return (
            <button
              key={preset.key}
              type="button"
              role="radio"
              aria-checked={active}
              className={`jm-voice-chip${active ? " jm-voice-chip--active" : ""}`}
              onClick={() => handleSelectVoicePreset(active ? "" : preset.key)}
              title={preset.directive || "自由输入该角色的专属声线描述"}
            >
              {preset.shortLabel}
            </button>
          );
        })}
      </div>
      <input
        type="text"
        className="gen-dialog__seed-input jm-voice-binder__input"
        value={voiceCustom}
        onChange={(e) => handleChangeVoiceCustom(e.target.value)}
        onBlur={handleBlurVoiceCustom}
        placeholder={
          voicePreset === "custom"
            ? "输入该角色的固定音色特征（如：略带微哑磁性女中音，语速偏慢从容）…"
            : "可选补充声线细节（如：轻微京腔、语速轻快、带呼吸感）…"
        }
        maxLength={120}
      />
      <p className="jm-voice-binder__hint">
        {boundVoiceDirective
          ? `已绑定：${boundVoiceDirective}（连线至下游视频节点时自动继承，若视频开启「静音视频」则自动屏蔽）`
          : "未绑定固定音色；绑定后，此角色连线到下游视频节点（含经由图片/文本中转）将自动保持一致声线。"}
      </p>
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
              className="gen-dialog__revert-btn"
              onClick={() => setSlashSkillOpen((v) => !v)}
              disabled={isWorking || queued}
              title="唤出 / 导演技能模板"
            >
              / 技能
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
      {safetyAuditNotes.length > 0 && !isWorking && !hasStoryboardUpstream && (
        <div className="gen-dialog__safety-banner" role="status">
          <span>🛡️ 安全词审核已自动改写：{safetyAuditNotes.join("；")}</span>
        </div>
      )}
      <textarea
        id={promptId}
        ref={firstFocusRef}
        className="gen-dialog__textarea"
        rows={isEmbedded ? 4 : 5}
        maxLength={PROMPT_MAX_LENGTH}
        value={prompt}
        onChange={(e) => {
          const val = e.target.value;
          const cursor = e.target.selectionStart ?? val.length;
          const beforeCursor = val.slice(0, cursor);
          setAtSuggestOpen(refSourceNodes.length > 0 && /@(?:图\s*)?$/.test(beforeCursor));
          setSlashSkillOpen(val.startsWith("/"));
          promptManuallyEditedRef.current = true;
          setPrompt(val);
          if (pendingBatchPrompts) setPendingBatchPrompts(undefined);
          if (autoPromptUsed) setAutoPromptUsed(false);
        }}
        onBlur={() => {
          if (isEmbedded && !hasStoryboardUpstream && prompt !== (node?.data.prompt ?? "")) {
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
      {(slashSkillOpen || prompt.startsWith("/")) && !hasStoryboardUpstream && (
        <div className="gen-dialog__at-bar" role="listbox" aria-label="斜杠导演技能">
          <span className="gen-dialog__at-hint">/ 导演技能：</span>
          {filterDirectorSkills(prompt.startsWith("/") ? prompt.slice(1) : "").map((skill) => (
            <button
              key={skill.id}
              type="button"
              className="gen-dialog__preset-chip gen-dialog__at-chip"
              title={skill.desc}
              onMouseDown={(e) => {
                e.preventDefault();
                handleApplyPromptSlashSkill(skill);
              }}
            >
              {skill.slash}
            </button>
          ))}
        </div>
      )}
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
          <div className="gen-dialog__audio-toolbar">
            <button
              type="button"
              className={`gen-dialog__preset-chip jm-silent-toggle${silentVideo ? " jm-silent-toggle--on" : ""}`}
              onClick={() => handleToggleSilentVideo()}
              aria-pressed={silentVideo}
              title="开启后将向模型注入严格静音约束，屏蔽人物台词、角色固定音色、背景音乐与环境音效"
            >
              {silentVideo ? "🔇 生成静音视频：已开启" : "🔇 生成静音视频"}
            </button>
            <button
              type="button"
              className={`gen-dialog__preset-chip${!silentVideo && (audioOpen || dialogueText || sfxText) ? " gen-dialog__preset-chip--active" : ""}`}
              onClick={() => setAudioOpen((v) => !v)}
              title="展开/收起角色原生对白台词与环境音效输入槽（适配 Veo / Omni 原生声画同步）"
            >
              {audioOpen ? "▾ 收起台词与音效" : "🎙️ + 台词与音效预设"}
              {!silentVideo && (dialogueText.trim() || sfxText.trim()) ? "（已填写）" : ""}
            </button>
          </div>
          {upstreamCharacterVoices.length > 0 && (
            <div className={`jm-inherited-voices${silentVideo ? " jm-inherited-voices--muted" : ""}`}>
              <span className="jm-inherited-voices__label">
                {silentVideo ? "🔇 角色音色（已因静音模式屏蔽）：" : "🎙️ 已继承上游角色固定音色："}
              </span>
              {upstreamCharacterVoices.map((v) => (
                <span
                  key={v.rfId}
                  className="jm-inherited-voices__pill"
                  title={`${v.title}（#${v.shortId}）：${v.directive}`}
                >
                  {v.title} · {v.label}
                </span>
              ))}
            </div>
          )}
          {audioOpen && (
            <div className="gen-dialog__audio-fields">
              {silentVideo && (
                <p className="jm-silent-notice">
                  已开启「生成静音视频」，提交生成时将自动忽略下方台词与音效，输出全程无声纯视觉画面。
                </p>
              )}
              <input
                type="text"
                className="gen-dialog__seed-input"
                value={dialogueText}
                onChange={(e) => setDialogueText(e.target.value)}
                disabled={silentVideo}
                placeholder="角色口型对白台词（如：这束光终于照进来了）…"
                maxLength={300}
              />
              <input
                type="text"
                className="gen-dialog__seed-input"
                value={sfxText}
                onChange={(e) => setSfxText(e.target.value)}
                disabled={silentVideo}
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

  const references = (
    <UpstreamReferencesSection
      isVideo={isVideo}
      isOmniVideo={effectiveVideoOmni}
      isVideoFirstLastMode={isVideoFirstLastMode}
      isVideoTextMode={isVideoTextMode}
      videoSubMode={videoSubMode}
      onSelectVideoSubMode={handleSelectVideoSubMode}
      videoCandidateFrames={videoCandidateFrames}
      firstFrameId={firstFrameId}
      setFirstFrameId={setFirstFrameId}
      lastFrameId={lastFrameId}
      setLastFrameId={setLastFrameId}
      sourceNode={sourceNode ?? null}
      sourceMediaIds={sourceMediaIds}
      selectedSourceIdx={selectedSourceIdx}
      setSelectedSourceIdx={setSelectedSourceIdx}
      refSourceNodes={refSourceNodes}
      promptSourceNodes={promptSourceNodes}
      openVariantPicker={openVariantPicker}
      setOpenVariantPicker={setOpenVariantPicker}
      pickVariantForEdge={pickVariantForEdge}
      insertRefMentionTag={insertRefMentionTag}
      hasVideoUpstream={hasVideoUpstream}
      videoRefFrame={videoRefFrame}
      setVideoRefFrame={setVideoRefFrame}
    />
  );

  const liveCredits = account?.credits ?? null;
  const showCreditsPill =
    !isPrompt && (isVideo || mediaProvider === "flow") && liveCredits !== null;

  const effectiveVideoCount =
    effectiveVideoMode === "first_frame" && selectedSourceIdx.size > 1
      ? selectedSourceIdx.size
      : variants;
  const costEstimate =
    !isPrompt && (isVideo || mediaProvider === "flow")
      ? isVideo
        ? estimateVideoCreditCost({
            videoModel: effectiveVideoModelFamily,
            omniVersion,
            videoQuality,
            durationSeconds: activeVideoDuration,
            videoResolution:
              effectiveVideoModelFamily !== "omni_flash" && videoResolution === "360p"
                ? "720p"
                : videoResolution,
            count: effectiveVideoCount,
            paygateTier,
          })
        : estimateImageCreditCost({
            imageModel,
            imageResolution,
            count: variants,
          })
      : null;

  const hasGeneratedMedia =
    !isPrompt &&
    Boolean(node.data.mediaId || node.data.mediaIds?.some((m) => typeof m === "string" && m.length > 0));

  const insufficientCredits =
    pendingVideoConfirm !== null &&
    liveCredits !== null &&
    pendingVideoConfirm.costTotal !== null &&
    pendingVideoConfirm.costTotal > liveCredits;

  const videoConfirmPortal = pendingVideoConfirm
    ? createPortal(
        <div
          className="gen-dialog__confirm-overlay gen-dialog__confirm-overlay--portal"
          role="alertdialog"
          aria-modal="true"
          aria-label="确认视频生成参数与积分消耗"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPendingVideoConfirm(null);
          }}
        >
          <div className="gen-dialog__confirm-card">
            <div className="gen-dialog__confirm-head">
              <div>
                <h3 className="gen-dialog__confirm-title">确认生成视频</h3>
                <p className="gen-dialog__confirm-sub">
                  请核对本次生成模式、模型清晰度与预计积分消耗，确认无误后提交至 Google Flow。
                </p>
              </div>
              <button
                type="button"
                className="gen-dialog__close"
                onClick={() => setPendingVideoConfirm(null)}
                aria-label="返回修改"
              >
                ✕
              </button>
            </div>

            <dl className="gen-dialog__confirm-grid">
              <dt>当前账号</dt>
              <dd>{pendingVideoConfirm.accountLabel}</dd>
              <dt>生成模式</dt>
              <dd>{pendingVideoConfirm.modeLabel}</dd>
              <dt>视频模型</dt>
              <dd>{pendingVideoConfirm.modelLabel}</dd>
              <dt>规格参数</dt>
              <dd>
                {pendingVideoConfirm.resolutionLabel} · {pendingVideoConfirm.durationSec} 秒 · x{pendingVideoConfirm.clipCount} 条
              </dd>
              <dt>音频模式</dt>
              <dd>{pendingVideoConfirm.audioModeLabel}</dd>
              <dt>预计消耗</dt>
              <dd>
                <span className={`jm-cost-pill${pendingVideoConfirm.costTotal === 0 ? " jm-cost-pill--zero" : ""}`}>
                  {pendingVideoConfirm.costDisplay}
                </span>
                {liveCredits !== null && (
                  <span className={`gen-dialog__confirm-balance${insufficientCredits ? " gen-dialog__confirm-balance--low" : ""}`}>
                    当前余额 {liveCredits.toLocaleString("zh-CN")} 积分
                    {insufficientCredits ? "（余额可能不足）" : ""}
                  </span>
                )}
              </dd>
            </dl>

            <div className="gen-dialog__confirm-prompt-box">
              <div className="gen-dialog__confirm-prompt-label">最终提交提示词</div>
              <p className="gen-dialog__confirm-prompt-text">{pendingVideoConfirm.finalPrompt}</p>
            </div>

            <label className="gen-dialog__confirm-skip">
              <input
                type="checkbox"
                checked={rememberNeverConfirm}
                onChange={(e) => setRememberNeverConfirm(e.target.checked)}
              />
              <span>以后生成视频直接提交，不再确认（可随时在「设置 → 生成前先确认」恢复为始终）</span>
            </label>

            <div className="gen-dialog__confirm-actions">
              <button
                type="button"
                className="gen-dialog__confirm-cancel"
                onClick={() => setPendingVideoConfirm(null)}
              >
                返回修改
              </button>
              <button
                type="button"
                className="gen-dialog__confirm-submit"
                onClick={() => void confirmPendingVideoDispatch()}
              >
                确认生成视频 ⌘↵
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  if (isDropdown) {
    const unavailable = isCharacter
      ? "请选择推荐/自定义模板、填写主体特征描述，或连线参考图。"
      : isVideoFirstLastMode
        ? "请选择两个不同的首帧与尾帧参考。"
        : isVideoTextMode
          ? "请输入视频主体、动作与镜头描述以进行纯文生视频。"
          : effectiveVideoOmni
            ? "请连线至少一张参考图或视频。"
            : isVideo
              ? "请连线并勾选至少一个图片或视频参考，或切换为纯文生视频。"
              : undefined;
    const inlineHint = isVideo && accountIssue
      ? accountIssue
      : !canGenerate && !queued && !isWorking && unavailable
        ? unavailable
        : undefined;
    const activeCameraLabel =
      CAMERA_MOVEMENTS.find((c) => c.key === camera)?.label ?? "智能动态";
    const hasAudioDirectives = Boolean(dialogueText.trim() || sfxText.trim());
    const hasAnyFrame = videoCandidateFrames.length >= 1;
    const hasTwoFrames = videoCandidateFrames.length >= 2;
    const activeVideoRes =
      effectiveVideoModelFamily !== "omni_flash" && videoResolution === "360p"
        ? "720p"
        : videoResolution;
    const activeRatioLabel = (isVideo ? VIDEO_ASPECT_RATIOS : IMAGE_ASPECT_RATIOS)
      .find((a) => a.key === aspectRatio)?.label ?? "16:9";

    return (
      <>
        <section
          className="jm-node-dropdown nodrag nopan nowheel"
          aria-label="节点快捷参数下拉框"
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Backspace" || event.key === "Delete") event.stopPropagation();
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              ((!isVideo && event.target instanceof HTMLTextAreaElement) || event.ctrlKey || event.metaKey)
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (!event.repeat && canGenerate) void handleSubmit();
            }
          }}
        >
          {/* Top Preset Shelf — inspired by Reference Screenshot 1, mapped to real Flow controls */}
          {!isPrompt && (
            <div className={`jm-drop-shelf${shelfCollapsed ? " jm-drop-shelf--collapsed" : ""}`}>
              {!shelfCollapsed && (
                <div className={`jm-drop-shelf__cards${isVideo ? " jm-drop-shelf__cards--four" : ""}`}>
                  {isVideo ? (
                    <>
                      <div className="jm-drop-pill-card jm-drop-pill-card--select" title="选择镜头运镜风格">
                        <span className="jm-drop-pill-card__icon" aria-hidden="true">🎬</span>
                        <span className="jm-drop-pill-card__text">
                          <span className="jm-drop-pill-card__kicker">运镜</span>
                          <span className="jm-drop-pill-card__val">{activeCameraLabel}</span>
                        </span>
                        <select
                          className="jm-drop-pill-card__overlay-select"
                          aria-label="镜头运动"
                          value={camera}
                          onChange={(e) => setCamera(e.target.value as CameraKey)}
                        >
                          {CAMERA_MOVEMENTS.map((c) => (
                            <option key={c.key} value={c.key}>{c.label}</option>
                          ))}
                        </select>
                      </div>

                      <button
                        type="button"
                        className={`jm-drop-pill-card${!silentVideo && (audioOpen || hasAudioDirectives || upstreamCharacterVoices.length > 0) ? " jm-drop-pill-card--active" : ""}`}
                        onClick={() => setAudioOpen((v) => !v)}
                        disabled={hasStoryboardUpstream}
                        title="设置 Veo / Omni 原生声画同步台词、环境音效或查看上游角色音色"
                      >
                        <span className="jm-drop-pill-card__icon" aria-hidden="true">🎙️</span>
                        <span className="jm-drop-pill-card__text">
                          <span className="jm-drop-pill-card__kicker">声画</span>
                          <span className="jm-drop-pill-card__val">
                            {silentVideo
                              ? "静音已屏蔽"
                              : hasAudioDirectives
                                ? "已填台词/音效"
                                : upstreamCharacterVoices.length > 0
                                  ? `音色(${upstreamCharacterVoices.length})`
                                  : "台词与音效"}
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        className={`jm-drop-pill-card${silentVideo ? " jm-drop-pill-card--warn" : ""}`}
                        onClick={() => handleToggleSilentVideo()}
                        disabled={hasStoryboardUpstream}
                        aria-pressed={silentVideo}
                        title="开关「生成静音视频」：开启后全程无对话、无配乐、无环境音效，并屏蔽上游角色音色"
                      >
                        <span className="jm-drop-pill-card__icon" aria-hidden="true">
                          {silentVideo ? "🔇" : "🔊"}
                        </span>
                        <span className="jm-drop-pill-card__text">
                          <span className="jm-drop-pill-card__kicker">静音视频</span>
                          <span className="jm-drop-pill-card__val">
                            {silentVideo ? "已开启静音" : "默认有声"}
                          </span>
                        </span>
                      </button>

                      <button
                        type="button"
                        className={`jm-drop-pill-card${autoBuilding ? " jm-drop-pill-card--active" : ""}`}
                        onClick={() => void handleAiPolish()}
                        disabled={isWorking || queued || hasStoryboardUpstream}
                        title="结合上游参考图进行中文 AI 润色，并自动触发安全词审核改写"
                      >
                        <span className="jm-drop-pill-card__icon" aria-hidden="true">✨</span>
                        <span className="jm-drop-pill-card__text">
                          <span className="jm-drop-pill-card__kicker">AI 润色</span>
                          <span className="jm-drop-pill-card__val">
                            {autoBuilding ? "润色中…" : "安全审核"}
                          </span>
                        </span>
                      </button>
                    </>
                  ) : isStoryboard ? (
                    <>
                      <div className="jm-drop-pill-card jm-drop-pill-card--select" title="选择分镜宫格布局">
                        <span className="jm-drop-pill-card__icon" aria-hidden="true">🎞️</span>
                        <span className="jm-drop-pill-card__text">
                          <span className="jm-drop-pill-card__kicker">宫格</span>
                          <span className="jm-drop-pill-card__val">{totalPanels(storyboardGrid)} 格分镜</span>
                        </span>
                        <select
                          className="jm-drop-pill-card__overlay-select"
                          aria-label="分镜宫格"
                          value={storyboardGrid}
                          onChange={(e) => setStoryboardGrid(e.target.value as StoryboardGrid)}
                        >
                          {STORYBOARD_GRIDS.map((g) => (
                            <option key={g} value={g}>{g} · {totalPanels(g)} 格</option>
                          ))}
                        </select>
                      </div>

                      <div className="jm-drop-pill-card jm-drop-pill-card--select" title="切换剧情连贯或同场多机位">
                        <span className="jm-drop-pill-card__icon" aria-hidden="true">🎬</span>
                        <span className="jm-drop-pill-card__text">
                          <span className="jm-drop-pill-card__kicker">模式</span>
                          <span className="jm-drop-pill-card__val">
                            {storyboardMode === "multicam" ? "同场多机位" : "剧情连贯"}
                          </span>
                        </span>
                        <select
                          className="jm-drop-pill-card__overlay-select"
                          aria-label="分镜模式"
                          value={storyboardMode}
                          onChange={(e) => setStoryboardMode(e.target.value as StoryboardMode)}
                        >
                          <option value="narrative">剧情连贯</option>
                          <option value="multicam">同场多机位</option>
                        </select>
                      </div>

                      <button
                        type="button"
                        className={`jm-drop-pill-card${autoBuilding ? " jm-drop-pill-card--active" : ""}`}
                        onClick={() => void handleAiPolish()}
                        disabled={isWorking || queued}
                        title="AI 润色故事板脚本并自动安全审核"
                      >
                        <span className="jm-drop-pill-card__icon" aria-hidden="true">✨</span>
                        <span className="jm-drop-pill-card__text">
                          <span className="jm-drop-pill-card__kicker">AI 润色</span>
                          <span className="jm-drop-pill-card__val">
                            {autoBuilding ? "润色中…" : "自动安全审核"}
                          </span>
                        </span>
                      </button>
                    </>
                  ) : (
                    <>
                      {isCharacter ? (
                        <button
                          type="button"
                          className={`jm-drop-pill-card${subjectTplOpen ? " jm-drop-pill-card--active" : ""}`}
                          onClick={() => {
                            setSubjectTplOpen((v) => !v);
                            setVoiceOpen(false);
                          }}
                          title="展开动漫 / 3D / 真人 / 萌宠官方与自定义主体模板"
                        >
                          <span className="jm-drop-pill-card__icon" aria-hidden="true">👤</span>
                          <span className="jm-drop-pill-card__text">
                            <span className="jm-drop-pill-card__kicker">主体模板</span>
                            <span className="jm-drop-pill-card__val">动漫 · 3D · 真人</span>
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`jm-drop-pill-card${presetsOpen ? " jm-drop-pill-card--active" : ""}`}
                          onClick={() => setPresetsOpen((v) => !v)}
                          title="一键补充中文电影质感、光影与构图词"
                        >
                          <span className="jm-drop-pill-card__icon" aria-hidden="true">🎨</span>
                          <span className="jm-drop-pill-card__text">
                            <span className="jm-drop-pill-card__kicker">画风词</span>
                            <span className="jm-drop-pill-card__val">快捷质感 +</span>
                          </span>
                        </button>
                      )}

                      {isCharacter ? (
                        <button
                          type="button"
                          className={`jm-drop-pill-card${voiceOpen || boundVoiceLabel ? " jm-drop-pill-card--active" : ""}`}
                          onClick={() => {
                            setVoiceOpen((v) => !v);
                            setSubjectTplOpen(false);
                          }}
                          title="为此角色绑定固定音色，连线下游视频节点时将自动继承保持一致声线"
                        >
                          <span className="jm-drop-pill-card__icon" aria-hidden="true">🎙️</span>
                          <span className="jm-drop-pill-card__text">
                            <span className="jm-drop-pill-card__kicker">固定音色</span>
                            <span className="jm-drop-pill-card__val">
                              {boundVoiceLabel ?? "点击绑定音色"}
                            </span>
                          </span>
                        </button>
                      ) : mediaProvider === "flow" && imageModel === "NANO_BANANA_2_1" ? (
                        <div className="jm-drop-pill-card jm-drop-pill-card--select" title="调节 Nano Banana 2.1 推理思考深度">
                          <span className="jm-drop-pill-card__icon" aria-hidden="true">🧠</span>
                          <span className="jm-drop-pill-card__text">
                            <span className="jm-drop-pill-card__kicker">思考深度</span>
                            <span className="jm-drop-pill-card__val">
                              {IMAGE_THINKING_OPTIONS.find((t) => t.value === imageThinkingLevel)?.label ?? "默认"}
                            </span>
                          </span>
                          <select
                            className="jm-drop-pill-card__overlay-select"
                            aria-label="思考深度"
                            value={imageThinkingLevel}
                            onChange={(e) => setImageThinkingLevel(e.target.value as ImageThinkingLevel)}
                          >
                            {IMAGE_THINKING_OPTIONS.map((t) => (
                              <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                          </select>
                        </div>
                      ) : (
                        <div className="jm-drop-pill-card jm-drop-pill-card--select" title="切换图片渲染引擎">
                          <span className="jm-drop-pill-card__icon" aria-hidden="true">⚡</span>
                          <span className="jm-drop-pill-card__text">
                            <span className="jm-drop-pill-card__kicker">引擎</span>
                            <span className="jm-drop-pill-card__val">
                              {mediaProvider === "flow" ? "Google Flow" : "Muse"}
                            </span>
                          </span>
                          <select
                            className="jm-drop-pill-card__overlay-select"
                            aria-label="渲染引擎"
                            value={mediaProvider}
                            onChange={(e) => setMediaProvider(e.target.value as MediaProviderKey)}
                          >
                            <option value="flow">Google Flow</option>
                            <option value="muse">Muse</option>
                          </select>
                        </div>
                      )}

                      <button
                        type="button"
                        className={`jm-drop-pill-card${autoBuilding ? " jm-drop-pill-card--active" : ""}`}
                        onClick={() => void handleAiPolish()}
                        disabled={isWorking || queued}
                        title="AI 润色中文提示词并自动安全词审核"
                      >
                        <span className="jm-drop-pill-card__icon" aria-hidden="true">✨</span>
                        <span className="jm-drop-pill-card__text">
                          <span className="jm-drop-pill-card__kicker">AI 润色</span>
                          <span className="jm-drop-pill-card__val">
                            {autoBuilding ? "润色审核中…" : "自动安全审核"}
                          </span>
                        </span>
                      </button>
                    </>
                  )}
                </div>
              )}
              <button
                type="button"
                className="jm-drop-shelf__toggle"
                onClick={() => setShelfCollapsed((v) => !v)}
                aria-label={shelfCollapsed ? "展开快捷工具栏" : "收起快捷工具栏"}
                title={shelfCollapsed ? "展开快捷工具栏" : "收起快捷工具栏"}
              >
                {shelfCollapsed ? "⌃" : "⌄"}
              </button>
            </div>
          )}

          {/* Main Elevated Composer Card */}
          <div className="jm-drop-card">
            <div className="jm-drop-card__top">
              <div className="jm-drop-refs">
                {!isPrompt && (
                  <div className="jm-drop-add-wrap">
                    <button
                      type="button"
                      className="jm-drop-add-btn"
                      onClick={() => setAddRefMenuOpen((v) => !v)}
                      disabled={uploadingRef}
                      title="添加参考图（上传本地图片自动连线，或打开资产库）"
                      aria-label="添加参考图"
                    >
                      {uploadingRef ? "…" : "+"}
                    </button>
                    {addRefMenuOpen && (
                      <div className="jm-drop-add-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className="jm-drop-add-menu__item"
                          onClick={() => void handleUploadAndWireRef()}
                        >
                          📤 上传本地图片并连线参考
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="jm-drop-add-menu__item"
                          onClick={() => {
                            setAddRefMenuOpen(false);
                            useReferencesStore.getState().openPanel("assets");
                          }}
                        >
                          📁 打开资产库选择素材
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* First-frame selectable source thumbnails for Veo i2v mode */}
                {isVideo && effectiveVideoMode === "first_frame" && sourceMediaIds.length > 0 && sourceNode && (
                  sourceMediaIds.map((mid, i) => {
                    const checked = selectedSourceIdx.has(i);
                    const isVidSrc = sourceNode.data.type === "video";
                    return (
                      <button
                        key={`ff-${mid}`}
                        type="button"
                        className={`jm-drop-ref-thumb${checked ? " jm-drop-ref-thumb--checked" : ""}`}
                        onClick={() => {
                          setSelectedSourceIdx((prev) => {
                            const next = new Set(prev);
                            if (next.has(i)) next.delete(i);
                            else next.add(i);
                            return next;
                          });
                        }}
                        title={`首帧参考 #${sourceNode.data.shortId} · v${i + 1}（点击勾选/取消）`}
                      >
                        {isVidSrc ? (
                          <video src={mediaUrl(mid)} muted playsInline preload="metadata" />
                        ) : (
                          <img src={mediaUrl(mid)} alt={sourceNode.data.title} />
                        )}
                        <span className="jm-drop-ref-thumb__badge">
                          {checked ? "首帧✓" : `v${i + 1}`}
                        </span>
                      </button>
                    );
                  })
                )}

                {/* Upstream multi-ref thumbnails (image / character / Storyboard / video ingredients) */}
                {(!isVideo || effectiveVideoMode === "ingredients") &&
                  refSourceNodes.map((r, rIdx) => {
                    const refTitle = displayNodeTitle(r.node.data.title, r.node.data.type);
                    const isMulti = r.allVariants.length >= 2;
                    const isPickerOpen = openVariantPicker === r.edgeId;
                    const isVidChip = r.node.data.type === "video";
                    return (
                      <div key={r.edgeId} className="ref-source-chip-wrap jm-drop-ref-wrap">
                        <button
                          type="button"
                          className={`jm-drop-ref-thumb${isPickerOpen ? " jm-drop-ref-thumb--checked" : ""}`}
                          onClick={() => {
                            if (isMulti) {
                              setOpenVariantPicker(isPickerOpen ? null : r.edgeId);
                            } else {
                              insertRefMentionTag(rIdx + 1);
                            }
                          }}
                          title={
                            isMulti
                              ? `${refTitle} (v${(r.variantIdx ?? 0) + 1}) · 点击切换变体`
                              : `${refTitle} · 点击插入 @图${rIdx + 1}`
                          }
                        >
                          {isVidChip ? (
                            <video src={mediaUrl(r.mediaId)} muted playsInline preload="metadata" />
                          ) : (
                            <img src={mediaUrl(r.mediaId)} alt={refTitle} />
                          )}
                          <span className="jm-drop-ref-thumb__badge">@图{rIdx + 1}</span>
                        </button>
                        {isMulti && isPickerOpen && (
                          <div className="ref-source-chip__picker" role="dialog" aria-label={`选择 ${refTitle} 变体`}>
                            {r.allVariants.map((mid, i) => {
                              if (!mid) return null;
                              const isCurrent = i === (r.variantIdx ?? 0);
                              return (
                                <button
                                  key={i}
                                  type="button"
                                  className={`ref-source-chip__picker-item${isCurrent ? " ref-source-chip__picker-item--current" : ""}`}
                                  onClick={() => void pickVariantForEdge(r.edgeId, i)}
                                >
                                  {isVidChip ? (
                                    <video className="ref-source-chip__picker-img" src={mediaUrl(mid)} muted playsInline preload="metadata" />
                                  ) : (
                                    <img className="ref-source-chip__picker-img" src={mediaUrl(mid)} alt={`v${i + 1}`} />
                                  )}
                                  <span className="ref-source-chip__picker-label">v{i + 1}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}

                {/* Upstream text prompt chips */}
                {promptSourceNodes.map((p) => (
                  <span
                    key={p.edgeId}
                    className="jm-drop-prompt-chip"
                    title={`${displayNodeTitle(p.node.data.title, p.node.data.type)}：${p.text.trim() || "空白文本"}`}
                  >
                    ✦ #{p.node.data.shortId}
                  </span>
                ))}
              </div>

              <div className="jm-drop-card__top-actions">
                {!hasStoryboardUpstream && preAiPrompt !== null && (
                  <button
                    type="button"
                    className="jm-drop-mini-btn"
                    onClick={handleRevertPreAiPrompt}
                    disabled={isWorking || queued}
                    title="还原润色前的原始提示词"
                  >
                    ↩ 还原
                  </button>
                )}
                {!hasStoryboardUpstream && (
                  <button
                    type="button"
                    className="jm-drop-mini-btn"
                    onClick={() => setSlashSkillOpen((v) => !v)}
                    disabled={isWorking || queued}
                    title="唤出 / 导演技能模板"
                  >
                    / 技能
                  </button>
                )}
                {!isPrompt && (
                  <button
                    type="button"
                    className="jm-drop-expand-btn"
                    onClick={() => openResultViewer(rfId, 0, "params")}
                    aria-label={isVideo ? "展开进入视频展示页与完整参数侧边栏" : "展开进入展示页与完整参数侧边栏"}
                    title={isVideo ? "展开进入视频展示页（右侧可收回完整参数侧边栏）" : "展开进入展示页（右侧可收回完整参数侧边栏）"}
                  >
                    ⤢
                  </button>
                )}
                <button
                  type="button"
                  className="jm-drop-expand-btn"
                  onClick={closeGenerationDialog}
                  aria-label="收起下拉框 (ESC)"
                  title="收起下拉框 (ESC)"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* Compact First+Last Frame pickers when first_last mode is active */}
            {isVideo && effectiveVideoMode === "first_last" && hasTwoFrames && (
              <div className="gen-dialog__first-last-row">
                <div className="gen-dialog__first-last-slot">
                  <span className="gen-dialog__first-last-tag">首帧</span>
                  <select
                    aria-label="选择首帧参考图"
                    value={firstFrameId}
                    onChange={(e) => setFirstFrameId(e.target.value)}
                  >
                    {videoCandidateFrames.map((c) => (
                      <option key={`start-${c.mediaId}`} value={c.mediaId}>{c.label}</option>
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
                  ⇄
                </button>
                <div className="gen-dialog__first-last-slot">
                  <span className="gen-dialog__first-last-tag">尾帧</span>
                  <select
                    aria-label="选择尾帧参考图"
                    value={lastFrameId}
                    onChange={(e) => setLastFrameId(e.target.value)}
                  >
                    {videoCandidateFrames.map((c) => (
                      <option key={`end-${c.mediaId}`} value={c.mediaId}>{c.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Toggleable Subject Templates Drawer for Character nodes */}
            {subjectTplOpen && subjectTemplatesSection}

            {/* Toggleable Fixed Voice Binder for Character nodes */}
            {voiceOpen && characterVoiceSection}

            {/* Toggleable Chinese Style Presets Strip */}
            {presetsOpen && !hasStoryboardUpstream && (
              <div className="gen-dialog__preset-row" aria-label="中文快捷画风词">
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

            {/* Inherited Upstream Character Voices Indicator for Video nodes */}
            {isVideo && upstreamCharacterVoices.length > 0 && !hasStoryboardUpstream && (
              <div className={`jm-inherited-voices${silentVideo ? " jm-inherited-voices--muted" : ""}`}>
                <span className="jm-inherited-voices__label">
                  {silentVideo ? "🔇 角色音色（已因静音模式屏蔽）：" : "🎙️ 已继承角色固定音色："}
                </span>
                {upstreamCharacterVoices.map((v) => (
                  <span
                    key={v.rfId}
                    className="jm-inherited-voices__pill"
                    title={`${v.title}（#${v.shortId}）：${v.directive}`}
                  >
                    {v.title} · {v.label}
                  </span>
                ))}
              </div>
            )}

            {/* Toggleable Video Dialogue & SFX fields */}
            {isVideo && audioOpen && !hasStoryboardUpstream && (
              <div className="gen-dialog__audio-fields">
                {silentVideo && (
                  <p className="jm-silent-notice">
                    已开启「生成静音视频」，提交时将自动屏蔽台词、角色固定音色与环境配乐，生成纯无声视频。
                  </p>
                )}
                <input
                  type="text"
                  className="gen-dialog__seed-input"
                  value={dialogueText}
                  onChange={(e) => setDialogueText(e.target.value)}
                  disabled={silentVideo}
                  placeholder="角色口型对白台词（如：这束光终于照进来了）…"
                  maxLength={300}
                />
                <input
                  type="text"
                  className="gen-dialog__seed-input"
                  value={sfxText}
                  onChange={(e) => setSfxText(e.target.value)}
                  disabled={silentVideo}
                  placeholder="环境音与音效（如：细雨落瓦、轻柔钢琴弦乐）…"
                  maxLength={300}
                />
              </div>
            )}

            {/* Clean Borderless Prompt Textarea */}
            <textarea
              id={promptId}
              ref={firstFocusRef}
              className="jm-drop-textarea"
              rows={2}
              maxLength={PROMPT_MAX_LENGTH}
              value={prompt}
              onChange={(e) => {
                const val = e.target.value;
                const cursor = e.target.selectionStart ?? val.length;
                const beforeCursor = val.slice(0, cursor);
                setAtSuggestOpen(refSourceNodes.length > 0 && /@(?:图\s*)?$/.test(beforeCursor));
                setSlashSkillOpen(val.startsWith("/"));
                promptManuallyEditedRef.current = true;
                setPrompt(val);
                if (pendingBatchPrompts) setPendingBatchPrompts(undefined);
                if (autoPromptUsed) setAutoPromptUsed(false);
              }}
              onBlur={() => {
                if (!hasStoryboardUpstream && prompt !== (node?.data.prompt ?? "")) {
                  persistNodeDraftPatch({ prompt });
                }
              }}
              placeholder={
                upstreamPromptText
                  ? "已默认继承上游文本节点提示词，可直接生成，或点击上方「AI 润色」…"
                  : isVideo
                    ? "上传参考图、输入文本或运镜描述，快速生成你想要的视频…"
                    : isCharacter
                      ? "描述动漫/3D/真人主体设定特征，或点击上方「主体模板」一键套用…"
                      : isStoryboard
                        ? "输入中文剧情脚本（如：清晨拆箱 → 试穿展示 → 街头漫步）…"
                        : isPrompt
                          ? "输入中文脚本或提示词灵感，连线后自动传递给下游节点…"
                          : "上传图片、输入画面描述或 @引用主体，快速生成你想要的图片…"
              }
              disabled={isWorking}
              readOnly={hasStoryboardUpstream}
            />

            {pendingAiConfirm && !isWorking && !hasStoryboardUpstream && (
              <div className="gen-dialog__confirm-banner" role="status">
                <span>✨ AI 已润色/生成提示词，请检查或微调后点击右下角确认生成</span>
              </div>
            )}
            {safetyAuditNotes.length > 0 && !isWorking && !hasStoryboardUpstream && (
              <div className="gen-dialog__safety-banner" role="status">
                <span>🛡️ 安全词审核已自动改写：{safetyAuditNotes.join("；")}</span>
              </div>
            )}
            {(slashSkillOpen || prompt.startsWith("/")) && !hasStoryboardUpstream && (
              <div className="gen-dialog__at-bar" role="listbox" aria-label="斜杠导演技能">
                <span className="gen-dialog__at-hint">/ 技能：</span>
                {filterDirectorSkills(prompt.startsWith("/") ? prompt.slice(1) : "").map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    className="gen-dialog__preset-chip gen-dialog__at-chip"
                    title={skill.desc}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleApplyPromptSlashSkill(skill);
                    }}
                  >
                    {skill.slash}
                  </button>
                ))}
              </div>
            )}
            {atSuggestOpen && refSourceNodes.length > 0 && !hasStoryboardUpstream && (
              <div className="gen-dialog__at-bar" role="listbox" aria-label="选择要引用的上游参考图">
                <span className="gen-dialog__at-hint">点选插入：</span>
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
            {hasStoryboardUpstream && (
              <p className="gen-dialog__hint gen-dialog__hint--locked">
                🎬 故事板动态演绎模板已启用（{totalPanels(storyboardUpstreamGrid)} 格分镜按顺序演绎）。
              </p>
            )}
            {inlineHint && (
              <p className="jm-context-generator__hint">{inlineHint}</p>
            )}

            {/* Bottom Flow Parameter Bar — Matching Screenshot 1 Layout with Flow's Real Settings */}
            <div className="jm-drop-bar">
              <div className="jm-drop-bar__left">
                {isVideo ? (
                  <>
                    {/* Model Picker */}
                    <label className="jm-drop-inline-ctrl jm-drop-inline-ctrl--model" title={selectedVideoEntry.bestFor}>
                      <span className="jm-drop-sparkle" aria-hidden="true">✦</span>
                      <select
                        aria-label="视频模型"
                        value={selectedVideoId}
                        onChange={(e) => applyVideoSelection(e.target.value as VideoModelCatalogEntry["id"])}
                      >
                        {VIDEO_MODEL_CATALOG.map((m) => {
                          const locked = !!m.ultraOnly && paygateTier !== "PAYGATE_TIER_TWO";
                          return (
                            <option key={m.id} value={m.id} disabled={locked}>
                              {m.label}{m.ultraOnly ? " (0分)" : ""}
                            </option>
                          );
                        })}
                      </select>
                    </label>

                    {/* Aspect · Resolution · Count compact group */}
                    <div className="jm-drop-spec-group" aria-label="画幅、清晰度与输出数量">
                      <select
                        aria-label="画幅比例"
                        value={aspectRatio}
                        onChange={(e) => updateAspectRatio(e.target.value as AspectKey)}
                      >
                        {VIDEO_ASPECT_RATIOS.map(({ key, label }) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                      <span className="jm-drop-spec-dot" aria-hidden="true">·</span>
                      <select
                        aria-label="视频分辨率"
                        value={activeVideoRes}
                        onChange={(e) => setVideoResolution(e.target.value as VideoResolutionKey)}
                      >
                        {VIDEO_RESOLUTION_OPTIONS.map((r) => {
                          const unsupported = !!r.omniOnly && effectiveVideoModelFamily !== "omni_flash";
                          return (
                            <option key={r.value} value={r.value} disabled={unsupported}>
                              {r.value.toUpperCase()}{unsupported ? " (Omni)" : ""}
                            </option>
                          );
                        })}
                      </select>
                      <span className="jm-drop-spec-dot" aria-hidden="true">·</span>
                      {effectiveVideoMode === "first_frame" && selectedSourceIdx.size > 1 ? (
                        <span className="jm-drop-spec-static">{selectedSourceIdx.size}条</span>
                      ) : (
                        <select
                          aria-label="视频输出数量"
                          value={variants}
                          onChange={(e) => updateVariants(Number(e.target.value))}
                        >
                          {OUTPUT_COUNT_OPTIONS.map((count) => (
                            <option key={count} value={count}>{count}条</option>
                          ))}
                        </select>
                      )}
                    </div>

                    {/* Video Generation Mode (Flow's Optional First-Frame / Ingredients / T2V / First+Last) */}
                    <label className="jm-drop-inline-ctrl" title="首帧一致为可选项：可按需选择纯文生、参考元素（不锁首帧）、首帧一致或首尾帧锁定">
                      <select
                        aria-label="视频生成模式"
                        value={effectiveVideoMode}
                        onChange={(e) => handleSelectVideoSubMode(e.target.value as VideoSubMode)}
                      >
                        <option value="t2v">纯文生视频</option>
                        <option value="ingredients" disabled={!hasAnyFrame}>
                          参考元素{hasAnyFrame ? "" : " (需连图)"}
                        </option>
                        <option value="first_frame" disabled={!hasAnyFrame}>
                          首帧一致{hasAnyFrame ? "" : " (需连图)"}
                        </option>
                        {hasTwoFrames && <option value="first_last">首尾帧锁定</option>}
                      </select>
                    </label>

                    {/* Duration */}
                    <label className="jm-drop-inline-ctrl" title="选择视频时长（3–15 秒）">
                      <select
                        aria-label="生成时长"
                        value={activeVideoDuration}
                        onChange={(e) => handleSelectVideoDuration(Number(e.target.value))}
                      >
                        {OMNI_1_2_DURATIONS.map((d) => (
                          <option key={d} value={d}>
                            {d}s{effectiveVideoModelFamily !== "omni_flash" && d !== 8 ? " · Omni" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : !isPrompt ? (
                  <>
                    {mediaProvider === "flow" ? (
                      <label className="jm-drop-inline-ctrl jm-drop-inline-ctrl--model" title={selectedImageEntry.bestFor}>
                        <span className="jm-drop-sparkle" aria-hidden="true">✦</span>
                        <select
                          aria-label="图片模型"
                          value={imageModel}
                          onChange={(e) => setImageModel(e.target.value as ImageModelKey)}
                        >
                          {IMAGE_MODEL_CATALOG.map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                        </select>
                      </label>
                    ) : (
                      <span className="jm-drop-spec-static">✦ Muse</span>
                    )}

                    <div className="jm-drop-spec-group" aria-label="比例、清晰度与张数">
                      <select
                        aria-label="画幅比例"
                        value={aspectRatio}
                        onChange={(e) => updateAspectRatio(e.target.value as AspectKey)}
                        title={`当前画幅 ${activeRatioLabel}`}
                      >
                        {IMAGE_ASPECT_RATIOS.map(({ key, label }) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                      <span className="jm-drop-spec-dot" aria-hidden="true">·</span>
                      <select
                        aria-label="图片清晰度"
                        value={imageResolution}
                        onChange={(e) => setImageResolution(e.target.value as ImageResolutionKey)}
                      >
                        {IMAGE_RESOLUTION_OPTIONS.map((r) => (
                          <option key={r.value} value={r.value}>{r.value}</option>
                        ))}
                      </select>
                      <span className="jm-drop-spec-dot" aria-hidden="true">·</span>
                      <select
                        aria-label="生成数量"
                        value={variants}
                        onChange={(e) => updateVariants(Number(e.target.value))}
                      >
                        {OUTPUT_COUNT_OPTIONS.map((count) => (
                          <option key={count} value={count}>{count}张</option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <span className="jm-drop-spec-static">文本节点 · 回车或点击右侧保存</span>
                )}

                {!isPrompt && refSourceNodes.length > 0 && !hasStoryboardUpstream && (
                  <button
                    type="button"
                    className={`jm-drop-at-btn${atSuggestOpen ? " jm-drop-at-btn--active" : ""}`}
                    onClick={() => setAtSuggestOpen((v) => !v)}
                    title="插入 @图N 引用上游参考素材"
                    aria-label="插入参考图引用"
                  >
                    @
                  </button>
                )}
              </div>

              <div className="jm-drop-bar__right">
                {costEstimate && (
                  <span
                    className={`jm-drop-cost${costEstimate.isZero ? " jm-drop-cost--zero" : ""}`}
                    title={costEstimate.breakdown}
                  >
                    <span className="jm-drop-sparkle" aria-hidden="true">✦</span>
                    {costEstimate.total !== null ? costEstimate.total : costEstimate.displayText.replace(/^消耗\s*/, "")}
                  </span>
                )}
                {showCreditsPill && (
                  <button
                    type="button"
                    className="jm-drop-balance"
                    onClick={() => void useFlowAccounts.getState().syncCredits()}
                    title="当前 Flow 实时积分余额（点击刷新）"
                  >
                    {liveCredits!.toLocaleString("zh-CN")}
                  </button>
                )}
                <button
                  type="button"
                  className={`jm-drop-submit${pendingAiConfirm ? " jm-drop-submit--confirm" : ""}`}
                  disabled={!canGenerate}
                  onClick={() => void handleSubmit()}
                  aria-label={
                    isPrompt
                      ? "保存文本"
                      : pendingAiConfirm
                        ? "确认并生成"
                        : isVideo && confirmBeforeVideoGen === "always"
                          ? "下一步：确认生成视频"
                          : "立即生成"
                  }
                  title={
                    isPrompt
                      ? "保存文本"
                      : pendingAiConfirm
                        ? "确认 AI 润色提示词并生成"
                        : isVideo && confirmBeforeVideoGen === "always"
                          ? "核对参数并确认生成视频（Ctrl / ⌘ + 回车）"
                          : "立即生成（Ctrl / ⌘ + 回车）"
                  }
                >
                  {isWorking || queued ? "…" : isPrompt ? "✓" : "↑"}
                </button>
              </div>
            </div>
          </div>
        </section>
        {videoConfirmPortal}
      </>
    );
  }

  if (isSidebar) {
    return (
      <>
        <div
          className="gen-sidebar-composer"
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (pendingVideoConfirm) {
                void confirmPendingVideoDispatch();
              } else if (canGenerate) {
                void handleSubmit();
              }
            }
          }}
        >
          <div className="gen-sidebar-composer__body">
            {subjectTemplatesSection}
            {characterVoiceSection}
            {promptField}
            {references}
            <ModalParameterControls
              isVideo={isVideo}
              isPrompt={isPrompt}
              isStoryboard={isStoryboard}
              isOmniVideo={effectiveVideoModelFamily === "omni_flash"}
              accountIssue={accountIssue ?? null}
              mediaProvider={mediaProvider}
              setMediaProvider={setMediaProvider}
              imageModel={imageModel}
              setImageModel={setImageModel}
              selectedImageEntry={selectedImageEntry}
              aspectRatio={aspectRatio}
              updateAspectRatio={updateAspectRatio}
              imageResolution={imageResolution}
              setImageResolution={setImageResolution}
              imageThinkingLevel={imageThinkingLevel}
              setImageThinkingLevel={setImageThinkingLevel}
              selectedVideoId={selectedVideoId}
              applyVideoSelection={applyVideoSelection}
              selectedVideoEntry={selectedVideoEntry}
              paygateTier={paygateTier ?? null}
              videoResolution={videoResolution}
              setVideoResolution={setVideoResolution}
              omniVersion={omniVersion}
              activeVideoDuration={activeVideoDuration}
              handleSelectVideoDuration={handleSelectVideoDuration}
              camera={camera}
              setCamera={setCamera}
              selectedSourceCount={effectiveVideoMode === "first_frame" ? selectedSourceIdx.size : 1}
              variants={variants}
              updateVariants={updateVariants}
              seedInput={seedInput}
              setSeedInput={setSeedInput}
              storyboardMode={storyboardMode}
              setStoryboardMode={setStoryboardMode}
              storyboardGrid={storyboardGrid}
              setStoryboardGrid={setStoryboardGrid}
            />
          </div>

          <div className="gen-sidebar-composer__footer">
            <div className="gen-sidebar-composer__meta">
              {isVideo && (
                <button
                  type="button"
                  className={`gen-dialog__confirm-toggle${confirmBeforeVideoGen === "always" ? " gen-dialog__confirm-toggle--on" : ""}`}
                  onClick={() =>
                    setConfirmBeforeVideoGen(
                      confirmBeforeVideoGen === "always" ? "never" : "always",
                    )
                  }
                  title="切换视频生成前二次确认策略（始终 / 永不）"
                >
                  生成前确认：{confirmBeforeVideoGen === "always" ? "始终" : "永不"}
                </button>
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
                  余额 {liveCredits!.toLocaleString("zh-CN")}
                </button>
              )}
            </div>
            <button
              className="gen-sidebar-composer__cta"
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canGenerate}
              title={
                nodeLLMBusy && !autoBuilding
                  ? "后台正在合成提示词，请稍候"
                  : undefined
              }
            >
              {isWorking
                ? "构思中…"
                : queued
                  ? node.data.status === "queued"
                    ? "已加入队列，等待生成…"
                    : "正在生成中…"
                  : isPrompt
                    ? "保存文本 ⌘↵"
                    : isVideo && confirmBeforeVideoGen === "always"
                      ? "下一步：确认生成视频 ⌘↵"
                      : pendingAiConfirm
                        ? "确认并生成 ⌘↵"
                        : isVideo
                          ? "立即生成视频 ⌘↵"
                          : "立即生成 ⌘↵"}
            </button>
          </div>
        </div>
        {videoConfirmPortal}
      </>
    );
  }

  return (
    <div
      className="gen-dialog-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (pendingVideoConfirm) setPendingVideoConfirm(null);
          else closeGenerationDialog();
        }
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
                ? "视频详细参数与生成"
                : isCharacter
                ? "主体设定详细参数"
                : isStoryboard
                ? "故事板详细参数"
                : isPrompt
                ? "编辑文本提示词"
                : "图片详细参数与生成"}
            </h2>
            <span className="gen-dialog__subtitle">
              节点 #{node?.data.shortId ?? rfId}
            </span>
          </div>
          <div className="gen-dialog__header-actions">
            {hasGeneratedMedia && (
              <button
                type="button"
                className="gen-dialog__showcase-btn"
                onClick={() => {
                  closeGenerationDialog();
                  openResultViewer(rfId, 0, "history");
                }}
                title={isVideo ? "打开官方风格视频展示页与时间轴播控" : "全屏预览已生成的图片与高清重塑"}
              >
                {isVideo ? "▶ 视频展示页" : "▣ 全屏预览"}
              </button>
            )}
            <button
              className="gen-dialog__close"
              onClick={closeGenerationDialog}
              aria-label="关闭窗口 (ESC)"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="gen-dialog__body">
        {subjectTemplatesSection}
        {characterVoiceSection}
        {promptField}
        {references}

        <ModalParameterControls
          isVideo={isVideo}
          isPrompt={isPrompt}
          isStoryboard={isStoryboard}
          isOmniVideo={effectiveVideoModelFamily === "omni_flash"}
          accountIssue={accountIssue ?? null}
          mediaProvider={mediaProvider}
          setMediaProvider={setMediaProvider}
          imageModel={imageModel}
          setImageModel={setImageModel}
          selectedImageEntry={selectedImageEntry}
          aspectRatio={aspectRatio}
          updateAspectRatio={updateAspectRatio}
          imageResolution={imageResolution}
          setImageResolution={setImageResolution}
          imageThinkingLevel={imageThinkingLevel}
          setImageThinkingLevel={setImageThinkingLevel}
          selectedVideoId={selectedVideoId}
          applyVideoSelection={applyVideoSelection}
          selectedVideoEntry={selectedVideoEntry}
          paygateTier={paygateTier ?? null}
          videoResolution={videoResolution}
          setVideoResolution={setVideoResolution}
          omniVersion={omniVersion}
          activeVideoDuration={activeVideoDuration}
          handleSelectVideoDuration={handleSelectVideoDuration}
          camera={camera}
          setCamera={setCamera}
          selectedSourceCount={effectiveVideoMode === "first_frame" ? selectedSourceIdx.size : 1}
          variants={variants}
          updateVariants={updateVariants}
          seedInput={seedInput}
          setSeedInput={setSeedInput}
          storyboardMode={storyboardMode}
          setStoryboardMode={setStoryboardMode}
          storyboardGrid={storyboardGrid}
          setStoryboardGrid={setStoryboardGrid}
        />
        </div>

        {/* Footer */}
        <div className="gen-dialog__footer">
          <span className="gen-dialog__board-ctx">
            {boardName === "Untitled" || !boardName ? "未命名项目" : boardName} · 共 {nodeCount} 个节点
          </span>
          {isVideo && (
            <button
              type="button"
              className={`gen-dialog__confirm-toggle${confirmBeforeVideoGen === "always" ? " gen-dialog__confirm-toggle--on" : ""}`}
              onClick={() =>
                setConfirmBeforeVideoGen(
                  confirmBeforeVideoGen === "always" ? "never" : "always",
                )
              }
              title="切换视频生成前二次确认策略（可在设置中修改：始终 / 永不）"
            >
              生成前确认：{confirmBeforeVideoGen === "always" ? "始终" : "永不"}
            </button>
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
              : isVideo && confirmBeforeVideoGen === "always"
              ? "下一步：确认生成 ⌘↵"
              : pendingAiConfirm
              ? "确认并生成 ⌘↵"
              : "立即生成 ⌘↵"}
          </button>
        </div>

        {videoConfirmPortal}
      </div>
    </div>
  );
}
