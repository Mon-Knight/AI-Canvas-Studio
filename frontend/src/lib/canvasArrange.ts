import type { FlowNode } from "../store/board";
import { mediaUrl } from "../api/client";

export type ArrangeMode =
  | "stack"
  | "grid"
  | "row"
  | "column"
  | "align_left"
  | "align_center_x"
  | "align_right"
  | "align_top"
  | "align_center_y"
  | "align_bottom"
  | "distribute_h"
  | "distribute_v";

export interface ArrangeNodeBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_GAP = 36;
const STACK_OFFSET_X = 18;
const STACK_OFFSET_Y = 14;

/**
 * Resolve a node's effective bounding box on the canvas (in flow coordinates),
 * falling back to sensible defaults matching NodeCard's CSS footprint when
 * ReactFlow hasn't measured the node yet.
 */
export function resolveNodeBox(
  node: FlowNode,
  measured?: { width?: number; height?: number },
): ArrangeNodeBox {
  const width =
    measured?.width ??
    node.measured?.width ??
    (typeof node.width === "number" && node.width > 0 ? node.width : undefined) ??
    (typeof node.data.customW === "number" && node.data.customW > 0 ? node.data.customW : undefined) ??
    264;
  const height =
    measured?.height ??
    node.measured?.height ??
    (typeof node.height === "number" && node.height > 0 ? node.height : undefined) ??
    (typeof node.data.customH === "number" && node.data.customH > 0 ? node.data.customH : undefined) ??
    210;
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width,
    height,
  };
}

/**
 * Pure layout calculator for marquee-selected nodes:
 * - stack: neat cascading card deck anchored at selection top-left
 * - grid: balanced multi-column grid with per-column widths and per-row heights
 * - row / column: clean horizontal or vertical strip preserving visual order
 * - align_*: align selected edges or centers
 * - distribute_h / distribute_v: even spacing between outer extremes (>= 3 nodes)
 */
export function computeArrangedPositions(
  boxes: ArrangeNodeBox[],
  mode: ArrangeMode,
  gap = DEFAULT_GAP,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (boxes.length < 2) return out;

  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxRight = Math.max(...boxes.map((b) => b.x + b.width));
  const maxBottom = Math.max(...boxes.map((b) => b.y + b.height));

  if (mode === "stack") {
    const ordered = [...boxes].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    ordered.forEach((b, idx) => {
      out.set(b.id, {
        x: Math.round(minX + idx * STACK_OFFSET_X),
        y: Math.round(minY + idx * STACK_OFFSET_Y),
      });
    });
    return out;
  }

  if (mode === "row") {
    const ordered = [...boxes].sort((a, b) => (a.x - b.x) || (a.y - b.y));
    let cursorX = minX;
    for (const b of ordered) {
      out.set(b.id, { x: Math.round(cursorX), y: Math.round(minY) });
      cursorX += b.width + gap;
    }
    return out;
  }

  if (mode === "column") {
    const ordered = [...boxes].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let cursorY = minY;
    for (const b of ordered) {
      out.set(b.id, { x: Math.round(minX), y: Math.round(cursorY) });
      cursorY += b.height + gap;
    }
    return out;
  }

  if (mode === "grid") {
    // Reading order: approximate rows by snapping Y into bands, then sort X
    const avgH = boxes.reduce((acc, b) => acc + b.height, 0) / boxes.length;
    const bandH = Math.max(80, avgH * 0.55);
    const ordered = [...boxes].sort((a, b) => {
      const rowDiff = Math.round(a.y / bandH) - Math.round(b.y / bandH);
      return rowDiff !== 0 ? rowDiff : a.x - b.x;
    });
    const cols = Math.max(2, Math.ceil(Math.sqrt(ordered.length)));
    const rows = Math.ceil(ordered.length / cols);
    const colWidths = Array.from({ length: cols }, () => 0);
    const rowHeights = Array.from({ length: rows }, () => 0);
    ordered.forEach((b, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      colWidths[c] = Math.max(colWidths[c], b.width);
      rowHeights[r] = Math.max(rowHeights[r], b.height);
    });
    const colOffsets: number[] = [];
    let accX = minX;
    for (let c = 0; c < cols; c++) {
      colOffsets.push(accX);
      accX += colWidths[c] + gap;
    }
    const rowOffsets: number[] = [];
    let accY = minY;
    for (let r = 0; r < rows; r++) {
      rowOffsets.push(accY);
      accY += rowHeights[r] + gap;
    }
    ordered.forEach((b, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      out.set(b.id, {
        x: Math.round(colOffsets[c]),
        y: Math.round(rowOffsets[r]),
      });
    });
    return out;
  }

  if (mode === "align_left") {
    for (const b of boxes) out.set(b.id, { x: Math.round(minX), y: Math.round(b.y) });
    return out;
  }

  if (mode === "align_right") {
    for (const b of boxes) {
      out.set(b.id, { x: Math.round(maxRight - b.width), y: Math.round(b.y) });
    }
    return out;
  }

  if (mode === "align_center_x") {
    const centerX = (minX + maxRight) / 2;
    for (const b of boxes) {
      out.set(b.id, { x: Math.round(centerX - b.width / 2), y: Math.round(b.y) });
    }
    return out;
  }

  if (mode === "align_top") {
    for (const b of boxes) out.set(b.id, { x: Math.round(b.x), y: Math.round(minY) });
    return out;
  }

  if (mode === "align_bottom") {
    for (const b of boxes) {
      out.set(b.id, { x: Math.round(b.x), y: Math.round(maxBottom - b.height) });
    }
    return out;
  }

  if (mode === "align_center_y") {
    const centerY = (minY + maxBottom) / 2;
    for (const b of boxes) {
      out.set(b.id, { x: Math.round(b.x), y: Math.round(centerY - b.height / 2) });
    }
    return out;
  }

  if (mode === "distribute_h") {
    if (boxes.length < 3) return computeArrangedPositions(boxes, "row", gap);
    const ordered = [...boxes].sort((a, b) => a.x - b.x);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const span = last.x + last.width - first.x;
    const totalW = ordered.reduce((sum, b) => sum + b.width, 0);
    const spacing = Math.max(gap, (span - totalW) / (ordered.length - 1));
    let cursorX = first.x;
    for (const b of ordered) {
      out.set(b.id, { x: Math.round(cursorX), y: Math.round(b.y) });
      cursorX += b.width + spacing;
    }
    return out;
  }

  if (mode === "distribute_v") {
    if (boxes.length < 3) return computeArrangedPositions(boxes, "column", gap);
    const ordered = [...boxes].sort((a, b) => a.y - b.y);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const span = last.y + last.height - first.y;
    const totalH = ordered.reduce((sum, b) => sum + b.height, 0);
    const spacing = Math.max(gap, (span - totalH) / (ordered.length - 1));
    let cursorY = first.y;
    for (const b of ordered) {
      out.set(b.id, { x: Math.round(b.x), y: Math.round(cursorY) });
      cursorY += b.height + spacing;
    }
    return out;
  }

  return out;
}

export interface MediaDownloadItem {
  url: string;
  filename: string;
  mediaId: string;
}

/**
 * Collect all downloadable generated/uploaded media files across a set of
 * selected nodes (including multi-variant outputs, skipping null slots).
 */
export function collectSelectedMediaDownloads(nodes: FlowNode[]): MediaDownloadItem[] {
  const items: MediaDownloadItem[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const data = node.data;
    if (data.type === "prompt" || data.type === "note") continue;
    const rawIds =
      data.mediaIds && data.mediaIds.length > 0
        ? data.mediaIds
        : data.mediaId
          ? [data.mediaId]
          : [];
    const ids = rawIds.filter((m): m is string => typeof m === "string" && m.length > 0);
    const safeTitle = (data.title || data.type).replace(/[^A-Za-z0-9\u4e00-\u9fa5_-]+/g, "_");
    const ext = data.type === "video" ? "mp4" : "png";
    ids.forEach((mid, i) => {
      if (seen.has(mid)) return;
      seen.add(mid);
      const suffix = ids.length > 1 ? `-${i + 1}` : "";
      items.push({
        mediaId: mid,
        url: mediaUrl(mid),
        filename: `${safeTitle}-${data.shortId}${suffix}.${ext}`,
      });
    });
  }
  return items;
}

/**
 * Compute a clean spawn position immediately to the right of a selection's
 * bounding box for AI synthesis target nodes (image / video / storyboard).
 */
export function computeRightSpawnPosition(boxes: ArrangeNodeBox[], offsetX = 76): { x: number; y: number } {
  if (boxes.length === 0) return { x: 240, y: 180 };
  const maxRight = Math.max(...boxes.map((b) => b.x + b.width));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxBottom = Math.max(...boxes.map((b) => b.y + b.height));
  return {
    x: Math.round(maxRight + offsetX),
    y: Math.round((minY + maxBottom) / 2 - 110),
  };
}
