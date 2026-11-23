import type { NodeType } from "../api/client";

export interface RecipeNodeSpec {
  key: string;
  type: NodeType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  status?: "idle" | "done";
  data: Record<string, unknown>;
}

export interface RecipeEdgeSpec {
  source_key: string;
  target_key: string;
  source_variant_idx?: number | null;
}

export interface StarterRecipe {
  id: string;
  title: string;
  badge: string;
  summary: string;
  boardName: string;
  nodes: RecipeNodeSpec[];
  edges: RecipeEdgeSpec[];
}

export const STARTER_RECIPES: ReadonlyArray<StarterRecipe> = [
  {
    id: "anime-series",
    title: "番剧角色锁脸与多镜续拍",
    badge: "动漫漫剧",
    summary: "主体三视图 → 2×2 四宫格故事板 → Omni 镜头一 → 尾帧续接镜头二",
    boardName: "示例·番剧角色锁脸与续拍",
    nodes: [
      {
        key: "guide",
        type: "note",
        x: 40,
        y: 20,
        w: 300,
        h: 150,
        status: "done",
        data: {
          title: "新手指引 · 番剧连贯工作流",
          prompt:
            "1. 先点击【主角三视图】生成角色设定图锁定画风与服装；\n" +
            "2. 选中【四宫格故事板】一键拆出 4 格连续镜头；\n" +
            "3. 沿连线生成【镜头一】与【镜头二】（支持自动截取尾帧续拍）。",
        },
      },
      {
        key: "subj",
        type: "character",
        x: 40,
        y: 210,
        w: 256,
        h: 196,
        status: "idle",
        data: {
          title: "主角三视图",
          aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
          imageModel: "GEM_PIX_2",
          imageResolution: "2K",
          variantCount: 1,
          prompt:
            "日系二次元角色标准三视图设定稿，银发青瞳、身着深海青蓝机能风斗篷与短靴的少年魔导士，" +
            "同一角色正面、侧面、背面全身站姿并排等高展示，严格统一头身比例、服饰剪裁与肩部纹章细节，" +
            "清透赛璐璐动画上色配干净纯浅灰背景，无任何多余文字标注",
        },
      },
      {
        key: "sb",
        type: "Storyboard",
        x: 380,
        y: 210,
        w: 256,
        h: 196,
        status: "idle",
        data: {
          title: "四宫格剧情分镜",
          aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
          storyboardGrid: "2x2",
          imageModel: "GEM_PIX_2",
          imageResolution: "2K",
          variantCount: 1,
          prompt:
            "严格保留主体角色的发色瞳色与机能斗篷造型：第1格黄昏霓虹天台远景俯瞰角色迎风伫立；" +
            "第2格中景微侧脸特写，风吹起发丝、神情警觉凝视前方；" +
            "第3格手部掌心亮起青蓝极光法阵的低角度动态构图；" +
            "第4格披风猎猎作响向都市夜空跃起的高燃广角瞬间，日系剧院版动画高对比光影",
        },
      },
      {
        key: "vid1",
        type: "video",
        x: 720,
        y: 110,
        w: 256,
        h: 184,
        status: "idle",
        data: {
          title: "镜头一 · 觉醒转身",
          aspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE",
          videoQuality: "omni",
          omniVersion: "1.2",
          videoResolution: "720p",
          durationSeconds: 6,
          variantCount: 1,
          prompt:
            "参考分镜中的主角与黄昏霓虹天台场景，0-3s 镜头由角色背影缓步右弧线环绕推进至侧面特写，微风吹动银发与斗篷衣摆；" +
            "3-6s 角色骤然抬眸直视远方，掌心凝聚出柔和流动的青蓝色极光粒子，赛璐璐电影感稳定帧率",
        },
      },
      {
        key: "vid2",
        type: "video",
        x: 720,
        y: 340,
        w: 256,
        h: 184,
        status: "idle",
        data: {
          title: "镜头二 · 尾帧续拍",
          aspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE",
          videoQuality: "omni",
          omniVersion: "1.2",
          videoResolution: "720p",
          durationSeconds: 5,
          variantCount: 1,
          prompt:
            "顺接上一镜头结尾掌心极光亮起的姿态与光影，0-2s 极光涟漪向四周扩散震飞天台尘埃；" +
            "2-5s 镜头快速后撤拉升，角色足尖轻点天台边缘顺势跃入璀璨都市夜景，动态流畅自然",
        },
      },
    ],
    edges: [
      { source_key: "subj", target_key: "sb", source_variant_idx: null },
      { source_key: "sb", target_key: "vid1", source_variant_idx: null },
      { source_key: "vid1", target_key: "vid2", source_variant_idx: null },
    ],
  },
  {
    id: "cinema-drama",
    title: "真人短剧定妆锁脸与情绪运镜",
    badge: "影视短剧",
    summary: "写实定妆主体 + 剧情脚本 → 电影感双参考剧照 → Veo 3.1 推镜短片",
    boardName: "示例·真人短剧定妆与推镜",
    nodes: [
      {
        key: "guide",
        type: "note",
        x: 40,
        y: 20,
        w: 300,
        h: 144,
        status: "done",
        data: {
          title: "新手指引 · 真人影视双参考链路",
          prompt:
            "同时连接【主角定妆照】与【场景剧情脚本】到【电影剧照】，既能锁定演员五官不走样，又能复用文本脚本控制光影与站位，最后用 Veo 3.1 一键动起来。",
        },
      },
      {
        key: "cast",
        type: "character",
        x: 40,
        y: 200,
        w: 256,
        h: 196,
        status: "idle",
        data: {
          title: "主角定妆照",
          aspectRatio: "IMAGE_ASPECT_RATIO_SQUARE",
          imageModel: "GEM_PIX_2",
          imageResolution: "2K",
          variantCount: 1,
          prompt:
            "电影级写实人物标准定妆照，一位28岁亚裔青年女侦探，利落黑色短发、深灰色风衣配米白高领针织衫，" +
            "正面平视镜头、神态克制冷静，真实肌肤纹理与柔和眼眸高光清晰锐利，" +
            "简约纯浅灰影棚背景配均匀主光，适合下游多镜头稳健锁脸",
        },
      },
      {
        key: "script",
        type: "prompt",
        x: 40,
        y: 430,
        w: 268,
        h: 168,
        status: "done",
        data: {
          title: "分场剧情与光影",
          prompt:
            "深夜雨幕中的街角复古咖啡馆窗边座，玻璃窗外流动着模糊的城市霓虹与车灯散景，室内暖橘色台灯光斑映在主人公侧脸，她双手轻捧一杯冒着微热白雾的陶瓷咖啡，眉头微蹙低头沉思，35mm 变形宽银幕镜头质感、浅景深、细腻胶片颗粒",
        },
      },
      {
        key: "still",
        type: "image",
        x: 390,
        y: 280,
        w: 256,
        h: 196,
        status: "idle",
        data: {
          title: "电影感关键剧照",
          aspectRatio: "IMAGE_ASPECT_RATIO_LANDSCAPE",
          imageModel: "GEM_PIX_2",
          imageResolution: "2K",
          variantCount: 1,
          prompt:
            "严格锁定参考主体人物外貌、短发与深灰风衣造型，置入夜间咖啡馆窗边场景，暖冷对比双色影调，电影构图三分线",
        },
      },
      {
        key: "shot",
        type: "video",
        x: 740,
        y: 280,
        w: 256,
        h: 184,
        status: "idle",
        data: {
          title: "Veo 3.1 推镜短片",
          aspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE",
          videoQuality: "lite",
          videoResolution: "720p",
          durationSeconds: 8,
          variantCount: 1,
          prompt:
            "机位缓慢而沉稳地向角色面部微距推近，咖啡杯口缕缕热气轻轻升腾消散，窗外雨滴沿玻璃缓缓滑落；" +
            "人物缓缓抬起眼眸望向窗外亮光，唇角带着克制的思索神情，电影级自然呼吸与眨眼细节",
        },
      },
    ],
    edges: [
      { source_key: "cast", target_key: "still", source_variant_idx: null },
      { source_key: "script", target_key: "still", source_variant_idx: null },
      { source_key: "still", target_key: "shot", source_variant_idx: null },
    ],
  },
  {
    id: "product-commercial",
    title: "核心产品锚定与商业广告大片",
    badge: "商业电商",
    summary: "产品主体锚点 → 极简展台主视觉 + 微距特写 → 环绕展示短片",
    boardName: "示例·商业产品广告工作流",
    nodes: [
      {
        key: "guide",
        type: "note",
        x: 40,
        y: 20,
        w: 300,
        h: 144,
        status: "done",
        data: {
          title: "新手指引 · 一源多态商业出片",
          prompt:
            "同一张【产品锚点图】（或拖入你自己的商品白底图）可同时连向多张风格海报与微距特写，最后汇总连入【环绕广告片】生成高质感带货短片。",
        },
      },
      {
        key: "prod",
        type: "character",
        x: 40,
        y: 200,
        w: 256,
        h: 196,
        status: "idle",
        data: {
          title: "产品主体锚点",
          aspectRatio: "IMAGE_ASPECT_RATIO_SQUARE",
          imageModel: "GEM_PIX_2",
          imageResolution: "2K",
          variantCount: 1,
          prompt:
            "高端极简无线降噪头戴式耳机标准产品主体图，哑光阳极氧化钛灰金属支架配合冰蓝微光灯环与细腻小羊皮耳罩，" +
            "四分之三立体标准展示视角，金属拉丝与皮革纹理高度清晰锐利，纯净浅灰影棚背景无文字水印",
        },
      },
      {
        key: "hero",
        type: "image",
        x: 390,
        y: 120,
        w: 256,
        h: 196,
        status: "idle",
        data: {
          title: "极简建筑展台 KV",
          aspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT",
          imageModel: "GEM_PIX_2",
          imageResolution: "2K",
          variantCount: 1,
          prompt:
            "严格保持参考产品的外观结构、材质与细节比例，悬置在深色黑曜石阶梯与半透明磨砂水晶石柱之上，" +
            "斜上方一束清冷建筑天窗硬光勾勒出锋利轮廓高光，商业级高奢海报构图，上下留白便于后期排版",
        },
      },
      {
        key: "macro",
        type: "image",
        x: 390,
        y: 350,
        w: 256,
        h: 196,
        status: "idle",
        data: {
          title: "材质微距特写图",
          aspectRatio: "IMAGE_ASPECT_RATIO_SQUARE",
          imageModel: "GEM_PIX_2",
          imageResolution: "2K",
          variantCount: 1,
          prompt:
            "保持参考产品的精准造型与金属质感，100mm 微距特写镜头聚焦耳罩转轴金属拉丝纹理与冰蓝呼吸灯环反射，细小水珠轻附于冰冷表面，梦幻浅景深柔焦背景",
        },
      },
      {
        key: "clip",
        type: "video",
        x: 740,
        y: 230,
        w: 256,
        h: 184,
        status: "idle",
        data: {
          title: "产品环绕广告片",
          aspectRatio: "VIDEO_ASPECT_RATIO_PORTRAIT",
          videoQuality: "omni",
          omniVersion: "1.2",
          videoResolution: "720p",
          durationSeconds: 5,
          variantCount: 1,
          prompt:
            "参考展台主视觉与微距材质，0-2.5s 镜头贴近水晶展台丝滑环绕 120 度扫过产品轮廓，束光随角度流动闪烁金属高光；" +
            "2.5-5s 镜头优雅拉远定格在产品全身，耳机轻盈悬浮微转，高级感电商短片节奏",
        },
      },
    ],
    edges: [
      { source_key: "prod", target_key: "hero", source_variant_idx: null },
      { source_key: "prod", target_key: "macro", source_variant_idx: null },
      { source_key: "hero", target_key: "clip", source_variant_idx: null },
      { source_key: "macro", target_key: "clip", source_variant_idx: null },
    ],
  },
];
