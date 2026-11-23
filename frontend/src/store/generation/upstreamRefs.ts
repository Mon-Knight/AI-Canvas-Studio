import type { Edge } from "@xyflow/react";
import { patchNode } from "../../api/client";
import {
  useBoardStore,
  type FlowboardEdgeData,
  type FlowNode,
  type NodeHistoryEntry,
} from "../board";
import {
  resolveVideoRefAsImageMediaId,
  type VideoRefFrameMode,
} from "../../lib/videoFrame";

export const REF_SOURCE_TYPES = new Set([
  "character",
  "image",
  "visual_asset",
  "Storyboard",
  "video",
]);
export const PASSTHROUGH_REF_TYPES = new Set(["prompt", "note"]);

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
  const allVariants = rawVariants.filter(
    (m): m is string => typeof m === "string" && m.length > 0,
  );
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
      } else if (
        PASSTHROUGH_REF_TYPES.has(src.data.type) &&
        !visitedPassThrough.has(src.id)
      ) {
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
    const text =
      typeof src.data.prompt === "string" ? src.data.prompt.trim() : "";
    if (text) texts.push(text);
  }
  return texts.join("，");
}

export function cacheVideoFrameOnNode(
  sourceNode: FlowNode,
  cacheKey: string,
  imageMediaId: string,
) {
  const prevCache =
    (sourceNode.data.videoFrameCache as Record<string, string> | undefined) ??
    {};
  const nextCache = { ...prevCache, [cacheKey]: imageMediaId };
  useBoardStore.getState().updateNodeData(sourceNode.id, {
    videoFrameCache: nextCache,
  });
  const dbId = parseInt(sourceNode.id, 10);
  if (!isNaN(dbId)) {
    patchNode(dbId, { data: { videoFrameCache: nextCache } }).catch(() => {});
  }
}

export async function resolveUpstreamRefImageIds(
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

export function snapshotExistingHistory(rfId: string): NodeHistoryEntry[] {
  const node = useBoardStore.getState().nodes.find((n) => n.id === rfId);
  if (!node) return [];
  const d = node.data;
  const list: NodeHistoryEntry[] = Array.isArray(d.history)
    ? d.history.filter((h): h is NodeHistoryEntry =>
        Boolean(h && typeof h.mediaId === "string" && h.mediaId),
      )
    : [];
  const curMid =
    typeof d.mediaId === "string" && d.mediaId ? d.mediaId : undefined;
  if (curMid && !list.some((h) => h.mediaId === curMid)) {
    return [
      ...list,
      {
        mediaId: curMid,
        mediaIds:
          Array.isArray(d.mediaIds) && d.mediaIds.length > 0
            ? d.mediaIds
            : [curMid],
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

export function appendRenderToHistory(
  rfId: string,
  entry: NodeHistoryEntry,
): NodeHistoryEntry[] {
  const base = snapshotExistingHistory(rfId).filter(
    (h) => h.mediaId !== entry.mediaId,
  );
  return [...base, entry].slice(-10);
}
