import type { FlowNode } from "../store/board";

export interface SnapNodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Distance from `node.position.y` to the top edge of `.jm-node-surface` */
  surfaceTopOffset: number;
  /** Optional footer inset below `.jm-node-surface` (e.g. multi-version history bar) */
  surfaceBottomInset?: number;
}

export interface SnapGuideLine {
  orientation: "h" | "v";
  /** Constant coordinate along the perpendicular axis (y for horizontal, x for vertical) in flow space */
  pos: number;
  /** Start coordinate along the line axis in flow space */
  start: number;
  /** End coordinate along the line axis in flow space */
  end: number;
  kind: "edge" | "center";
}

export interface SmartSnapResult {
  snappedX: number;
  snappedY: number;
  didSnapX: boolean;
  didSnapY: boolean;
  guides: SnapGuideLine[];
}

/** Default vertical offset from NodeCard outer wrapper top to `.jm-node-surface` top (.node-header = 26px + 5px gap) */
export const DEFAULT_NODE_HEADER_OFFSET = 31;
/** Extra height when `.jm-node-group-badge` renders above `.node-header` */
export const GROUP_BADGE_EXTRA_OFFSET = 24;
/** Extra footer height when `.jm-node-history-bar` renders below `.jm-node-surface` */
export const HISTORY_BAR_FOOTER_INSET = 30;

/**
 * Resolve a FlowNode into a `SnapNodeRect` with accurate `.jm-node-surface` offsets
 * so horizontal alignment guides visually hug the card body top/center/bottom edges
 * across all heterogeneous module types (image, video, character, prompt, note, storyboard).
 */
export function resolveSnapRect(
  node: FlowNode,
  measured?: { width?: number; height?: number },
  overridePos?: { x: number; y: number },
): SnapNodeRect {
  const width =
    measured?.width ??
    node.measured?.width ??
    (typeof node.width === "number" && node.width > 0 ? node.width : undefined) ??
    (typeof node.data.customW === "number" && node.data.customW > 0 ? node.data.customW : undefined) ??
    256;
  const height =
    measured?.height ??
    node.measured?.height ??
    (typeof node.height === "number" && node.height > 0 ? node.height : undefined) ??
    (typeof node.data.customH === "number" && node.data.customH > 0 ? node.data.customH : undefined) ??
    210;

  const hasGroup = Boolean(node.data.groupId);
  const surfaceTopOffset = DEFAULT_NODE_HEADER_OFFSET + (hasGroup ? GROUP_BADGE_EXTRA_OFFSET : 0);
  const hasHistoryBar = Array.isArray(node.data.history) && node.data.history.length >= 2;
  const surfaceBottomInset = hasHistoryBar ? HISTORY_BAR_FOOTER_INSET : 0;

  return {
    id: node.id,
    x: overridePos ? overridePos.x : node.position.x,
    y: overridePos ? overridePos.y : node.position.y,
    width,
    height,
    surfaceTopOffset: Math.min(surfaceTopOffset, Math.max(0, height - 24)),
    surfaceBottomInset: Math.min(surfaceBottomInset, Math.max(0, height - surfaceTopOffset - 24)),
  };
}

interface VisualMetrics {
  left: number;
  centerX: number;
  right: number;
  outerTop: number;
  top: number;
  centerY: number;
  bottom: number;
}

function getVisualMetrics(r: SnapNodeRect): VisualMetrics {
  const left = r.x;
  const right = r.x + r.width;
  const centerX = (left + right) / 2;
  const topOffset = Math.max(0, r.surfaceTopOffset);
  const bottomInset = Math.max(0, r.surfaceBottomInset ?? 0);
  const top = r.y + topOffset;
  const bottom = Math.max(top + 20, r.y + r.height - bottomInset);
  const centerY = (top + bottom) / 2;
  return { left, centerX, right, outerTop: r.y, top, centerY, bottom };
}

/**
 * Compute clean segment bounds between two aligned rectangles:
 * - When disjoint along the line axis, draw strictly across the clean gap between facing edges
 *   (matching the reference screenshot where top/middle/bottom dashed lines bridge the gap cleanly
 *   without cutting across node card faces).
 * - When overlapping along the line axis, span from the outer-most edge to the opposite outer edge.
 */
function computeSpanBetween(aStart: number, aEnd: number, bStart: number, bEnd: number): [number, number] {
  if (aEnd <= bStart) return [aEnd, bStart];
  if (bEnd <= aStart) return [bEnd, aStart];
  return [Math.min(aStart, bStart), Math.max(aEnd, bEnd)];
}

/**
 * Pure smart magnetic snapping & guide-line calculator for dragging one node
 * (or a multi-selection bounding box) relative to all other modules on the canvas.
 */
export function computeSmartSnapGuides(
  dragging: SnapNodeRect,
  targets: readonly SnapNodeRect[],
  threshold = 7,
  matchEpsilon = 1.25,
): SmartSnapResult {
  if (targets.length === 0) {
    return {
      snappedX: dragging.x,
      snappedY: dragging.y,
      didSnapX: false,
      didSnapY: false,
      guides: [],
    };
  }

  const d = getVisualMetrics(dragging);

  let bestDx: number | null = null;
  let bestAbsDx = threshold + 0.001;
  let bestDy: number | null = null;
  let bestAbsDy = threshold + 0.001;

  for (const tRect of targets) {
    if (tRect.id === dragging.id) continue;
    const t = getVisualMetrics(tRect);

    // Candidate X deltas: left-left, center-center, right-right, left-right, right-left
    const xCandidates = [
      t.left - d.left,
      t.centerX - d.centerX,
      t.right - d.right,
      t.right - d.left,
      t.left - d.right,
    ];
    for (const dx of xCandidates) {
      const abs = Math.abs(dx);
      if (abs <= threshold && abs < bestAbsDx) {
        bestAbsDx = abs;
        bestDx = dx;
      }
    }

    // Candidate Y deltas: top-top, center-center, bottom-bottom, top-bottom, bottom-top
    const yCandidates = [
      t.top - d.top,
      t.centerY - d.centerY,
      t.bottom - d.bottom,
      t.bottom - d.top,
      t.top - d.bottom,
    ];
    for (const dy of yCandidates) {
      const abs = Math.abs(dy);
      if (abs <= threshold && abs < bestAbsDy) {
        bestAbsDy = abs;
        bestDy = dy;
      }
    }
  }

  const snappedX = bestDx !== null ? dragging.x + bestDx : dragging.x;
  const snappedY = bestDy !== null ? dragging.y + bestDy : dragging.y;
  const snappedRect: SnapNodeRect = { ...dragging, x: snappedX, y: snappedY };
  const s = getVisualMetrics(snappedRect);

  const guides: SnapGuideLine[] = [];
  const seenKeys = new Set<string>();

  const pushGuide = (g: SnapGuideLine) => {
    const start = Math.min(g.start, g.end);
    const end = Math.max(g.start, g.end);
    if (end - start < 2) return;
    const key = `${g.orientation}:${Math.round(g.pos * 2)}:${Math.round(start)}:${Math.round(end)}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    guides.push({ ...g, start, end });
  };

  for (const tRect of targets) {
    if (tRect.id === dragging.id) continue;
    const t = getVisualMetrics(tRect);

    // Horizontal guides (shared Y lines: top, centerY, bottom, and cross-edges)
    const [hx1, hx2] = computeSpanBetween(s.left, s.right, t.left, t.right);
    const hChecks: Array<{ a: number; b: number; kind: "edge" | "center" }> = [
      { a: s.top, b: t.top, kind: "edge" },
      { a: s.centerY, b: t.centerY, kind: "center" },
      { a: s.bottom, b: t.bottom, kind: "edge" },
      { a: s.top, b: t.bottom, kind: "edge" },
      { a: s.bottom, b: t.top, kind: "edge" },
    ];
    for (const chk of hChecks) {
      if (Math.abs(chk.a - chk.b) <= matchEpsilon) {
        pushGuide({
          orientation: "h",
          pos: chk.b,
          start: hx1,
          end: hx2,
          kind: chk.kind,
        });
      }
    }

    // Vertical guides (shared X lines: left, centerX, right, and cross-edges)
    const [vy1, vy2] = computeSpanBetween(s.outerTop, s.bottom, t.outerTop, t.bottom);
    const vChecks: Array<{ a: number; b: number; kind: "edge" | "center" }> = [
      { a: s.left, b: t.left, kind: "edge" },
      { a: s.centerX, b: t.centerX, kind: "center" },
      { a: s.right, b: t.right, kind: "edge" },
      { a: s.left, b: t.right, kind: "edge" },
      { a: s.right, b: t.left, kind: "edge" },
    ];
    for (const chk of vChecks) {
      if (Math.abs(chk.a - chk.b) <= matchEpsilon) {
        pushGuide({
          orientation: "v",
          pos: chk.b,
          start: vy1,
          end: vy2,
          kind: chk.kind,
        });
      }
    }
  }

  return {
    snappedX,
    snappedY,
    didSnapX: bestDx !== null,
    didSnapY: bestDy !== null,
    guides,
  };
}
