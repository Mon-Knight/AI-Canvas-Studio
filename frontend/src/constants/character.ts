import { create } from "zustand";

// 角色主体预设字典 —— 保留旧版枚举导出以兼容已保存节点的 ResultViewer 元数据胶囊展示；
// 同时提供对齐即梦官方「主体」能力的官方推荐模板库（支持二次元动漫、3D/游戏、真人影视、萌宠道具）与自定义模板持久化。

export const CHARACTER_GENDERS = [
  { key: "female", label: "女", tag: "female", zhTag: "女性" },
  { key: "male", label: "男", tag: "male", zhTag: "男性" },
] as const;

export const CHARACTER_COUNTRIES = [
  { key: "cn", label: "中国", tag: "Chinese", zhTag: "中国籍" },
  { key: "kr", label: "韩国", tag: "Korean", zhTag: "韩国籍" },
  { key: "jp", label: "日本", tag: "Japanese", zhTag: "日本籍" },
  { key: "vn", label: "越南", tag: "Vietnamese", zhTag: "越南籍" },
  { key: "th", label: "泰国", tag: "Thai", zhTag: "泰国籍" },
  { key: "us", label: "美国", tag: "American", zhTag: "美国籍" },
  { key: "fr", label: "法国", tag: "French", zhTag: "法国籍" },
] as const;

export const CHARACTER_VIBES = [
  {
    key: "clean",
    label: "清透水光",
    tokens: [
      "Clean Girl makeup styling, fresh dewy skin with sheer skin-tint coverage, healthy natural radiance, peachy cream blush on the cheek apples",
      "brushed-up laminated brows with clear brow gel finish, minimal eye makeup, glossy plump lips with lip-oil sheen",
      "slicked-back low bun or polished sleek hair, simple modern minimalist outfit, delicate gold hoop earrings",
      "relaxed friendly expression with a gentle subtle smile, soft natural gaze, soft natural daylight, airy bright tone, clean minimalist backdrop",
    ],
    zhTokens: [
      "清透水光裸妆造型，肤质鲜活透亮带有健康自然光泽，苹果肌点缀蜜桃色奶油腮红",
      "自然野生立挺眉形与淡雅眼妆，水润饱满玻璃唇感",
      "整洁贴服低发髻或顺滑长发，简约现代极简穿搭，精致细小金色圆环耳饰",
      "轻松亲和的微表情与温和目光，柔和自然日光、通透洁净的极简浅色背景",
    ],
  },
  {
    key: "douyin",
    label: "抖音氛围",
    tokens: [
      "Douyin makeup styling, porcelain-smooth flawless complexion, glossy ethereal skin with subtle pearl glow",
      "shimmery glittery eyeshadow with light-catching pearl highlights, defined aegyo sal under-eye accent, individual cluster false lashes",
      "blurred-edge gradient lip in soft berry or muted red tone with diffused outline, delicate styled hair with face-framing strands, refined feminine outfit",
      "soft alluring expression with a composed sultry gaze, soft beauty lighting with subtle ethereal glow, clean pale studio backdrop, dreamy atmosphere",
    ],
    zhTokens: [
      "精致网感氛围妆容，瓷感细腻透亮底妆泛着柔和珠光光泽",
      "眼影带有细闪高光，卧蚕立体提亮配合自然单簇假睫毛",
      "柔雾渐变浆果红晕染唇妆，修饰脸型的蓬松碎发与精致穿搭",
      "温柔笃定的眼神镜头感，柔美棚拍美颜光线配合梦幻干净的浅色摄影棚背景",
    ],
  },
  {
    key: "oldmoney",
    label: "老钱风范",
    tokens: [
      "Old Money makeup styling, polished neutral palette in earth tones (taupe, nude, soft coral), matte refined skin finish",
      "softly contoured eyes with warm matte brown shadow, groomed defined brows, classic red or elegant nude-pink lip",
      "polished sleek hair, timeless tailored outfit, understated gold or pearl jewelry",
      "composed dignified expression with a calm refined gaze, soft directional studio lighting, warm neutral backdrop, timeless heritage atmosphere",
    ],
    zhTokens: [
      "老钱静奢质感妆造，大地灰棕与柔和珊瑚裸色调，哑光高级雾面肌理",
      "暖棕消肿轮廓眼妆与利落眉型，经典优雅红唇或气质裸粉唇色",
      "柔顺光泽发型与经典剪裁精良服饰，克制的金色或珍珠配饰",
      "从容端庄的沉稳神态与克制眼神，柔和侧逆光影棚光效配合温暖中性背景，营造复古传承感",
    ],
  },
  {
    key: "coldgirl",
    label: "清冷高智",
    tokens: [
      "Cool-tone makeup styling, ash-pink, mauve and cool grey-brown palette, matte velvety skin finish",
      "cool-toned smoky eye, ash-pink blush, soft mauve lip, subtle high-point highlight on cheekbones, brow bone and cupid's bow",
      "sleek modern hair, edgy contemporary outfit, minimalist silver accessories",
      "cool composed expression with a confident detached gaze, cool-toned cinematic lighting, muted soft blue-grey backdrop, modern moody atmosphere",
    ],
    zhTokens: [
      "清冷高智冷调妆容，灰粉、干枯玫瑰紫与冷灰棕色系搭配丝绒雾面底妆",
      "冷调轻烟熏眼妆与灰粉腮红，颧骨与眉弓点缀清透水光高光，柔和豆沙玫瑰唇",
      "干练利落现代发型与冷峻先锋极简穿搭，搭配纤细银质饰品",
      "疏离沉静的冷艳气质与自信目光，冷调电影质感布光配合低饱和蓝灰渐变背景",
    ],
  },
  {
    key: "kpop",
    label: "韩系偶像",
    tokens: [
      "K-pop idol styling, glossy plump lips, soft sculpted contour, glittery inner-corner highlight, dewy skin",
      "glossy hair with face-framing layers, trendy stylish outfit, delicate accessories",
      "soft confident expression, gentle closed-lip smile",
      "soft beauty lighting, clean studio glow, smooth pastel backdrop",
    ],
    zhTokens: [
      "韩系舞台偶像妆造，饱满水光嫩唇与立体修容，眼头细闪提亮配水光底妆",
      "层次感空气刘海或修饰脸型光泽发丝，时尚利落打歌风穿搭与精致小配饰",
      "自信灵动神态，自然含蓄的闭唇微笑",
      "明亮柔和棚拍光效，干净通透的柔粉浅色背景",
    ],
  },
  {
    key: "casual",
    label: "日常松弛",
    tokens: [
      "minimal natural styling, fresh clear skin, soft tinted lips",
      "relaxed natural hair, simple everyday outfit",
      "warm friendly soft smile, gentle natural gaze",
      "soft natural daylight, airy bright tone, clean light backdrop",
    ],
    zhTokens: [
      "极简日常素颜感妆容，清新透明肌理与自然润色双唇",
      "自然随性微卷或直发，舒适简约日常休闲穿搭",
      "温暖松弛的浅浅微笑，真诚松弛的自然注视",
      "柔和清晨自然窗光，通透明亮色调配合洁净浅色实景背景",
    ],
  },
] as const;

export type GenderKey = (typeof CHARACTER_GENDERS)[number]["key"];
export type CountryKey = (typeof CHARACTER_COUNTRIES)[number]["key"];
export type VibeKey = (typeof CHARACTER_VIBES)[number]["key"];

export function countryLabel(key: string | undefined): string | null {
  if (!key) return null;
  return CHARACTER_COUNTRIES.find((c) => c.key === key)?.label ?? null;
}

export function vibeLabel(key: string | undefined): string | null {
  if (!key) return null;
  return CHARACTER_VIBES.find((v) => v.key === key)?.label ?? null;
}

// ── 官方主体推荐模板 & 自定义主体模板体系 ─────────────────────────────────────

export type SubjectTemplateCategory =
  | "all"
  | "anime"
  | "3d_game"
  | "realistic"
  | "creature_prop";

export const SUBJECT_TEMPLATE_CATEGORIES: ReadonlyArray<{
  key: SubjectTemplateCategory;
  label: string;
}> = [
  { key: "all", label: "全部" },
  { key: "anime", label: "动漫二次元" },
  { key: "3d_game", label: "3D·游戏奇幻" },
  { key: "realistic", label: "真人影视" },
  { key: "creature_prop", label: "萌宠·道具" },
];

export interface OfficialSubjectTemplate {
  id: string;
  category: Exclude<SubjectTemplateCategory, "all">;
  title: string;
  badge: string;
  summary: string;
  prompt: string;
  recommendedAspect?:
    | "IMAGE_ASPECT_RATIO_SQUARE"
    | "IMAGE_ASPECT_RATIO_PORTRAIT"
    | "IMAGE_ASPECT_RATIO_LANDSCAPE";
}

export const OFFICIAL_SUBJECT_TEMPLATES: ReadonlyArray<OfficialSubjectTemplate> = [
  {
    id: "anime-extract",
    category: "anime",
    title: "参考图动漫主体提纯",
    badge: "去字提纯",
    summary: "连线动漫/插画参考图，去除文字杂物并高保真还原角色设定",
    prompt:
      "基于参考图高度还原该动漫角色主体，严格保留原画风、线条与赛璐璐上色质感、发色瞳色及全部标志性服饰头饰配件，去除画面中的一切文字、字幕、水印与杂乱背景，将角色完整置于干净纯色背景中央，生成高清晰标准角色主体设定图",
    recommendedAspect: "IMAGE_ASPECT_RATIO_SQUARE",
  },
  {
    id: "anime-stand",
    category: "anime",
    title: "日系二次元标准立绘",
    badge: "动漫立绘",
    summary: "赛璐璐清透上色 + 干净纯底，适合番剧/漫剧角色锚定",
    prompt:
      "日系二次元动画角色标准设定立绘，精细干净线稿配清透赛璐璐动画上色，正面全身站姿居中完整入画，五官神态、标志性发型瞳色与服饰配件细节清晰鲜明，干净纯色背景无文字水印，适合下游多镜头保持画风与角色高度一致",
    recommendedAspect: "IMAGE_ASPECT_RATIO_PORTRAIT",
  },
  {
    id: "anime-turnaround",
    category: "anime",
    title: "二次元角色三视图",
    badge: "三视图",
    summary: "正/侧/背同屏等高设定稿，全方位锁定角色服饰与造型",
    prompt:
      "日系二次元角色标准三视图设定稿，同一角色正面、侧面、背面全身站姿在同一画面并排等高展示，严格统一头身比例、发色瞳色、服饰剪裁与随身配饰细节，赛璐璐清透动画上色，干净浅色纯底背景无多余文字标注",
    recommendedAspect: "IMAGE_ASPECT_RATIO_LANDSCAPE",
  },
  {
    id: "guoman-3d",
    category: "3d_game",
    title: "国漫 3D CG 角色",
    badge: "3D 国漫",
    summary: "次世代高精度建模质感，适合 3D 漫剧与玄幻动画主角",
    prompt:
      "高精度国漫 3D CG 角色主体设定图，次世代精细建模与柔和次表面散射材质，立体精致五官、灵动发丝与华丽服饰刺绣纹理清晰锐利，柔和影棚体积光勾勒轮廓，干净纯色背景，适合连续动画镜头复用",
    recommendedAspect: "IMAGE_ASPECT_RATIO_PORTRAIT",
  },
  {
    id: "chibi-ip",
    category: "3d_game",
    title: "Q版潮玩 / 吉祥物 IP",
    badge: "潮玩手办",
    summary: "二头身盲盒 PVC 质感，适合品牌 IP 与可爱动画角色",
    prompt:
      "盲盒潮玩手办风格 Q 版角色主体，二头身圆润讨喜比例，细腻 PVC 哑光与局部高光复合材质，标志性配色、神态与随身小道具清晰完整，柔和棚拍立体布光配干净纯色背景",
    recommendedAspect: "IMAGE_ASPECT_RATIO_SQUARE",
  },
  {
    id: "fantasy-concept",
    category: "3d_game",
    title: "奇幻游戏原画角色",
    badge: "概念原画",
    summary: "支持帽子/眼镜/盔甲/武器等完整装备设定，不强制去遮挡",
    prompt:
      "奇幻游戏概念原画角色主体立绘，高级厚涂光影质感与高辨识度剪影设计，完整保留巫师帽、眼镜、兜帽、头饰、披风或随身武器等标志性装备细节，全身居中标准构图，简洁中性纯底背景",
    recommendedAspect: "IMAGE_ASPECT_RATIO_PORTRAIT",
  },
  {
    id: "cinema-portrait",
    category: "realistic",
    title: "影视写实人物定妆",
    badge: "锁脸定妆",
    summary: "电影级标准正脸平视定妆照，适合短剧与真人多镜头锁脸",
    prompt:
      "电影级写实人物标准定妆照，人物正面平视镜头、神态自然沉稳，真实肌肤纹理与发丝细节清晰锐利，简约纯色影棚背景配柔和均匀主光，适合下游多镜头生图与图生视频稳定锁定人物外貌",
    recommendedAspect: "IMAGE_ASPECT_RATIO_SQUARE",
  },
  {
    id: "clean-modern",
    category: "realistic",
    title: "清透都市时尚模特",
    badge: "都市人像",
    summary: "清透自然妆造 + 现代极简穿搭，适合电商与生活流短片",
    prompt:
      "现代都市清透水光质感人物主体，自然通透肤质与温和亲切微表情，简约高级现代穿搭与精致小配饰，柔和自然日光与通透洁净浅色背景，高辨识度真实人像主体",
    recommendedAspect: "IMAGE_ASPECT_RATIO_SQUARE",
  },
  {
    id: "ancient-wuxia",
    category: "realistic",
    title: "东方古风侠客主体",
    badge: "国风古装",
    summary: "汉服武侠衣袂与发冠细节考究，适合古装短剧角色设定",
    prompt:
      "东方古风影视角色主体定妆照，衣袂层次分明的汉服或武侠服饰材质考究，发髻冠饰精致，神态清冷从容，东方素雅净底背景与柔和电影侧逆光",
    recommendedAspect: "IMAGE_ASPECT_RATIO_PORTRAIT",
  },
  {
    id: "cute-creature",
    category: "creature_prop",
    title: "灵动萌宠 / 幻想生物",
    badge: "动物萌宠",
    summary: "锁定毛发花色与特征神态，支持真实宠物或奇幻神兽",
    prompt:
      "高细节萌宠或幻想生物主体标准设定图，毛发绒感、花色斑纹与灵动眼神清晰鲜明，全身自然姿态完整居中入画，干净柔和纯色背景，便于跨场景动作与互动延展",
    recommendedAspect: "IMAGE_ASPECT_RATIO_SQUARE",
  },
  {
    id: "hero-prop",
    category: "creature_prop",
    title: "核心道具 / 载具主体",
    badge: "道具锚点",
    summary: "四分之三立体结构展示，方便下游角色持握或跨镜头复用",
    prompt:
      "核心道具、法器或产品标准主体参考图，四分之三立体视角完整呈现结构造型，金属、玻璃、织物等材质肌理与高光反射准确，干净无杂物纯色背景，便于下游角色持握或场景合成",
    recommendedAspect: "IMAGE_ASPECT_RATIO_SQUARE",
  },
];

export interface CustomSubjectTemplate {
  id: string;
  title: string;
  prompt: string;
  createdAt: string;
}

const CUSTOM_SUBJECT_TEMPLATES_KEY = "flowboard.customSubjectTemplates.v1";
const MAX_CUSTOM_TEMPLATES = 50;

export function loadCustomSubjectTemplates(): CustomSubjectTemplate[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(CUSTOM_SUBJECT_TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is CustomSubjectTemplate =>
          item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.title === "string" &&
          typeof item.prompt === "string" &&
          item.title.trim().length > 0 &&
          item.prompt.trim().length > 0,
      )
      .slice(0, MAX_CUSTOM_TEMPLATES);
  } catch {
    return [];
  }
}

function persistCustomSubjectTemplates(list: CustomSubjectTemplate[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(CUSTOM_SUBJECT_TEMPLATES_KEY, JSON.stringify(list.slice(0, MAX_CUSTOM_TEMPLATES)));
  } catch {
    // Ignore storage quota or SSR environment errors
  }
}

interface SubjectTemplatesState {
  customTemplates: CustomSubjectTemplate[];
  addCustomTemplate(title: string, prompt: string): CustomSubjectTemplate | null;
  updateCustomTemplate(id: string, title: string, prompt: string): boolean;
  removeCustomTemplate(id: string): void;
}

export const useSubjectTemplatesStore = create<SubjectTemplatesState>((set, get) => ({
  customTemplates: loadCustomSubjectTemplates(),

  addCustomTemplate(title: string, prompt: string) {
    const cleanTitle = title.trim().slice(0, 40);
    const cleanPrompt = prompt.trim().slice(0, 2000);
    if (!cleanTitle || !cleanPrompt) return null;
    const entry: CustomSubjectTemplate = {
      id: `tpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title: cleanTitle,
      prompt: cleanPrompt,
      createdAt: new Date().toISOString(),
    };
    const next = [entry, ...get().customTemplates].slice(0, MAX_CUSTOM_TEMPLATES);
    persistCustomSubjectTemplates(next);
    set({ customTemplates: next });
    return entry;
  },

  updateCustomTemplate(id: string, title: string, prompt: string) {
    const cleanTitle = title.trim().slice(0, 40);
    const cleanPrompt = prompt.trim().slice(0, 2000);
    if (!cleanTitle || !cleanPrompt) return false;
    const existing = get().customTemplates;
    if (!existing.some((t) => t.id === id)) return false;
    const next = existing.map((t) =>
      t.id === id ? { ...t, title: cleanTitle, prompt: cleanPrompt } : t,
    );
    persistCustomSubjectTemplates(next);
    set({ customTemplates: next });
    return true;
  },

  removeCustomTemplate(id: string) {
    const next = get().customTemplates.filter((t) => t.id !== id);
    persistCustomSubjectTemplates(next);
    set({ customTemplates: next });
  },
}));

/**
 * 智能套用主体模板提示词：
 * - 若当前提示词为空，或与上一次套用的纯模板文本完全一致，则直接替换为新模板（方便连续点选对比不同模板）；
 * - 若用户已手写主体特征（如「银发红瞳小魔女戴尖顶帽」），则将模板设定框架与用户手写特征自然融合，不覆盖用户心血。
 */
export function applySubjectTemplateText(
  currentPrompt: string,
  templatePrompt: string,
  lastAppliedTemplatePrompt: string | null,
  maxLength = 2000,
): string {
  const trimmedCurrent = currentPrompt.trim();
  const trimmedTemplate = templatePrompt.trim();
  if (!trimmedTemplate) return currentPrompt;
  if (!trimmedCurrent || trimmedCurrent === (lastAppliedTemplatePrompt ?? "").trim()) {
    return trimmedTemplate.slice(0, maxLength);
  }
  if (trimmedCurrent.includes(trimmedTemplate)) {
    return trimmedCurrent.slice(0, maxLength);
  }
  const sep = /[，。；,.;!！?？]$/.test(trimmedTemplate) ? "" : "，";
  return `${trimmedTemplate}${sep}主体具体特征：${trimmedCurrent}`.slice(0, maxLength);
}
