// Locked prompt template for Storyboard nodes. The node IS an image
// node — it wraps the user's topic in a deterministic preamble so Flow renders
// a single composite grid that visually narrates the topic or captures 9
// synchronized camera angles of the same scene.
import type { StoryboardGrid, StoryboardMode } from "../store/board";

export const STORYBOARD_GRIDS: readonly StoryboardGrid[] = [
  "2x2",
  "2x3",
  "2x4",
  "3x3",
] as const;

export function normaliseStoryboardGrid(
  value: unknown,
  fallback: StoryboardGrid = "2x2",
): StoryboardGrid {
  return value === "2x2" || value === "2x3" || value === "2x4" || value === "3x3"
    ? value
    : fallback;
}

export function normaliseStoryboardMode(
  value: unknown,
  fallback: StoryboardMode = "narrative",
): StoryboardMode {
  return value === "multicam" ? "multicam" : value === "narrative" ? "narrative" : fallback;
}

export function totalPanels(grid: StoryboardGrid): number {
  if (grid === "2x2") return 4;
  if (grid === "2x3") return 6;
  if (grid === "2x4") return 8;
  return 9;
}

// Map grid + image aspect ratio → concrete rows × cols. For asymmetric
// grids (2x3, 2x4), the larger dimension follows the longer edge of
// the image so panels remain readable: landscape → wider grid (cols
// = larger), portrait → taller grid (rows = larger). 2x2 and 3x3 are symmetric.
export function resolveStoryboardLayout(
  grid: StoryboardGrid,
  aspectRatio?: string,
): { rows: number; cols: number; total: number } {
  if (grid === "2x2") return { rows: 2, cols: 2, total: 4 };
  if (grid === "3x3") return { rows: 3, cols: 3, total: 9 };
  const big = grid === "2x3" ? 3 : 4; // total = 6 or 8
  const isPortrait = aspectRatio?.includes("PORTRAIT") ?? false;
  return isPortrait
    ? { rows: big, cols: 2, total: 2 * big }
    : { rows: 2, cols: big, total: 2 * big };
}

export function buildStoryboardPrompt(
  topic: string,
  grid: StoryboardGrid = "2x2",
  aspectRatio?: string,
  mode: StoryboardMode = "narrative",
): string {
  const { rows, cols, total } = resolveStoryboardLayout(grid, aspectRatio);
  const t = topic.trim() || "未命名故事主题";
  if (mode === "multicam") {
    return [
      `请围绕场景/主题「${t}」创作一张同场多机位分镜九宫格联系表大图，`,
      `严格按 ${rows}x${cols} 宫格排版（共 ${rows} 行、${cols} 列，总计 ${total} 个独立机位画面）。`,
      `全部 ${total} 个画面必须锁定同一时空时刻、同一主体人物外貌服饰与一致的环境光源材质，`,
      `依次展示 ${total} 种不同电影景别与机位视角：全览定场远景、正面中景主视角、侧面 45° 近景、面部表情特写、过肩反打视角、低机位仰拍、高机位俯拍、手部/核心道具微距细节与氛围背影镜头。`,
      `严格版式要求：`,
      `• 相邻格子之间仅保留细匀干净的纯色分隔边界，严禁画面跨格溢边或重复错位；`,
      `• 所有分镜格均为规整等大矩形、无重叠边框且方便单独裁切；`,
      `• 请保持每个子画面纯洁无文字、无编号水印与字幕遮挡。`,
    ].join(" ");
  }
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
