// 角色主体预设字典 —— 供 GenerationDialog（支持简体中文 zhTag/zhTokens 与英文兼容拼装）
// 与 ResultViewer（使用 label 展示中文元数据胶囊）共享。
// 注意：key 与 tag/tokens 必须保持稳定，以确保已保存节点兼容；新增 zhTag / zhTokens 用于中文提示词生成。

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
