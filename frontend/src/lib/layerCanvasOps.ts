/**
 * 纯函数几何与提示词辅助工具（Stage 3A「图层编辑精修画板」）：
 * - 局部涂抹选区包围盒统计与空间坐标描述
 * - 局部重绘 / 消除笔指令合成
 * - 比例扩图（Outpaint）画布填充布局计算与提示词合成
 * - 多图拼贴（Collage）图层结构与光影融合提示词合成
 *
 * 刻意不依赖 DOM / window，方便 Node SSR 单元测试直接导入验证。
 */

export interface MaskPoint {
  x: number;
  y: number;
  radius: number;
}

export interface MaskRegionSpec {
  minXRatio: number;
  minYRatio: number;
  maxXRatio: number;
  maxYRatio: number;
  quadrantLabel: string;
  percentDesc: string;
}

export type OutpaintPresetKey = "16:9" | "9:16" | "1:1" | "expand_1_4x";

export interface OutpaintPadLayout {
  preset: OutpaintPresetKey;
  label: string;
  canvasWidth: number;
  canvasHeight: number;
  drawX: number;
  drawY: number;
  drawWidth: number;
  drawHeight: number;
  aspectRatio: string;
}

export interface CollageLayerItem {
  id: string;
  rfId: string;
  mediaId: string;
  title: string;
  /** 图层中心在拼贴画布中的归一化 X 位置 [0..1] */
  x: number;
  /** 图层中心在拼贴画布中的归一化 Y 位置 [0..1] */
  y: number;
  /** 相对于画布高度/短边的缩放比例 */
  scale: number;
  flipX: boolean;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function describeQuadrant(cx: number, cy: number): string {
  const horiz = cx < 0.38 ? "左" : cx > 0.62 ? "右" : "中";
  const vert = cy < 0.38 ? "上" : cy > 0.62 ? "下" : "中";
  if (horiz === "中" && vert === "中") return "画面中央区域";
  if (horiz === "中") return vert === "上" ? "画面上半区域" : "画面下半区域";
  if (vert === "中") return horiz === "左" ? "画面左侧区域" : "画面右侧区域";
  return `画面${horiz}${vert}区域`;
}

/** 根据用户涂抹笔画列表，计算精确归一化的选区包围盒与空间文字描述。 */
export function computeMaskRegionSpec(
  strokes: MaskPoint[][],
  width: number,
  height: number,
): MaskRegionSpec | null {
  if (width <= 0 || height <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let count = 0;

  for (const stroke of strokes) {
    for (const pt of stroke) {
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      const r = Math.max(1, Number.isFinite(pt.radius) ? pt.radius : 12);
      minX = Math.min(minX, pt.x - r);
      minY = Math.min(minY, pt.y - r);
      maxX = Math.max(maxX, pt.x + r);
      maxY = Math.max(maxY, pt.y + r);
      count += 1;
    }
  }

  if (count === 0) return null;

  const minXRatio = clamp01(minX / width);
  const minYRatio = clamp01(minY / height);
  const maxXRatio = clamp01(maxX / width);
  const maxYRatio = clamp01(maxY / height);
  const cx = (minXRatio + maxXRatio) / 2;
  const cy = (minYRatio + maxYRatio) / 2;
  const quadrantLabel = describeQuadrant(cx, cy);
  const x0 = Math.round(minXRatio * 100);
  const x1 = Math.round(maxXRatio * 100);
  const y0 = Math.round(minYRatio * 100);
  const y1 = Math.round(maxYRatio * 100);

  return {
    minXRatio,
    minYRatio,
    maxXRatio,
    maxYRatio,
    quadrantLabel,
    percentDesc: `${quadrantLabel}（横向 ${x0}%–${x1}%，纵向 ${y0}%–${y1}%）`,
  };
}

/** 合成发往 Google Flow `edit_image` 的局部重绘 / 一键消除提示词。 */
export function composeInpaintPrompt(
  mode: "inpaint" | "erase",
  region: MaskRegionSpec,
  userPrompt: string,
): string {
  const cleanUser = userPrompt.trim();
  if (mode === "erase") {
    const focus = cleanUser ? `（目标内容：${cleanUser}）` : "";
    return [
      `请参照 ref_image_1 中青蓝色高亮蒙版标定的位置，精确针对原图${region.percentDesc}执行无痕物品消除${focus}：`,
      `完全移除该涂抹区域内的前景杂物、水印、路人或多余元素，并根据四周原生纹理、地平线与光线方向智能补全底层背景；`,
      `严格保持选区之外的构图、主体五官服饰、光影与透视 100% 不变，最终输出不得残留任何青蓝色高亮框线。`,
    ].join("");
  }

  const editInstruction = cleanUser || "优化该区域的材质细节并使其自然融入环境";
  return [
    `请参照 ref_image_1 中青蓝色高亮蒙版标定的位置，仅针对原图${region.percentDesc}执行局部重绘修改：`,
    `将该选区内容调整为「${editInstruction}」。`,
    `严格保持高亮选区以外的其余画面内容、人物主体特征、视角构图、色彩与影调完全不变，新生成内容边缘光影自然融合，最终成图不得带有任何青蓝色遮罩色块。`,
  ].join("");
}

/** 计算扩图（Outpaint）目标画布尺寸与原图在扩图底板中的居中落点。 */
export function computeOutpaintPadLayout(
  srcWidth: number,
  srcHeight: number,
  preset: OutpaintPresetKey,
): OutpaintPadLayout {
  const safeW = Math.max(64, Math.round(srcWidth || 1024));
  const safeH = Math.max(64, Math.round(srcHeight || 1024));

  if (preset === "expand_1_4x") {
    const ratio = safeW / safeH;
    const aspectRatio =
      ratio >= 1.15
        ? "IMAGE_ASPECT_RATIO_LANDSCAPE"
        : ratio <= 0.87
          ? "IMAGE_ASPECT_RATIO_PORTRAIT"
          : "IMAGE_ASPECT_RATIO_SQUARE";
    const maxCanvas = 1280;
    const canvasWidth = ratio >= 1 ? maxCanvas : Math.max(480, Math.round(maxCanvas * ratio));
    const canvasHeight = ratio >= 1 ? Math.max(480, Math.round(maxCanvas / ratio)) : maxCanvas;
    const innerScale = 1 / 1.4;
    const drawWidth = Math.round(canvasWidth * innerScale);
    const drawHeight = Math.round(canvasHeight * innerScale);
    return {
      preset,
      label: "四周扩展 1.4x",
      canvasWidth,
      canvasHeight,
      drawX: Math.round((canvasWidth - drawWidth) / 2),
      drawY: Math.round((canvasHeight - drawHeight) / 2),
      drawWidth,
      drawHeight,
      aspectRatio,
    };
  }

  let canvasWidth = 1280;
  let canvasHeight = 720;
  let aspectRatio = "IMAGE_ASPECT_RATIO_LANDSCAPE";
  let label = "16:9 横屏扩图";

  if (preset === "9:16") {
    canvasWidth = 720;
    canvasHeight = 1280;
    aspectRatio = "IMAGE_ASPECT_RATIO_PORTRAIT";
    label = "9:16 竖屏扩图";
  } else if (preset === "1:1") {
    canvasWidth = 1024;
    canvasHeight = 1024;
    aspectRatio = "IMAGE_ASPECT_RATIO_SQUARE";
    label = "1:1 方图扩图";
  }

  const containScale = Math.min(canvasWidth / safeW, canvasHeight / safeH);
  let drawWidth = Math.round(safeW * containScale);
  let drawHeight = Math.round(safeH * containScale);

  // 若原图比例与目标画布几乎一致（四周几乎没有留白），适度内缩为 78% 以提供足够扩图延展区
  const fillCoverageW = drawWidth / canvasWidth;
  const fillCoverageH = drawHeight / canvasHeight;
  if (fillCoverageW > 0.9 && fillCoverageH > 0.9) {
    drawWidth = Math.round(drawWidth * 0.78);
    drawHeight = Math.round(drawHeight * 0.78);
  }

  return {
    preset,
    label,
    canvasWidth,
    canvasHeight,
    drawX: Math.round((canvasWidth - drawWidth) / 2),
    drawY: Math.round((canvasHeight - drawHeight) / 2),
    drawWidth,
    drawHeight,
    aspectRatio,
  };
}

/** 合成发往 Google Flow `edit_image` 的无痕扩图提示词。 */
export function composeOutpaintPrompt(
  layout: OutpaintPadLayout,
  extraHint = "",
): string {
  const hint = extraHint.trim();
  return [
    `请依据当前画布底板及 ref_image_1 中的清晰原图，将画面向四周${layout.label}目标比例自然无痕外扩补全：`,
    `严格保留中央核心原图的主体人物、服装、物体形态与锐利细节；`,
    `将边缘柔化延伸区域平滑重构为高清晰度的真实背景建筑、天空、地面透视与连续环境光影，消除一切接缝与模糊晕影。`,
    hint ? `补充延展要求：${hint}。` : "",
  ]
    .filter(Boolean)
    .join("");
}

/** 合成多节点拼贴后的电影级光影统一融合提示词。 */
export function composeCollageFusionPrompt(
  userPrompt: string,
  layerTitles: string[],
): string {
  const clean = userPrompt.trim();
  const subjects = layerTitles.filter(Boolean).slice(0, 4).join("、");
  const subjectNote = subjects ? `保留参与拼贴的 ${subjects} 主体特征与布局关系，` : "";
  const directive =
    clean || "电影级自然环境光照、真实地面接触阴影、统一色调与空气透视";
  return [
    `请以当前拼贴合成底图为基础并参照对应参考图细节，执行专业级多图层光影融合重绘：`,
    subjectNote,
    `保持各元素在画面中的前后层次与摆放位置，消除生硬剪贴边缘与色温割裂，按照「${directive}」统一主光源方向、环境反光、地面接触投影与景深虚化，生成一张浑然一体的实拍级完整画面。`,
  ].join("");
}
