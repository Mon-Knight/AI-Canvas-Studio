"""HTTP routes for Google Flow Music (personal credits channel)."""
from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from flowboard.node_mirror import apply_node_patch
from flowboard.routes.local_only import local_origin
from flowboard.services import media as media_service
from flowboard.services.flowmusic_client import FlowMusicError, get_flowmusic_client

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
        return {**status, **res}
    except FlowMusicError as exc:
        code = 401 if exc.code in ("FLOWMUSIC_NOT_LOGGED_IN", "FLOWMUSIC_AUTH_EXPIRED") else 502
        raise HTTPException(status_code=code, detail=exc.message) from None


class LyricsBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    lyrics_id: Optional[str] = None


@router.post("/lyrics")
async def generate_music_lyrics(body: LyricsBody):
    """0-credit lyrics generation or revision via Flow Music's built-in lyricist."""
    try:
        return await get_flowmusic_client().generate_lyrics(body.prompt, lyrics_id=body.lyrics_id)
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
    user_hint: str = Field(default="", max_length=1500)
    instrumental: bool = True
    target_duration_s: Optional[int] = Field(default=None, ge=30, le=240)


@router.post("/compose-prompt")
async def compose_music_prompt(body: ComposeMusicPromptBody):
    """Synthesize a Flow Music prompt from upstream storyboard/video briefs for human review."""
    context_block = "\n".join(f"- {t.strip()[:260]}" for t in body.context_texts if isinstance(t, str) and t.strip())
    hint = body.user_hint.strip()
    mode_desc = "纯音乐影视配乐（无主唱人声）" if body.instrumental else "带人声演唱的主题曲"
    dur_hint = f"目标成片总时长约 {body.target_duration_s} 秒" if body.target_duration_s else "标准 60–120 秒"

    fallback_prompt = (
        f"Cinematic {'instrumental soundtrack' if body.instrumental else 'theme song'}, "
        f"{hint or 'emotional atmospheric score, warm strings, subtle percussion, evolving dynamics'}"
    )

    try:
        from flowboard.services.llm.registry import get_provider_for_feature

        provider = get_provider_for_feature("auto_prompt")
        if provider is None or not provider.is_available():
            return {
                "sound_prompt": fallback_prompt,
                "suggested_bpm": 96,
                "suggested_title": "画布影视配乐",
                "used_llm": False,
            }

        system_prompt = (
            "你是专业影视配乐总监与 Google Flow Music (Lyria 3.5) 提示词专家。"
            "请根据画布镜头摘要与用户补充要求，提炼一条可直接输入 Lyria 3.5 的高质量英文音乐风格描述（40–80词，包含曲风、核心乐器、情绪层次、混音质感与节奏推进，不要包含真实歌手/乐队名），"
            "并给出建议 BPM（整数 60–160）和一个简洁中文曲名。"
            "严格返回 JSON：{\"sound_prompt\": \"...\", \"suggested_bpm\": 96, \"suggested_title\": \"...\"}"
        )
        user_msg = (
            f"配乐类型：{mode_desc}\n"
            f"时长参考：{dur_hint}\n"
            f"用户补充：{hint or '无'}\n"
            f"画布画面与剧情摘要：\n{context_block or '（暂无上游镜头，请按电影级氛围配乐构思）'}"
        )
        raw = await provider.complete(user_msg, system_prompt=system_prompt)
        import json as _json
        import re as _re

        text = (raw or "").strip()
        m = _re.search(r"\{[\s\S]*\}", text)
        if m:
            parsed = _json.loads(m.group(0))
            sp = str(parsed.get("sound_prompt") or "").strip()
            bpm_raw = parsed.get("suggested_bpm")
            bpm_val = int(bpm_raw) if isinstance(bpm_raw, (int, float)) and 50 <= bpm_raw <= 200 else 96
            title_val = str(parsed.get("suggested_title") or "画布影视配乐").strip()[:60]
            if sp:
                return {
                    "sound_prompt": sp,
                    "suggested_bpm": bpm_val,
                    "suggested_title": title_val,
                    "used_llm": True,
                }
        return {
            "sound_prompt": text[:500] or fallback_prompt,
            "suggested_bpm": 96,
            "suggested_title": "画布影视配乐",
            "used_llm": True,
        }
    except Exception:
        logger.debug("compose_music_prompt fell back to deterministic template", exc_info=True)
        return {
            "sound_prompt": fallback_prompt,
            "suggested_bpm": 96,
            "suggested_title": "画布影视配乐",
            "used_llm": False,
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
