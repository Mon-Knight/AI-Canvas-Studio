/**
 * 客户端 Flow/Veo 提示词安全审核与自动改写（与后端 `prompt_safety.py` 规则保持一致）。
 * 主要用于离线/本地兜底润色路径，确保无远端 LLM 时仍自动柔化易触发有害内容拦截的表达。
 */

export interface PromptSafetyAuditResult {
  text: string;
  rewritten: boolean;
  notes: string[];
}

interface SafetyRule {
  pattern: RegExp;
  replacement: string;
  note: string;
}

const SAFETY_RULES: readonly SafetyRule[] = [
  {
    pattern:
      /(?:毅然|决然|纵身)?(?:向后仰身|仰身|翻身|纵身)?(?:纵入|跃入|跳入|跃下|跳下|坠入)(?:苍茫|漆黑|无尽)?(?:夜空|深渊|高楼|天台|楼顶|悬崖)(?:[，,]?\s*身体在失重气流中向深处坠落)?/gi,
    replacement:
      "在天台微风中昂首迎向璀璨夜空，衣袂与裙摆随夜风轻扬，镜头缓慢拉远升格展现壮阔霓虹天际线",
    note: "高空坠落/自伤意象 → 已转为迎风升格夜空镜头",
  },
  {
    pattern:
      /身体在失重气流中向深处坠落|在失重(?:气流)?中(?:急速|向深处)?坠落|从(?:高楼|天台|楼顶|悬崖)(?:一跃而下|坠落|跳下)/gi,
    replacement: "衣袂在夜风气流中轻盈舒展，镜头缓缓拉远融入星光与城市霓虹",
    note: "高空失重坠落 → 已转为夜风舒展升格镜头",
  },
  {
    pattern: /跳楼|坠楼|跳崖|自杀|自残|自伤|割腕|上吊|轻生|寻死|服毒/gi,
    replacement: "独自伫立远眺夜色沉思",
    note: "自伤敏感词 → 已转为克制情绪镜头",
  },
  {
    pattern:
      /\b(?:jump(?:ing|s|ed)?|leap(?:ing|s|t)?|plung(?:e|ing|ed)|fall(?:ing)?)\s+(?:off|from)\s+(?:a\s+|the\s+)?(?:roof(?:top)?|building|cliff|bridge|ledge)\b|\b(?:suicide|self[- ]?harm|kill(?:ing)?\s+(?:herself|himself|themselves|myself)|slit(?:ting)?\s+wrists?)\b/gi,
    replacement:
      "standing safely in the night breeze gazing out over the glowing skyline as the camera rises",
    note: "英文高空坠落/自伤词 → 已转为安全升格镜头",
  },
  {
    pattern:
      /鲜血(?:四溅|淋漓|直流|喷涌)|血流成河|满身是血|浑身鲜血|血肉模糊|血腥(?:暴力|场面|画面)?|断肢|斩首|爆头|剖腹|分尸/gi,
    replacement: "绯红花瓣随风飘散与冷暖电影光影交错",
    note: "血腥暴力画面 → 已转为艺术化花瓣光影意象",
  },
  {
    pattern:
      /虐杀|屠杀|残杀|杀戮|谋杀|捅死|刺杀|砍死|打死|尸横遍野|尸体|血迹斑斑|鲜血/gi,
    replacement: "紧张戏剧光影对峙",
    note: "暴力致伤敏感词 → 已转为克制戏剧张力描写",
  },
  {
    pattern:
      /\b(?:blood\s+splatter|gory|gore|decapitat\w*|dismember\w*|brutal\s+killing|corpse|mutilat\w*|stabbing\s+to\s+death)\b/gi,
    replacement: "dramatic cinematic shadow contrast",
    note: "英文血腥暴力词 → 已转为电影光影张力描写",
  },
  {
    pattern:
      /开枪射击|机枪扫射|枪杀|举枪瞄准头部|引爆炸弹|炸弹爆炸|恐怖袭击|自杀式袭击/gi,
    replacement: "科幻能量光束闪耀与绚丽霓虹光效绽放",
    note: "枪械/爆炸敏感词 → 已转为科幻光效画面",
  },
  {
    pattern:
      /\b(?:gunshot|shoot(?:ing)?\s+(?:at|in\s+the\s+head)|terrorist\s+attack|bomb\s+explosion|mass\s+shooting)\b/gi,
    replacement: "stylized sci-fi light burst and cinematic sparks",
    note: "英文武器/爆炸词 → 已转为科幻光效画面",
  },
  {
    pattern:
      /全裸|赤裸身体|裸体|裸露(?:身体|胸部|隐私)?|色情|情色|淫秽|性爱|床戏|性感挑逗/gi,
    replacement: "高级时尚优雅剪影造型",
    note: "裸露/成人敏感词 → 已转为优雅时尚穿搭描写",
  },
  {
    pattern:
      /\b(?:nude|naked|nsfw|pornograph\w*|explicit\s+sex|erotic\s+pose|topless|lingerie\s+strip)\b/gi,
    replacement: "tasteful editorial fashion silhouette",
    note: "英文成人/裸露词 → 已转为时尚剪影描写",
  },
  {
    pattern: /杀了你们|我要杀了你|和你同归于尽|同归于尽|血债血偿|死无葬身之地/gi,
    replacement: "我绝不会就此认输，真相终将大白",
    note: "极端暴力台词 → 已柔和化为坚定戏剧对白",
  },
  {
    pattern: /\b(?:i\s+will\s+kill\s+you(?:\s+all)?|die\s+together|burn\s+in\s+hell)\b/gi,
    replacement: "I will never give up until the truth comes out",
    note: "英文极端威胁台词 → 已柔和化为坚定戏剧对白",
  },
];

export function sanitizePromptForFlowSafetyClient(
  text: string,
): PromptSafetyAuditResult {
  if (!text || !text.trim()) {
    return { text: text || "", rewritten: false, notes: [] };
  }
  let current = text;
  const notes: string[] = [];
  for (const rule of SAFETY_RULES) {
    const next = current.replace(rule.pattern, rule.replacement);
    if (next !== current) {
      current = next;
      if (!notes.includes(rule.note)) {
        notes.push(rule.note);
      }
    }
  }
  if (notes.length > 0) {
    current = current
      .replace(/[，,]{2,}/g, "，")
      .replace(/[。.]{2,}/g, "。")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return {
    text: current,
    rewritten: notes.length > 0,
    notes,
  };
}
