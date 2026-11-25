"""Google Flow / Veo prompt content-safety audit & automatic rewrite.

Google Flow rejects image and video jobs with ``PUBLIC_ERROR_UNSAFE_GENERATION``
(or "此提示可能违反了我们关于生成有害内容的政策") when prompts describe
self-harm / leaping off buildings, graphic gore or violence, realistic
weapons/explosives, explicit nudity, or violent threats.

This module provides two complementary layers used during AI prompt polish:
1. ``SAFETY_SYSTEM_POLICY_CLAUSE`` — injected into LLM system prompts so the
   model proactively reimagines risky scenes into compliant cinematic metaphors.
2. ``sanitize_prompt_for_flow_safety`` — deterministic post-polish safety net
   that catches residual sensitive CN/EN expressions (including offline
   fallback paths) and rewrites them into safe, dramatic visual language while
   returning human-readable audit notes.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


SAFETY_SYSTEM_POLICY_CLAUSE = (
    "\n\nCONTENT SAFETY & POLICY COMPLIANCE — MANDATORY:\n"
    "Before outputting the final prompt, AUTOMATICALLY audit and rewrite any "
    "element that could trigger Google Flow / Veo safety moderation "
    "(PUBLIC_ERROR_UNSAFE_GENERATION / harmful content policy):\n"
    "  • SELF-HARM / ROOFTOP FALLING: NEVER describe jumping off roofs, "
    "falling to death, suicide, self-injury, or leaning/plunging off high "
    "ledges (e.g. 跳楼 / 纵身跃下 / 向后仰身坠落 / 失重坠落 / 自杀 / 割腕). "
    "Reimagine into safe, dramatic visual emotion: standing safely behind "
    "the railing facing the night breeze with hair and dress billowing, "
    "camera slowly rising/pulling back into a starry neon skyline, or "
    "dissolving into glowing light petals.\n"
    "  • VIOLENCE / GORE / BLOOD: NEVER describe graphic blood, wounds, "
    "killing, corpses, torture, or lethal attacks. Replace with stylized "
    "cinematic tension, dramatic shadows, falling crimson petals, or "
    "non-graphic action choreography.\n"
    "  • WEAPONS / EXPLOSIVES: Avoid realistic firearms aimed at people, "
    "bombs, or terrorism. Replace with stylized sci-fi energy light effects, "
    "sparks, or celebratory fireworks when action is needed.\n"
    "  • EXPLICIT / NSFW: Avoid nudity, sexualized poses, or suggestive "
    "underage depictions. Use tasteful editorial fashion framing.\n"
    "  • HARMFUL THREATS IN DIALOGUE: Soften explicit violent threats "
    "(e.g. '杀了你们', '同归于尽') into resolute dramatic dialogue "
    "(e.g. '我绝不会就此认输', '真相终将大白').\n"
    "  • REAL CELEBRITIES / POLITICIANS: Never name real public figures or "
    "protected IP trademarks; describe original visual traits instead.\n"
    "Preserve the user's emotional tone, aesthetic style, and dramatic "
    "storytelling while guaranteeing 100% policy-safe phrasing."
)


@dataclass(frozen=True)
class _SafetyRule:
    category: str
    pattern: re.Pattern[str]
    replacement: str
    note: str


_SAFETY_RULES: tuple[_SafetyRule, ...] = (
    # 1. Self-harm & rooftop/cliff jumping (highest priority — specific multi-word scenes first)
    _SafetyRule(
        category="self_harm",
        pattern=re.compile(
            r"(?:毅然|决然|纵身)?(?:向后仰身|仰身|翻身|纵身)?(?:纵入|跃入|跳入|跃下|跳下|坠入)(?:苍茫|漆黑|无尽)?(?:夜空|深渊|高楼|天台|楼顶|悬崖)"
            r"(?:[，,]?\s*身体在失重气流中向深处坠落)?",
            re.IGNORECASE,
        ),
        replacement="在天台微风中昂首迎向璀璨夜空，衣袂与裙摆随夜风轻扬，镜头缓慢拉远升格展现壮阔霓虹天际线",
        note="高空坠落/自伤意象 → 已转为迎风升格夜空镜头",
    ),
    _SafetyRule(
        category="self_harm",
        pattern=re.compile(
            r"身体在失重气流中向深处坠落|在失重(?:气流)?中(?:急速|向深处)?坠落|从(?:高楼|天台|楼顶|悬崖)(?:一跃而下|坠落|跳下)",
            re.IGNORECASE,
        ),
        replacement="衣袂在夜风气流中轻盈舒展，镜头缓缓拉远融入星光与城市霓虹",
        note="高空失重坠落 → 已转为夜风舒展升格镜头",
    ),
    _SafetyRule(
        category="self_harm",
        pattern=re.compile(
            r"跳楼|坠楼|跳崖|自杀|自残|自伤|割腕|上吊|轻生|寻死|服毒",
            re.IGNORECASE,
        ),
        replacement="独自伫立远眺夜色沉思",
        note="自伤敏感词 → 已转为克制情绪镜头",
    ),
    _SafetyRule(
        category="self_harm",
        pattern=re.compile(
            r"\b(?:jump(?:ing|s|ed)?|leap(?:ing|s|t)?|plung(?:e|ing|ed)|fall(?:ing)?)\s+(?:off|from)\s+(?:a\s+|the\s+)?(?:roof(?:top)?|building|cliff|bridge|ledge)\b"
            r"|\b(?:suicide|self[- ]?harm|kill(?:ing)?\s+(?:herself|himself|themselves|myself)|slit(?:ting)?\s+wrists?)\b",
            re.IGNORECASE,
        ),
        replacement="standing safely in the night breeze gazing out over the glowing skyline as the camera rises",
        note="英文高空坠落/自伤词 → 已转为安全升格镜头",
    ),
    # 2. Graphic violence, blood, gore
    _SafetyRule(
        category="violence_gore",
        pattern=re.compile(
            r"鲜血(?:四溅|淋漓|直流|喷涌)|血流成河|满身是血|浑身鲜血|血肉模糊|血腥(?:暴力|场面|画面)?|断肢|斩首|爆头|剖腹|分尸",
            re.IGNORECASE,
        ),
        replacement="绯红花瓣随风飘散与冷暖电影光影交错",
        note="血腥暴力画面 → 已转为艺术化花瓣光影意象",
    ),
    _SafetyRule(
        category="violence_gore",
        pattern=re.compile(
            r"虐杀|屠杀|残杀|杀戮|谋杀|捅死|刺杀|砍死|打死|尸横遍野|尸体|血迹斑斑|鲜血",
            re.IGNORECASE,
        ),
        replacement="紧张戏剧光影对峙",
        note="暴力致伤敏感词 → 已转为克制戏剧张力描写",
    ),
    _SafetyRule(
        category="violence_gore",
        pattern=re.compile(
            r"\b(?:blood\s+splatter|gory|gore|decapitat\w*|dismember\w*|brutal\s+killing|corpse|mutilat\w*|stabbing\s+to\s+death)\b",
            re.IGNORECASE,
        ),
        replacement="dramatic cinematic shadow contrast",
        note="英文血腥暴力词 → 已转为电影光影张力描写",
    ),
    # 3. Weapons, shootings, terrorism, explosions
    _SafetyRule(
        category="weapons_explosives",
        pattern=re.compile(
            r"开枪射击|机枪扫射|枪杀|举枪瞄准头部|引爆炸弹|炸弹爆炸|恐怖袭击|自杀式袭击",
            re.IGNORECASE,
        ),
        replacement="科幻能量光束闪耀与绚丽霓虹光效绽放",
        note="枪械/爆炸敏感词 → 已转为科幻光效画面",
    ),
    _SafetyRule(
        category="weapons_explosives",
        pattern=re.compile(
            r"\b(?:gunshot|shoot(?:ing)?\s+(?:at|in\s+the\s+head)|terrorist\s+attack|bomb\s+explosion|mass\s+shooting)\b",
            re.IGNORECASE,
        ),
        replacement="stylized sci-fi light burst and cinematic sparks",
        note="英文武器/爆炸词 → 已转为科幻光效画面",
    ),
    # 4. Explicit sexual / nudity
    _SafetyRule(
        category="nsfw",
        pattern=re.compile(
            r"全裸|赤裸身体|裸体|裸露(?:身体|胸部|隐私)?|色情|情色|淫秽|性爱|床戏|性感挑逗",
            re.IGNORECASE,
        ),
        replacement="高级时尚优雅剪影造型",
        note="裸露/成人敏感词 → 已转为优雅时尚穿搭描写",
    ),
    _SafetyRule(
        category="nsfw",
        pattern=re.compile(
            r"\b(?:nude|naked|nsfw|pornograph\w*|explicit\s+sex|erotic\s+pose|topless|lingerie\s+strip)\b",
            re.IGNORECASE,
        ),
        replacement="tasteful editorial fashion silhouette",
        note="英文成人/裸露词 → 已转为时尚剪影描写",
    ),
    # 5. Violent threats in dialogue
    _SafetyRule(
        category="violent_dialogue",
        pattern=re.compile(
            r"杀了你们|我要杀了你|和你同归于尽|同归于尽|血债血偿|死无葬身之地",
            re.IGNORECASE,
        ),
        replacement="我绝不会就此认输，真相终将大白",
        note="极端暴力台词 → 已柔和化为坚定戏剧对白",
    ),
    _SafetyRule(
        category="violent_dialogue",
        pattern=re.compile(
            r"\b(?:i\s+will\s+kill\s+you(?:\s+all)?|die\s+together|burn\s+in\s+hell)\b",
            re.IGNORECASE,
        ),
        replacement="I will never give up until the truth comes out",
        note="英文极端威胁台词 → 已柔和化为坚定戏剧对白",
    ),
)


@dataclass
class SafetySanitizeResult:
    text: str
    rewritten: bool = False
    notes: list[str] = field(default_factory=list)


def sanitize_prompt_for_flow_safety(text: str) -> SafetySanitizeResult:
    """Audit and automatically rewrite sensitive terms likely to trigger Flow moderation.

    Clean prompts are returned verbatim with ``rewritten=False`` and ``notes=[]``.
    """
    if not text or not text.strip():
        return SafetySanitizeResult(text=text or "", rewritten=False, notes=[])

    current = text
    notes: list[str] = []
    seen_notes: set[str] = set()

    for rule in _SAFETY_RULES:
        updated, count = rule.pattern.subn(rule.replacement, current)
        if count > 0 and updated != current:
            current = updated
            if rule.note not in seen_notes:
                seen_notes.add(rule.note)
                notes.append(rule.note)

    # Clean up occasional doubled punctuation after substitutions.
    if notes:
        current = re.sub(r"[，,]{2,}", "，", current)
        current = re.sub(r"[。\.]{2,}", "。", current)
        current = re.sub(r"\s{2,}", " ", current).strip()

    return SafetySanitizeResult(
        text=current,
        rewritten=bool(notes),
        notes=notes,
    )
