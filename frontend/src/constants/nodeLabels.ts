/**
 * 统一简体中文节点标题与画布项目名称映射工具。
 * 集中收敛历史英文节点类型/标题与「未命名项目」回退逻辑，避免各组件重复维护。
 */

export const LEGACY_TITLE_MAP: Record<string, string> = {
  Character: "角色主体",
  Image: "图片",
  Video: "视频",
  Audio: "音频",
  Prompt: "文本",
  Note: "便签",
  "Visual asset": "物品素材",
  Storyboard: "故事板",
  Reference: "参考素材",
  character: "角色主体",
  image: "图片",
  video: "视频",
  audio: "音频",
  prompt: "文本",
  note: "便签",
  visual_asset: "物品素材",
  merge: "合成",
};

const LEGACY_VARIANT_SUFFIX = " (variant)";
const CN_VARIANT_SUFFIX = "（副本）";

/**
 * 将节点标题（含历史英文默认名与 `(variant)` 克隆后缀）规范化为简体中文显示。
 */
export function displayNodeTitle(raw: string | undefined, type?: string): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    if (!type) return "";
    return LEGACY_TITLE_MAP[type] ?? type;
  }
  if (trimmed.endsWith(LEGACY_VARIANT_SUFFIX)) {
    const base = trimmed.slice(0, -LEGACY_VARIANT_SUFFIX.length);
    const mappedBase = LEGACY_TITLE_MAP[base] ?? base;
    return `${mappedBase}${CN_VARIANT_SUFFIX}`;
  }
  return LEGACY_TITLE_MAP[trimmed] ?? trimmed;
}

/**
 * 将画布项目名称规范化为中文显示，空名称或历史默认 `Untitled` 统一返回「未命名项目」。
 */
export function displayBoardName(raw: string | undefined): string {
  if (!raw || raw.trim() === "" || raw === "Untitled") return "未命名项目";
  return raw;
}
