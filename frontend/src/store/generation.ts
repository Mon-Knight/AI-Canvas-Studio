import { create } from "zustand";
import type { Edge } from "@xyflow/react";
import {
  ensureBoardProject,
  createRequest,
  getRequest,
  listBoardRequests,
  patchNode,
} from "../api/client";
import {
  useBoardStore,
  type FlowboardEdgeData,
  type FlowboardNodeData,
  type FlowNode,
  type NodeHistoryEntry,
} from "./board";
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

type PollEntry = { requestId: number; timerId: ReturnType<typeof setTimeout> | null };

// Everything the poll loop needs that it can't read back off the request
// row. Both are re-derivable from `request.params`, which is why the resume
// endpoint ships them — see `resumeActiveRequests`.
type PollOpts = { prompt: string; aspectRatio?: string };

// The synchronous LLM activities. Mirrors `SIDECAR_REQUEST_TYPES` in
// agent/flowboard/request_types.py, and for the same reason the media
// copy below exists: the poll that handles these has to be safe on its
// own terms whatever the backend hands it.
type SidecarType = "vision" | "auto_prompt" | "auto_prompt_batch";

const SIDECAR_TYPES = new Set<string>([
  "vision",
  "auto_prompt",
  "auto_prompt_batch",
]);

interface GenerationState {
  active: Record<string, PollEntry>;
  // Sidecar polls get their own ownership map, NOT a second entry in
  // `active`. The two kinds are independent concerns that can legitimately
  // run on the same node at the same time — a generation writes media, a
  // vision call writes `aiBrief` — so sharing one map would make
  // dispatching a generation silently orphan an in-flight vision poll,
  // and vice versa.
  sidecar: Record<string, PollEntry>;
  openDialog: { rfId: string | null; prompt: string };
  openViewer: { rfId: string | null; idx: number };
  videoDraft: { rfId: string; prompt: string; revision: number } | null;
  projectId: string | null;
  // Auto-detected from Flow's createProject response — used as the
  // default tier for every dispatch so the UI no longer needs to ask.
  // Null until the first successful project bootstrap.
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
      // Multi-source-image i2v: when the upstream image has N variants
      // we generate one video per variant. Backend sends N items in the
      // batchAsyncGenerate body so all are dispatched together.
      sourceMediaIds?: string[];
      variantCount?: number;
      // Per-variant prompts. When provided, each variant uses its own
      // prompt — required for batch auto-prompt to keep poses distinct
      // across the 4 generated images.
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

  // Re-attach a poll to everything still in flight on the backend —
  // generations AND the synchronous LLM activities, each through its own
  // loop. Called after a board loads, because a page reload kills every
  // poll this store had running.
  resumeActiveRequests(boardId: number): Promise<void>;

  cancelGeneration(rfId: string): void;
  cancelSidecarPoll(rfId: string): void;
  clearError(): void;
}

// Walk the board to collect mediaIds of every upstream media-bearing node
// (character / image / visual_asset) feeding into this image-target node.
// All of these are passed to Flow as IMAGE_INPUT_TYPE_REFERENCE inputs so the
// new image is composed from them.
//
// Per-edge variant pinning: each edge from a multi-variant source
// remembers exactly WHICH variant feeds the downstream — stored on
// `edge.data.sourceVariantIdx`. Resolution rules per edge:
//   1. If the edge has a pinned `sourceVariantIdx` AND the source has
//      a `mediaIds[idx]` entry there → use it.
//   2. Else if the source has an active `mediaId` → use it
//      (single-variant case; or multi-variant where the user hasn't
//      pinned yet — variant 0 is the natural default).
//   3. Else if the source has a non-empty `mediaIds[]` → use index 0.
// One ref per edge means one Flow API call regardless of how many
// variants the upstream has — the user picks which variant feeds
// which downstream by clicking the variant tile (Stage 2 UX).
const REF_SOURCE_TYPES = new Set([
  "character",
  "image",
  "visual_asset",
  "Storyboard",
  "video",
]);
const PASSTHROUGH_REF_TYPES = new Set(["prompt", "note"]);

export interface UpstreamRefEntry {
  edgeId: string;
  node: FlowNode;
  mediaId: string;
  variantIdx: number | null;
  allVariants: string[];
}

function resolveRefMediaFromEdge(
  src: FlowNode,
  edge: Edge<FlowboardEdgeData>,
): { mediaId: string; variantIdx: number | null; allVariants: string[] } | null {
  const rawVariants = Array.isArray(src.data.mediaIds) ? src.data.mediaIds : [];
  const allVariants = rawVariants.filter((m): m is string => typeof m === "string" && m.length > 0);
  const pinned = (edge.data?.sourceVariantIdx ?? null) as number | null;

  if (pinned !== null && pinned >= 0 && pinned < rawVariants.length) {
    const picked = rawVariants[pinned];
    if (typeof picked === "string" && picked) {
      return { mediaId: picked, variantIdx: pinned, allVariants };
    }
  }
  if (typeof src.data.mediaId === "string" && src.data.mediaId) {
    const idx = rawVariants.indexOf(src.data.mediaId);
    return {
      mediaId: src.data.mediaId,
      variantIdx: idx >= 0 ? idx : null,
      allVariants,
    };
  }
  if (allVariants.length > 0) {
    return { mediaId: allVariants[0], variantIdx: 0, allVariants };
  }
  return null;
}

/** Walk upstream edges of `targetRfId`, transparently traversing `prompt` / `note`
 * pass-through nodes (cycle-safe) so `Image -> Prompt -> Target` preserves upstream refs. */
export function collectUpstreamRefEntries(
  targetRfId: string,
  nodes: FlowNode[],
  edges: Edge<FlowboardEdgeData>[],
): UpstreamRefEntry[] {
  const entries: UpstreamRefEntry[] = [];
  const visitedPassThrough = new Set<string>([targetRfId]);
  const seenKeys = new Set<string>();

  function walk(currTargetId: string) {
    for (const edge of edges) {
      if (edge.target !== currTargetId) continue;
      const src = nodes.find((n) => n.id === edge.source);
      if (!src) continue;

      if (REF_SOURCE_TYPES.has(src.data.type)) {
        const resolved = resolveRefMediaFromEdge(src, edge);
        if (resolved) {
          const dedupeKey = `${src.id}:${resolved.mediaId}`;
          if (!seenKeys.has(dedupeKey)) {
            seenKeys.add(dedupeKey);
            entries.push({
              edgeId: edge.id,
              node: src,
              mediaId: resolved.mediaId,
              variantIdx: resolved.variantIdx,
              allVariants: resolved.allVariants,
            });
          }
        }
      } else if (PASSTHROUGH_REF_TYPES.has(src.data.type) && !visitedPassThrough.has(src.id)) {
        visitedPassThrough.add(src.id);
        walk(src.id);
      }
    }
  }

  walk(targetRfId);
  return entries;
}

export function collectUpstreamRefMediaIds(targetRfId: string): string[] {
  const { nodes, edges } = useBoardStore.getState();
  const entries = collectUpstreamRefEntries(targetRfId, nodes, edges);
  const out: string[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (!seenIds.has(entry.mediaId)) {
      seenIds.add(entry.mediaId);
      out.push(entry.mediaId);
    }
  }
  return out;
}

/** Collect direct upstream `prompt` (文本) nodes connected to `targetRfId` and join their
 * trimmed texts in edge order. Used when the user links 文本 -> 图片/视频 without AI polish. */
export function collectUpstreamPromptText(
  targetRfId: string,
  nodes: FlowNode[],
  edges: Edge<FlowboardEdgeData>[],
): string {
  const texts: string[] = [];
  for (const e of edges) {
    if (e.target !== targetRfId) continue;
    const src = nodes.find((n) => n.id === e.source);
    if (!src || src.data.type !== "prompt") continue;
    const text = typeof src.data.prompt === "string" ? src.data.prompt.trim() : "";
    if (text) texts.push(text);
  }
  return texts.join("，");
}

function cacheVideoFrameOnNode(
  sourceNode: FlowNode,
  cacheKey: string,
  imageMediaId: string,
) {
  const prevCache =
    (sourceNode.data.videoFrameCache as Record<string, string> | undefined) ?? {};
  const nextCache = { ...prevCache, [cacheKey]: imageMediaId };
  useBoardStore.getState().updateNodeData(sourceNode.id, {
    videoFrameCache: nextCache,
  });
  const dbId = parseInt(sourceNode.id, 10);
  if (!isNaN(dbId)) {
    patchNode(dbId, { data: { videoFrameCache: nextCache } }).catch(() => {});
  }
}

async function resolveUpstreamRefImageIds(
  targetRfId: string,
  opts: {
    projectId: string;
    flowAccountId?: string | null;
    videoRefFrame?: VideoRefFrameMode;
  },
): Promise<string[]> {
  const { nodes, edges } = useBoardStore.getState();
  const entries = collectUpstreamRefEntries(targetRfId, nodes, edges);
  const mode: VideoRefFrameMode = opts.videoRefFrame ?? "last";
  const out: string[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries) {
    let resolvedId = entry.mediaId;
    if (entry.node.data.type === "video") {
      resolvedId = await resolveVideoRefAsImageMediaId({
        videoMediaId: entry.mediaId,
        mode,
        projectId: opts.projectId || "local",
        nodeId: parseInt(entry.node.id, 10) || undefined,
        flowAccountId: opts.flowAccountId,
        existingCache: entry.node.data.videoFrameCache,
        onCacheUpdate: (cacheKey, imageMediaId) => {
          cacheVideoFrameOnNode(entry.node, cacheKey, imageMediaId);
        },
      });
    }
    if (!seenIds.has(resolvedId)) {
      seenIds.add(resolvedId);
      out.push(resolvedId);
    }
  }
  return out;
}

// Request types that render media. Mirrors `MEDIA_PRODUCING_TYPES` in
// agent/flowboard/request_types.py — the backend already refuses to hand
// any other type to a resume, this copy exists so the poll loop is safe
// on its own terms whatever reaches it.
const MEDIA_PRODUCING_TYPES = new Set([
  "gen_image",
  "gen_video",
  "gen_video_omni",
  "gen_video_first_last",
  "gen_video_text",
  "edit_image",
]);

function snapshotExistingHistory(rfId: string): NodeHistoryEntry[] {
  const node = useBoardStore.getState().nodes.find((n) => n.id === rfId);
  if (!node) return [];
  const d = node.data;
  const list: NodeHistoryEntry[] = Array.isArray(d.history)
    ? d.history.filter((h): h is NodeHistoryEntry => Boolean(h && typeof h.mediaId === "string" && h.mediaId))
    : [];
  const curMid = typeof d.mediaId === "string" && d.mediaId ? d.mediaId : undefined;
  if (curMid && !list.some((h) => h.mediaId === curMid)) {
    return [
      ...list,
      {
        mediaId: curMid,
        mediaIds: Array.isArray(d.mediaIds) && d.mediaIds.length > 0 ? d.mediaIds : [curMid],
        prompt: d.prompt,
        renderedAt: d.renderedAt,
        aspectRatio: d.aspectRatio,
        imageModel: d.imageModel,
        videoQuality: d.videoQuality,
      },
    ].slice(-10);
  }
  return list.slice(-10);
}

function appendRenderToHistory(
  rfId: string,
  entry: NodeHistoryEntry,
): NodeHistoryEntry[] {
  const base = snapshotExistingHistory(rfId).filter((h) => h.mediaId !== entry.mediaId);
  return [...base, entry].slice(-10);
}

// ── Poll loop ────────────────────────────────────────────────────────────
// Lifted out of `dispatchGeneration` so the reload-resume path can re-attach
// the same machinery to a request it never dispatched. All three callers —
// `dispatchGeneration`, `refineImage`, `resumeActiveRequests` — drive the one
// `active` map, because a second poll implementation would mean a second way
// for a node to decide it's finished, and they would disagree. (Refine kept
// its own copy for a while and did exactly that.)
//
// Reaches the store through `useGenerationStore` rather than the factory's
// `set` / `get` (identical functions) purely so it can live out here; it is
// only ever called after the store exists.

// `active[rfId]` names exactly one request per node, and that name is the
// chain's ownership token: a chain may only touch the node while the entry
// still points at ITS `requestId`. Re-dispatching on a node overwrites the
// entry, which is what hands ownership over.
//
// Every await is a place where ownership can change underneath a chain, so
// every await is followed by this check. Without it a chain that was sitting
// inside `getRequest` when the user hit Generate again would come back, write
// its own entry over the new one, and keep running alongside its replacement:
// two chains racing to decide the node is finished. The loser's `patchNode`
// can land after the worker committed the newer generation, which pins the
// node to the OLDER result permanently.
function ownsPoll(rfId: string, requestId: number): boolean {
  return useGenerationStore.getState().active[rfId]?.requestId === requestId;
}

function attachPoll(rfId: string, requestId: number, opts: PollOpts) {
  // Cap consecutive network errors so a dead agent can't keep a poll alive
  // forever; bail to failed state after this many.
  const MAX_NETWORK_RETRIES = 8;
  let networkRetries = 0;

  function scheduleNextPoll() {
    // Stop chaining once this chain no longer owns the node — cancelled
    // (user deleted it) or superseded by a newer request.
    if (!ownsPoll(rfId, requestId)) return;

    const timerId = setTimeout(async () => {
      // Ownership may have moved on while we slept.
      if (!ownsPoll(rfId, requestId)) return;
      try {
        const req = await getRequest(requestId);
        // ...and again after the round-trip. This is the check that keeps a
        // superseded chain from writing node data, PATCHing the DB, or
        // resurrecting its own `active` entry: everything below mutates
        // shared state, so nothing below may run for a stale request.
        if (!ownsPoll(rfId, requestId)) return;
        networkRetries = 0;

        if (req.status === "running") {
          useBoardStore.getState().updateNodeData(rfId, { status: "running" });
          // Reschedule
          useGenerationStore.setState((s) => ({
            active: {
              ...s.active,
              [rfId]: { requestId, timerId: null },
            },
          }));
          scheduleNextPoll();
        } else if (req.status === "done") {
          // `media_ids` may contain `null` placeholders for variants
          // the backend marked as partial-failures (e.g. Veo content
          // filter blocked one of 4 i2v clips while the other 3
          // succeeded). Keep the positional alignment so the frontend
          // can map slot i ↔ upstream variant i, but pick the first
          // non-null entry as the "primary" mediaId for legacy
          // single-tile UI consumers.
          const mediaIds = (req.result["media_ids"] as (string | null)[] | undefined) ?? [];
          const mediaId = mediaIds.find(
            (m): m is string => typeof m === "string" && m.length > 0,
          );
          // A type that renders nothing must never write the media keys.
          // The LLM activity types (`vision`, `auto_prompt`, ...) settle
          // with a result that has no `media_ids` at all, and the read
          // above turns that absence into
          // `[]` + `undefined` — which `updateNodeData` (a plain spread)
          // then lays straight over whatever the node was showing, so the
          // user watches their generated image vanish off the canvas.
          // The resume endpoint no longer hands those types to a poll
          // (agent/flowboard/routes/boards.py::RESUMABLE_REQUEST_TYPES),
          // but this branch is reachable by direct dispatch too, and the
          // rule is the same either way: an absent `media_ids` is "this
          // request was never about media", not "nothing rendered".
          const producesMedia = MEDIA_PRODUCING_TYPES.has(req.type);
          // Surface the partial-error summary onto data.error while
          // keeping status="done" — the node still has renderable
          // variants, but the UI can flag that some slots got blocked.
          const partialError = (req.result["partial_error"] as string | undefined) ?? null;
          // Per-slot error codes (aligned to mediaIds) so the detail
          // viewer can render the exact filter reason on each blocked
          // tile. `null` length-matched array when nothing's blocked;
          // missing on legacy / non-video results.
          const slotErrors =
            (req.result["slot_errors"] as (string | null)[] | undefined) ?? null;
          // Stamp the model used onto the node so the detail panel can
          // show "Banana Pro" / "Quality" etc. — read from req.params
          // (what was dispatched). Tier-1 UI locks Lite + Quality so
          // we trust params directly without a backend fallback round-trip.
          // `edit_image` (refine) is dispatched with the same image-model
          // setting, so it stamps through here too.
          const stampedImageModel =
            req.type === "gen_image" || req.type === "edit_image"
              ? (req.params["image_model"] as string | undefined)
              : undefined;
          // For Veo (`gen_video`) the dispatched `video_quality` IS the
          // model selector (lite / fast / quality / lite_relaxed). For
          // Omni Flash (`gen_video_omni`) the model is duration-scoped —
          // derive the Flow model key (abra_r2v_<N>s) from the dispatched
          // duration so the detail panel can surface the exact variant
          // that ran (mirrors backend's resolve_omni_flash_model).
          let stampedVideoQuality: string | undefined;
          if (req.type === "gen_video" && req.params.media_provider === "google_video") {
            stampedVideoQuality = String(req.result.model || "Gemini Omni Flash");
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
            const d = (req.result["duration_s"] ?? req.params["duration_s"] ?? 8) as number;
            stampedVideoQuality = `first_last_${d}s`;
          } else if (req.type === "gen_video_text") {
            const d = (req.result["duration_s"] ?? req.params["duration_s"] ?? 4) as number;
            stampedVideoQuality = `t2v_${d}s`;
          }
          const isVideoReqType = req.type.startsWith("gen_video");
          const videoMetadata = isVideoReqType ? {
            mediaProvider: String(req.params.media_provider || "flow"),
            durationSeconds:
              typeof req.result["duration_s"] === "number"
                ? (req.result["duration_s"] as number)
                : typeof req.params.duration_s === "number"
                  ? req.params.duration_s
                  : null,
            ...(typeof req.params.resolution === "string" ? { videoResolution: req.params.resolution } : {}),
            ...(typeof req.params.omni_version === "string" ? { omniVersion: req.params.omni_version } : {}),
          } : {};
          const imageMeta =
            req.type === "gen_image" || req.type === "edit_image"
              ? {
                  ...(typeof req.params.image_resolution === "string"
                    ? { imageResolution: req.params.image_resolution }
                    : {}),
                  ...(typeof req.params.thinking_level === "string"
                    ? { thinkingLevel: req.params.thinking_level }
                    : {}),
                  ...(typeof req.params.seed === "number" ? { seed: req.params.seed } : {}),
                }
              : {};
          const renderedAt = new Date().toISOString();
          const nextHistory =
            producesMedia && mediaId
              ? appendRenderToHistory(rfId, {
                  mediaId,
                  mediaIds,
                  prompt: opts.prompt || (typeof req.params.prompt === "string" ? req.params.prompt : undefined),
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
            ...(req.type.startsWith("gen_video") && mediaIds.length ? { variantCount: mediaIds.length } : {}),
            ...(producesMedia
              ? { mediaId, mediaIds, slotErrors: slotErrors ?? undefined }
              : {}),
            ...(nextHistory ? { history: nextHistory } : {}),
            aiBrief: undefined,
            // Same guard as `prompt` in the patch below, for the same
            // reason: a resumed poll rebuilds `opts` from the request's
            // params, so a request type that doesn't send `aspect_ratio`
            // would spread `undefined` straight over the node's real
            // value. Every gen type sends one today — this is here so the
            // next one that doesn't isn't a silent data loss.
            ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
            renderedAt,
            error: partialError ?? undefined,
            ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
            ...(stampedVideoQuality ? { videoQuality: stampedVideoQuality } : {}),
          });
          // Belt-and-braces. The worker already wrote all of this onto
          // the node before it flipped the request to `done` (see
          // agent/flowboard/worker/processor.py::_node_completion_patch)
          // — that is what makes the result survive a reload, and it is
          // now the authoritative write. This PATCH re-sends the same
          // values, so it is idempotent; it stays because dropping it is
          // a bigger refactor than this fix needs, and because it keeps
          // the round-trip honest if the two ever disagree.
          const dbId = parseInt(rfId, 10);
          if (!isNaN(dbId) && producesMedia && mediaId) {
            const n = useBoardStore.getState().nodes.find((x) => x.id === rfId);
            const d = n?.data;
            // Backend merges `data`, so only deltas need to ship.
            // `aiBrief: null` is the explicit "clear" sentinel —
            // undefined would be dropped by JSON.stringify and leave
            // the stale brief sitting on the node.
            patchNode(dbId, {
              status: "done",
              data: {
                // Persist prompt — without this, reloading the page
                // shows "(no prompt)" in the detail panel because the
                // dispatch flow only stamps prompt into the in-memory
                // store, never to the backend. This used to live in
                // the patchNode payload pre-Phase 20 and was
                // accidentally dropped during the "only deltas" refactor.
                // Only sent when we actually have one: a resumed poll
                // reconstructs `opts` from the request's params, and an
                // empty string here would merge over the real prompt
                // rather than leave it alone.
                ...(opts.prompt ? { prompt: opts.prompt } : {}),
                mediaId,
                mediaIds,
                ...(nextHistory ? { history: nextHistory } : {}),
                slotErrors: slotErrors ?? null,
                variantCount: req.type.startsWith("gen_video") ? mediaIds.length : d?.variantCount ?? mediaIds.length,
                aiBrief: null,
                ...(opts.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
                renderedAt,
                // `null` clears stale error from a previous attempt
                // when this run was clean; otherwise persist the
                // partial summary so it survives reload.
                error: partialError ?? null,
                ...(stampedImageModel ? { imageModel: stampedImageModel } : {}),
                ...(stampedVideoQuality ? { videoQuality: stampedVideoQuality } : {}),
              },
            }).catch(() => {
              // Non-fatal: the in-memory state is still correct for this session.
            });
          }
          // Generation results always carry a prompt (the one we just
          // dispatched with), and downstream synth treats prompt as the
          // source of truth. Vision adds nothing here — skip it.
          // Manual upload paths in NodeCard.tsx still call
          // requestAutoBrief; that helper now early-returns if the
          // target node already has a prompt, so behaviour stays sane
          // for upload-then-type flows too.
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next };
          });
          if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
            window.dispatchEvent(new Event("flowboard:credits-stale"));
          }
        } else if (req.status === "failed" || req.status === "timeout") {
          // 'timeout' is the dedicated terminal state for the
          // 5-minute video-gen budget. We render it as a node error
          // so the card visually flags the stuck run, but tag the
          // message so the user can tell auto-timeout apart from a
          // generation failure.
          const errMsg =
            req.status === "timeout"
              ? `视频任务等待超时（${req.error ?? "video_timeout"}），请先核对生成记录再重试。`
              : (req.error ?? "生成失败");
          useBoardStore.getState().updateNodeData(rfId, { status: "error", error: errMsg });
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next, error: errMsg };
          });
        } else if (req.status === "canceled") {
          // User-initiated cancel from the activity bell. Don't
          // stamp the node as 'error' — clear the in-flight state
          // and leave whatever the node was showing before.
          useBoardStore.getState().updateNodeData(rfId, { status: "idle" });
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next };
          });
          if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
            window.dispatchEvent(new Event("flowboard:credits-stale"));
          }
        } else {
          // queued — keep polling
          useGenerationStore.setState((s) => ({
            active: {
              ...s.active,
              [rfId]: { requestId, timerId: null },
            },
          }));
          scheduleNextPoll();
        }
      } catch (err) {
        // A superseded chain keeps its failure to itself — the node now
        // belongs to a newer request and is not this chain's to fail.
        if (!ownsPoll(rfId, requestId)) return;
        networkRetries += 1;
        if (networkRetries >= MAX_NETWORK_RETRIES) {
          const msg = err instanceof Error ? err.message : "网络异常";
          useBoardStore.getState().updateNodeData(rfId, { status: "error", error: msg });
          useGenerationStore.setState((s) => {
            const next = { ...s.active };
            delete next[rfId];
            return { active: next, error: `轮询任务状态失败：${msg}` };
          });
          return;
        }
        scheduleNextPoll();
      }
    }, 1500);

    useGenerationStore.setState((s) => ({
      active: {
        ...s.active,
        [rfId]: { requestId, timerId },
      },
    }));
  }

  // Take ownership. The ownership check alone stops the outgoing chain from
  // acting, but it can't unschedule its pending wake-up — clear that here so
  // attaching is self-contained however the caller got here.
  const outgoing = useGenerationStore.getState().active[rfId];
  if (outgoing && outgoing.timerId !== null) clearTimeout(outgoing.timerId);

  // Initialize active entry before first poll
  useGenerationStore.setState((s) => ({
    active: {
      ...s.active,
      [rfId]: { requestId, timerId: null },
    },
  }));
  scheduleNextPoll();
}

// ── Sidecar poll loop ────────────────────────────────────────────────────
// A deliberately separate, much smaller loop for the synchronous LLM
// activities. Pointing `attachPoll` at one of these is exactly the bug
// that wiped nodes' images: that loop carries generation semantics it
// reads off the result — `media_ids`, `slot_errors`, model stamps — and a
// `vision` result has none of them, so it spread an empty media list over
// the node. This one knows only about text.
//
// It keeps the one thing from `attachPoll` that is not about generations:
// the ownership token. `sidecar[rfId]` names exactly one request per node,
// and a chain may only touch the node while the entry still points at ITS
// `requestId` — so a second sidecar call on the same node hands ownership
// over rather than racing the first. Every await is a place ownership can
// move, so every await is followed by the check.

function ownsSidecarPoll(rfId: string, requestId: number): boolean {
  return useGenerationStore.getState().sidecar[rfId]?.requestId === requestId;
}

function releaseSidecarPoll(rfId: string, requestId: number) {
  useGenerationStore.setState((s) => {
    // Guarded: a terminal chain must not delete an entry that already
    // belongs to a newer request on this node.
    if (s.sidecar[rfId]?.requestId !== requestId) return s;
    const next = { ...s.sidecar };
    delete next[rfId];
    return { sidecar: next };
  });
}

// Which node field each activity's "busy" flag lives in. The two are
// rendered identically (NodeCard's "Analyzing…" / "Composing…" overlay)
// but they are distinct states — a node can legitimately have had a
// vision brief and be composing a prompt.
//
// Returns a patch rather than the key name on purpose: `FlowboardNodeData`
// carries an index signature, so a computed `{ [key]: value }` would type-
// check against a misspelled key and fail silently at runtime.
function sidecarStatusPatch(
  type: SidecarType,
  value: "pending" | "failed" | undefined,
): Partial<FlowboardNodeData> {
  return type === "vision"
    ? { aiBriefStatus: value }
    : { autoPromptStatus: value };
}

// Turn a settled sidecar result into the node fields it belongs in. This
// is the whole difference between the two loops: text out, never media.
// Mirrors what the backend already wrote onto the node when it settled
// the row (services/vision.py, services/prompt_synth.py) — the backend is
// the authority, this just brings THIS tab's in-memory board in line
// without waiting for a reload.
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
  // Auto-prompt: `autoPromptStatus` clears rather than going to "done",
  // matching what GenerationDialog does on its own success path — the
  // status exists only to render the busy treatment.
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

function attachSidecarPoll(rfId: string, requestId: number, type: SidecarType) {
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
          // No `data.error` and no `status: "error"` here: those belong to
          // the generation the node exists to render. A failed brief is a
          // missing nicety, and the node may well be showing a perfectly
          // good image at the same time.
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
          // queued / running — hold the busy flag and keep waiting.
          useGenerationStore.setState((s) => ({
            sidecar: { ...s.sidecar, [rfId]: { requestId, timerId: null } },
          }));
          scheduleNextPoll();
        }
      } catch {
        if (!ownsSidecarPoll(rfId, requestId)) return;
        networkRetries += 1;
        if (networkRetries >= MAX_NETWORK_RETRIES) {
          // Give the node its card back rather than leaving it dimmed
          // forever. The backend still holds the real answer; the next
          // board load picks it up off `Node.data`.
          useBoardStore
            .getState()
            .updateNodeData(rfId, sidecarStatusPatch(type, "failed"));
          releaseSidecarPoll(rfId, requestId);
          return;
        }
        scheduleNextPoll();
      }
    }, 1500);

    useGenerationStore.setState((s) => ({
      sidecar: { ...s.sidecar, [rfId]: { requestId, timerId } },
    }));
  }

  const outgoing = useGenerationStore.getState().sidecar[rfId];
  if (outgoing && outgoing.timerId !== null) clearTimeout(outgoing.timerId);

  useGenerationStore.setState((s) => ({
    sidecar: { ...s.sidecar, [rfId]: { requestId, timerId: null } },
  }));
  scheduleNextPoll();
}

// Resolve a project and its account together; capture the response with the
// dispatch so even profiles pointing at the same project cannot be confused.
async function resolveBoardProject() {
  const boardId = useBoardStore.getState().boardId;
  if (boardId === null) throw new Error("请先打开一个画布。");
  return ensureBoardProject(boardId);
}

let draftRevision = 0;
const submittingVideo = new Set<string>();

async function submitFlowVideo(rfId: string, opts: {
  prompt: string; aspectRatio?: string; flowAccountId?: string; flowProjectId?: string;
  sourceMediaId?: string; sourceMediaIds?: string[];
  variantCount?: number;
  videoModel?: VideoModelFamily;
  videoQuality?: VideoQuality;
  omniVersion?: OmniFlashVersion;
  durationSeconds?: number;
  videoResolution?: VideoResolutionKey;
  videoRefFrame?: VideoRefFrameMode;
  videoSubMode?: "auto" | "first_last" | "t2v";
  endMediaId?: string;
}) {
  const board = useBoardStore.getState();
  const node = board.nodes.find(n => n.id === rfId);
  if (node?.data.type !== "video" || board.boardId === null) return;
  if (submittingVideo.has(rfId) || useGenerationStore.getState().active[rfId] ||
      node.data.status === "running" || node.data.status === "queued") return;
  const snapshot = useFlowAccounts.getState().snapshot;
  const account = snapshot?.accounts.find(a => a.id === snapshot.active_account_id);
  const reject = (error: string) => {
    useGenerationStore.setState({ error });
    useBoardStore.getState().updateNodeData(rfId, { status: "error", error });
  };
  if (!account) return reject("请先在右上角选择要使用的 Flow 账号。");
  if (!opts.flowAccountId || opts.flowAccountId !== account.id || opts.flowProjectId !== account.project_id)
    return reject("Flow 账号或项目已更换，请确认后重新提交。");
  if (!account.project_id || !account.connected || !account.flow_tab_open)
    return reject("请在右上角绑定 Flow 项目，并打开该账号的 Flow 网页、连接扩展。");
  if (!opts.prompt.trim()) return reject("请输入视频提示词。");
  const settings = useSettingsStore.getState();
  const chosenModelFamily = opts.videoModel ?? settings.videoModel;
  const omni = chosenModelFamily === "omni_flash";
  const omniVersion: OmniFlashVersion = opts.omniVersion ?? settings.omniVersion ?? "1.2";
  const rawDuration = opts.durationSeconds ?? settings.omniFlashDuration ?? 4;
  const durationS =
    omniVersion === "1.1" && ![4, 6, 8, 10].includes(rawDuration)
      ? 4
      : Math.min(15, Math.max(3, Math.round(rawDuration)));
  const videoQuality = opts.videoQuality ?? settings.videoQuality;
  const rawVideoRes = opts.videoResolution ?? settings.videoResolution ?? "720p";
  // Veo 3.1 原生最低 720p；若历史配置残留 360p，发送前自动归一化为 720p 避免 Flow [3] 报错。
  const videoResolution: VideoResolutionKey =
    !omni && rawVideoRes === "360p" ? "720p" : rawVideoRes;
  const variantCount = Math.min(4, Math.max(1, opts.variantCount ?? settings.defaultVideoCount ?? 1));
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
  const hasVideoSource = !isTextToVideo && rawReferences.some((id) => videoNodeByMediaId.has(id));
  const nodeId = Number(rfId);
  if (!Number.isSafeInteger(nodeId) || nodeId < 1) return reject("视频节点尚未保存。");
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
      references = isFirstLast ? resolvedList : Array.from(new Set(resolvedList));
    }

    const normalizedPrompt = normalizePromptRefMentions(opts.prompt, references.length);
    let reqType: string;
    let reqParams: Record<string, unknown>;
    const aspect = opts.aspectRatio ?? settings.defaultVideoAspect ?? "VIDEO_ASPECT_RATIO_LANDSCAPE";

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
          ? { duration_s: durationS, omni_version: omniVersion, ref_media_ids: references }
          : {
              video_quality: videoQuality,
              ...(references.length === 1
                ? { start_media_id: references[0] }
                : { start_media_ids: references }),
            }),
      };
    }

    // Do not clear the last take, change the recorded balance, or start a second poll.
    const req = await createRequest({
      type: reqType,
      node_id: nodeId,
      flow_account_id: account.id,
      params: reqParams,
    });
    const live = useBoardStore.getState();
    if (live.boardId !== board.boardId || !live.nodes.some(n => n.id === rfId)) return;
    live.updateNodeData(rfId, {
      status: "queued",
      prompt: normalizedPrompt,
      error: undefined,
      videoResolution: reqType === "gen_video_text" && rawVideoRes === "360p" ? "720p" : videoResolution,
      ...(omni ? { omniVersion, durationSeconds: durationS } : { videoQuality }),
      ...(!node.data.mediaId && !node.data.mediaIds?.some(Boolean)
        ? { variantCount: isTextToVideo || isFirstLast || omni ? variantCount : Math.max(references.length, variantCount) }
        : {}),
    });
    if (draftAtSubmit?.rfId === rfId && useGenerationStore.getState().videoDraft === draftAtSubmit)
      useGenerationStore.setState({ videoDraft: null });
    attachPoll(rfId, req.id, { prompt: normalizedPrompt, aspectRatio: opts.aspectRatio });
  } catch (err) {
    reject(err instanceof Error ? err.message : "视频提交失败，请先查看任务记录再重试。");
  } finally {
    submittingVideo.delete(rfId);
  }
}

export const useGenerationStore = create<GenerationState>((set, get) => ({
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
    if (board.nodes.some(n => n.id === rfId && n.data.type === "video")) {
      board.setNodes(board.nodes.map(n => !!n.selected === (n.id === rfId) ? n : { ...n, selected: n.id === rfId }));
      set({ openDialog: { rfId: null, prompt: "" }, videoDraft: { rfId, prompt, revision: ++draftRevision } });
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

  async dispatchGeneration(rfId, opts: {
    prompt: string;
    aspectRatio?: string;
    paygateTier?: string;
    kind?: "image" | "video";
    sourceMediaId?: string;
    sourceMediaIds?: string[];
    variantCount?: number;
    prompts?: string[];
    mediaProvider?: MediaProviderKey;
    flowAccountId?: string;
    flowProjectId?: string;
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
  }) {
    if (opts.kind === "video") {
      return submitFlowVideo(rfId, opts);
    }
    const mediaProvider = opts.mediaProvider ?? useSettingsStore.getState().mediaProvider;
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

    // Pre-flight: refuse to dispatch if the paygate tier is unknown.
    // The backend would reject with `paygate_tier_unknown` anyway (since
    // Phase 1 stopped silently defaulting to Pro), but bailing here gives
    // the user a clearer hint without spending a captcha round-trip and
    // without leaving a `failed` request row in the DB. The
    // AccountPanel's "Tier unknown — Open Flow" banner is the recovery
    // path. (Muse path needs no tier.)
    const knownTier = opts.paygateTier ?? get().paygateTier;
    if (mediaProvider === "flow" && !knownTier) {
      set({
        error: "尚未检测到有效套餐等级，请先在右上角「Flow 账号」或「更多 ··· → 生成引擎与项目设置」中确认套餐配置（Pro / Ultra）后重试。",
      });
      useBoardStore.getState().updateNodeData(rfId, {
        status: "error",
        error: "尚未配置套餐等级",
      });
      return;
    }

    // Release this node from whatever poll was watching it. Dropping the
    // `active` entry (not just the timer) is what makes the outgoing chain
    // bail at its next ownership check instead of running on through the
    // `createRequest` await below. It also means a dispatch that throws
    // leaves no ghost owner behind — a stale entry would block
    // `resumeActiveRequests` from ever re-attaching to this node.
    get().cancelGeneration(rfId);

    // Optimistically update node — record variantCount and preserve any existing
    // render in `history` before clearing the visible tile slots.
    const variantCount = Math.max(1, Math.min(opts.variantCount ?? 1, 4));
    const preservedHistory = snapshotExistingHistory(rfId);
    useBoardStore.getState().updateNodeData(rfId, {
      status: "queued",
      prompt: opts.prompt,
      error: undefined,
      variantCount,
      ...(preservedHistory.length > 0 ? { history: preservedHistory } : {}),
      mediaIds: undefined, mediaId: undefined,
    });

    // Create request
    let reqDto;
    let normalizedPrompt = opts.prompt;
    try {
      const nodeDbId = parseInt(rfId, 10);
      const refMediaIds = await resolveUpstreamRefImageIds(rfId, {
        projectId,
        flowAccountId,
        videoRefFrame: opts.videoRefFrame,
      });
      normalizedPrompt = normalizePromptRefMentions(opts.prompt, refMediaIds.length);
      const curSettings = useSettingsStore.getState();
      const chosenImageModel = opts.imageModel ?? curSettings.imageModel;
      const chosenImageResolution = opts.imageResolution ?? curSettings.imageResolution;
      const chosenThinking = opts.thinkingLevel ?? curSettings.imageThinkingLevel;
      const params: Record<string, unknown> = {
        prompt: normalizedPrompt,
        media_provider: mediaProvider,
        project_id: projectId,
        aspect_ratio: opts.aspectRatio ?? curSettings.defaultImageAspect ?? "IMAGE_ASPECT_RATIO_LANDSCAPE",
        paygate_tier:
          opts.paygateTier ?? get().paygateTier ?? "PAYGATE_TIER_ONE",
        variant_count: variantCount,
        // User's image model preference from Settings / Dialog.
        // Backend resolves the nickname → real Flow model identifier.
        image_model: chosenImageModel,
        image_resolution: chosenImageResolution,
      };
      if (chosenImageModel === "NANO_BANANA_2_1" && chosenThinking !== "default") {
        params.thinking_level = chosenThinking;
      }
      if (typeof opts.seed === "number" && !Number.isNaN(opts.seed)) {
        params.seed = opts.seed;
      }
      if (refMediaIds.length > 0) {
        params.ref_media_ids = refMediaIds;
      }
      // Per-variant prompts: when present, each variant uses its own
      // text instead of all sharing `params.prompt`. Backend falls back
      // to single prompt when missing/short.
      if (opts.prompts && opts.prompts.length > 0) {
        params.prompts = opts.prompts.map((p) => normalizePromptRefMentions(p, refMediaIds.length));
      }
      reqDto = await createRequest({
        type: "gen_image",
        flow_account_id: flowAccountId,
        node_id: isNaN(nodeDbId) ? undefined : nodeDbId,
        params,
      });
    } catch (err) {
      useBoardStore.getState().updateNodeData(rfId, { status: "error", error: err instanceof Error ? err.message : "请求提交失败" });
      set({ error: err instanceof Error ? err.message : "生成请求提交失败" });
      return;
    }

    // Start polling — same machinery the reload-resume path re-attaches.
    attachPoll(rfId, reqDto.id, {
      prompt: normalizedPrompt,
      aspectRatio: opts.aspectRatio,
    });
  },

  async resumeActiveRequests(boardId) {
    // A page reload wipes every timer this store had running, so anything
    // dispatched before the refresh has nobody watching it. The backend
    // keeps the node current on its own now — the worker for generations,
    // the service itself for vision / auto-prompt — but the board still
    // needs to know WHICH requests are still moving so the card ticks
    // over without waiting for the next manual reload.
    //
    // Both kinds in one round trip, then routed by type below. They are
    // NOT interchangeable: a sidecar row through `attachPoll` is the bug
    // that wiped nodes' images, so the split is enforced by the switch
    // here as well as by the backend's `kinds` filter.
    let items;
    try {
      ({ items } = await listBoardRequests(boardId, {
        active: true,
        kinds: ["worker", "sidecar"],
      }));
    } catch {
      // Non-fatal: the board is usable, the affected nodes just sit on
      // whatever status the DB gave them until the next load.
      return;
    }

    for (const item of items) {
      if (item.node_id === null) continue;
      const rfId = String(item.node_id);

      if (SIDECAR_TYPES.has(item.type)) {
        // Its own ownership map, so this never collides with a generation
        // poll on the same node.
        if (get().sidecar[rfId] !== undefined) continue;
        const type = item.type as SidecarType;
        // Restore the busy treatment straight away rather than waiting
        // ~1.5s for the first poll. This is the state the reload lost —
        // the node came back from the DB looking idle while the server
        // was still mid-call.
        useBoardStore
          .getState()
          .updateNodeData(rfId, sidecarStatusPatch(type, "pending"));
        attachSidecarPoll(rfId, item.id, type);
        continue;
      }

      // Deny by default. The sidecar branch above is an allowlist, so
      // without this an unrecognised type falls through to the generation
      // poll — which is exactly what wiped node images in #7. Adding a
      // type to the backend's sidecar set and forgetting `SIDECAR_TYPES`
      // is the realistic way that happens again. `producesMedia` in the
      // done-branch would still block the DB write, but the card would
      // get a spurious `running` stamp and lose its brief in memory.
      if (!MEDIA_PRODUCING_TYPES.has(item.type)) continue;

      // A poll we started in this session already owns this node — don't
      // stack a second one on it.
      if (get().active[rfId] !== undefined) continue;

      // Rebuild the poll's options from what the request was dispatched
      // with. This is why the endpoint ships `params`.
      const prompt =
        typeof item.params["prompt"] === "string" ? item.params["prompt"] : "";
      const aspectRatio =
        typeof item.params["aspect_ratio"] === "string"
          ? (item.params["aspect_ratio"] as string)
          : undefined;

      // Show the busy state immediately rather than waiting ~1.5s for the
      // first poll to come back. Matters most for `queued`, which the poll
      // loop deliberately doesn't stamp (it only reschedules).
      useBoardStore.getState().updateNodeData(rfId, {
        status: item.status === "running" ? "running" : "queued",
        // Only override the prompt when we actually have one — a blank
        // would wipe what the board just loaded from the DB.
        ...(prompt ? { prompt } : {}),
      });

      attachPoll(rfId, item.id, { prompt, aspectRatio });
    }
  },

  async refineImage(rfId, opts) {
    const mediaProvider: MediaProviderKey = useSettingsStore.getState().mediaProvider;
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
    const chosenThinking = opts.thinkingLevel ?? sSettings.imageThinkingLevel;

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
          ...(chosenModel === "NANO_BANANA_2_1" && chosenThinking !== "default"
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

    // Same poll machinery as dispatch. A refine used to run its own copy of
    // the loop, which cost it both things `attachPoll` owns: the `ownsPoll`
    // token, and reload-resume — `resumeActiveRequests` re-attaches through
    // `attachPoll`, so a refine that only lived inside its private loop came
    // back from an F5 with nobody watching it.
    attachPoll(rfId, reqDto.id, {
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

  // Sidecar polls live in their own map, so `cancelGeneration` never
  // touched them — deleting a node mid-vision left its chain polling
  // `/api/requests/{id}` every 1.5s for up to ~120s against a node that
  // no longer exists. Harmless but wasteful, and it kept a dead node's
  // rfId alive in the map.
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
}));
