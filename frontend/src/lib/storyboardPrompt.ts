// Locked prompt template for Storyboard nodes. The node IS an image
// node — it just wraps the user's topic in a deterministic preamble
// so Flow renders a single composite grid that visually narrates the
// topic. Tweak wording here, never inline at the dispatch site.
import type { StoryboardGrid } from "../store/board";

export const STORYBOARD_GRIDS: readonly StoryboardGrid[] = [
  "2x2",
  "2x3",
  "2x4",
] as const;

// Normalise whatever was persisted on a node (incl. legacy "3x3" from
// 1.2.15-1.2.18) into a valid grid. Unknown / legacy → "2x2" (the
// simplest baseline; user can re-pick).
export function normaliseStoryboardGrid(
  value: unknown,
  fallback: StoryboardGrid = "2x2",
): StoryboardGrid {
  return value === "2x2" || value === "2x3" || value === "2x4"
    ? value
    : fallback;
}

export function totalPanels(grid: StoryboardGrid): number {
  return grid === "2x2" ? 4 : grid === "2x3" ? 6 : 8;
}

// Map grid + image aspect ratio → concrete rows × cols. For asymmetric
// grids (2x3, 2x4), the larger dimension follows the longer edge of
// the image so panels remain readable: landscape → wider grid (cols
// = larger), portrait → taller grid (rows = larger). 2x2 is symmetric.
export function resolveStoryboardLayout(
  grid: StoryboardGrid,
  aspectRatio?: string,
): { rows: number; cols: number; total: number } {
  if (grid === "2x2") return { rows: 2, cols: 2, total: 4 };
  const big = grid === "2x3" ? 3 : 4; // total = 6 or 8
  // Flow's aspect-ratio enums look like IMAGE_ASPECT_RATIO_PORTRAIT
  // or VIDEO_ASPECT_RATIO_PORTRAIT — substring match catches both.
  const isPortrait = aspectRatio?.includes("PORTRAIT") ?? false;
  return isPortrait
    ? { rows: big, cols: 2, total: 2 * big }
    : { rows: 2, cols: big, total: 2 * big };
}

export function buildStoryboardPrompt(
  topic: string,
  grid: StoryboardGrid = "2x2",
  aspectRatio?: string,
): string {
  const { rows, cols, total } = resolveStoryboardLayout(grid, aspectRatio);
  const t = topic.trim() || "未命名故事主题";
  return [
    `请为主题「${t}」创作一张单一合成故事板分镜大图，`,
    `严格按 ${rows}x${cols} 宫格排版（共 ${rows} 行、${cols} 列，总计 ${total} 个分镜画面）。`,
    `每一格展示故事中的一个关键情节推进，`,
    `阅读顺序严格按照从左到右、从上到下编号依次衔接（1 → ${total}）。`,
    `严格版式要求：`,
    `• 相邻格子之间保留干净清晰的白色留白分隔线，严禁画面溢边或边框重叠；`,
    `• 所有分镜格均为规整等大的矩形且边界锐利清晰；`,
    `• 在每个分镜格左上角标注清晰、大小统一的编号数字（1, 2, 3, …, ${total}）；`,
    `• 在每个分镜格画面下方的白色留白区域，用简短精炼的简体中文标注一句动作/场景说明文字（保持文字清晰可读、无乱码）。`,
  ].join(" ");
}

export function buildStoryboardVideoPrompt(
  grid: StoryboardGrid = "2x2",
): string {
  const lastFrame = totalPanels(grid);
  return `请严格按照参考故事板图像中的编号顺序，从第 1 格连贯叙事推进并流畅演绎至第 ${lastFrame} 格，呈现极具电影质感的动态故事短片，转场自然连贯且保持角色与场景视觉一致`;
}
