import type { FlowNode } from "../store/board";

export interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function collectOccupiedBoxes(
  nodes: FlowNode[],
  extra: CanvasBox[] = [],
  defaultWidth = 256,
  defaultHeight = 260,
): CanvasBox[] {
  return [
    ...nodes.map(({ position, measured }) => ({
      x: position.x,
      y: position.y,
      width: measured?.width ?? defaultWidth,
      height: Math.max(measured?.height ?? defaultHeight, defaultHeight),
    })),
    ...extra,
  ];
}

function overlapsAny(candidate: CanvasBox, occupied: CanvasBox[], margin = 20): boolean {
  return occupied.some((box) => (
    candidate.x < box.x + box.width + margin
    && candidate.x + candidate.width + margin > box.x
    && candidate.y < box.y + box.height + margin
    && candidate.y + candidate.height + margin > box.y
  ));
}

/**
 * 在画布坐标系（flow units）中为新节点寻找不与已有节点重叠的坐标。
 * 优先在当前可见视口范围内寻找空闲位置；若当前视口已排满，则沿螺旋网格或已有节点下方外扩，
 * 确保连点工具栏或从资产库批量导入时绝不互相遮挡（不受画布缩放倍率影响）。
 */
export function findFreeCanvasPosition(opts: {
  origin: { x: number; y: number };
  occupied: CanvasBox[];
  width?: number;
  height?: number;
  minBounds?: { x: number; y: number };
  maxBounds?: { x: number; y: number };
  stepX?: number;
  stepY?: number;
}): { x: number; y: number } {
  const width = opts.width ?? 256;
  const height = opts.height ?? 260;
  const stepX = opts.stepX ?? 292;
  const stepY = opts.stepY ?? 288;

  const gridOffsets: Array<[number, number]> = [
    [0, 0],
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [2, 0], [-2, 0], [0, 2], [0, -2],
    [2, 1], [-2, 1], [2, -1], [-2, -1],
    [1, 2], [-1, 2], [2, 2], [-2, 2],
  ];

  const candidates = gridOffsets.map(([gx, gy]) => ({
    x: Math.round(opts.origin.x + gx * stepX),
    y: Math.round(opts.origin.y + gy * stepY),
    width,
    height,
  }));

  if (opts.minBounds && opts.maxBounds) {
    const inView = candidates.find((c) => (
      c.x >= opts.minBounds!.x
      && c.y >= opts.minBounds!.y
      && c.x + width <= opts.maxBounds!.x
      && c.y + height <= opts.maxBounds!.y
      && !overlapsAny(c, opts.occupied)
    ));
    if (inView) return { x: inView.x, y: inView.y };
  }

  const anyFree = candidates.find((c) => !overlapsAny(c, opts.occupied));
  if (anyFree) return { x: anyFree.x, y: anyFree.y };

  const maxBottom = opts.occupied.reduce(
    (max, box) => Math.max(max, box.y + box.height),
    opts.origin.y,
  );
  return { x: Math.round(opts.origin.x), y: Math.round(maxBottom + 32) };
}
