"""HTTP routes for Google Flow Music (personal credits channel)."""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from flowboard.node_mirror import apply_node_patch
from flowboard.routes.local_only import local_origin
from flowboard.services import media as media_service
from flowboard.services.flowmusic_client import (
    FlowMusicError,
    _clean_and_validate_lyrics,
    _looks_chinese_prompt,
    compute_lyrics_id,
    get_flowmusic_client,
)
from flowboard.services.llm import LLMError, run_llm

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/music", tags=["music"], dependencies=[Depends(local_origin)])


@router.get("/status")
async def get_music_status(refresh: bool = Query(default=False)):
    """Return Flow Music personal-channel connection state, credits, and models."""
    return await get_flowmusic_client().get_status(refresh_remote=refresh)


class ConnectMusicBody(BaseModel):
    active: bool = True


@router.post("/connect")
async def connect_music_browser(body: ConnectMusicBody = ConnectMusicBody()):
    """Open www.flowmusic.app inside the active account's Chrome profile."""
    try:
        return await get_flowmusic_client().connect_browser(active=body.active)
    except FlowMusicError as exc:
        raise HTTPException(status_code=503, detail=exc.message) from None


@router.post("/sync-credits")
async def sync_music_credits():
    """Fetch live Flow Music credit balance, subscription plan, and models."""
    try:
        res = await get_flowmusic_client().sync_credits()
        status = await get_flowmusic_client().get_status(refresh_remote=False)
        merged = {**status, **res}
        if merged.get("music_credits") is None and res.get("credits") is not None:
            merged["music_credits"] = res["credits"]
        if not merged.get("music_plan") and res.get("plan"):
            merged["music_plan"] = res["plan"]
        if not merged.get("email") and res.get("email"):
            merged["email"] = res["email"]
        return merged
    except FlowMusicError as exc:
        code = 401 if exc.code in ("FLOWMUSIC_NOT_LOGGED_IN", "FLOWMUSIC_AUTH_EXPIRED") else 502
        raise HTTPException(status_code=code, detail=exc.message) from None


def _resolve_visual_attachments(media_ids: list[str], limit: int = 3) -> list[str]:
    """Resolve up to `limit` cached image files for direct vision-grounded music scoring."""
    out: list[str] = []
    seen: set[str] = set()
    for raw_id in media_ids:
        if len(out) >= limit:
            break
        if not isinstance(raw_id, str) or not raw_id.strip():
            continue
        clean = media_service.normalize_media_id(raw_id)
        if not clean or clean in seen or not media_service.is_valid_media_id(clean):
            continue
        seen.add(clean)
        cached = media_service.cached_path(clean)
        if cached is None or not cached.is_file():
            continue
        mime = media_service._mime_from_ext(cached.suffix)
        if mime.startswith("image/"):
            out.append(str(cached.resolve()))
    return out


async def _run_music_llm(
    user_prompt: str,
    *,
    system_prompt: str,
    attachments: Optional[list[str]] = None,
    timeout: float = 75.0,
) -> tuple[Optional[str], bool]:
    """Dispatch to the user's configured LLM via `run_llm`, returning `(text, used_vision)`."""
    if attachments:
        for feature in ("vision", "auto_prompt", "planner", "chat_agent"):
            try:
                raw = await run_llm(
                    feature,
                    user_prompt,
                    system_prompt=system_prompt,
                    attachments=attachments,
                    timeout=timeout,
                )
                if isinstance(raw, str) and raw.strip():
                    return raw.strip(), True
            except (LLMError, Exception) as exc:
                logger.debug("Music LLM (%s, vision) skipped: %s", feature, exc)

    for feature in ("auto_prompt", "planner", "chat_agent"):
        try:
            raw = await run_llm(
                feature,
                user_prompt,
                system_prompt=system_prompt,
                timeout=timeout,
            )
            if isinstance(raw, str) and raw.strip():
                return raw.strip(), False
        except (LLMError, Exception) as exc:
            logger.debug("Music LLM (%s, text) skipped: %s", feature, exc)

    return None, False


def _extract_json_object(raw: str) -> Optional[dict[str, Any]]:
    text = (raw or "").strip()
    if not text:
        return None
    fence = re.match(r"^```(?:json)?\s*\n([\s\S]*?)\n```\s*$", text, re.IGNORECASE)
    if fence:
        text = fence.group(1).strip()
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except ValueError:
        pass
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            parsed = json.loads(m.group(0))
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            pass
    return None


def _build_chinese_fallback_music_prompt(
    context_texts: list[str],
    user_hint: str,
    instrumental: bool,
) -> tuple[str, int, str]:
    """Scene-aware Simplified Chinese fallback used only when no LLM provider is configured."""
    merged = " ".join([user_hint, *context_texts])
    vocal_clause = "纯音乐无主唱人声" if instrumental else "搭配细腻富有情感张力的人声演唱"

    presets: list[tuple[tuple[str, ...], str, int, str]] = [
        (
            ("古风", "国风", "仙侠", "武侠", "汉服", "山水", "竹林", "宫殿", "江湖", "水墨", "朝代"),
            f"新中式国风影视配乐，清越竹笛与古筝拨弦领奏，二胡与管弦弦乐温柔托底，前奏空灵悠远，中段辅以轻盈中国大鼓推进情绪高潮，宽广古雅混响质感，{vocal_clause}",
            84,
            "山水清音 · 国风配乐",
        ),
        (
            ("赛博", "霓虹", "科幻", "机甲", "未来", "朋克", "cyberpunk", "neon", "废土", "都市夜景"),
            f"赛博朋克未来感电子配乐，厚重模拟合成器低音铺底，脉冲琶音与冷冽霓虹质感合成器主旋律交替推进，中段切入利落电子鼓组与宽阔空间混响，科技感与雨夜氛围并存，{vocal_clause}",
            106,
            "霓虹脉冲 · 赛博配乐",
        ),
        (
            ("悬疑", "惊悚", "暗黑", "侦探", "追逐", "恐怖", "危机", "神秘", "阴郁", "noir"),
            f"悬疑紧张心理惊悚配乐，低沉大提琴拨弦与脉冲合成器低音制造压迫感，穿插细腻金属打击乐与渐强弦乐震音，节奏步步紧逼并在高潮处骤然收束，电影级暗调混音，{vocal_clause}",
            112,
            "暗涌谜踪 · 悬疑配乐",
        ),
        (
            ("二次元", "动漫", "校园", "青春", "日系", "anime", "少女", "少年", "元气", "樱花"),
            f"日系二次元青春感原声配乐，明快清透原声钢琴与亮色电吉他分解和弦领奏，轻盈实录鼓组与温暖弦乐在中段推向灿烂副歌高潮，通透清新的动画电影混音质感，{vocal_clause}",
            120,
            "微风晴空 · 青春配乐",
        ),
        (
            ("战斗", "史诗", "战争", "热血", "摇滚", "机甲战", "史诗级", "燃", "冒险", "英雄"),
            f"宏大热血史诗电影配乐，铿锵铜管齐奏与疾速弦乐固定音型开场，重击战鼓与失真节奏元素层层叠加推向震撼高潮，宽广交响大厅空间感与冲击力动态，{vocal_clause}",
            128,
            "破晓征途 · 史诗配乐",
        ),
        (
            ("治愈", "温暖", "咖啡", "日常", "森林", "海边", "阳光", "田园", "治愈系", "清新"),
            f"温暖治愈电影氛围配乐，柔和原声钢琴与温暖木吉他轻盈交织，大提琴长音与细腻环境质感轻轻托底，旋律舒缓自然、情绪温柔上扬，干净透亮的近场原声混音，{vocal_clause}",
            82,
            "晴光微暖 · 治愈配乐",
        ),
        (
            ("雨夜", "忧伤", "孤独", "回忆", "离别", "浪漫", "深夜", "情感", "慢镜头"),
            f"深情抒情电影配乐，静谧柔焦钢琴前奏缓缓引入大提琴独奏与细腻弦乐群，中段情感层层递进并在尾声轻柔回落，克制而动人的银幕级空间混响，{vocal_clause}",
            76,
            "雨夜回响 · 抒情配乐",
        ),
        (
            ("时尚", "都市", "走秀", "商业", "广告", "街拍", "潮流", "高级感", "lookbook", "fashion"),
            f"现代都市高级感时尚电子流行配乐，利落律动贝斯线与精致质感合成器和弦奠定摩登节奏，轻快清脆的鼓点与细腻高频空气感贯穿全曲，干净时髦的商业大片混音，{vocal_clause}",
            114,
            "摩登节拍 · 都市配乐",
        ),
    ]

    low_merged = merged.lower()
    for keywords, desc, bpm, title in presets:
        if any(kw in low_merged for kw in keywords):
            if user_hint:
                return f"{desc}；融入补充要求：{user_hint[:140]}", bpm, title
            return desc, bpm, title

    base = f"电影感叙事配乐，细腻钢琴与温暖大提琴铺底，中段逐步加入宽广管弦乐与克制节奏打击乐推进情绪层次，通透立体的银幕级空间混响，{vocal_clause}"
    if user_hint:
        base = f"{base}；核心主题与风格参考：{user_hint[:140]}"
    return base, 92, "画布影视配乐"


class LyricsBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    lyrics_id: Optional[str] = None
    existing_lyrics: Optional[str] = Field(default=None, max_length=6000)
    context_texts: list[str] = Field(default_factory=list, max_length=24)
    target_duration_s: Optional[int] = Field(default=None, ge=30, le=240)
    title_hint: Optional[str] = Field(default=None, max_length=120)


@router.post("/lyrics")
async def generate_music_lyrics(body: LyricsBody):
    """0-credit lyrics creation or revision (prefers configured LLM for clean Chinese lyrics, falls back to Flow Music lyricist)."""
    clean_prompt = body.prompt.strip()
    if not clean_prompt:
        raise HTTPException(status_code=400, detail="请输入歌词主题或曲风描述。")

    context_block = "\n".join(
        f"- {t.strip()[:260]}" for t in body.context_texts if isinstance(t, str) and t.strip()
    )
    existing = (body.existing_lyrics or "").strip()
    prefer_zh = _looks_chinese_prompt(f"{clean_prompt} {body.title_hint or ''} {context_block}")
    dur_s = body.target_duration_s or 90
    section_guide = (
        "[Verse 1]、[Chorus]、[Outro]（精炼 12–16 行，适合约 60 秒歌曲）"
        if dur_s <= 65
        else "[Verse 1]、[Pre-Chorus]、[Chorus]、[Verse 2]、[Chorus]、[Bridge]、[Outro]（约 20–30 行，适合约 90–120 秒歌曲）"
        if dur_s <= 135
        else "[Verse 1]、[Pre-Chorus]、[Chorus]、[Verse 2]、[Pre-Chorus]、[Chorus]、[Bridge]、[Final Chorus]、[Outro]（约 28–38 行，适合 2.5–3 分钟完整歌曲）"
    )

    lang_rule = (
        "歌词正文必须全部使用流畅、自然、有诗意与节奏韵律的**简体中文**，严禁输出乱码、拼音、音标或夹杂无关英文解释。"
        if prefer_zh
        else "严格按用户要求的语种撰写自然流畅、可真实演唱的押韵歌词，严禁乱码或夹杂解释文字。"
    )

    system_prompt = (
        "你是华语乐坛与影视原声资深专业作词人，专门为 Google Flow Music (Lyria 3.5) 创作可直接演唱的高质量歌词。\n"
        "严格遵守以下规则：\n"
        f"1. {lang_rule}\n"
        f"2. 歌曲分段标记必须使用 Lyria 标准方括号英文标签：{section_guide}，每个分段之间空一行，每句歌词一行，长短匀称、利于上口演唱。\n"
        "3. 歌词意象必须紧扣曲风情绪与画布画面剧情，杜绝空洞口水话与机械重复，严禁出现任何真实歌手名、版权作品名、思考过程、Markdown 解释或 JSON 字段残片。\n"
        "4. 若提供了原有歌词，则在保留优点的基础上严格按用户修改要求进行润色改写。\n"
        "5. 严格返回纯 JSON（不要额外文字）：{\"title\": \"简洁歌名\", \"lyrics\": \"完整分段歌词（使用 \\n 换行）\"}"
    )

    user_parts = [
        f"曲风与主题要求：{clean_prompt}",
        f"目标时长：约 {dur_s} 秒",
    ]
    if body.title_hint and body.title_hint.strip():
        user_parts.append(f"参考歌名：{body.title_hint.strip()}")
    if context_block:
        user_parts.append(f"画布分镜与画面剧情参考：\n{context_block}")
    if existing:
        user_parts.append(f"现有歌词（请按要求修改润色）：\n{existing[:3000]}")

    raw_llm, _ = await _run_music_llm(
        "\n".join(user_parts),
        system_prompt=system_prompt,
        timeout=75.0,
    )
    if raw_llm:
        parsed = _extract_json_object(raw_llm)
        cand_title = ""
        cand_lyrics = ""
        if parsed:
            cand_title = str(parsed.get("title") or "").strip()[:80]
            cand_lyrics = str(parsed.get("lyrics") or "").strip()
        else:
            cand_lyrics = raw_llm
        valid_lyrics = _clean_and_validate_lyrics(cand_lyrics, prefer_chinese=prefer_zh)
        if valid_lyrics:
            return {
                "title": cand_title or (body.title_hint or "").strip(),
                "lyrics": valid_lyrics,
                "lyrics_id": compute_lyrics_id(valid_lyrics),
                "source": "llm",
            }
        logger.warning("LLM lyrics output failed validation; falling back to Flow Music lyricist")

    # Fallback: Flow Music's built-in 0-credit lyricist (with full client_context & gibberish guard)
    try:
        res = await get_flowmusic_client().generate_lyrics(clean_prompt, lyrics_id=body.lyrics_id)
        return {**res, "source": "flowmusic"}
    except FlowMusicError as exc:
        code = 401 if exc.code in ("FLOWMUSIC_NOT_LOGGED_IN", "FLOWMUSIC_AUTH_EXPIRED") else 502
        raise HTTPException(status_code=code, detail=exc.message) from None


class AnalyzeAudioBody(BaseModel):
    media_id: str = Field(min_length=1, max_length=128)
    node_id: Optional[int] = None
    remove_vocals: bool = False


@router.post("/analyze")
async def analyze_cached_audio(body: AnalyzeAudioBody):
    """Upload a locally cached audio asset to Flow Music and run 0-credit caption + transcribe."""
    clean_id = media_service.normalize_media_id(body.media_id)
    cached = media_service.cached_path(clean_id)
    if cached is None or not cached.is_file():
        raise HTTPException(status_code=404, detail="未在本地缓存中找到该音频文件。")

    raw_bytes = cached.read_bytes()
    mime = media_service._mime_from_ext(cached.suffix)
    if not mime.startswith("audio/"):
        mime = "audio/mpeg"

    try:
        result = await get_flowmusic_client().upload_and_analyze_audio(
            raw_bytes,
            cached.name,
            mime,
            remove_vocals=body.remove_vocals,
        )
    except FlowMusicError as exc:
        code = 401 if exc.code in ("FLOWMUSIC_NOT_LOGGED_IN", "FLOWMUSIC_AUTH_EXPIRED") else 502
        raise HTTPException(status_code=code, detail=exc.message) from None

    if body.node_id is not None:
        patch: dict = {}
        if result.get("clip_id"):
            patch["musicClipId"] = result["clip_id"]
        if result.get("caption"):
            patch["aiBrief"] = result["caption"]
        if result.get("lyrics"):
            patch["musicLyrics"] = result["lyrics"]
        if patch:
            apply_node_patch(body.node_id, data_patch=patch)

    return result


class ComposeMusicPromptBody(BaseModel):
    context_texts: list[str] = Field(default_factory=list, max_length=24)
    media_ids: list[str] = Field(default_factory=list, max_length=6)
    user_hint: str = Field(default="", max_length=1500)
    lyrics: str = Field(default="", max_length=4000)
    instrumental: bool = True
    target_duration_s: Optional[int] = Field(default=None, ge=30, le=240)


@router.post("/compose-prompt")
async def compose_music_prompt(body: ComposeMusicPromptBody):
    """Synthesize an accurate Simplified Chinese Flow Music prompt from canvas storyboards & images."""
    clean_contexts = [t.strip()[:360] for t in body.context_texts if isinstance(t, str) and t.strip()]
    context_block = "\n".join(f"{idx + 1}. {txt}" for idx, txt in enumerate(clean_contexts))
    hint = body.user_hint.strip()
    lyrics_excerpt = body.lyrics.strip()[:400]
    mode_desc = "纯音乐影视配乐（无主唱人声）" if body.instrumental else "带人声演唱的主题曲/插曲"
    dur_hint = f"目标成片总时长约 {body.target_duration_s} 秒" if body.target_duration_s else "标准 60–120 秒"
    attachments = _resolve_visual_attachments(body.media_ids, limit=3)

    fb_prompt, fb_bpm, fb_title = _build_chinese_fallback_music_prompt(
        clean_contexts, hint, body.instrumental
    )

    system_prompt = (
        "你是顶级影视配乐总监与 Google Flow Music (Lyria 3.5) 编曲提示词专家。\n"
        "请深度分析用户提供的画布镜头文案、分镜顺序以及附带参考画面（如有），创作一条精准贴合该画面的**简体中文**配乐风格提示词。\n"
        "严格要求：\n"
        "1. 【必须全简体中文】：`sound_prompt` 和 `suggested_title` 必须全部使用地道、流畅、富有画面感的简体中文（允许偶尔出现 BPM、Lo-Fi、R&B 等通用音乐简称，但严禁输出英文句子或中英混杂机翻腔）。\n"
        "2. 【高度贴合真实画面】：必须根据画面中的具体时代背景、视觉风格（如古风/国漫/二次元/赛博科幻/写实都市/悬疑暗黑/温暖日常等）、场景光影、角色情绪和镜头节奏定制专属配乐方案，禁止套用空洞万能的“电影配乐、温暖弦乐”模板。\n"
        "3. 【编曲要素完整（65–140字）】：依次涵盖核心曲风流派、具体主奏与铺底乐器、画面情绪基调、编曲动态推进（前奏→发展→高潮→尾声）、空间混音质感；"
        "若为纯音乐须明确“纯音乐无主唱人声”；若为人声歌曲须说明合适的人声性别、音色与唱腔特点；严禁出现真实歌手、乐队或版权作品名。\n"
        "4. 严格返回纯 JSON（不要解释、不要多余文本）："
        "{\"sound_prompt\": \"简体中文配乐描述\", \"suggested_bpm\": 96, \"suggested_title\": \"简洁中文曲名\"}"
    )

    user_sections = [
        f"配乐形态：{mode_desc}",
        f"时长参考：{dur_hint}",
        f"用户补充方向：{hint or '无（完全以画布画面内容为主导）'}",
    ]
    if lyrics_excerpt:
        user_sections.append(f"已有歌词片段（配乐需与歌词情绪节奏吻合）：\n{lyrics_excerpt}")
    if attachments:
        user_sections.append(f"已附带 {len(attachments)} 张画布关键画面参考图，请结合画面构图、色调与视觉氛围构思配乐。")
    user_sections.append(
        f"画布分镜与节点内容（按叙事顺序）：\n{context_block or '（暂无文字分镜，请优先依据附带参考画面或用户补充构思）'}"
    )

    raw, used_vision = await _run_music_llm(
        "\n".join(user_sections),
        system_prompt=system_prompt,
        attachments=attachments or None,
        timeout=75.0,
    )
    if raw:
        parsed = _extract_json_object(raw)
        if parsed:
            sp = str(parsed.get("sound_prompt") or "").strip()
            bpm_raw = parsed.get("suggested_bpm")
            bpm_val = int(bpm_raw) if isinstance(bpm_raw, (int, float)) and 50 <= bpm_raw <= 200 else fb_bpm
            title_val = str(parsed.get("suggested_title") or fb_title).strip()[:60]
            if sp:
                return {
                    "sound_prompt": sp,
                    "suggested_bpm": bpm_val,
                    "suggested_title": title_val,
                    "used_llm": True,
                    "used_vision": used_vision,
                }
        cleaned_raw = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", raw).strip()
        if cleaned_raw and len(cleaned_raw) >= 12:
            return {
                "sound_prompt": cleaned_raw[:500],
                "suggested_bpm": fb_bpm,
                "suggested_title": fb_title,
                "used_llm": True,
                "used_vision": used_vision,
            }

    return {
        "sound_prompt": fb_prompt,
        "suggested_bpm": fb_bpm,
        "suggested_title": fb_title,
        "used_llm": False,
        "used_vision": False,
    }


@router.get("/download/{clip_id}")
async def download_flowmusic_clip(
    clip_id: str,
    format: Literal["wav", "mp3", "m4a"] = Query(default="wav"),
):
    """Download a Flow Music clip on demand in lossless 48kHz WAV, MP3, or M4A."""
    clean = clip_id.strip()
    if not clean or not media_service.is_valid_media_id(clean):
        raise HTTPException(status_code=400, detail="无效的 clip_id")
    try:
        raw, mime = await get_flowmusic_client().download_clip_bytes(clean, fmt=format)
    except FlowMusicError as exc:
        code = 401 if exc.code in ("FLOWMUSIC_NOT_LOGGED_IN", "FLOWMUSIC_AUTH_EXPIRED") else 502
        raise HTTPException(status_code=code, detail=exc.message) from None

    return Response(
        content=raw,
        media_type=mime,
        headers={
            "Content-Disposition": f'attachment; filename="flowmusic-{clean[:8]}.{format}"',
            "Cache-Control": "private, max-age=3600",
        },
    )
