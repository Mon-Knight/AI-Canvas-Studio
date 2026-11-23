import { create } from "zustand";
import {
  ensureBoardProject,
  createRequest,
  listBoardRequests,
} from "../api/client";
import { useBoardStore, type FlowNode } from "./board";
import { normalizePromptRefMentions } from "../lib/promptMentions";
import {
  useSettingsStore,
  type ImageModelKey,
  type ImageResolutionKey,
  type ImageThinkingLevel,
  type MediaProviderKey,
  type OmniFlashVersion,
  type VideoModelFamily,
  type VideoQuality,
  type VideoResolutionKey,
} from "./settings";
import { useFlowAccounts } from "./flowAccounts";
import {
  resolveVideoRefAsImageMediaId,
  type VideoRefFrameMode,
} from "../lib/videoFrame";
import {
  cacheVideoFrameOnNode,
  collectUpstreamPromptText,
  collectUpstreamRefEntries,
  collectUpstreamRefMediaIds,
  resolveUpstreamRefImageIds,
  snapshotExistingHistory,
  type UpstreamRefEntry,
} from "./generation/upstreamRefs";
import {
  createGenerationPollers,
  MEDIA_PRODUCING_TYPES,
  SIDECAR_TYPES,
  sidecarStatusPatch,
  type PollEntry,
  type SidecarType,
} from "./generation/poller";

export {
  collectUpstreamPromptText,
  collectUpstreamRefEntries,
  collectUpstreamRefMediaIds,
  type UpstreamRefEntry,
};

async function resolveBoardProject() {
  const boardId = useBoardStore.getState().boardId;
  if (boardId === null) throw new Error("请先打开一个画布。");
  return ensureBoardProject(boardId);
}

interface GenerationState {
  active: Record<string, PollEntry>;
  sidecar: Record<string, PollEntry>;
  openDialog: { rfId: string | null; prompt: string };
  openViewer: { rfId: string | null; idx: number };
  videoDraft: { rfId: string; prompt: string; revision: number } | null;
  projectId: string | null;
  paygateTier: "PAYGATE_TIER_ONE" | "PAYGATE_TIER_TWO" | null;
  error: string | null;

  openGenerationDialog(rfId: string, prompt: string): void;
  closeGenerationDialog(): void;
  openResultViewer(rfId: string, idx?: number): void;
  closeResultViewer(): void;

  ensureProjectId(): Promise<string | null>;
  ensureProjectBinding(): Promise<Awaited<ReturnType<typeof resolveBoardProject>> | null>;

  dispatchGeneration(
    rfId: string,
    opts: {
      prompt: string;
      aspectRatio?: string;
      paygateTier?: string;
      kind?: "image" | "video";
      mediaProvider?: MediaProviderKey;
      flowAccountId?: string;
      flowProjectId?: string;
      sourceMediaId?: string;
      sourceMediaIds?: string[];
      variantCount?: number;
      prompts?: string[];
      imageModel?: ImageModelKey;
      imageResolution?: ImageResolutionKey;
      thinkingLevel?: ImageThinkingLevel;
      seed?: number | null;
      videoModel?: VideoModelFamily;
      videoQuality?: VideoQuality;
      omniVersion?: OmniFlashVersion;
      durationSeconds?: number;
      videoResolution?: VideoResolutionKey;
      videoRefFrame?: VideoRefFrameMode;
      videoSubMode?: "auto" | "first_last" | "t2v";
      endMediaId?: string;
    },
  ): Promise<void>;

  refineImage(
    rfId: string,
    opts: {
      prompt: string;
      refMediaIds?: string[];
      aspectRatio?: string;
      imageModel?: ImageModelKey;
      imageResolution?: ImageResolutionKey;
      thinkingLevel?: ImageThinkingLevel;
      seed?: number | null;
    },
  ): Promise<void>;

  resumeActiveRequests(boardId: number): Promise<void>;
  cancelGeneration(rfId: string): void;
  cancelSidecarPoll(rfId: string): void;
  clearError(): void;
}

let draftRevision = 0;
const submittingVideo = new Set<string>();

let attachPollFn: ReturnType<typeof createGenerationPollers>["attachPoll"];
let attachSidecarPollFn: ReturnType<typeof createGenerationPollers>["attachSidecarPoll"];

async function submitFlowVideo(
  rfId: string,
  opts: {
    prompt: string;
    aspectRatio?: string;
    flowAccountId?: string;
    flowProjectId?: string;
    sourceMediaId?: string;
    sourceMediaIds?: string[];
    variantCount?: number;
    videoModel?: VideoModelFamily;
    videoQuality?: VideoQuality;
    omniVersion?: OmniFlashVersion;
    durationSeconds?: number;
    videoResolution?: VideoResolutionKey;
    videoRefFrame?: VideoRefFrameMode;
    videoSubMode?: "auto" | "first_last" | "t2v";
    endMediaId?: string;
  },
) {
  const board = useBoardStore.getState();
  const node = board.nodes.find((n) => n.id === rfId);
  if (node?.data.type !== "video" || board.boardId === null) return;
  if (
    submittingVideo.has(rfId) ||
    useGenerationStore.getState().active[rfId] ||
    node.data.status === "running" ||
    node.data.status === "queued"
  )
    return;
  const snapshot = useFlowAccounts.getState().snapshot;
  const account = snapshot?.accounts.find(
    (a) => a.id === snapshot.active_account_id,
  );
  const reject = (error: string) => {
    useGenerationStore.setState({ error });
    useBoardStore.getState().updateNodeData(rfId, { status: "error", error });
  };
  if (!account) return reject("请先在右上角选择要使用的 Flow 账号。");
  if (
    !opts.flowAccountId ||
    opts.flowAccountId !== account.id ||
    opts.flowProjectId !== account.project_id
  )
    return reject("Flow 账号或项目已更换，请确认后重新提交。");
  if (!account.project_id || !account.connected || !account.flow_tab_open)
    return reject("请在右上角绑定 Flow 项目，并打开该账号的 Flow 网页、连接扩展。");
  if (!opts.prompt.trim()) return reject("请输入视频提示词。");
  const settings = useSettingsStore.getState();
  const chosenModelFamily = opts.videoModel ?? settings.videoModel;
  const omni = chosenModelFamily === "omni_flash";
  const omniVersion: OmniFlashVersion =
    opts.omniVersion ?? settings.omniVersion ?? "1.2";
  const rawDuration = opts.durationSeconds ?? settings.omniFlashDuration ?? 4;
  const durationS =
    omniVersion === "1.1" && ![4, 6, 8, 10].includes(rawDuration)
      ? 4
      : Math.min(15, Math.max(3, Math.round(rawDuration)));
  const videoQuality = opts.videoQuality ?? settings.videoQuality;
  const rawVideoRes = opts.videoResolution ?? settings.videoResolution ?? "720p";
  const videoResolution: VideoResolutionKey =
    !omni && rawVideoRes === "360p" ? "720p" : rawVideoRes;
  const variantCount = Math.min(
    4,
    Math.max(1, opts.variantCount ?? settings.defaultVideoCount ?? 1),
  );
  const rawEntries = collectUpstreamRefEntries(rfId, board.nodes, board.edges);
  const subMode = opts.videoSubMode ?? "auto";
  const rawReferences =
    subMode === "t2v"
      ? []
      : subMode === "first_last" && opts.sourceMediaId && opts.endMediaId
        ? [opts.sourceMediaId, opts.endMediaId]
        : omni
          ? collectUpstreamRefMediaIds(rfId)
          : opts.sourceMediaIds?.length
            ? opts.sourceMediaIds
            : opts.sourceMediaId
              ? [opts.sourceMediaId]
              : collectUpstreamRefMediaIds(rfId);
  const isTextToVideo = subMode === "t2v" || rawReferences.length === 0;
  const isFirstLast = subMode === "first_last" && rawReferences.length >= 2;
  const videoNodeByMediaId = new Map<string, FlowNode>();
  for (const entry of rawEntries) {
    if (entry.node.data.type === "video") {
      videoNodeByMediaId.set(entry.mediaId, entry.node);
      for (const vm of entry.allVariants) {
        videoNodeByMediaId.set(vm, entry.node);
      }
    }
  }
  const hasVideoSource =
    !isTextToVideo && rawReferences.some((id) => videoNodeByMediaId.has(id));
  const nodeId = Number(rfId);
  if (!Number.isSafeInteger(nodeId) || nodeId < 1)
    return reject("视频节点尚未保存。");
  const draftAtSubmit = useGenerationStore.getState().videoDraft;
  submittingVideo.add(rfId);
  try {
    let references = rawReferences;
    if (hasVideoSource) {
      const mode: VideoRefFrameMode = opts.videoRefFrame ?? "last";
      const resolvedList: string[] = [];
      for (const mediaId of rawReferences) {
        const videoSourceNode = videoNodeByMediaId.get(mediaId);
        if (!videoSourceNode) {
          resolvedList.push(mediaId);
          continue;
        }
        const extractedId = await resolveVideoRefAsImageMediaId({
          videoMediaId: mediaId,
          mode,
          projectId: account.project_id,
          nodeId: parseInt(videoSourceNode.id, 10) || undefined,
          flowAccountId: account.id,
          existingCache: videoSourceNode.data.videoFrameCache,
          onCacheUpdate: (cacheKey, imageMediaId) => {
            cacheVideoFrameOnNode(videoSourceNode, cacheKey, imageMediaId);
          },
        });
        resolvedList.push(extractedId);
      }
      references = isFirstLast
        ? resolvedList
        : Array.from(new Set(resolvedList));
    }

    const normalizedPrompt = normalizePromptRefMentions(
      opts.prompt,
      references.length,
    );
    let reqType: string;
    let reqParams: Record<string, unknown>;
    const aspect =
      opts.aspectRatio ??
      settings.defaultVideoAspect ??
      "VIDEO_ASPECT_RATIO_LANDSCAPE";

    if (isFirstLast && references.length >= 2) {
      const firstLastDur = [4, 6, 8, 10].reduce((best, cand) =>
        Math.abs(cand - durationS) < Math.abs(best - durationS) ? cand : best,
      );
      reqType = "gen_video_first_last";
      reqParams = {
        media_provider: "flow",
        project_id: account.project_id,
        prompt: normalizedPrompt,
        aspect_ratio: aspect,
        resolution: rawVideoRes,
        variant_count: variantCount,
        duration_s: firstLastDur,
        start_media_id: references[0],
        end_media_id: references[1],
      };
    } else if (isTextToVideo) {
      const t2vDur = durationS >= 7 ? 8 : 4;
      reqType = "gen_video_text";
      reqParams = {
        media_provider: "flow",
        project_id: account.project_id,
        prompt: normalizedPrompt,
        aspect_ratio: aspect,
        resolution: rawVideoRes === "360p" ? "720p" : rawVideoRes,
        variant_count: variantCount,
        duration_s: t2vDur,
      };
    } else {
      reqType = omni ? "gen_video_omni" : "gen_video";
      reqParams = {
        media_provider: "flow",
        project_id: account.project_id,
        prompt: normalizedPrompt,
        aspect_ratio: aspect,
        resolution: videoResolution,
        variant_count: variantCount,
        ...(omni
          ? {
              duration_s: durationS,
              omni_version: omniVersion,
              ref_media_ids: references,
            }
          : {
              video_quality: videoQuality,
              ...(references.length === 1
                ? { start_media_id: references[0] }
                : { start_media_ids: references }),
            }),
      };
    }

    const req = await createRequest({
      type: reqType,
      node_id: nodeId,
      flow_account_id: account.id,
      params: reqParams,
    });
    const live = useBoardStore.getState();
    if (
      live.boardId !== board.boardId ||
      !live.nodes.some((n) => n.id === rfId)
    )
      return;
    live.updateNodeData(rfId, {
      status: "queued",
      prompt: normalizedPrompt,
      error: undefined,
      videoResolution:
        reqType === "gen_video_text" && rawVideoRes === "360p"
          ? "720p"
          : videoResolution,
      ...(omni ? { omniVersion, durationSeconds: durationS } : { videoQuality }),
      ...(!node.data.mediaId && !node.data.mediaIds?.some(Boolean)
        ? {
            variantCount:
              isTextToVideo || isFirstLast || omni
                ? variantCount
                : Math.max(references.length, variantCount),
          }
        : {}),
    });
    if (
      draftAtSubmit?.rfId === rfId &&
      useGenerationStore.getState().videoDraft === draftAtSubmit
    )
      useGenerationStore.setState({ videoDraft: null });
    attachPollFn(rfId, req.id, {
      prompt: normalizedPrompt,
      aspectRatio: opts.aspectRatio,
    });
  } catch (err) {
    reject(
      err instanceof Error
        ? err.message
        : "视频提交失败，请先查看任务记录再重试。",
    );
  } finally {
    submittingVideo.delete(rfId);
  }
}

export const useGenerationStore = create<GenerationState>((set, get) => {
  const pollers = createGenerationPollers(get, set);
  attachPollFn = pollers.attachPoll;
  attachSidecarPollFn = pollers.attachSidecarPoll;

  return {
    active: {},
    sidecar: {},
    openDialog: { rfId: null, prompt: "" },
    openViewer: { rfId: null, idx: 0 },
    projectId: null,
    videoDraft: null,
    paygateTier: null,
    error: null,

    openGenerationDialog(rfId, prompt) {
      const board = useBoardStore.getState();
      if (board.nodes.some((n) => n.id === rfId && n.data.type === "video")) {
        board.setNodes(
          board.nodes.map((n) =>
            !!n.selected === (n.id === rfId)
              ? n
              : { ...n, selected: n.id === rfId },
          ),
        );
        set({
          openDialog: { rfId: null, prompt: "" },
          videoDraft: { rfId, prompt, revision: ++draftRevision },
        });
        return;
      }
      set({ openDialog: { rfId, prompt } });
    },

    closeGenerationDialog() {
      set({ openDialog: { rfId: null, prompt: "" } });
    },

    openResultViewer(rfId, idx = 0) {
      set({ openViewer: { rfId, idx } });
    },

    closeResultViewer() {
      set({ openViewer: { rfId: null, idx: 0 } });
    },

    async ensureProjectId() {
      return (await get().ensureProjectBinding())?.flow_project_id ?? null;
    },

    async ensureProjectBinding() {
      try {
        const proj = await resolveBoardProject();
        set({ projectId: proj.flow_project_id });
        return proj;
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) });
        return null;
      }
    },

    async dispatchGeneration(rfId, opts) {
      if (opts.kind === "video") {
        return submitFlowVideo(rfId, opts);
      }
      const mediaProvider =
        opts.mediaProvider ?? useSettingsStore.getState().mediaProvider;
      let projectId = "";
      let flowAccountId: string | null = null;
      if (mediaProvider === "flow") {
        try {
          const project = await resolveBoardProject();
          projectId = project.flow_project_id;
          flowAccountId = project.flow_account_id ?? null;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
          return;
        }
      }

      const knownTier = opts.paygateTier ?? get().paygateTier;
      if (mediaProvider === "flow" && !knownTier) {
        set({
          error:
            "尚未检测到有效套餐等级，请先在右上角「Flow 账号」或「更多 ··· → 生成引擎与项目设置」中确认套餐配置（Pro / Ultra）后重试。",
        });
        useBoardStore.getState().updateNodeData(rfId, {
          status: "error",
          error: "尚未配置套餐等级",
        });
        return;
      }

      get().cancelGeneration(rfId);

      const variantCount = Math.max(1, Math.min(opts.variantCount ?? 1, 4));
      const preservedHistory = snapshotExistingHistory(rfId);
      useBoardStore.getState().updateNodeData(rfId, {
        status: "queued",
        prompt: opts.prompt,
        error: undefined,
        variantCount,
        ...(preservedHistory.length > 0 ? { history: preservedHistory } : {}),
        mediaIds: undefined,
        mediaId: undefined,
      });

      let reqDto;
      let normalizedPrompt = opts.prompt;
      try {
        const nodeDbId = parseInt(rfId, 10);
        const refMediaIds = await resolveUpstreamRefImageIds(rfId, {
          projectId,
          flowAccountId,
          videoRefFrame: opts.videoRefFrame,
        });
        normalizedPrompt = normalizePromptRefMentions(
          opts.prompt,
          refMediaIds.length,
        );
        const curSettings = useSettingsStore.getState();
        const chosenImageModel = opts.imageModel ?? curSettings.imageModel;
        const chosenImageResolution =
          opts.imageResolution ?? curSettings.imageResolution;
        const chosenThinking =
          opts.thinkingLevel ?? curSettings.imageThinkingLevel;
        const params: Record<string, unknown> = {
          prompt: normalizedPrompt,
          media_provider: mediaProvider,
          project_id: projectId,
          aspect_ratio:
            opts.aspectRatio ??
            curSettings.defaultImageAspect ??
            "IMAGE_ASPECT_RATIO_LANDSCAPE",
          paygate_tier:
            opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
          variant_count: variantCount,
          image_model: chosenImageModel,
          image_resolution: chosenImageResolution,
        };
        if (
          chosenImageModel === "NANO_BANANA_2_1" &&
          chosenThinking !== "default"
        ) {
          params.thinking_level = chosenThinking;
        }
        if (typeof opts.seed === "number" && !Number.isNaN(opts.seed)) {
          params.seed = opts.seed;
        }
        if (refMediaIds.length > 0) {
          params.ref_media_ids = refMediaIds;
        }
        if (opts.prompts && opts.prompts.length > 0) {
          params.prompts = opts.prompts.map((p) =>
            normalizePromptRefMentions(p, refMediaIds.length),
          );
        }
        reqDto = await createRequest({
          type: "gen_image",
          flow_account_id: flowAccountId,
          node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
          params,
        });
      } catch (err) {
        useBoardStore.getState().updateNodeData(rfId, {
          status: "error",
          error: err instanceof Error ? err.message : "请求提交失败",
        });
        set({ error: err instanceof Error ? err.message : "生成请求提交失败" });
        return;
      }

      pollers.attachPoll(rfId, reqDto.id, {
        prompt: normalizedPrompt,
        aspectRatio: opts.aspectRatio,
      });
    },

    async resumeActiveRequests(boardId) {
      let items;
      try {
        ({ items } = await listBoardRequests(boardId, {
          active: true,
          kinds: ["worker", "sidecar"],
        }));
      } catch {
        return;
      }

      for (const item of items) {
        if (item.node_id === null) continue;
        const rfId = String(item.node_id);

        if (SIDECAR_TYPES.has(item.type)) {
          if (get().sidecar[rfId] !== undefined) continue;
          const type = item.type as SidecarType;
          useBoardStore
            .getState()
            .updateNodeData(rfId, sidecarStatusPatch(type, "pending"));
          attachSidecarPollFn(rfId, item.id, type);
          continue;
        }

        if (!MEDIA_PRODUCING_TYPES.has(item.type)) continue;
        if (get().active[rfId] !== undefined) continue;

        const prompt =
          typeof item.params["prompt"] === "string"
            ? item.params["prompt"]
            : "";
        const aspectRatio =
          typeof item.params["aspect_ratio"] === "string"
            ? (item.params["aspect_ratio"] as string)
            : undefined;

        useBoardStore.getState().updateNodeData(rfId, {
          status: item.status === "running" ? "running" : "queued",
          ...(prompt ? { prompt } : {}),
        });

        pollers.attachPoll(rfId, item.id, { prompt, aspectRatio });
      }
    },

    async refineImage(rfId, opts) {
      const mediaProvider: MediaProviderKey =
        useSettingsStore.getState().mediaProvider;
      const useMuse = mediaProvider === "muse";
      let projectId = "";
      let flowAccountId: string | null = null;
      if (!useMuse) {
        try {
          const project = await resolveBoardProject();
          projectId = project.flow_project_id;
          flowAccountId = project.flow_account_id ?? null;
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
          return;
        }
      }

      const node = useBoardStore.getState().nodes.find((n) => n.id === rfId);
      const sourceMediaId = node?.data.mediaId;
      if (!sourceMediaId) {
        set({ error: "未找到可精修的源图像" });
        return;
      }

      get().cancelGeneration(rfId);

      const preservedHistory = snapshotExistingHistory(rfId);
      useBoardStore.getState().updateNodeData(rfId, {
        status: "queued",
        prompt: opts.prompt,
        error: undefined,
        variantCount: 1,
        ...(preservedHistory.length > 0 ? { history: preservedHistory } : {}),
        mediaIds: undefined,
      });

      const sSettings = useSettingsStore.getState();
      const chosenModel = opts.imageModel ?? sSettings.imageModel;
      const chosenRes = opts.imageResolution ?? sSettings.imageResolution;
      const chosenThinking =
        opts.thinkingLevel ?? sSettings.imageThinkingLevel;

      const nodeDbId = parseInt(rfId, 10);
      let reqDto;
      try {
        reqDto = await createRequest({
          type: "edit_image",
          flow_account_id: flowAccountId,
          node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
          params: {
            prompt: opts.prompt,
            media_provider: mediaProvider,
            project_id: projectId,
            source_media_id: sourceMediaId,
            ref_media_ids: opts.refMediaIds ?? [],
            aspect_ratio: opts.aspectRatio ?? "IMAGE_ASPECT_RATIO_LANDSCAPE",
            paygate_tier: get().paygateTier ?? "PAYGATE_TIER_ONE",
            image_model: chosenModel,
            image_resolution: chosenRes,
            ...(chosenModel === "NANO_BANANA_2_1" &&
            chosenThinking !== "default"
              ? { thinking_level: chosenThinking }
              : {}),
            ...(typeof opts.seed === "number" && !Number.isNaN(opts.seed)
              ? { seed: opts.seed }
              : {}),
          },
        });
      } catch (err) {
        useBoardStore.getState().updateNodeData(rfId, {
          status: "error",
          error: err instanceof Error ? err.message : "图像精修请求失败",
        });
        set({ error: err instanceof Error ? err.message : "图像精修请求失败" });
        return;
      }

      pollers.attachPoll(rfId, reqDto.id, {
        prompt: opts.prompt,
        aspectRatio: opts.aspectRatio,
      });
    },

    cancelGeneration(rfId) {
      const entry = get().active[rfId];
      if (entry && entry.timerId !== null) {
        clearTimeout(entry.timerId);
      }
      set((s) => {
        const next = { ...s.active };
        delete next[rfId];
        return { active: next };
      });
    },

    cancelSidecarPoll(rfId) {
      const entry = get().sidecar[rfId];
      if (entry && entry.timerId !== null) {
        clearTimeout(entry.timerId);
      }
      set((s) => {
        const next = { ...s.sidecar };
        delete next[rfId];
        return { sidecar: next };
      });
    },

    clearError() {
      set({ error: null });
    },
  };
});
