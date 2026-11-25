"""Worker handlers for Google Flow Music (personal credits channel)."""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Optional

from flowboard.db import get_session
from flowboard.db.models import Request
from flowboard.services import media as media_service
from flowboard.services.flowmusic_client import (
    DEFAULT_MUSIC_MODEL,
    FlowMusicError,
    get_flowmusic_client,
)

logger = logging.getLogger(__name__)


def _is_request_canceled(request_id: Optional[int]) -> bool:
    if request_id is None:
        return False
    try:
        with get_session() as s:
            row = s.get(Request, request_id)
            return row is not None and row.status == "canceled"
    except Exception:
        return False


def _sniff_image_mime(raw: bytes, fallback: str = "image/jpeg") -> str:
    if len(raw) >= 8 and raw[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if len(raw) >= 3 and raw[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    return fallback if fallback.startswith("image/") else "image/jpeg"


async def _ingest_clips_result(
    clips: list[dict[str, Any]],
    *,
    preferred_fmt: str = "m4a",
) -> tuple[list[str], list[str], Optional[str], dict[str, Any]]:
    """Download clip audio + first cover image into the local /media cache."""
    client = get_flowmusic_client()
    media_ids: list[str] = []
    clip_ids: list[str] = []
    cover_media_id: Optional[str] = None
    primary_meta: dict[str, Any] = {}

    for idx, clip in enumerate(clips):
        cid = str(clip.get("id") or "").strip()
        if not cid:
            continue
        raw_audio, mime = await client.download_clip_bytes(cid, fmt=preferred_fmt, clip_meta=clip)
        mid = str(uuid.uuid4())
        ok = media_service.ingest_inline_bytes(mid, raw_audio, kind="audio", mime=mime)
        if not ok:
            raise FlowMusicError("FLOWMUSIC_CACHE_WRITE_FAILED", "写入本地音频缓存失败。")
        media_ids.append(mid)
        clip_ids.append(cid)

        if idx == 0:
            primary_meta = clip
            img_url = clip.get("image_url") or clip.get("cover_url")
            if isinstance(img_url, str) and img_url.startswith("https://"):
                try:
                    img_bytes, img_ctype = await client.download_binary_url(img_url)
                    img_mime = _sniff_image_mime(img_bytes, img_ctype)
                    cmid = str(uuid.uuid4())
                    if media_service.ingest_inline_bytes(cmid, img_bytes, kind="image", mime=img_mime):
                        cover_media_id = cmid
                except Exception:
                    logger.debug("Cover download skipped for clip %s", cid, exc_info=True)

    return media_ids, clip_ids, cover_media_id, primary_meta


def _schedule_music_credits_refresh() -> None:
    async def _refresh() -> None:
        try:
            await get_flowmusic_client().sync_credits()
        except Exception:
            logger.debug("Background music credits refresh skipped", exc_info=True)

    try:
        asyncio.create_task(_refresh())
    except RuntimeError:
        pass


async def _handle_gen_music(params: dict[str, Any]) -> tuple[dict[str, Any], Optional[str]]:
    prompt = str(params.get("prompt") or params.get("sound_prompt") or "").strip()
    if not prompt:
        return {}, "请输入音乐风格或氛围描述。"

    req_id = params.get("__request_id")
    instrumental = bool(params.get("instrumental", False))
    lyrics = params.get("lyrics") if isinstance(params.get("lyrics"), str) else None
    bpm = params.get("bpm") if isinstance(params.get("bpm"), int) and not isinstance(params.get("bpm"), bool) else None
    duration_s = (
        params.get("duration_s")
        if isinstance(params.get("duration_s"), int) and not isinstance(params.get("duration_s"), bool)
        else None
    )
    model = str(params.get("music_model") or DEFAULT_MUSIC_MODEL).strip() or DEFAULT_MUSIC_MODEL
    seed = params.get("seed") if isinstance(params.get("seed"), int) and not isinstance(params.get("seed"), bool) else None
    title = params.get("title") if isinstance(params.get("title"), str) else None

    try:
        client = get_flowmusic_client()
        gen = await client.create_song(
            sound_prompt=prompt,
            lyrics=lyrics,
            instrumental=instrumental,
            bpm=bpm,
            duration_s=duration_s,
            model=model,
            seed=seed,
            title=title,
            is_canceled=lambda: _is_request_canceled(req_id),
        )
        media_ids, clip_ids, cover_media_id, primary = await _ingest_clips_result(gen["clips"])
    except FlowMusicError as exc:
        return {"error_code": exc.code}, exc.message
    except Exception as exc:  # noqa: BLE001
        logger.exception("gen_music unexpected error")
        return {}, f"音乐生成异常：{exc}"

    if not media_ids:
        return {}, "Flow Music 未生成有效音频文件，请重试。"

    _schedule_music_credits_refresh()
    dur_val = primary.get("duration") or primary.get("duration_s") or duration_s
    final_lyrics = primary.get("lyrics") if isinstance(primary.get("lyrics"), str) else ("" if instrumental else (lyrics or ""))
    final_title = (
        (primary.get("title") if isinstance(primary.get("title"), str) and primary.get("title").strip() else None)
        or (title.strip() if isinstance(title, str) and title.strip() else None)
        or "AI 音乐"
    )
    return (
        {
            "media_ids": media_ids,
            "clip_ids": clip_ids,
            "clip_id": clip_ids[0],
            "cover_media_id": cover_media_id,
            "music_title": final_title,
            "music_lyrics": final_lyrics,
            "music_duration_s": float(dur_val) if isinstance(dur_val, (int, float)) else None,
            "music_bpm": bpm,
            "music_instrumental": instrumental,
            "music_model": gen.get("model") or model,
            "conversation_id": gen.get("conversation_id"),
            "sound_prompt": gen.get("sound_prompt") or prompt,
        },
        None,
    )


async def _handle_edit_music(params: dict[str, Any]) -> tuple[dict[str, Any], Optional[str]]:
    clip_id = str(params.get("source_clip_id") or params.get("clip_id") or "").strip()
    action = str(params.get("action") or "extend").strip().lower()
    if not clip_id:
        return {}, "缺少上游 Flow Music 音频 clip_id，无法执行衍生编辑。"

    req_id = params.get("__request_id")
    instruction = str(params.get("prompt") or params.get("instruction") or "").strip()
    model = str(params.get("music_model") or DEFAULT_MUSIC_MODEL).strip() or DEFAULT_MUSIC_MODEL
    title = params.get("title") if isinstance(params.get("title"), str) else None
    seed = params.get("seed") if isinstance(params.get("seed"), int) and not isinstance(params.get("seed"), bool) else None

    try:
        client = get_flowmusic_client()
        edited = await client.edit_song(
            clip_id=clip_id,
            action=action,
            instruction=instruction,
            extend_from_s=params.get("extend_from_s"),
            extend_s=float(params.get("extend_s") or 30.0),
            replace_start_s=params.get("replace_start_s"),
            replace_end_s=params.get("replace_end_s"),
            cover_strength=float(params.get("cover_strength") or 0.65),
            seed=seed,
            title=title,
            model=model,
            is_canceled=lambda: _is_request_canceled(req_id),
        )
        media_ids, clip_ids, cover_media_id, primary = await _ingest_clips_result(edited["clips"])
    except FlowMusicError as exc:
        return {"error_code": exc.code}, exc.message
    except Exception as exc:  # noqa: BLE001
        logger.exception("edit_music unexpected error")
        return {}, f"音频衍生编辑异常：{exc}"

    if not media_ids:
        return {}, "音频编辑未返回有效音频。"

    _schedule_music_credits_refresh()
    dur_val = primary.get("duration") or primary.get("duration_s")
    final_title = (
        (primary.get("title") if isinstance(primary.get("title"), str) and primary.get("title").strip() else None)
        or (title.strip() if isinstance(title, str) and title.strip() else None)
        or f"{action.title()} 变奏"
    )
    return (
        {
            "media_ids": media_ids,
            "clip_ids": clip_ids,
            "clip_id": clip_ids[0],
            "cover_media_id": cover_media_id,
            "music_title": final_title,
            "music_lyrics": primary.get("lyrics") if isinstance(primary.get("lyrics"), str) else None,
            "music_duration_s": float(dur_val) if isinstance(dur_val, (int, float)) else None,
            "music_model": model,
            "music_edit_mode": action,
            "conversation_id": edited.get("conversation_id"),
            "source_clip_id": clip_id,
        },
        None,
    )


async def _handle_split_stems(params: dict[str, Any]) -> tuple[dict[str, Any], Optional[str]]:
    clip_id = str(params.get("clip_id") or "").strip()
    existing_media_id = str(params.get("media_id") or "").strip()
    if not clip_id:
        return {}, "当前音频节点缺少 Flow Music clip_id，仅 Flow Music 生成的歌曲支持 0 积分四轨分轨。"

    try:
        client = get_flowmusic_client()
        raw_stems = await client.split_stems(clip_id)
        cached_stems: dict[str, str] = {}
        for stem_key, info in raw_stems.items():
            if not isinstance(info, dict):
                continue
            raw_bytes: Optional[bytes] = None
            mime = str(info.get("mime") or "audio/mp4")
            if isinstance(info.get("bytes"), (bytes, bytearray)):
                raw_bytes = bytes(info["bytes"])
            elif isinstance(info.get("url"), str) and info["url"].startswith("https://"):
                raw_bytes, fetched_mime = await client.download_binary_url(info["url"])
                if fetched_mime.startswith("audio/"):
                    mime = fetched_mime
            if not raw_bytes:
                continue
            mid = str(uuid.uuid4())
            if media_service.ingest_inline_bytes(mid, raw_bytes, kind="audio", mime=mime):
                cached_stems[stem_key] = mid
    except FlowMusicError as exc:
        return {"error_code": exc.code}, exc.message
    except Exception as exc:  # noqa: BLE001
        logger.exception("split_stems unexpected error")
        return {}, f"四轨分轨异常：{exc}"

    if not cached_stems:
        return {}, "未能下载分轨音频，请稍后重试。"

    # Keep existing song media_id as primary media_ids so settlement preserves the card.
    preserved = [existing_media_id] if existing_media_id else [next(iter(cached_stems.values()))]
    return (
        {
            "media_ids": preserved,
            "stems": cached_stems,
            "clip_id": clip_id,
            "preserve_primary_media": True,
        },
        None,
    )


async def _handle_effect_music(params: dict[str, Any]) -> tuple[dict[str, Any], Optional[str]]:
    clip_id = str(params.get("source_clip_id") or params.get("clip_id") or "").strip()
    effect = str(params.get("effect") or "trim").strip().lower()
    if not clip_id:
        return {}, "缺少源音频 clip_id，无法执行裁剪/变速效果。"

    req_id = params.get("__request_id")
    try:
        client = get_flowmusic_client()
        out = await client.apply_effect(
            clip_id=clip_id,
            effect=effect,
            start_s=params.get("start_s"),
            end_s=params.get("end_s"),
            speed=params.get("speed"),
            semitones=params.get("semitones"),
            title=params.get("title") if isinstance(params.get("title"), str) else None,
            is_canceled=lambda: _is_request_canceled(req_id),
        )
        media_ids, clip_ids, cover_media_id, primary = await _ingest_clips_result(out["clips"])
    except FlowMusicError as exc:
        return {"error_code": exc.code}, exc.message
    except Exception as exc:  # noqa: BLE001
        logger.exception("effect_music unexpected error")
        return {}, f"音频裁剪/变速失败：{exc}"

    if not media_ids:
        return {}, "音频效果处理未产生输出音频。"

    dur_val = primary.get("duration") or primary.get("duration_s")
    return (
        {
            "media_ids": media_ids,
            "clip_ids": clip_ids,
            "clip_id": clip_ids[0],
            "cover_media_id": cover_media_id,
            "music_title": primary.get("title") or f"{effect} 处理音频",
            "music_duration_s": float(dur_val) if isinstance(dur_val, (int, float)) else None,
            "music_edit_mode": effect,
            "conversation_id": out.get("conversation_id"),
            "source_clip_id": clip_id,
        },
        None,
    )
