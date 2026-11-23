/**
 * LibTV 风格单图快捷衍生工具：
 * - ⏭ 推演下一幕 / ⏮ 倒推前一幕 / 🎥 多机位换角度（新建下游联动图生图节点）
 * - 💡 电影级重打光（原地走 Flow 0 积分 edit_image BASE_IMAGE）
 * - 🔍 一键 2K 超清重塑（走 Flow SPrCad + 自动记入历史版本）
 * - ⏱ 节点历史版本无损切换（< 第1版 / 第2版 >）
 */
import { createEdge, createNode, patchNode, upscaleMedia } from "../api/client";
import { collectOccupiedBoxes, findFreeCanvasPosition } from "./canvasLayout";
import { useBoardStore, type FlowNode, type NodeHistoryEntry } from "../store/board";
import { useGenerationStore } from "../store/generation";

export interface AnglePreset {
  key: string;
  label: string;
  instruction: string;
}

export const CAMERA_ANGLE_PRESETS: readonly AnglePreset[] = [
  {
    key: "closeup",
    label: "正面情绪特写",
    instruction: "切换为正面平视近景特写镜头，浅景深虚化背景，聚焦人物神态眼神或主体核心材质细节",
  },
  {
    key: "side_45",
    label: "侧 45° 半身中景",
    instruction: "切换为侧面 45 度电影中景视角，保留立体轮廓光影，展现主体空间景深关系",
  },
  {
    key: "over_shoulder",
    label: "过肩反打机位",
    instruction: "切换为电影叙事过肩反打视角（Over-the-Shoulder Shot），前景虚化肩膀轮廓，强化对手戏视线张力",
  },
  {
    key: "low_angle",
    label: "低机位仰拍英雄视角",
    instruction: "切换为戏剧性低机位広角仰拍，拉高主体身形比例与气场压迫感，背景天际线压低",
  },
  {
    key: "high_bird",
    label: "高机位俯拍视角",
    instruction: "切换为高机位 45 度俯拍全景视角，清晰交代主体与地面环境动线、构图层次极简高级",
  },
  {
    key: "back_follow",
    label: "电影感背影跟拍",
    instruction: "切换为后方跟拍视角（Follow Shot），展现角色背影与前方延伸光影氛围",
  },
] as const;

export interface LightingPreset {
  key: string;
  label: string;
  instruction: string;
}

export const LIGHTING_PRESETS: readonly LightingPreset[] = [
  {
    key: "rembrandt",
    label: "伦勃朗戏剧侧光",
    instruction:
      "严格保持画面构图、主体形态、服饰造型与背景位置完全不变，仅将整体光线重塑为高对比伦勃朗戏剧性侧逆光，在脸部形成柔和三角高光与深邃暗部层次。",
  },
  {
    key: "cyber_neon",
    label: "赛博双色霓虹光",
    instruction:
      "严格保持画面构图、主体形态与人物五官完全不变，仅重打光为电影级青蓝（#38bdf8）与品红双色霓虹轮廓光，雨夜环境冷暖对比鲜明。",
  },
  {
    key: "golden_hour",
    label: "黄金时刻暖调逆光",
    instruction:
      "严格保持原画面人物姿态与场景结构不变，仅重打光为日落黄金时刻暖金色低角度逆光，发丝边缘呈现柔和金边轮廓光，空气感通透温柔。",
  },
  {
    key: "volumetric",
    label: "丁达尔体积圣光",
    instruction:
      "严格保持画面主体位置与场景结构完全不变，仅重新布光加入穿透烟雾/窗棂的斜射丁达尔体积光束（Tyndall God Rays），光尘微粒细腻立体。",
  },
  {
    key: "studio_soft",
    label: "商业棚拍柔光精修",
    instruction:
      "严格保持主体外观细节与背景位置不变，仅调整为高端商业影棚大柔光箱主光配合细腻高光轮廓光，色彩纯净通透、肤质质感柔和高级。",
  },
] as const;

async function spawnConnectedChildImageNode(
  srcRfId: string,
  title: string,
  prompt: string,
): Promise<void> {
  const state = useBoardStore.getState();
  const boardId = state.boardId;
  const srcNode = state.nodes.find((n) => n.id === srcRfId);
  if (boardId === null || !srcNode) return;

  const occupied = collectOccupiedBoxes(state.nodes, [], 256, 320);
  const pos = findFreeCanvasPosition({
    origin: { x: srcNode.position.x + 330, y: srcNode.position.y },
    occupied,
    width: 256,
    height: 320,
  });

  const dto = await createNode({
    board_id: boardId,
    type: "image",
    x: Math.round(pos.x),
    y: Math.round(pos.y),
    data: {
      title,
      prompt,
      aspectRatio: srcNode.data.aspectRatio,
    },
  });

  const rfNode: FlowNode = {
    id: String(dto.id),
    type: "image",
    position: { x: dto.x, y: dto.y },
    data: {
      type: "image",
      shortId: dto.short_id,
      title,
      prompt,
      aspectRatio: srcNode.data.aspectRatio,
      status: "idle",
    },
  };

  let edgeObj: ReturnType<typeof useBoardStore.getState>["edges"][number] | null = null;
  const srcDbId = parseInt(srcRfId, 10);
  if (!isNaN(srcDbId)) {
    try {
      const eDto = await createEdge({
        board_id: boardId,
        source_id: srcDbId,
        target_id: dto.id,
      });
      edgeObj = {
        id: String(eDto.id),
        source: String(eDto.source_id),
        target: String(eDto.target_id),
        data: { sourceVariantIdx: null },
      };
    } catch {
      // fallback without persisted edge
    }
  }

  useBoardStore.setState((s) => ({
    nodes: [...s.nodes, rfNode],
    edges: edgeObj ? [...s.edges, edgeObj] : s.edges,
  }));

  await useGenerationStore.getState().dispatchGeneration(rfNode.id, {
    prompt,
    kind: "image",
    aspectRatio: srcNode.data.aspectRatio,
    variantCount: 1,
  });
}

export async function deriveNextScene(srcRfId: string): Promise<void> {
  const srcNode = useBoardStore.getState().nodes.find((n) => n.id === srcRfId);
  if (!srcNode) return;
  const context = srcNode.data.aiBrief || srcNode.data.prompt || "当前画面主体与场景";
  const prompt = [
    `请以参考图「${context}」为上一帧画面起点，严格锁定主角五官特征、服装配饰与一致光影环境，`,
    `推演 3 秒后的下一幕戏剧性动作延续镜头：主体动作自然推进、微表情与场景交互更具故事张力，电影级 35mm 实拍质感。`,
  ].join("");
  await spawnConnectedChildImageNode(srcRfId, "下一幕推演", prompt);
}

export async function derivePrevScene(srcRfId: string): Promise<void> {
  const srcNode = useBoardStore.getState().nodes.find((n) => n.id === srcRfId);
  if (!srcNode) return;
  const context = srcNode.data.aiBrief || srcNode.data.prompt || "当前画面主体与场景";
  const prompt = [
    `请以参考图「${context}」为结果画面逆向推演 5 秒前的前因镜头，严格锁定同一主角外形服饰与场景美术基调，`,
    `展现事件发生前的铺垫瞬间与动作蓄势状态，电影级空间构图与真实光线衔接。`,
  ].join("");
  await spawnConnectedChildImageNode(srcRfId, "前一幕倒推", prompt);
}

export async function deriveCameraAngle(srcRfId: string, presetKey: string): Promise<void> {
  const srcNode = useBoardStore.getState().nodes.find((n) => n.id === srcRfId);
  if (!srcNode) return;
  const preset = CAMERA_ANGLE_PRESETS.find((p) => p.key === presetKey) ?? CAMERA_ANGLE_PRESETS[0];
  const context = srcNode.data.aiBrief || srcNode.data.prompt || "参考画面中的主角与环境";
  const prompt = [
    `严格锁定参考图中的人物外貌、服装材质、配色与所处场景元素，`,
    `${preset.instruction}（基于上下文：${context}）。`,
  ].join("");
  await spawnConnectedChildImageNode(srcRfId, preset.label, prompt);
}

export async function relightImageNode(srcRfId: string, presetKey: string): Promise<void> {
  const srcNode = useBoardStore.getState().nodes.find((n) => n.id === srcRfId);
  if (!srcNode || !srcNode.data.mediaId) return;
  const preset = LIGHTING_PRESETS.find((p) => p.key === presetKey) ?? LIGHTING_PRESETS[0];
  await useGenerationStore.getState().refineImage(srcRfId, {
    prompt: preset.instruction,
    aspectRatio: srcNode.data.aspectRatio,
  });
}

export async function upscaleImageNode2K(
  srcRfId: string,
  targetRes: "2K" | "4K" = "2K",
): Promise<void> {
  const srcNode = useBoardStore.getState().nodes.find((n) => n.id === srcRfId);
  const currentMid = srcNode?.data.mediaId;
  if (!srcNode || !currentMid) return;

  const projectId = useGenerationStore.getState().projectId;
  const dbId = parseInt(srcRfId, 10);
  const res = await upscaleMedia(currentMid, {
    resolution: targetRes,
    kind: "image",
    projectId: projectId ?? undefined,
    aspectRatio: srcNode.data.aspectRatio,
    nodeId: isNaN(dbId) ? undefined : dbId,
  });

  const nextMid = res.media_id || currentMid;
  const existingHistory = Array.isArray(srcNode.data.history) ? [...srcNode.data.history] : [];
  if (!existingHistory.some((h) => h.mediaId === currentMid)) {
    existingHistory.push({
      mediaId: currentMid,
      mediaIds: srcNode.data.mediaIds ?? [currentMid],
      prompt: srcNode.data.prompt,
      renderedAt: srcNode.data.renderedAt,
      aspectRatio: srcNode.data.aspectRatio,
      imageModel: srcNode.data.imageModel,
    });
  }
  const filtered = existingHistory.filter((h) => h.mediaId !== nextMid);
  filtered.push({
    mediaId: nextMid,
    mediaIds: [nextMid],
    prompt: srcNode.data.prompt,
    renderedAt: new Date().toISOString(),
    aspectRatio: srcNode.data.aspectRatio,
    imageModel: srcNode.data.imageModel,
  });
  const capped = filtered.slice(-10);

  useBoardStore.getState().updateNodeData(srcRfId, {
    mediaId: nextMid,
    mediaIds: [nextMid],
    variantCount: 1,
    imageResolution: res.resolution,
    history: capped,
  });
}

export function switchNodeHistoryVersion(rfId: string, targetIndex: number): void {
  const node = useBoardStore.getState().nodes.find((n) => n.id === rfId);
  const history = node?.data.history;
  if (!node || !Array.isArray(history) || history.length === 0) return;
  const clamped = Math.max(0, Math.min(history.length - 1, targetIndex));
  const entry: NodeHistoryEntry | undefined = history[clamped];
  if (!entry || !entry.mediaId) return;

  const nextMediaIds =
    Array.isArray(entry.mediaIds) && entry.mediaIds.length > 0
      ? entry.mediaIds
      : [entry.mediaId];
  const patch: Record<string, unknown> = {
    mediaId: entry.mediaId,
    mediaIds: nextMediaIds,
    variantCount: nextMediaIds.length,
    ...(entry.prompt ? { prompt: entry.prompt } : {}),
    ...(entry.renderedAt ? { renderedAt: entry.renderedAt } : {}),
    ...(entry.aspectRatio ? { aspectRatio: entry.aspectRatio } : {}),
    ...(entry.imageModel ? { imageModel: entry.imageModel } : {}),
    ...(entry.videoQuality ? { videoQuality: entry.videoQuality } : {}),
  };

  useBoardStore.getState().updateNodeData(rfId, patch);
  const dbId = parseInt(rfId, 10);
  if (!isNaN(dbId)) {
    patchNode(dbId, { status: "done", data: patch }).catch(() => {});
  }
}
