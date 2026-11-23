import { getRequest, patchNode } from "../../api/client";
import { useBoardStore, type FlowboardNodeData } from "../board";
import { appendRenderToHistory } from "./upstreamRefs";

export type PollEntry = {
  requestId: number;
  timerId: ReturnType<typeof setTimeout> | null;
};

export type PollOpts = { prompt: string; aspectRatio?: string };

export type SidecarType = "vision" | "auto_prompt" | "auto_prompt_batch";

export const SIDECAR_TYPES = new Set<string>([
  "vision",
  "auto_prompt",
  "auto_prompt_batch",
]);

export const MEDIA_PRODUCING_TYPES = new Set([
  "gen_image",
  "gen_video",
  "gen_video_omni",
  "gen_video_first_last",
  "gen_video_text",
  "edit_image",
]);

export function sidecarStatusPatch(
  type: SidecarType,
  value: "pending" | "failed" | undefined,
): Partial<FlowboardNodeData> {
  return type === "vision"
    ? { aiBriefStatus: value }
    : { autoPromptStatus: value };
}

function sidecarDonePatch(
  type: SidecarType,
  result: Record<string, unknown>,
): Partial<FlowboardNodeData> {
  if (type === "vision") {
    const description = result["description"];
    return {
      aiBriefStatus: "done",
      ...(typeof description === "string" && description
        ? { aiBrief: description }
        : {}),
    };
  }
  const single = result["prompt"];
  const batch = result["prompts"];
  const text =
    typeof single === "string" && single
      ? single
      : Array.isArray(batch) && typeof batch[0] === "string"
        ? (batch[0] as string)
        : null;
  return {
    autoPromptStatus: undefined,
    ...(text ? { prompt: text } : {}),
  };
}

export interface PollerStoreSlice {
  active: Record<string, PollEntry>;
  sidecar: Record<string, PollEntry>;
  error: string | null;
}

export function createGenerationPollers<S extends PollerStoreSlice>(
  getState: () => S,
  setState: (
    partial: Partial<S> | ((state: S) => Partial<S> | S),
  ) => void,
) {
  function ownsPoll(rfId: string, requestId: number): boolean {
    return getState().active[rfId]?.requestId === requestId;
  }

  function attachPoll(rfId: string, requestId: number, opts: PollOpts) {
    const MAX_NETWORK_RETRIES = 8;
    let networkRetries = 0;

    function scheduleNextPoll() {
      if (!ownsPoll(rfId, requestId)) return;

      const timerId = setTimeout(async () => {
        if (!ownsPoll(rfId, requestId)) return;
        try {
          const req = await getRequest(requestId);
          if (!ownsPoll(rfId, requestId)) return;
          networkRetries = 0;

          if (req.status === "running") {
            useBoardStore.getState().updateNodeData(rfId, { status: "running" });
            setState((s) => ({
              active: { ...s.active, [rfId]: { requestId, timerId: null } },
            } as Partial<S>));
            scheduleNextPoll();
          } else if (req.status === "done") {
            const mediaIds =
              (req.result["media_ids"] as (string | null)[] | undefined) ?? [];
            const mediaId = mediaIds.find(
              (m): m is string => typeof m === "string" && m.length > 0,
            );
            const producesMedia = MEDIA_PRODUCING_TYPES.has(req.type);
            const partialError =
              (req.result["partial_error"] as string | undefined) ?? null;
            const slotErrors =
              (req.result["slot_errors"] as (string | null)[] | undefined) ??
              null;
            const stampedImageModel =
              req.type === "gen_image" || req.type === "edit_image"
                ? (req.params["image_model"] as string | undefined)
                : undefined;

            let stampedVideoQuality: string | undefined;
            if (
              req.type === "gen_video" &&
              req.params.media_provider === "google_video"
            ) {
              stampedVideoQuality = String(
                req.result.model || "Gemini Omni Flash",
              );
            } else if (req.type === "gen_video") {
              stampedVideoQuality = req.params["video_quality"] as
                | string
                | undefined;
            } else if (req.type === "gen_video_omni") {
              const d = req.params["duration_s"] as number | undefined;
              const ver = req.params["omni_version"] as string | undefined;
              if (ver === "1.2" && typeof d === "number" && d >= 3 && d <= 15) {
                stampedVideoQuality = `omni_1.2_${d}s`;
              } else if (d === 4 || d === 6 || d === 8 || d === 10) {
                stampedVideoQuality = `abra_r2v_${d}s`;
              }
            } else if (req.type === "gen_video_first_last") {
              const d = (req.result["duration_s"] ??
                req.params["duration_s"] ??
                8) as number;
              stampedVideoQuality = `first_last_${d}s`;
            } else if (req.type === "gen_video_text") {
              const d = (req.result["duration_s"] ??
                req.params["duration_s"] ??
                4) as number;
              stampedVideoQuality = `t2v_${d}s`;
            }

            const isVideoReqType = req.type.startsWith("gen_video");
            const videoMetadata = isVideoReqType
              ? {
                  mediaProvider: String(req.params.media_provider || "flow"),
                  durationSeconds:
                    typeof req.result["duration_s"] === "number"
                      ? (req.result["duration_s"] as number)
                      : typeof req.params.duration_s === "number"
                        ? req.params.duration_s
                        : null,
                  ...(typeof req.params.resolution === "string"
                    ? { videoResolution: req.params.resolution }
                    : {}),
                  ...(typeof req.params.omni_version === "string"
                    ? { omniVersion: req.params.omni_version }
                    : {}),
                }
              : {};
            const imageMeta =
              req.type === "gen_image" || req.type === "edit_image"
                ? {
                    ...(typeof req.params.image_resolution === "string"
                      ? { imageResolution: req.params.image_resolution }
                      : {}),
                    ...(typeof req.params.thinking_level === "string"
                      ? { thinkingLevel: req.params.thinking_level }
                      : {}),
                    ...(typeof req.params.seed === "number"
                      ? { seed: req.params.seed }
                      : {}),
                  }
                : {};
            const renderedAt = new Date().toISOString();
            const nextHistory =
              producesMedia && mediaId
                ? appendRenderToHistory(rfId, {
                    mediaId,
                    mediaIds,
                    prompt:
                      opts.prompt ||
                      (typeof req.params.prompt === "string"
                        ? req.params.prompt
                        : undefined),
                    renderedAt,
                    aspectRatio: opts.aspectRatio,
                    imageModel: stampedImageModel,
                    videoQuality: stampedVideoQuality,
                  })
                : undefined;

            useBoardStore.getState().updateNodeData(rfId, {
              status: "done",
              ...videoMetadata,
              ...imageMeta,
              ...(req.type.startsWith("gen_video") && mediaIds.length
                ? { variantCount: mediaIds.length }
                : {}),
              ...(producesMedia
                ? { mediaId, mediaIds, slotErrors: slotErrors ?? undefined }
                : {}),
              ...(nextHistory ? { history: nextHistory } : {}),
              aiBrief: undefined,
              ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
              renderedAt,
              error: partialError ?? undefined,
              ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
              ...(stampedVideoQuality
                ? { videoQuality: stampedVideoQuality }
                : {}),
            });

            const dbId = parseInt(rfId, 10);
            if (!isNaN(dbId) && producesMedia && mediaId) {
              const n = useBoardStore
                .getState()
                .nodes.find((x) => x.id === rfId);
              const d = n?.data;
              patchNode(dbId, {
                status: "done",
                data: {
                  ...(opts.prompt ? { prompt: opts.prompt } : {}),
                  mediaId,
                  mediaIds,
                  ...(nextHistory ? { history: nextHistory } : {}),
                  slotErrors: slotErrors ?? null,
                  variantCount: req.type.startsWith("gen_video")
                    ? mediaIds.length
                    : d?.variantCount ?? mediaIds.length,
                  aiBrief: null,
                  ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
                  renderedAt,
                  error: partialError ?? null,
                  ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
                  ...(stampedVideoQuality
                    ? { videoQuality: stampedVideoQuality }
                    : {}),
                },
              }).catch(() => {});
            }

            setState((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next } as Partial<S>;
            });
            if (
              typeof window !== "undefined" &&
              typeof window.dispatchEvent === "function"
            ) {
              window.dispatchEvent(new Event("flowboard:credits-stale"));
            }
          } else if (req.status === "failed" || req.status === "timeout") {
            const errMsg =
              req.status === "timeout"
                ? `视频任务等待超时（${req.error ?? "video_timeout"}），请先核对生成记录再重试。`
                : (req.error ?? "生成失败");
            useBoardStore
              .getState()
              .updateNodeData(rfId, { status: "error", error: errMsg });
            setState((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next, error: errMsg } as Partial<S>;
            });
          } else if (req.status === "canceled") {
            useBoardStore.getState().updateNodeData(rfId, { status: "idle" });
            setState((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return { active: next } as Partial<S>;
            });
            if (
              typeof window !== "undefined" &&
              typeof window.dispatchEvent === "function"
            ) {
              window.dispatchEvent(new Event("flowboard:credits-stale"));
            }
          } else {
            setState((s) => ({
              active: { ...s.active, [rfId]: { requestId, timerId: null } },
            } as Partial<S>));
            scheduleNextPoll();
          }
        } catch (err) {
          if (!ownsPoll(rfId, requestId)) return;
          networkRetries += 1;
          if (networkRetries >= MAX_NETWORK_RETRIES) {
            const msg = err instanceof Error ? err.message : "网络异常";
            useBoardStore
              .getState()
              .updateNodeData(rfId, { status: "error", error: msg });
            setState((s) => {
              const next = { ...s.active };
              delete next[rfId];
              return {
                active: next,
                error: `轮询任务状态失败：${msg}`,
              } as Partial<S>;
            });
            return;
          }
          scheduleNextPoll();
        }
      }, 1500);

      setState((s) => ({
        active: { ...s.active, [rfId]: { requestId, timerId } },
      } as Partial<S>));
    }

    const outgoing = getState().active[rfId];
    if (outgoing && outgoing.timerId !== null) clearTimeout(outgoing.timerId);

    setState((s) => ({
      active: { ...s.active, [rfId]: { requestId, timerId: null } },
    } as Partial<S>));
    scheduleNextPoll();
  }

  function ownsSidecarPoll(rfId: string, requestId: number): boolean {
    return getState().sidecar[rfId]?.requestId === requestId;
  }

  function releaseSidecarPoll(rfId: string, requestId: number) {
    setState((s) => {
      if (s.sidecar[rfId]?.requestId !== requestId) return s;
      const next = { ...s.sidecar };
      delete next[rfId];
      return { sidecar: next } as Partial<S>;
    });
  }

  function attachSidecarPoll(
    rfId: string,
    requestId: number,
    type: SidecarType,
  ) {
    const MAX_NETWORK_RETRIES = 8;
    let networkRetries = 0;

    function scheduleNextPoll() {
      if (!ownsSidecarPoll(rfId, requestId)) return;

      const timerId = setTimeout(async () => {
        if (!ownsSidecarPoll(rfId, requestId)) return;
        try {
          const req = await getRequest(requestId);
          if (!ownsSidecarPoll(rfId, requestId)) return;
          networkRetries = 0;

          if (req.status === "done") {
            useBoardStore
              .getState()
              .updateNodeData(rfId, sidecarDonePatch(type, req.result));
            releaseSidecarPoll(rfId, requestId);
          } else if (req.status === "failed" || req.status === "timeout") {
            useBoardStore
              .getState()
              .updateNodeData(rfId, sidecarStatusPatch(type, "failed"));
            releaseSidecarPoll(rfId, requestId);
          } else if (req.status === "canceled") {
            useBoardStore
              .getState()
              .updateNodeData(rfId, sidecarStatusPatch(type, undefined));
            releaseSidecarPoll(rfId, requestId);
          } else {
            setState((s) => ({
              sidecar: { ...s.sidecar, [rfId]: { requestId, timerId: null } },
            } as Partial<S>));
            scheduleNextPoll();
          }
        } catch {
          if (!ownsSidecarPoll(rfId, requestId)) return;
          networkRetries += 1;
          if (networkRetries >= MAX_NETWORK_RETRIES) {
            useBoardStore
              .getState()
              .updateNodeData(rfId, sidecarStatusPatch(type, "failed"));
            releaseSidecarPoll(rfId, requestId);
            return;
          }
          scheduleNextPoll();
        }
      }, 1500);

      setState((s) => ({
        sidecar: { ...s.sidecar, [rfId]: { requestId, timerId } },
      } as Partial<S>));
    }

    const outgoing = getState().sidecar[rfId];
    if (outgoing && outgoing.timerId !== null) clearTimeout(outgoing.timerId);

    setState((s) => ({
      sidecar: { ...s.sidecar, [rfId]: { requestId, timerId: null } },
    } as Partial<S>));
    scheduleNextPoll();
  }

  return { attachPoll, attachSidecarPoll };
}
