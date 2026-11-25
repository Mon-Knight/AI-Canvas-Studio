/**
 * Google Flow 官方模型目录、官方备注、画质与适用场景分析，以及音视频/图片全量生成参数定义。
 * 后端路由与扩展协议键名同步于 agent/flowboard/services/flow_sdk.py & flow_batch.py。
 */

import type {
  ImageModelKey,
  ImageResolutionKey,
  ImageThinkingLevel,
  OmniFlashVersion,
  VideoModelFamily,
  VideoQuality,
  VideoResolutionKey,
} from "../store/settings";

export interface VideoModelCatalogEntry {
  id:
    | "omni_1_2_flash"
    | "omni_1_1_flash"
    | "veo_3_1_lite"
    | "veo_3_1_fast"
    | "veo_3_1_quality"
    | "veo_3_1_lite_relaxed";
  label: string;
  videoModel: VideoModelFamily;
  omniVersion?: OmniFlashVersion;
  videoQuality?: VideoQuality;
  officialBadge: string;
  creditTag: string;
  deprecationNote?: string;
  deprecated?: boolean;
  ultraOnly?: boolean;
  speedTier: string;
  qualityTier: string;
  bestFor: string;
  durationHint: string;
}

export const VIDEO_MODEL_CATALOG: readonly VideoModelCatalogEntry[] = [
  {
    id: "omni_1_2_flash",
    label: "Omni 1.2 Flash",
    videoModel: "omni_flash",
    omniVersion: "1.2",
    officialBadge: "新一代 · 多参考图",
    creditTag: "360p 3–20 / 720p 9–60 积分/条（11–15秒加倍）",
    speedTier: "极快（3–15秒连续时长）",
    qualityTier: "高（角色一致性与多图融合最佳）",
    bestFor:
      "人物/主体锁定、多张参考图叙事串联、带台词/音效的动态短片（3–10秒 全会员可用；11–15秒 需 Plus/Pro/Ultra；若当前账号暂未开放 1.2 将自动平滑回退 1.1）",
    durationHint: "3–15秒可选",
  },
  {
    id: "omni_1_1_flash",
    label: "Omni 1.1 Flash",
    videoModel: "omni_flash",
    omniVersion: "1.1",
    officialBadge: "旧版多参考",
    creditTag: "360p 4–7 / 720p 15–30 积分/条（随秒数）",
    deprecationNote: "将于 12月5日停用",
    deprecated: true,
    speedTier: "极快（4/6/8/10秒）",
    qualityTier: "中高（按分辨率与秒数计费）",
    bestFor: "旧版参考生视频工作流兼容；新项目建议优先使用 Omni 1.2 Flash",
    durationHint: "4 / 6 / 8 / 10秒",
  },
  {
    id: "veo_3_1_lite",
    label: "Veo 3.1 - Lite",
    videoModel: "veo",
    videoQuality: "lite",
    officialBadge: "主力默认 · 长期保留",
    creditTag: "Ultra 5 / Pro 10 积分/条",
    speedTier: "较快（8秒固定）",
    qualityTier: "均衡高性价比",
    bestFor:
      "日常图生视频、镜头平滑运镜与稳定出片；Free/Pro/Ultra 长期保留型号，综合性价比最高",
    durationHint: "8秒固定",
  },
  {
    id: "veo_3_1_fast",
    label: "Veo 3.1 - Fast",
    videoModel: "veo",
    videoQuality: "fast",
    officialBadge: "高速档",
    creditTag: "Ultra 10 / Pro 20 积分/条",
    deprecationNote: "将于 12月5日停用",
    deprecated: true,
    speedTier: "快（8秒固定）",
    qualityTier: "高（光影自然 · 快速试错）",
    bestFor: "需要较高画质同时兼顾出片速度的分镜验证与动作尝试",
    durationHint: "8秒固定",
  },
  {
    id: "veo_3_1_quality",
    label: "Veo 3.1 - Quality",
    videoModel: "veo",
    videoQuality: "quality",
    officialBadge: "最高精修",
    creditTag: "全档位 100 积分/条",
    deprecationNote: "将于 12月5日停用",
    deprecated: true,
    speedTier: "较慢（高负载排队）",
    qualityTier: "影视级精修（细节纹理最强）",
    bestFor: "最终成片精修、复杂水体/布料/面部微表情及电影级光影镜头",
    durationHint: "8秒固定",
  },
  {
    id: "veo_3_1_lite_relaxed",
    label: "Veo 3.1 - Lite [Lower Priority]",
    videoModel: "veo",
    videoQuality: "lite_relaxed",
    officialBadge: "仅限 Ultra · 0 积分",
    creditTag: "0 积分/条（仅 Ultra）",
    ultraOnly: true,
    speedTier: "低优先级队列（闲时较快）",
    qualityTier: "同 Lite 画质 · 零积分消耗",
    bestFor: "Ultra 订阅专享省积分通道：批量抽卡、氛围背景与不急用的多方案测试",
    durationHint: "8秒固定",
  },
];

export interface ImageModelCatalogEntry {
  id: ImageModelKey;
  flowCode: string;
  label: string;
  officialBadge: string;
  creditTag: string;
  deprecationNote?: string;
  deprecated?: boolean;
  supportsThinking?: boolean;
  speedTier: string;
  qualityTier: string;
  bestFor: string;
}

export const IMAGE_MODEL_CATALOG: readonly ImageModelCatalogEntry[] = [
  {
    id: "NANO_BANANA_PRO",
    flowCode: "GEM_PIX_2",
    label: "Nano Banana Pro",
    officialBadge: "旗舰主力 · 长期推荐",
    creditTag: "0 积分（计入每日额度）",
    speedTier: "标准",
    qualityTier: "极高（写实皮肤纹理与中文文字排版最佳）",
    bestFor: "人像精修、电商产品质感、海报中文排版、复杂光影首帧与高质量重绘首选",
  },
  {
    id: "NANO_BANANA_2_1",
    flowCode: "BELUGA",
    label: "Nano Banana 2.1",
    officialBadge: "新一代 · 可调思考深度",
    creditTag: "0 积分（计入每日额度）",
    supportsThinking: true,
    speedTier: "随思考深度变化",
    qualityTier: "高（复杂指令与空间关系理解突出）",
    bestFor: "多角色站位、九宫格连续分镜、复杂构图约束（支持 低/中/高 三档推理深度）",
  },
  {
    id: "NANO_BANANA_2_LITE",
    flowCode: "HARBOR_SEAL",
    label: "Nano Banana 2 Lite",
    officialBadge: "极速轻量",
    creditTag: "0 积分（计入每日额度）",
    speedTier: "极快",
    qualityTier: "中高（轻快出图）",
    bestFor: "灵感草图、多张快速抽卡对比构图、轻量材质替换",
  },
  {
    id: "NANO_BANANA_2",
    flowCode: "NARWHAL",
    label: "Nano Banana 2（旧版兼容）",
    officialBadge: "旧版接口 · 自动兜底",
    creditTag: "0 积分（计入每日额度）",
    deprecationNote: "官方已逐步切换至 Pro / 2.1，失败时自动回退至 Nano Banana Pro",
    deprecated: true,
    speedTier: "快",
    qualityTier: "中（历史兼容）",
    bestFor: "仅作旧节点与历史画布兼容；常规创作建议选用 Nano Banana Pro 或 2.1",
  },
];

export interface AspectOption {
  value: string;
  shortLabel: string;
  label: string;
  ratio: string;
}

export const IMAGE_ASPECT_OPTIONS: readonly AspectOption[] = [
  { value: "IMAGE_ASPECT_RATIO_LANDSCAPE", shortLabel: "16:9", label: "16:9 横屏", ratio: "16:9" },
  { value: "IMAGE_ASPECT_RATIO_PORTRAIT", shortLabel: "9:16", label: "9:16 竖屏", ratio: "9:16" },
  { value: "IMAGE_ASPECT_RATIO_SQUARE", shortLabel: "1:1", label: "1:1 方图", ratio: "1:1" },
  {
    value: "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE",
    shortLabel: "4:3",
    label: "4:3 横幅",
    ratio: "4:3",
  },
  {
    value: "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR",
    shortLabel: "3:4",
    label: "3:4 竖幅",
    ratio: "3:4",
  },
];

export const VIDEO_ASPECT_OPTIONS: readonly AspectOption[] = [
  { value: "VIDEO_ASPECT_RATIO_LANDSCAPE", shortLabel: "16:9", label: "16:9 横屏", ratio: "16:9" },
  { value: "VIDEO_ASPECT_RATIO_PORTRAIT", shortLabel: "9:16", label: "9:16 竖屏", ratio: "9:16" },
];

export interface ResolutionOption<T extends string> {
  value: T;
  label: string;
  badge: string;
  hint: string;
  omniOnly?: boolean;
}

export const IMAGE_RESOLUTION_OPTIONS: readonly ResolutionOption<ImageResolutionKey>[] = [
  { value: "1K", label: "1K 标准", badge: "原生直出", hint: "极速直出，适合快速预览与多连抽" },
  { value: "2K", label: "2K 高清", badge: "SPrCad 精修", hint: "生成后自动 2K 高清重塑（Free 可用）" },
  { value: "4K", label: "4K 超清", badge: "Ultra 专属", hint: "生成后自动 4K 超清重塑（需 Ultra，失败自动保留原图）" },
];

export const VIDEO_RESOLUTION_OPTIONS: readonly ResolutionOption<VideoResolutionKey>[] = [
  {
    value: "360p",
    label: "360p",
    badge: "Omni 低分草稿",
    hint: "Omni 专属低成本草稿（1–10秒 1积分/秒，11–15秒超出部分 2积分/秒，约为 720p 的 1/3）",
    omniOnly: true,
  },
  {
    value: "720p",
    label: "720p",
    badge: "标准原生",
    hint: "Flow 默认原生输出清晰度（Omni 1–10秒 3积分/秒，11–15秒超出部分 6积分/秒）",
  },
  {
    value: "1080p",
    label: "1080p",
    badge: "Plus/Pro/Ultra 超分",
    hint: "720p 成片后自动调用官方 1080p 超分（1–10秒 0 附加分；11–15秒超出10秒部分 +1积分/秒）",
  },
  {
    value: "4k",
    label: "4K",
    badge: "Ultra 专属 +50分起",
    hint: "720p 成片后自动调用官方 4K 超分（需 Ultra：1–10秒 +50积分/条，超过10秒每多1秒 +5积分）",
  },
];

export const OUTPUT_COUNT_OPTIONS = [1, 2, 3, 4] as const;

export const OMNI_1_2_DURATIONS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
export const OMNI_1_1_DURATIONS = [4, 6, 8, 10] as const;

export const IMAGE_THINKING_OPTIONS: ReadonlyArray<{
  value: ImageThinkingLevel;
  label: string;
  hint: string;
}> = [
  { value: "default", label: "标准", hint: "默认推理平衡速度与精度" },
  { value: "low", label: "低", hint: "快速遵循提示词字面描述" },
  { value: "medium", label: "中", hint: "加强构图与细节推敲" },
  { value: "high", label: "高", hint: "复杂多元素关系深度规划" },
];

export const CHINESE_PROMPT_PRESETS: ReadonlyArray<{ label: string; snippet: string }> = [
  { label: "电影级光影", snippet: "电影级体积光与柔焦景深，高动态范围光影过渡，35mm 胶片颗粒质感" },
  { label: "人物外貌锁定", snippet: "保持角色面部五官、发型、服饰材质与配饰细节与参考图完全一致" },
  { label: "电商质感精修", snippet: "商业影棚主光配合细腻高光轮廓光，材质纹理清晰锐利，干净高级背景" },
  { label: "自然运镜过渡", snippet: "镜头平稳推进，主体动作流畅自然，背景环境具有真实物理景深视差" },
  { label: "中式国风美学", snippet: "新中式光影构图，青砖黛瓦与薄雾氛围，东方审美柔和色调与细腻意境" },
  { label: "九宫格多视角", snippet: "紧凑无缝九宫格分镜网格，无白边无文字水印，涵盖特写、中景与广角全景" },
];

export function resolveVideoSelectionId(
  videoModel: VideoModelFamily,
  omniVersion: OmniFlashVersion,
  videoQuality: VideoQuality,
): VideoModelCatalogEntry["id"] {
  if (videoModel === "omni_flash") {
    return omniVersion === "1.2" ? "omni_1_2_flash" : "omni_1_1_flash";
  }
  if (videoQuality === "lite") return "veo_3_1_lite";
  if (videoQuality === "quality") return "veo_3_1_quality";
  if (videoQuality === "lite_relaxed") return "veo_3_1_lite_relaxed";
  return "veo_3_1_fast";
}

export function findVideoModelEntry(
  id: VideoModelCatalogEntry["id"],
): VideoModelCatalogEntry {
  return (
    VIDEO_MODEL_CATALOG.find((m) => m.id === id) ?? VIDEO_MODEL_CATALOG[2]
  );
}

export function findImageModelEntry(
  id: string | undefined,
): ImageModelCatalogEntry {
  return (
    IMAGE_MODEL_CATALOG.find((m) => m.id === id) ?? IMAGE_MODEL_CATALOG[0]
  );
}

// ── Flow 官方积分消耗表（严格同步 Google Flow 官方积分帮助文档）────────────────
// Omni 1.2 Flash 720p：1–10秒 3积分/秒；11–15秒超出10秒部分 6积分/秒
export const OMNI_1_2_CREDIT_COST: Readonly<Record<number, number>> = {
  3: 9,
  4: 12,
  5: 15,
  6: 18,
  7: 21,
  8: 24,
  9: 27,
  10: 30,
  11: 36,
  12: 42,
  13: 48,
  14: 54,
  15: 60,
};

// Omni 1.2 Flash 360p：1–10秒 1积分/秒；11–15秒超出10秒部分 2积分/秒（约为 720p 的 1/3）
export const OMNI_1_2_CREDIT_COST_360P: Readonly<Record<number, number>> = {
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 12,
  12: 14,
  13: 16,
  14: 18,
  15: 20,
};

export const OMNI_1_1_CREDIT_COST: Readonly<Record<number, number>> = {
  4: 15,
  6: 20,
  8: 25,
  10: 30,
};

export const OMNI_1_1_CREDIT_COST_360P: Readonly<Record<number, number>> = {
  4: 4,
  6: 5,
  8: 6,
  10: 7,
};

/** 计算 Omni Flash 基础生成单条积分（1080p/4K 先出 720p 底片，故基础档按 720p 计费）。 */
export function estimateOmniBaseCreditCost(
  version: OmniFlashVersion,
  durationSeconds: number,
  resolution: VideoResolutionKey = "720p",
): number {
  const dur = Math.max(3, Math.min(15, Math.round(durationSeconds || 8)));
  const is360p = resolution === "360p";
  if (version === "1.2") {
    if (is360p) {
      return (
        OMNI_1_2_CREDIT_COST_360P[dur] ??
        (dur <= 10 ? dur : 10 + (dur - 10) * 2)
      );
    }
    return (
      OMNI_1_2_CREDIT_COST[dur] ??
      (dur <= 10 ? dur * 3 : 30 + (dur - 10) * 6)
    );
  }
  if (is360p) {
    return OMNI_1_1_CREDIT_COST_360P[dur] ?? 6;
  }
  return OMNI_1_1_CREDIT_COST[dur] ?? 25;
}

/** 计算视频超分重塑（UPSAMPLE_VIDEO）单条附加积分，严格匹配 Google Flow 官方规则：
 * - 1080p（Plus/Pro/Ultra）：1–10 秒 0 积分；超出 10 秒部分 +1 积分/秒
 * - 4K（仅 Ultra）：1–10 秒固定 +50 积分；超出 10 秒部分 +5 积分/秒 */
export function estimateVideoUpscaleCreditCost(
  resolution: VideoResolutionKey | "1080p" | "4K" | "4k",
  durationSeconds = 8,
): number {
  const norm = String(resolution || "720p").trim().toLowerCase();
  const dur = Math.max(1, Math.round(durationSeconds || 8));
  const extraOver10 = Math.max(0, dur - 10);
  if (norm === "1080p") {
    return extraOver10;
  }
  if (norm === "4k") {
    return 50 + extraOver10 * 5;
  }
  return 0;
}

export interface CreditEstimate {
  perUnit: number;
  perUnitMax?: number;
  count: number;
  total: number;
  totalMax?: number;
  isZero: boolean;
  /** 简短胶囊展示文案，例如 "消耗 10 积分" / "消耗 5~10 积分" / "消耗 0 积分" */
  displayText: string;
  /** 详细分解文案，供 Hover 提示或设置页说明 */
  breakdown: string;
}

export function estimateImageCreditCost(params: {
  imageModel: ImageModelKey;
  imageResolution: ImageResolutionKey;
  count?: number;
}): CreditEstimate {
  const safeCount = Math.max(1, Math.round(params.count ?? 1));
  const modelEntry = findImageModelEntry(params.imageModel);
  const resNote =
    params.imageResolution === "4K"
      ? "4K 超清重塑（需 Ultra 订阅额度 · 0 额外积分）"
      : params.imageResolution === "2K"
        ? "2K 高清重塑（0 额外积分）"
        : "1K 原生直出";
  return {
    perUnit: 0,
    count: safeCount,
    total: 0,
    isZero: true,
    displayText: "消耗 0 积分",
    breakdown: `${modelEntry.label} × ${safeCount} 张 · ${resNote} · 计入每日免费生成额度（不扣 Flow 积分）`,
  };
}

export function estimateVideoCreditCost(params: {
  videoModel: VideoModelFamily;
  omniVersion?: OmniFlashVersion;
  videoQuality?: VideoQuality;
  durationSeconds?: number;
  videoResolution?: VideoResolutionKey;
  count?: number;
  paygateTier?: string | null;
}): CreditEstimate {
  const safeCount = Math.max(1, Math.round(params.count ?? 1));
  const rawRes = params.videoResolution ?? "720p";
  const res: VideoResolutionKey =
    params.videoModel !== "omni_flash" && rawRes === "360p" ? "720p" : rawRes;
  const effectiveDur =
    params.videoModel === "omni_flash" ? (params.durationSeconds ?? 8) : 8;
  const upscalePerUnit = estimateVideoUpscaleCreditCost(res, effectiveDur);
  const resNote =
    res === "4k"
      ? `4K 超分（需 Ultra · +${upscalePerUnit} 积分/条）`
      : res === "1080p"
        ? upscalePerUnit > 0
          ? `1080p 超分（Plus/Pro/Ultra · +${upscalePerUnit} 积分/条）`
          : "1080p 超分（Plus/Pro/Ultra · 1–10秒 0 附加分）"
        : res === "360p"
          ? "360p 草稿（约为 720p 的 1/3）"
          : "720p 原生";

  if (params.videoModel === "omni_flash") {
    const ver = params.omniVersion ?? "1.2";
    const dur = effectiveDur;
    const basePerUnit = estimateOmniBaseCreditCost(ver, dur, res);
    const perUnit = basePerUnit + upscalePerUnit;
    const total = perUnit * safeCount;
    const baseLabel = res === "360p" ? "360p" : "720p";
    const detailFormula =
      upscalePerUnit > 0
        ? `${baseLabel} ${basePerUnit} + ${res.toUpperCase()}超分 ${upscalePerUnit} = ${perUnit} 积分/条`
        : `${baseLabel} ${perUnit} 积分/条`;
    return {
      perUnit,
      count: safeCount,
      total,
      isZero: total === 0,
      displayText: `消耗 ${total} 积分`,
      breakdown: `Omni ${ver} Flash · ${dur}秒 (${detailFormula}) × ${safeCount} 条 · ${resNote}`,
    };
  }

  const q = params.videoQuality ?? "lite";
  if (q === "lite_relaxed") {
    const perUnit = upscalePerUnit;
    const total = perUnit * safeCount;
    const tierWarn =
      params.paygateTier === "PAYGATE_TIER_ONE"
        ? "（当前账号为 Pro 档，此通道仅限 Ultra 账号使用）"
        : "（Ultra 专属零积分低优队列）";
    const costPart =
      upscalePerUnit > 0
        ? `底片 0 + ${res.toUpperCase()}超分 ${upscalePerUnit} = ${perUnit} 积分/条`
        : "0 积分/条";
    return {
      perUnit,
      count: safeCount,
      total,
      isZero: total === 0,
      displayText: `消耗 ${total} 积分`,
      breakdown: `Veo 3.1 - Lite [Lower Priority] · 8秒 (${costPart}) × ${safeCount} 条 · ${resNote} ${tierWarn}`,
    };
  }

  // 官方标准费率（Veo 3.1 Quality 对所有会员均为 100 积分/条；Lite 为 Ultra 5 / 其他 10；Fast 为 Ultra 10 / 其他 20）
  const rates: Record<"lite" | "fast" | "quality", [number, number]> = {
    lite: [5, 10],
    fast: [10, 20],
    quality: [100, 100],
  };
  const [ultraBase, proBase] = rates[q === "quality" ? "quality" : q === "fast" ? "fast" : "lite"];
  const ultraRate = ultraBase + upscalePerUnit;
  const proRate = proBase + upscalePerUnit;
  const modelLabel =
    q === "quality"
      ? "Veo 3.1 - Quality"
      : q === "fast"
        ? "Veo 3.1 - Fast"
        : "Veo 3.1 - Lite";

  if (params.paygateTier === "PAYGATE_TIER_TWO") {
    const total = ultraRate * safeCount;
    const detail =
      upscalePerUnit > 0
        ? `Ultra 档 底片 ${ultraBase} + ${res.toUpperCase()}超分 ${upscalePerUnit} = ${ultraRate} 积分/条`
        : `Ultra 档 ${ultraRate} 积分/条`;
    return {
      perUnit: ultraRate,
      count: safeCount,
      total,
      isZero: false,
      displayText: `消耗 ${total} 积分`,
      breakdown: `${modelLabel} · ${detail} × ${safeCount} 条 · 8秒 · ${resNote}`,
    };
  }

  if (params.paygateTier === "PAYGATE_TIER_ONE") {
    const total = proRate * safeCount;
    const detail =
      upscalePerUnit > 0
        ? `Pro 档 底片 ${proBase} + ${res.toUpperCase()}超分 ${upscalePerUnit} = ${proRate} 积分/条`
        : `Pro 档 ${proRate} 积分/条`;
    return {
      perUnit: proRate,
      count: safeCount,
      total,
      isZero: false,
      displayText: `消耗 ${total} 积分`,
      breakdown: `${modelLabel} · ${detail} × ${safeCount} 条 · 8秒 · ${resNote}`,
    };
  }

  const totalMin = ultraRate * safeCount;
  const totalMax = proRate * safeCount;
  if (totalMin === totalMax) {
    return {
      perUnit: ultraRate,
      count: safeCount,
      total: totalMin,
      isZero: false,
      displayText: `消耗 ${totalMin} 积分`,
      breakdown: `${modelLabel} · 全档位 ${ultraRate} 积分/条 × ${safeCount} 条 · 8秒 · ${resNote}`,
    };
  }
  return {
    perUnit: ultraRate,
    perUnitMax: proRate,
    count: safeCount,
    total: totalMin,
    totalMax,
    isZero: false,
    displayText: `消耗 ${totalMin}~${totalMax} 积分`,
    breakdown: `${modelLabel} · Ultra ${ultraRate} / Pro ${proRate} 积分/条 × ${safeCount} 条 · 8秒 · ${resNote}（连接账号并同步积分后显示精确档位）`,
  };
}

// ── Google Flow Music (Lyria 3.5 / 3 Pro · 个人独立音乐积分) ──────────────────

export interface MusicModelCatalogEntry {
  id: string;
  label: string;
  badge: string;
  creditCost: number;
  summary: string;
}

export const MUSIC_MODEL_CATALOG: readonly MusicModelCatalogEntry[] = [
  {
    id: "Lyria 3.5",
    label: "Lyria 3.5",
    badge: "旗舰推荐",
    creditCost: 5,
    summary: "最新一代音乐模型，旋律自然、人声咬字与时长/BPM 控制最佳（最长 3 分钟）",
  },
  {
    id: "Lyria 3 Pro",
    label: "Lyria 3 Pro",
    badge: "经典专业版",
    creditCost: 5,
    summary: "经典完整编曲模型，适合对照抽卡或特定复古曲风风格",
  },
] as const;

export const MUSIC_DURATION_PRESETS = [
  { seconds: 60, label: "60 秒" },
  { seconds: 90, label: "90 秒" },
  { seconds: 120, label: "2 分钟" },
  { seconds: 180, label: "3 分钟" },
] as const;

export const MUSIC_STEM_META: Record<string, { label: string; icon: string }> = {
  vocals: { label: "人声轨", icon: "🎤" },
  drums: { label: "鼓点节奏", icon: "🥁" },
  bass: { label: "贝斯低音", icon: "🎸" },
  other: { label: "纯伴奏 / 旋律", icon: "🎹" },
};

export function estimateMusicCreditCost(
  kind: "gen_music" | "edit_music" | "split_stems" | "effect_music" | "lyrics",
): CreditEstimate {
  if (kind === "split_stems") {
    return {
      perUnit: 0,
      count: 1,
      total: 0,
      isZero: true,
      displayText: "0 音乐积分",
      breakdown: "Flow Music 四轨分轨（人声/鼓/贝斯/伴奏）消耗 0 积分",
    };
  }
  if (kind === "effect_music" || kind === "lyrics") {
    return {
      perUnit: 0,
      count: 1,
      total: 0,
      isZero: true,
      displayText: "0 音乐积分",
      breakdown: "Flow Music 裁剪变速与 AI 作词消耗 0 积分",
    };
  }
  const label = kind === "edit_music" ? "音乐衍生编辑（续写/翻唱/替换）" : "Flow Music 完整歌曲/配乐";
  return {
    perUnit: 5,
    count: 1,
    total: 5,
    isZero: false,
    displayText: "消耗 5 音乐积分",
    breakdown: `${label} · 从账号独立 Flow Music 积分池扣除，不消耗视频积分`,
  };
}
