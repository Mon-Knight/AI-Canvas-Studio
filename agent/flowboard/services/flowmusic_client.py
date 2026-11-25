"""Google Flow Music (www.flowmusic.app / Lyria 3.5) personal-credits client.

Architecture:
- Personal BYOA channel only: reuses the user's signed-in Chrome profile via the
  local Flowboard extension bridge (:8355).
- Short-lived `access_token` (~1h) is borrowed into memory ONLY and never
  written to disk or logs. `refresh_token` stays exclusively inside Chrome so
  Supabase's single-use refresh rotation never collides between tabs and agent.
- Primary transport: direct async `httpx` against `https://www.flowmusic.app/__api/*`
  with Windows system-proxy normalisation and native async SSE streaming.
- Fallback transport (`FLOWBOARD_FLOWMUSIC_TRANSPORT=extension_fetch`): relays
  same-origin `fetch()` calls through the signed-in `flowmusic.app` tab.
"""
from __future__ import annotations

import asyncio
import base64
import codecs
import json
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional

import httpx

from flowboard.services import flow_accounts, media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.ws_server import profile_music_presence

logger = logging.getLogger(__name__)

SITE_URL = "https://www.flowmusic.app"
API_BASE = f"{SITE_URL}/__api"
GCS_CLIP_BASE = "https://storage.googleapis.com/producer-app-public/clips"

# Namespace UUID used by flowmusic.app web client to hash lyrics into lyrics_id.
LYRICS_UUID_NS = uuid.UUID("b8f9e3a1-7c2d-4f5e-9a8b-1c3d5e7f9a2b")

DEFAULT_MUSIC_MODEL = "Lyria 3.5"
DEFAULT_MODELS_CATALOG = [
    {"id": "Lyria 3.5", "label": "Lyria 3.5（旗舰最新版）"},
    {"id": "Lyria 3 Pro", "label": "Lyria 3 Pro（经典专业版）"},
]

_TOKEN_REFRESH_MARGIN_S = 90.0
_POLL_INTERVAL_S = 4.0
_POLL_MAX_CYCLES = 75  # ~5 minutes hard cap
_AUDIO_TOOLS = {
    "audio__create_song",
    "lyria__generate_song",
    "audio__modify_song",
    "audio__render_edit",
    "audio__apply_effect",
    "audio__split_stems",
}


class FlowMusicError(RuntimeError):
    """Structured error surfaced cleanly to canvas nodes and API responses."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable


def compute_lyrics_id(lyrics_text: str) -> str:
    return str(uuid.uuid5(LYRICS_UUID_NS, lyrics_text))


def format_duration_tag(duration_s: int) -> str:
    clamped = max(60, min(240, int(duration_s)))
    mins, secs = divmod(clamped, 60)
    return f"[End - {mins}:{secs:02d}]"


_INVISIBLE_UNICODE_RE = re.compile(r"[\ufffc\ufffd\u200b-\u200f\u202a-\u202e\u2060\ufeff\x00-\x08\x0b\x0c\x0e-\x1f]")
_PROMPT_DECOR_RE = re.compile(r"[•●▪▫▶◆◇🎵🎶🎹🎸🥁🎤💬✨🔥🌟⭐]+")


def _sanitize_music_text(text: Optional[str], *, single_line: bool = False) -> str:
    """Strip invisible/paste-artifact chars (e.g. U+FFFC ￼ from WeChat/web) safely."""
    raw = _INVISIBLE_UNICODE_RE.sub("", text or "")
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    if single_line:
        raw = _PROMPT_DECOR_RE.sub(" ", raw)
        lines = [ln.strip(" \t-–—|") for ln in raw.splitlines() if ln.strip(" \t-–—|")]
        raw = "，".join(lines)
        raw = re.sub(r"\s{2,}", " ", raw)
        raw = re.sub(r"[，,]{2,}", "，", raw)
        return raw.strip(" ，,")
    # Preserve lyric line structure while trimming trailing spaces & excess blank lines
    cleaned_lines = [ln.strip() for ln in raw.splitlines()]
    out = "\n".join(cleaned_lines)
    out = re.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def compose_sound_prompt(sound_prompt: str, bpm: Optional[int] = None, *, max_chars: int = 420) -> str:
    base = _sanitize_music_text(sound_prompt, single_line=True)
    if max_chars > 0 and len(base) > max_chars:
        base = base[:max_chars].rstrip(" ，,;；:：")
    if bpm is not None:
        safe_bpm = max(40, min(240, int(bpm)))
        if f"{safe_bpm} bpm" not in base.lower() and "bpm" not in base.lower():
            base = f"{base}, {safe_bpm} bpm" if base else f"{safe_bpm} bpm"
    return base


def compose_lyrics_payload(
    *,
    lyrics: Optional[str] = None,
    instrumental: bool = False,
    duration_s: Optional[int] = None,
) -> tuple[Optional[str], dict[str, str]]:
    """Prepare `(lyrics_id, lyrics_id_map)` matching flowmusic.app's direct form contract."""
    if instrumental:
        text = "[Instrumental]"
    else:
        text = _sanitize_music_text(lyrics, single_line=False)

    if duration_s is not None and duration_s > 0:
        tag = format_duration_tag(duration_s)
        if "[End -" not in text:
            text = f"{text}\n\n{tag}".strip() if text else tag

    if not text:
        return None, {}

    lid = compute_lyrics_id(text)
    return lid, {lid: text}


def build_edit_recipe(
    *,
    clip_id: str,
    action: str,
    instruction: str = "",
    extend_from_s: Optional[float] = None,
    extend_s: float = 30.0,
    replace_start_s: Optional[float] = None,
    replace_end_s: Optional[float] = None,
    cover_strength: float = 0.65,
    seed: Optional[int] = None,
    title: Optional[str] = None,
) -> dict[str, Any]:
    """Build the 3-node recipe graph expected by `POST /__api/recipes/create`.

    Matches Flow Music backend Pydantic union discriminator `node_type` plus
    explicit `input_ids` / `output_ids` wiring.
    """
    act = (action or "").strip().lower()
    clean_instr = _sanitize_music_text(instruction, single_line=True)
    if len(clean_instr) > 420:
        clean_instr = clean_instr[:420].rstrip(" ，,;；:：")

    input_node: dict[str, Any] = {
        "node_type": "Input",
        "clip_id": clip_id,
        "input_ids": [],
        "output_ids": ["input"],
    }

    if act == "extend":
        op_node: dict[str, Any] = {
            "node_type": "ExtendSection",
            "input_ids": ["input"],
            "output_ids": ["processing"],
            "extend_s": max(10.0, min(120.0, float(extend_s or 30.0))),
            "extend_from_s": float(extend_from_s) if extend_from_s is not None and extend_from_s >= 0 else None,
            "instruction": clean_instr or "Naturally continue and develop the musical piece",
            "seed": int(seed) if seed is not None else None,
        }
    elif act == "replace":
        start_s = max(0.0, float(replace_start_s or 0.0))
        end_s = max(start_s + 2.0, float(replace_end_s or (start_s + 15.0)))
        op_node = {
            "node_type": "ReplaceSection",
            "input_ids": ["input"],
            "output_ids": ["processing"],
            "masks": [{"start_s": start_s, "end_s": end_s}],
            "instruction": clean_instr or "Rewrite this section with stronger musical energy",
            "seed": int(seed) if seed is not None else None,
        }
    elif act == "cover":
        op_node = {
            "node_type": "CoverSong",
            "input_ids": ["input"],
            "output_ids": ["processing"],
            "strength": max(0.1, min(1.0, float(cover_strength))),
            "instruction": clean_instr or "Re-arrange in a fresh genre while keeping the melody",
            "seed": int(seed) if seed is not None else None,
        }
    else:
        raise FlowMusicError("invalid_edit_action", f"不支持的音频编辑类型：{action}")

    out_title = (title.strip()[:120] if title and title.strip() else f"Flow Music ({act.capitalize()})")
    output_node: dict[str, Any] = {
        "node_type": "Output",
        "input_ids": ["processing"],
        "output_ids": ["output"],
        "title": out_title,
        "generate_image": True,
    }

    return {
        "recipe": {
            "nodes": [input_node, op_node, output_node],
            "instruction": clean_instr or None,
        }
    }


def build_effect_graph(
    *,
    clip_id: str,
    effect: str,
    start_s: Optional[float] = None,
    end_s: Optional[float] = None,
    speed: Optional[float] = None,
    semitones: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Build the 3-node effect graph expected by `audio__apply_effect`."""
    eff = (effect or "").strip().lower()
    input_node: dict[str, Any] = {
        "node_type": "Input",
        "node_id": "input",
        "track_id": clip_id,
    }
    if eff == "trim":
        st = max(0.0, float(start_s or 0.0))
        ed = max(st + 1.0, float(end_s or (st + 30.0)))
        op_id = "trim"
        op_node: dict[str, Any] = {
            "node_type": "Trim",
            "node_id": op_id,
            "input_ids": ["input"],
            "start_s": st,
            "end_s": ed,
        }
    elif eff in ("tempo", "speed", "tempo_shift"):
        op_id = "fx"
        op_node = {
            "node_type": "TempoShift",
            "node_id": op_id,
            "input_ids": ["input"],
            "speed": max(0.5, min(2.0, float(speed if speed is not None else 1.0))),
            "semitones": max(-12, min(12, int(semitones if semitones is not None else 0))),
        }
    else:
        raise FlowMusicError("invalid_effect", f"不支持的音频效果类型：{effect}")
    return [input_node, op_node, {"node_type": "Output", "input_ids": [op_id]}]


@dataclass
class SSEEvent:
    event: str
    data: Any
    event_id: Optional[str] = None


def parse_sse_lines(lines: Iterable[str]) -> list[SSEEvent]:
    """Parse standard text/event-stream lines into structured `SSEEvent` items."""
    events: list[SSEEvent] = []
    ev_name = "message"
    ev_id: Optional[str] = None
    data_buf: list[str] = []

    def _flush() -> None:
        nonlocal ev_name, ev_id, data_buf
        if not data_buf:
            ev_name = "message"
            ev_id = None
            return
        raw = "\n".join(data_buf)
        try:
            parsed: Any = json.loads(raw)
        except ValueError:
            parsed = raw
        events.append(SSEEvent(event=ev_name or "message", data=parsed, event_id=ev_id))
        ev_name = "message"
        ev_id = None
        data_buf = []

    for raw_line in lines:
        line = raw_line.rstrip("\r\n")
        if line == "":
            _flush()
            continue
        if line.startswith(":"):
            continue
        field_name, sep, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if not sep:
            continue
        if field_name == "event":
            ev_name = value.strip()
        elif field_name == "id":
            ev_id = value.strip()
        elif field_name == "data":
            data_buf.append(value)
    _flush()
    return events


@dataclass
class ProducerJobOutcome:
    job_id: str
    conversation_id: Optional[str] = None
    title: Optional[str] = None
    text: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    tool_returns: list[dict[str, Any]] = field(default_factory=list)
    completed: bool = False
    error: Optional[str] = None
    error_type: Optional[str] = None
    raw_error: Optional[str] = None

    @property
    def clip_refs(self) -> list[dict[str, Any]]:
        refs: list[dict[str, Any]] = []
        seen: set[str] = set()
        for tr in self.tool_returns:
            content = tr.get("content")
            if not isinstance(content, dict):
                continue
            tool_name = tr.get("tool_name")
            for out in content.get("clip_outputs") or []:
                if isinstance(out, dict) and isinstance(out.get("clip_id"), str) and out["clip_id"]:
                    cid = out["clip_id"]
                    if cid not in seen:
                        seen.add(cid)
                        refs.append(
                            {
                                "clip_id": cid,
                                "operation_id": out.get("operation_id") or content.get("operation_id"),
                                "title": out.get("title") or content.get("title"),
                                "tool": tool_name,
                            }
                        )
            for cid_key, op_key in (
                ("clip_id", "operation_id"),
                ("clip_id_b", "operation_id_b"),
                ("result_clip_id", "operation_id"),
            ):
                cid = content.get(cid_key)
                if isinstance(cid, str) and cid and cid not in seen:
                    seen.add(cid)
                    refs.append(
                        {
                            "clip_id": cid,
                            "operation_id": content.get(op_key),
                            "title": content.get("title"),
                            "tool": tool_name,
                        }
                    )
        return refs

    @property
    def failures(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for tr in self.tool_returns:
            content = tr.get("content")
            tname = tr.get("tool_name")
            if isinstance(content, dict):
                st = content.get("status")
                if st not in (None, "success", "complete", "completed", "pending", "processing"):
                    out.append({"tool": tname, **content})
            elif isinstance(content, str) and tname in _AUDIO_TOOLS and "error" in content.lower():
                out.append({"tool": tname, "status": "error", "message": content})
        return out


_UI_HIDDEN_RE = re.compile(r"<ui-hidden>[\s\S]*?</ui-hidden>", re.IGNORECASE)
_CODE_FENCE_RE = re.compile(r"^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n```\s*$")
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")
_LONG_ASCII_BLOB_RE = re.compile(r"[A-Za-z0-9+/=_-]{48,}")
_MOJIBAKE_RE = re.compile(r"(?:Ã.|å.|ç.|é.|æ.|ï¿|â€|Ð.|Ñ.){2,}")
_EXPLICIT_NON_ZH_RE = re.compile(
    r"(英文|英语|全英|english|日文|日语|japanese|韩文|韩语|korean|法语|french|西班牙语|spanish)",
    re.IGNORECASE,
)


def _clean_sse_text(raw: str) -> str:
    cleaned = _UI_HIDDEN_RE.sub("", raw or "")
    return cleaned.strip()


def _parse_tool_return_content(content: Any) -> Any:
    if isinstance(content, str):
        stripped = content.strip()
        if (stripped.startswith("{") and stripped.endswith("}")) or (
            stripped.startswith("[") and stripped.endswith("]")
        ):
            try:
                return json.loads(stripped)
            except ValueError:
                return content
    return content


def _looks_chinese_prompt(text: str) -> bool:
    if not text:
        return False
    if _EXPLICIT_NON_ZH_RE.search(text):
        return False
    return len(_CJK_RE.findall(text)) >= 2


def _clean_and_validate_lyrics(raw_text: str, *, prefer_chinese: bool = False) -> Optional[str]:
    """Sanitize generated lyrics and reject gibberish, mojibake, JSON blobs, or Base64 signatures."""
    if not isinstance(raw_text, str):
        return None
    text = _clean_sse_text(raw_text)
    if not text:
        return None

    m_fence = _CODE_FENCE_RE.match(text)
    if m_fence:
        text = m_fence.group(1).strip()

    # Unwrap accidental JSON wrapper if a model/tool returned stringified JSON
    if text.startswith("{") and text.endswith("}"):
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                extracted = obj.get("lyrics") or (
                    obj.get("data", {}).get("lyrics") if isinstance(obj.get("data"), dict) else None
                )
                if isinstance(extracted, str) and extracted.strip():
                    text = extracted.strip()
                else:
                    return None
        except ValueError:
            pass

    if "\\n" in text and "\n" not in text:
        text = text.replace("\\n", "\n")

    text = re.sub(r"\r\n?", "\n", text).strip()
    if len(text) < 16:
        return None

    # Reject UTF-8 replacement chars, control bytes, or obvious Latin-1 mojibake
    if "\ufffd" in text or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", text):
        return None
    if _MOJIBAKE_RE.search(text):
        return None

    # Reject technical JSON/SSE leaks or base64 thought_signature blobs
    low = text.lower()
    if any(
        tok in low
        for tok in (
            '"part_kind"',
            '"tool_call_id"',
            '"thought_signature"',
            '"reasoning_traces"',
            '"raw_track"',
            '"session_snapshot"',
        )
    ):
        return None
    if _LONG_ASCII_BLOB_RE.search(text):
        return None

    # Reject single-line non-lyric chatter / gibberish
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) < 2:
        return None

    if prefer_chinese:
        cjk_count = len(_CJK_RE.findall(text))
        if cjk_count < 8:
            return None

    return text


def _default_client_context(
    model: Optional[str] = None,
    lyrics_map: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    ctx: dict[str, Any] = {
        "current_song_id": None,
        "song_queue": [],
        "project_id": None,
        "selected_model": (model or DEFAULT_MUSIC_MODEL).strip() or DEFAULT_MUSIC_MODEL,
        "lyrics_id_map": lyrics_map or {},
        "ghostwriter_version": "standard",
        "onboarding_variant": None,
        "client_platform": "web",
    }
    return ctx


def extract_job_outcome(job_id: str, events: Iterable[SSEEvent]) -> ProducerJobOutcome:
    out = ProducerJobOutcome(job_id=job_id)
    text_parts: dict[int, str] = {}
    for ev in events:
        d = ev.data if isinstance(ev.data, dict) else {}
        if ev.event == "conversation_id" and isinstance(d.get("id"), str):
            out.conversation_id = d["id"]
        elif ev.event == "generated-title" and isinstance(d.get("title"), str):
            out.title = d["title"]
        elif ev.event == "part":
            part = d.get("part") or {}
            if not isinstance(part, dict):
                continue
            kind = part.get("part_kind")
            status = d.get("status")
            idx = d.get("index")
            part_idx = idx if isinstance(idx, int) else len(text_parts)
            # Never leak model thinking/reasoning traces into user-visible text.
            if kind in ("thinking", "thought", "reasoning"):
                continue
            if kind == "tool-call" and status == "final":
                out.tool_calls.append(part)
            elif kind == "tool-return" and status in (None, "final"):
                parsed_content = _parse_tool_return_content(part.get("content"))
                out.tool_returns.append({**part, "content": parsed_content})
            elif kind == "text":
                if status == "start":
                    txt = part.get("content")
                    text_parts[part_idx] = txt if isinstance(txt, str) else ""
                elif status == "delta":
                    delta = d.get("delta")
                    if isinstance(delta, str) and delta:
                        text_parts[part_idx] = text_parts.get(part_idx, "") + delta
                elif status == "final":
                    txt = part.get("content")
                    if isinstance(txt, str) and txt:
                        text_parts[part_idx] = txt
        elif ev.event == "message" and isinstance(d.get("parts"), list):
            for part in d["parts"]:
                if not isinstance(part, dict):
                    continue
                kind = part.get("part_kind")
                if kind in ("thinking", "thought", "reasoning"):
                    continue
                if kind == "tool-call":
                    out.tool_calls.append(part)
                elif kind == "tool-return":
                    parsed_content = _parse_tool_return_content(part.get("content"))
                    out.tool_returns.append({**part, "content": parsed_content})
                elif kind == "text":
                    txt = part.get("content")
                    if isinstance(txt, str) and txt:
                        text_parts[len(text_parts)] = txt
        elif ev.event in ("complete", "final"):
            out.completed = True
        elif ev.event == "error":
            err_type = d.get("type") if isinstance(d.get("type"), str) else None
            raw_err = d.get("raw_error") or d.get("error")
            msg = d.get("message") or d.get("detail") or (str(raw_err) if raw_err else str(ev.data))
            out.error_type = err_type
            out.raw_error = str(raw_err)[:300] if raw_err else None
            out.error = str(msg)

    cleaned_chunks = [_clean_sse_text(v) for _, v in sorted(text_parts.items())]
    out.text = "\n\n".join(c for c in cleaned_chunks if c).strip()
    return out


def _raise_producer_outcome_error(outcome: ProducerJobOutcome) -> None:
    """Classify and raise a clear, actionable Chinese FlowMusicError from SSE error/failure fields."""
    if outcome.error:
        etype = (outcome.error_type or "").lower()
        msg = outcome.error
        raw = outcome.raw_error or ""
        detail = f"{msg} | {raw}" if raw and raw not in msg else msg
        low = f"{etype} {detail}".lower()
        if any(
            tok in low
            for tok in ("moderation", "copyright", "policy", "artist", "flagged", "blocked", "safety", "recitation", "prohibited")
        ):
            raise FlowMusicError(
                "FLOWMUSIC_BLOCKED",
                f"触发 Flow Music 内容或版权审核（请移除真实歌手/乐队名并避免直接粘贴受版权保护的成曲歌词）：{detail}",
            )
        if "rate_limit" in low or "ratelimit" in low or "too many" in low:
            raise FlowMusicError(
                "FLOWMUSIC_RATE_LIMITED",
                f"Flow Music 请求过于频繁，请稍等片刻后重试（{detail}）",
                retryable=True,
            )
        if "credit" in low and ("insufficient" in low or "out of" in low or "not enough" in low):
            raise FlowMusicError("FLOWMUSIC_OUT_OF_CREDITS", f"Flow Music 积分不足：{detail}")
        if etype == "permission":
            raise FlowMusicError("FLOWMUSIC_NO_ACCESS", f"当前账号无此操作权限：{detail}")
        if "streaming parts" in low or etype == "inference":
            raise FlowMusicError(
                "FLOWMUSIC_PRODUCER_ERROR",
                f"Flow Music 服务端流式生成中断（{detail}）。常见原因：提示词/歌词触发版权或歌手名限制、文本过长或服务端临时波动，请精简描述并确保使用原创歌词后重试。",
                retryable=True,
            )
        raise FlowMusicError("FLOWMUSIC_PRODUCER_ERROR", f"Flow Music 生成报错：{detail}")

    if outcome.failures:
        first = outcome.failures[0]
        msg = str(first.get("message") or first.get("error_message") or first.get("reason") or first.get("error") or first)
        low = msg.lower()
        if any(tok in low for tok in ("moderation", "copyright", "policy", "artist", "flagged", "blocked", "safety", "recitation")):
            raise FlowMusicError(
                "FLOWMUSIC_BLOCKED",
                f"触发 Flow Music 内容或版权审核（请移除真实歌手名与版权歌词）：{msg}",
            )
        raise FlowMusicError("FLOWMUSIC_TOOL_FAILED", f"Flow Music 执行失败：{msg}")


def _coerce_nonneg_int(val: Any) -> Optional[int]:
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, (int, float)):
        return int(val) if val >= 0 else None
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return None
        try:
            num = float(s)
            return int(num) if num >= 0 else None
        except ValueError:
            return None
    return None


def _extract_credits_and_plan(credits_payload: Any, sub_payload: Any = None) -> tuple[Optional[int], Optional[str]]:
    credits: Optional[int] = None
    plan: Optional[str] = None

    credit_dicts: list[dict[str, Any]] = []
    if isinstance(credits_payload, dict):
        credit_dicts.append(credits_payload)
        for nested_key in ("data", "wallet", "billing", "user"):
            nested = credits_payload.get(nested_key)
            if isinstance(nested, dict):
                credit_dicts.append(nested)

    for d in credit_dicts:
        for key in (
            "credits_remaining",
            "credits",
            "remaining_credits",
            "tokens_remaining",
            "balance",
            "total_credits",
            "available_credits",
        ):
            val = _coerce_nonneg_int(d.get(key))
            if val is not None:
                credits = val
                break
        if credits is not None:
            break

    plan_dicts: list[dict[str, Any]] = []
    if isinstance(sub_payload, dict):
        plan_dicts.append(sub_payload)
        for nested_key in ("data", "subscription"):
            nested = sub_payload.get(nested_key)
            if isinstance(nested, dict):
                plan_dicts.append(nested)
    plan_dicts.extend(credit_dicts)

    for d in plan_dicts:
        for pkey in ("subscription_tier", "plan", "tier", "plan_name", "name"):
            pv = d.get(pkey)
            if isinstance(pv, str) and pv.strip():
                plan = pv.strip()
                break
        if plan is not None:
            break

    if plan is None:
        for d in plan_dicts:
            pv = d.get("status")
            if isinstance(pv, str) and pv.strip() and pv.strip().lower() not in {"ok", "success", "true", "error", "active"}:
                plan = pv.strip()
                break

    return credits, plan


def _extract_email_or_username(me_payload: Any) -> Optional[str]:
    if not isinstance(me_payload, dict):
        return None
    candidates: list[dict[str, Any]] = [me_payload]
    for nested_key in ("data", "user", "profile"):
        nested = me_payload.get(nested_key)
        if isinstance(nested, dict):
            candidates.append(nested)
    for d in candidates:
        for key in ("email",):
            v = d.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    for d in candidates:
        for key in ("username", "display_name", "name"):
            v = d.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return None


def _extract_models(models_payload: Any) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    raw_list: list[Any] = []
    if isinstance(models_payload, list):
        raw_list = models_payload
    elif isinstance(models_payload, dict):
        for k in ("models", "items", "data"):
            if isinstance(models_payload.get(k), list):
                raw_list = models_payload[k]
                break
    seen: set[str] = set()
    for entry in raw_list:
        if isinstance(entry, str) and entry.strip():
            mid = entry.strip()
            if mid not in seen:
                seen.add(mid)
                items.append({"id": mid, "label": mid})
        elif isinstance(entry, dict):
            mid = str(entry.get("name") or entry.get("id") or entry.get("display_name") or "").strip()
            lbl = str(entry.get("display_name") or entry.get("label") or mid).strip()
            if mid and mid not in seen:
                seen.add(mid)
                items.append({"id": mid, "label": lbl or mid})
    return items or list(DEFAULT_MODELS_CATALOG)


def _map_http_error(status: int, body_text: str) -> FlowMusicError:
    detail = body_text.strip()[:260]
    try:
        j = json.loads(body_text)
        if isinstance(j, dict):
            detail = str(j.get("detail") or j.get("message") or j.get("error") or detail)
    except Exception:
        pass
    low = detail.lower()
    if status == 401:
        return FlowMusicError("FLOWMUSIC_AUTH_EXPIRED", "Flow Music 登录态已过期，请刷新 Flow Music 页面后重试。", retryable=True)
    if status == 402 or "credit" in low and ("insufficient" in low or "out of" in low or "not enough" in low):
        return FlowMusicError("FLOWMUSIC_OUT_OF_CREDITS", f"Flow Music 积分不足：{detail}")
    if status == 403:
        if "cloudflare" in low or "just a moment" in low:
            return FlowMusicError(
                "FLOWMUSIC_CF_BLOCKED",
                "Flow Music 网络请求被安全校验拦截，可尝试切换同源模式（FLOWBOARD_FLOWMUSIC_TRANSPORT=extension_fetch）后重试。",
                retryable=True,
            )
        return FlowMusicError("FLOWMUSIC_NO_ACCESS", f"当前账号暂不可用 Flow Music 或受地区限制：{detail}")
    if status == 429:
        return FlowMusicError("FLOWMUSIC_RATE_LIMITED", "Flow Music 请求过于频繁，请稍等片刻后重试。", retryable=True)
    if status in (400, 422):
        if any(tok in low for tok in ("policy", "copyright", "artist", "vocal", "blocked", "unsafe")):
            return FlowMusicError("FLOWMUSIC_BLOCKED", f"提示词或音频触发 Flow Music 内容/版权规则：{detail}")
        return FlowMusicError("FLOWMUSIC_BAD_REQUEST", f"Flow Music 请求参数被拒绝：{detail}")
    if status >= 500:
        return FlowMusicError("FLOWMUSIC_SERVER_ERROR", f"Flow Music 服务端暂时异常（HTTP {status}），请稍后重试。", retryable=True)
    return FlowMusicError(f"FLOWMUSIC_HTTP_{status}", f"Flow Music 接口返回异常（HTTP {status}）：{detail}")


class FlowMusicClient:
    """Async Flow Music client using memory-only borrowed short-lived tokens."""

    def __init__(self) -> None:
        # In-memory short-lived access_token cache keyed by account_id. Never persisted.
        self._token_cache: dict[str, dict[str, Any]] = {}
        # In-memory credits/plan cache (supports legacy single-account mode too).
        self._credits_cache: dict[str, dict[str, Any]] = {}
        self._last_paid_dispatch: dict[str, float] = {}
        self._dispatch_lock = asyncio.Lock()

    def clear_cached_tokens(self) -> None:
        self._token_cache.clear()
        self._credits_cache.clear()

    @staticmethod
    def _transport_mode() -> str:
        mode = (os.getenv("FLOWBOARD_FLOWMUSIC_TRANSPORT") or "direct").strip().lower()
        return "extension_fetch" if mode == "extension_fetch" else "direct"

    @staticmethod
    def _cooldown_s() -> float:
        raw = os.getenv("FLOWBOARD_FLOWMUSIC_COOLDOWN_S", "3.0").strip()
        try:
            return max(0.0, min(60.0, float(raw)))
        except ValueError:
            return 3.0

    def _active_cache_key(self) -> str:
        return flow_accounts.active_id() or "__legacy__"

    async def get_access_token(
        self,
        *,
        force_refresh: bool = False,
        refresh_if_expired: bool = True,
    ) -> str:
        """Borrow a valid short-lived access_token from Chrome without touching refresh_token."""
        key = self._active_cache_key()
        cached = self._token_cache.get(key)
        now = time.time()
        if not force_refresh and cached:
            exp = cached.get("expires_at")
            if isinstance(cached.get("access_token"), str) and (
                not isinstance(exp, (int, float)) or exp > now + _TOKEN_REFRESH_MARGIN_S
            ):
                return cached["access_token"]

        if not flow_client.music_connected:
            raise FlowMusicError(
                "FLOWMUSIC_EXTENSION_DISCONNECTED",
                "尚未检测到当前账号的 Chrome 扩展连接。请先确保托管 Chrome 与扩展已在线。",
            )

        method = "flowmusic_refresh_session" if force_refresh else "flowmusic_get_token"
        resp = await flow_client.music_rpc(
            method,
            {"refreshIfExpired": bool(refresh_if_expired)},
            timeout=30.0,
        )
        if not isinstance(resp, dict) or resp.get("error") or not resp.get("access_token"):
            err = str((resp or {}).get("error") or "FLOWMUSIC_NOT_LOGGED_IN")
            diag = (resp or {}).get("diag") if isinstance(resp, dict) else None
            if err == "extension_disconnected":
                raise FlowMusicError(
                    "FLOWMUSIC_EXTENSION_DISCONNECTED",
                    "扩展连接已断开，请先在右上角确认 Chrome 伴侣已就绪。",
                )
            if err == "timeout":
                raise FlowMusicError(
                    "FLOWMUSIC_EXTENSION_OUTDATED",
                    "Chrome 扩展响应超时。若刚更新版本，请打开 chrome://extensions 点击 Flowboard Bridge 卡片上的「重新加载」图标后重试。",
                    retryable=True,
                )
            if err == "FLOWMUSIC_NOT_LOGGED_IN":
                if isinstance(diag, dict):
                    logger.warning("Flow Music session not detected in browser (diag=%s)", diag)
                    if diag.get("has_cookies_api") is False:
                        raise FlowMusicError(
                            "FLOWMUSIC_EXTENSION_PERMISSION",
                            "Chrome 扩展尚未启用 Flow Music Cookie 权限，请在 chrome://extensions 中重新加载 Flowboard Bridge 扩展后重试。",
                        )
                raise FlowMusicError(
                    "FLOWMUSIC_NOT_LOGGED_IN",
                    "当前 Google 账号尚未登录 Flow Music。请点击「开启 Flow Music 通道」在 Chrome 中完成一次 Google 登录；若已登录，请刷新 flowmusic.app 页面或在 chrome://extensions 重载扩展后重试。",
                )
            raise FlowMusicError(err, f"获取 Flow Music 会话失败：{err}")

        # Never accept or persist refresh_token even if an older peer ever sent one.
        token_entry = {
            "access_token": str(resp["access_token"]),
            "expires_at": resp.get("expires_at"),
            "user_id": resp.get("user_id"),
            "email": resp.get("email"),
        }
        self._token_cache[key] = token_entry
        return token_entry["access_token"]

    async def connect_browser(self, *, active: bool = True) -> dict[str, Any]:
        """Open www.flowmusic.app inside the active account's Chrome profile."""
        if flow_client.music_connected:
            resp = await flow_client.music_rpc("flowmusic_open", {"active": active}, timeout=25.0)
            if isinstance(resp, dict) and not resp.get("error"):
                return {
                    "ok": True,
                    "launched_via": "extension",
                    "music_tab_open": bool(resp.get("music_tab_open", True)),
                    "signed_in": bool(resp.get("signed_in", False)),
                    "email": resp.get("email"),
                }

        account_id = flow_accounts.active_id()
        if account_id:
            from flowboard.db import get_session
            from flowboard.db.models import FlowAccount

            with get_session() as s:
                acct = s.get(FlowAccount, account_id)
            if acct is not None:
                try:
                    flow_accounts.launch_music(acct)
                    return {
                        "ok": True,
                        "launched_via": "chrome_profile",
                        "music_tab_open": False,
                        "signed_in": False,
                        "email": None,
                    }
                except (OSError, ValueError) as exc:
                    raise FlowMusicError("FLOWMUSIC_LAUNCH_FAILED", str(exc)) from exc

        raise FlowMusicError(
            "FLOWMUSIC_EXTENSION_DISCONNECTED",
            "请先在右上角连接或打开一个 Google Flow 账号窗口，再开启 Flow Music 通道。",
        )

    async def _httpx_request(
        self,
        method: str,
        path: str,
        *,
        token: str,
        json_body: Any = None,
        params: Optional[dict[str, Any]] = None,
        files: Any = None,
        data: Any = None,
        timeout: float = 60.0,
    ) -> httpx.Response:
        url = f"{API_BASE}/{path.lstrip('/')}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Origin": SITE_URL,
            "Referer": f"{SITE_URL}/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        }
        kwargs = media_service._outbound_httpx_kwargs()
        kwargs["timeout"] = httpx.Timeout(timeout, connect=20.0)
        async with httpx.AsyncClient(**kwargs) as client:
            return await client.request(
                method,
                url,
                headers=headers,
                json=json_body,
                params=params,
                files=files,
                data=data,
            )

    @staticmethod
    def _build_api_path(path: str, params: Optional[dict[str, Any]] = None) -> str:
        full_path = f"/__api/{path.lstrip('/')}"
        if params:
            from urllib.parse import urlencode

            qs = urlencode({k: v for k, v in params.items() if v is not None})
            if qs:
                full_path = f"{full_path}?{qs}"
        return full_path

    async def _extension_fetch_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Optional[dict[str, Any]] = None,
        timeout: float = 60.0,
    ) -> Any:
        full_path = self._build_api_path(path, params)
        res = await flow_client.music_rpc(
            "flowmusic_fetch",
            {
                "path": full_path,
                "method": method,
                "body": json_body,
                "asText": False,
                "allowCookieOnly": True,
            },
            timeout=timeout,
        )
        if not isinstance(res, dict) or res.get("error"):
            err = str((res or {}).get("error") or "FLOWMUSIC_FETCH_FAILED")
            raise FlowMusicError(err, f"Flow Music 同源代理请求失败：{err}")
        st = int(res.get("status") or 200)
        if st >= 400:
            body_text = (
                res.get("data")
                if isinstance(res.get("data"), str)
                else json.dumps(res.get("data"), ensure_ascii=False)
            )
            raise _map_http_error(st, body_text)
        return res.get("data")

    async def _extension_fetch_text(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict[str, Any]] = None,
        timeout: float = 180.0,
    ) -> str:
        full_path = self._build_api_path(path, params)
        res = await flow_client.music_rpc(
            "flowmusic_fetch",
            {
                "path": full_path,
                "method": method,
                "asText": True,
                "allowCookieOnly": True,
            },
            timeout=timeout,
        )
        if not isinstance(res, dict) or res.get("error"):
            err = str((res or {}).get("error") or "FLOWMUSIC_SSE_FAILED")
            raise FlowMusicError(err, f"读取 Flow Music 生成流失败：{err}")
        st = int(res.get("status") or 200)
        if st >= 400:
            raise _map_http_error(st, str(res.get("text") or ""))
        return str(res.get("text") or "")

    async def request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: Optional[dict[str, Any]] = None,
        files: Any = None,
        data: Any = None,
        timeout: float = 60.0,
    ) -> Any:
        """Issue an authenticated call against `/__api/*`, refreshing once on HTTP 401.

        Automatically falls back to same-origin `extension_fetch` inside Chrome when
        direct Python `httpx` hits a network/proxy failure or Cloudflare 403 block.
        """
        can_proxy = files is None and data is None
        if self._transport_mode() == "extension_fetch" and can_proxy:
            return await self._extension_fetch_json(
                method, path, json_body=json_body, params=params, timeout=timeout
            )

        refreshed = False
        while True:
            token = await self.get_access_token(force_refresh=refreshed)
            try:
                resp = await self._httpx_request(
                    method,
                    path,
                    token=token,
                    json_body=json_body,
                    params=params,
                    files=files,
                    data=data,
                    timeout=timeout,
                )
            except httpx.HTTPError as exc:
                if can_proxy and flow_client.music_connected:
                    logger.info(
                        "Direct Flow Music request %s %s hit %s; falling back to Chrome extension_fetch",
                        method,
                        path,
                        exc.__class__.__name__,
                    )
                    try:
                        return await self._extension_fetch_json(
                            method, path, json_body=json_body, params=params, timeout=timeout
                        )
                    except FlowMusicError:
                        pass
                raise FlowMusicError(
                    "FLOWMUSIC_NETWORK_ERROR",
                    f"连接 Flow Music 失败：{exc}",
                    retryable=True,
                ) from exc

            if resp.status_code == 401 and not refreshed:
                refreshed = True
                self._token_cache.pop(self._active_cache_key(), None)
                continue

            if resp.status_code == 403 and can_proxy and flow_client.music_connected:
                logger.info(
                    "Direct Flow Music request %s %s returned HTTP 403; falling back to Chrome extension_fetch",
                    method,
                    path,
                )
                return await self._extension_fetch_json(
                    method, path, json_body=json_body, params=params, timeout=timeout
                )

            if resp.status_code >= 400:
                raise _map_http_error(resp.status_code, resp.text)

            if not resp.content:
                return None
            ctype = resp.headers.get("content-type", "")
            if "json" in ctype:
                return resp.json()
            try:
                return resp.json()
            except ValueError:
                return resp.text

    async def stream_job_events(self, job_id: str, *, timeout: float = 180.0) -> list[SSEEvent]:
        """Consume `GET /__api/messages/{job_id}/stream` SSE stream to completion."""
        stream_path = f"/messages/{job_id}/stream"
        stream_params = {"last_id": "0", "tool_progress": "true"}

        if self._transport_mode() == "extension_fetch":
            text = await self._extension_fetch_text(
                "GET", stream_path, params=stream_params, timeout=timeout
            )
            return parse_sse_lines(text.splitlines())

        refreshed = False
        while True:
            token = await self.get_access_token(force_refresh=refreshed)
            url = f"{API_BASE}{stream_path}"
            headers = {
                "Authorization": f"Bearer {token}",
                "Accept": "text/event-stream",
                "Origin": SITE_URL,
                "Referer": f"{SITE_URL}/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
            }
            kwargs = media_service._outbound_httpx_kwargs()
            kwargs["timeout"] = httpx.Timeout(timeout, connect=20.0, read=timeout)
            try:
                async with httpx.AsyncClient(**kwargs) as client:
                    async with client.stream(
                        "GET",
                        url,
                        params=stream_params,
                        headers=headers,
                    ) as resp:
                        if resp.status_code == 401 and not refreshed:
                            refreshed = True
                            self._token_cache.pop(self._active_cache_key(), None)
                            continue
                        if resp.status_code == 403 and flow_client.music_connected:
                            text = await self._extension_fetch_text(
                                "GET", stream_path, params=stream_params, timeout=timeout
                            )
                            return parse_sse_lines(text.splitlines())
                        if resp.status_code >= 400:
                            body = (await resp.aread()).decode("utf-8", errors="replace")
                            raise _map_http_error(resp.status_code, body)
                        decoder = codecs.getincrementaldecoder("utf-8")("replace")
                        buf = ""
                        lines: list[str] = []
                        async for chunk in resp.aiter_bytes():
                            buf += decoder.decode(chunk, final=False)
                            while "\n" in buf:
                                raw_line, buf = buf.split("\n", 1)
                                lines.append(raw_line.rstrip("\r"))
                        tail = buf + decoder.decode(b"", final=True)
                        if tail:
                            lines.extend(tail.splitlines())
                        return parse_sse_lines(lines)
            except httpx.HTTPError as exc:
                if flow_client.music_connected:
                    try:
                        text = await self._extension_fetch_text(
                            "GET", stream_path, params=stream_params, timeout=timeout
                        )
                        return parse_sse_lines(text.splitlines())
                    except FlowMusicError:
                        pass
                raise FlowMusicError(
                    "FLOWMUSIC_SSE_ERROR",
                    f"读取 Flow Music 事件流中断：{exc}",
                    retryable=True,
                ) from exc

    async def _respect_paid_cooldown(self) -> None:
        cooldown = self._cooldown_s()
        if cooldown <= 0:
            return
        key = self._active_cache_key()
        async with self._dispatch_lock:
            last = self._last_paid_dispatch.get(key, 0.0)
            wait_s = cooldown - (time.monotonic() - last)
            if wait_s > 0:
                await asyncio.sleep(wait_s)
            self._last_paid_dispatch[key] = time.monotonic()

    # ── Account & status ──────────────────────────────────────────────────

    async def get_status(self, *, refresh_remote: bool = False) -> dict[str, Any]:
        account_id = flow_accounts.active_id()
        connected, music_tab_open = profile_music_presence(account_id)
        ext_connected = flow_client.music_connected or connected

        saved_credits: Optional[int] = None
        saved_plan: Optional[str] = None
        saved_updated: Optional[str] = None
        if account_id:
            from datetime import timezone
            from flowboard.db import get_session
            from flowboard.db.models import FlowAccount

            with get_session() as s:
                row = s.get(FlowAccount, account_id)
                if row is not None:
                    saved_credits = row.music_credits
                    saved_plan = row.music_plan
                    if row.music_credits_updated_at:
                        saved_updated = row.music_credits_updated_at.replace(
                            tzinfo=timezone.utc
                        ).isoformat()

        cache_key = self._active_cache_key()
        mem_credits = self._credits_cache.get(cache_key)
        if mem_credits:
            if saved_credits is None and mem_credits.get("credits") is not None:
                saved_credits = mem_credits["credits"]
            if not saved_plan and mem_credits.get("plan"):
                saved_plan = mem_credits["plan"]
            if not saved_updated and mem_credits.get("updated_at"):
                saved_updated = mem_credits["updated_at"]

        signed_in = False
        email: Optional[str] = mem_credits.get("email") if mem_credits else None
        models: list[dict[str, str]] = list(DEFAULT_MODELS_CATALOG)
        error_msg: Optional[str] = None

        if ext_connected:
            try:
                await self.get_access_token(
                    force_refresh=False,
                    refresh_if_expired=refresh_remote,
                )
                signed_in = True
                cached = self._token_cache.get(cache_key) or {}
                if cached.get("email"):
                    email = cached["email"]
                if refresh_remote or saved_credits is None:
                    try:
                        synced = await self.sync_credits()
                        if synced.get("credits") is not None:
                            saved_credits = synced["credits"]
                        if synced.get("plan"):
                            saved_plan = synced["plan"]
                        if synced.get("models"):
                            models = synced["models"]
                        if synced.get("email"):
                            email = synced["email"]
                        if synced.get("updated_at"):
                            saved_updated = synced["updated_at"]
                    except FlowMusicError as sync_exc:
                        if sync_exc.code in ("FLOWMUSIC_AUTH_EXPIRED", "FLOWMUSIC_NOT_LOGGED_IN"):
                            signed_in = False
                        error_msg = sync_exc.message
            except FlowMusicError as exc:
                error_msg = exc.message
                signed_in = False

        return {
            "account_id": account_id,
            "extension_connected": ext_connected,
            "music_tab_open": music_tab_open,
            "signed_in": signed_in,
            "email": email,
            "music_credits": saved_credits,
            "music_plan": saved_plan,
            "music_credits_updated_at": saved_updated,
            "models": models,
            "transport": self._transport_mode(),
            "error": error_msg,
        }

    async def sync_credits(self) -> dict[str, Any]:
        """Fetch live Flow Music credits, subscription plan, and available models."""
        from datetime import datetime, timezone

        account_id = flow_accounts.active_id()
        credits_data, billing_sub_data, models_data, me_data = await asyncio.gather(
            self.request_json("GET", "/billing/credits", timeout=20.0),
            self.request_json("GET", "/billing/subscription", timeout=15.0),
            self.request_json("GET", "/models", timeout=20.0),
            self.request_json("GET", "/users/me", timeout=20.0),
            return_exceptions=True,
        )
        if isinstance(credits_data, FlowMusicError):
            raise credits_data
        if isinstance(credits_data, Exception):
            raise FlowMusicError("FLOWMUSIC_CREDITS_FAILED", f"同步 Flow Music 积分失败：{credits_data}")

        sub_data: Any = None if isinstance(billing_sub_data, Exception) else billing_sub_data
        credits, plan = _extract_credits_and_plan(credits_data, sub_data)
        if plan is None:
            try:
                legacy_sub = await self.request_json("GET", "/subscription", timeout=15.0)
                c2, p2 = _extract_credits_and_plan(credits_data, legacy_sub)
                if credits is None and c2 is not None:
                    credits = c2
                if p2:
                    plan = p2
            except Exception:
                pass

        models = _extract_models(models_data) if not isinstance(models_data, Exception) else list(DEFAULT_MODELS_CATALOG)
        cached = self._token_cache.get(self._active_cache_key()) or {}
        email = _extract_email_or_username(me_data) or cached.get("email")
        updated_iso = datetime.now(timezone.utc).isoformat()
        self._credits_cache[self._active_cache_key()] = {
            "credits": credits,
            "plan": plan,
            "email": email,
            "updated_at": updated_iso,
        }
        if account_id:
            flow_accounts.record_account_music_credits(account_id, credits, plan)
        return {
            "credits": credits,
            "plan": plan,
            "models": models,
            "email": email,
            "updated_at": updated_iso,
            "raw_credits": credits_data if isinstance(credits_data, dict) else None,
        }

    # ── Producer Tool-Call helpers ────────────────────────────────────────

    async def create_conversation(self) -> str:
        res = await self.request_json("POST", "/conversation/create", json_body={})
        if isinstance(res, dict):
            cid = res.get("conversation_id") or res.get("id")
            if isinstance(cid, str) and cid:
                return cid
        raise FlowMusicError("FLOWMUSIC_CONVERSATION_FAILED", "创建 Flow Music 会话失败。")

    async def run_tool_call(
        self,
        *,
        tool_name: str,
        args: dict[str, Any],
        conversation_id: Optional[str] = None,
        client_context: Optional[dict[str, Any]] = None,
        timeout: float = 180.0,
    ) -> ProducerJobOutcome:
        cid = conversation_id or await self.create_conversation()
        merged_ctx = _default_client_context()
        if client_context:
            merged_ctx.update(client_context)
        payload = {
            "conversation_id": cid,
            "part": {
                "tool_name": tool_name,
                "args": args,
                "part_kind": "tool-call",
                "tool_call_id": f"call_{uuid.uuid4().hex[:16]}",
            },
            "client_context": merged_ctx,
        }
        res = await self.request_json("POST", "/producer/tool-call", json_body=payload, timeout=45.0)
        job_id = res.get("job_id") if isinstance(res, dict) else None
        if not isinstance(job_id, str) or not job_id:
            raise FlowMusicError("FLOWMUSIC_JOB_START_FAILED", f"提交 Flow Music 工具 {tool_name} 失败。")

        events = await self.stream_job_events(job_id, timeout=timeout)
        outcome = extract_job_outcome(job_id, events)
        if not outcome.conversation_id:
            outcome.conversation_id = cid
        _raise_producer_outcome_error(outcome)
        return outcome

    async def register_lyrics(
        self,
        lyrics_text: str,
        *,
        conversation_id: Optional[str] = None,
        model: Optional[str] = None,
    ) -> tuple[Optional[str], Optional[str]]:
        """Register lyrics server-side via `lyrics__register`, returning `(lyrics_id, conversation_id)`."""
        outcome = await self.run_tool_call(
            tool_name="lyrics__register",
            args={"lyrics": lyrics_text},
            conversation_id=conversation_id,
            client_context=_default_client_context(model=model),
            timeout=45.0,
        )
        for tr in outcome.tool_returns:
            content = _parse_tool_return_content(tr.get("content"))
            if isinstance(content, dict):
                lid = content.get("lyrics_id") or (
                    content.get("data", {}).get("lyrics_id") if isinstance(content.get("data"), dict) else None
                )
                if isinstance(lid, str) and lid.strip():
                    return lid.strip(), outcome.conversation_id or conversation_id
        return None, outcome.conversation_id or conversation_id

    async def run_conversation_song(
        self,
        *,
        sound_prompt: str,
        lyrics_text: Optional[str] = None,
        instrumental: bool = False,
        duration_s: Optional[int] = None,
        model: Optional[str] = None,
        title: Optional[str] = None,
        conversation_id: Optional[str] = None,
        timeout: float = 180.0,
    ) -> ProducerJobOutcome:
        """Official web-UI generation path via `POST /__api/conversation` (co-producer orchestration)."""
        selected_model = (model or DEFAULT_MUSIC_MODEL).strip() or DEFAULT_MUSIC_MODEL
        lines = [f"Create and render the song immediately without asking clarifying questions.\nStyle: {sound_prompt}"]
        if title and title.strip():
            lines.append(f"Title: {title.strip()[:120]}")
        if duration_s and duration_s > 0:
            lines.append(f"Target length: {format_duration_tag(duration_s)}")
        if instrumental:
            lines.append("Make it strictly instrumental (no vocals).")
        elif lyrics_text and lyrics_text.strip():
            clean_lyr = re.sub(r"\[End\s*-\s*\d+:\d+\]", "", lyrics_text).strip()
            if clean_lyr:
                lines.append(f"Use these lyrics:\n\n{clean_lyr}")

        client_ctx = _default_client_context(model=selected_model)
        client_ctx["clarifying_questions"] = {
            "supports_question_options": False,
            "supports_multi_question_options": False,
            "arm": "questionnaire",
        }
        body: dict[str, Any] = {
            "parts": [{"content": "\n\n".join(lines), "part_kind": "user-prompt"}],
            "client_context": client_ctx,
            "model_name": "producer:standard",
            "mode": "standard",
        }
        if conversation_id:
            body["conversation_id"] = conversation_id

        res = await self.request_json("POST", "/conversation", json_body=body, timeout=45.0)
        job_id = res.get("job_id") if isinstance(res, dict) else None
        if not isinstance(job_id, str) or not job_id:
            raise FlowMusicError("FLOWMUSIC_JOB_START_FAILED", "提交 Flow Music 对话生成任务失败。")

        events = await self.stream_job_events(job_id, timeout=timeout)
        outcome = extract_job_outcome(job_id, events)
        if not outcome.conversation_id and conversation_id:
            outcome.conversation_id = conversation_id
        _raise_producer_outcome_error(outcome)
        return outcome

    async def generate_lyrics(self, prompt: str, *, lyrics_id: Optional[str] = None) -> dict[str, str]:
        """0-credit lyrics creation or revision via Flow Music's built-in lyricist."""
        clean = (prompt or "").strip()
        if not clean:
            raise FlowMusicError("FLOWMUSIC_EMPTY_PROMPT", "请输入歌词主题或修改要求。")
        prefer_zh = _looks_chinese_prompt(clean)
        anchored_prompt = (
            f"{clean}\n\n请用自然押韵的简体中文撰写完整歌词，使用 [Verse 1] / [Chorus] / [Bridge] / [Outro] 分段，只输出纯歌词。"
            if prefer_zh and not lyrics_id
            else clean
        )
        tool = "lyrics__edit" if lyrics_id else "lyrics__create"
        args: dict[str, Any] = {"prompt": anchored_prompt}
        if lyrics_id:
            args["lyrics_id"] = lyrics_id
        outcome = await self.run_tool_call(tool_name=tool, args=args, timeout=90.0)

        for tr in outcome.tool_returns:
            content = _parse_tool_return_content(tr.get("content"))
            candidates: list[tuple[str, str, Optional[str]]] = []
            if isinstance(content, dict):
                inner = content.get("data") if isinstance(content.get("data"), dict) else None
                for src in (content, inner):
                    if not isinstance(src, dict):
                        continue
                    raw_lyr = src.get("lyrics") or src.get("text")
                    if isinstance(raw_lyr, str) and raw_lyr.strip():
                        candidates.append(
                            (
                                str(src.get("title") or content.get("title") or outcome.title or "").strip(),
                                raw_lyr,
                                str(src.get("lyrics_id") or content.get("lyrics_id") or "").strip() or None,
                            )
                        )
            elif isinstance(content, str) and content.strip():
                candidates.append((outcome.title or "", content, None))

            for cand_title, raw_lyr, cand_id in candidates:
                valid = _clean_and_validate_lyrics(raw_lyr, prefer_chinese=prefer_zh)
                if valid:
                    return {
                        "title": cand_title,
                        "lyrics": valid,
                        "lyrics_id": cand_id or compute_lyrics_id(valid),
                    }

        if outcome.text:
            valid = _clean_and_validate_lyrics(outcome.text, prefer_chinese=prefer_zh)
            if valid:
                return {
                    "title": outcome.title or "",
                    "lyrics": valid,
                    "lyrics_id": compute_lyrics_id(valid),
                }

        raise FlowMusicError(
            "FLOWMUSIC_LYRICS_INVALID",
            "Flow Music 内置作词未返回有效歌词（可能含异常字符或格式不符）。请在「设置 → AI 模型」中配置对话模型以启用高质量中文作词，或调整主题后重试。",
        )

    async def wait_for_clips(
        self,
        clip_refs: list[dict[str, Any]],
        *,
        is_canceled: Optional[Callable[[], bool]] = None,
        poll_interval_s: float = _POLL_INTERVAL_S,
        max_cycles: int = _POLL_MAX_CYCLES,
    ) -> list[dict[str, Any]]:
        """Poll operation status + batch clip metadata until audio URLs are ready."""
        if not clip_refs:
            return []
        clip_ids = [r["clip_id"] for r in clip_refs if isinstance(r.get("clip_id"), str) and r["clip_id"]]
        op_by_clip = {
            r["clip_id"]: r.get("operation_id")
            for r in clip_refs
            if isinstance(r.get("clip_id"), str) and r["clip_id"]
        }

        last_clips: dict[str, dict[str, Any]] = {}
        for _ in range(max_cycles):
            if is_canceled and is_canceled():
                raise FlowMusicError("canceled", "音乐任务已取消")

            # Check explicit operation statuses when present
            for cid, op_id in list(op_by_clip.items()):
                if not op_id:
                    continue
                try:
                    st = await self.request_json("GET", f"/audio-create-song-status/{op_id}", timeout=20.0)
                    if isinstance(st, dict):
                        status_val = str(st.get("status") or "").lower()
                        if status_val in ("error", "failed", "blocked"):
                            reason = st.get("error_type") or st.get("message") or st.get("detail") or "渲染失败"
                            raise FlowMusicError("FLOWMUSIC_RENDER_FAILED", f"歌曲渲染失败：{reason}")
                        if status_val in ("complete", "completed", "done"):
                            op_by_clip[cid] = None
                except FlowMusicError:
                    raise
                except Exception:
                    pass

            batch = await self.request_json("POST", "/clips", json_body={"clip_ids": clip_ids}, timeout=25.0)
            clips_map: dict[str, dict[str, Any]] = {}
            if isinstance(batch, dict):
                raw_clips = batch.get("clips", batch)
                if isinstance(raw_clips, dict):
                    clips_map = {k: v for k, v in raw_clips.items() if isinstance(v, dict)}
                elif isinstance(raw_clips, list):
                    for item in raw_clips:
                        if isinstance(item, dict) and isinstance(item.get("id"), str):
                            clips_map[item["id"]] = item
            elif isinstance(batch, list):
                for item in batch:
                    if isinstance(item, dict) and isinstance(item.get("id"), str):
                        clips_map[item["id"]] = item

            if clips_map:
                last_clips.update(clips_map)

            all_ready = True
            for cid in clip_ids:
                meta = last_clips.get(cid) or {}
                has_audio = bool(meta.get("audio_url") or meta.get("wav_url"))
                op_pending = bool(op_by_clip.get(cid))
                clip_state = str(meta.get("status") or meta.get("state") or "").lower()
                if clip_state in ("error", "failed"):
                    raise FlowMusicError("FLOWMUSIC_RENDER_FAILED", f"音频片段 {cid} 渲染失败。")
                if not has_audio or op_pending:
                    all_ready = False
                    break

            if all_ready:
                return [
                    {"id": cid, **(last_clips.get(cid) or {})}
                    for cid in clip_ids
                ]

            await asyncio.sleep(poll_interval_s)

        raise FlowMusicError("FLOWMUSIC_TIMEOUT", "等待 Flow Music 音频渲染超时，请稍后重试。", retryable=True)

    async def create_song(
        self,
        *,
        sound_prompt: str,
        lyrics: Optional[str] = None,
        instrumental: bool = False,
        bpm: Optional[int] = None,
        duration_s: Optional[int] = None,
        model: Optional[str] = None,
        seed: Optional[int] = None,
        title: Optional[str] = None,
        is_canceled: Optional[Callable[[], bool]] = None,
    ) -> dict[str, Any]:
        """Generate a full song or instrumental BGM (5 music credits).

        Uses direct `lyrics__register` + `audio__create_song`, and automatically
        falls back once to Flow Music's official web-UI `POST /__api/conversation`
        endpoint if the direct tool-call encounters a server streaming error
        (before any clip/credits are consumed).
        """
        await self._respect_paid_cooldown()
        selected_model = (model or DEFAULT_MUSIC_MODEL).strip() or DEFAULT_MUSIC_MODEL
        final_prompt = compose_sound_prompt(sound_prompt, bpm)
        if not final_prompt:
            raise FlowMusicError("FLOWMUSIC_EMPTY_PROMPT", "请输入曲风、乐器或情绪描述。")

        lyrics_id, lyrics_map = compose_lyrics_payload(
            lyrics=lyrics,
            instrumental=instrumental,
            duration_s=duration_s,
        )
        lyrics_text = lyrics_map.get(lyrics_id) if lyrics_id else None

        cid = await self.create_conversation()
        # Register lyrics server-side just like Flow Music's web lyrics editor so
        # Lyria 3.5 direct tool calls never fail looking up unregistered lyrics_id.
        if lyrics_text:
            try:
                reg_id, reg_cid = await self.register_lyrics(
                    lyrics_text,
                    conversation_id=cid,
                    model=selected_model,
                )
                if reg_cid:
                    cid = reg_cid
                if reg_id:
                    lyrics_id = reg_id
                    lyrics_map[reg_id] = lyrics_text
            except FlowMusicError as reg_exc:
                if reg_exc.code in (
                    "FLOWMUSIC_AUTH_EXPIRED",
                    "FLOWMUSIC_NOT_LOGGED_IN",
                    "FLOWMUSIC_BLOCKED",
                    "FLOWMUSIC_OUT_OF_CREDITS",
                    "FLOWMUSIC_RATE_LIMITED",
                ):
                    raise
                logger.info("lyrics__register skipped (%s); falling back to local lyrics_id_map", reg_exc.code)
            except Exception:
                logger.debug("lyrics__register non-fatal error; continuing with local lyrics_id_map", exc_info=True)

        args: dict[str, Any] = {"sound_prompt": final_prompt}
        if lyrics_id:
            args["lyrics_id"] = lyrics_id
        if seed is not None:
            args["seed"] = int(seed)

        client_ctx = _default_client_context(model=selected_model, lyrics_map=lyrics_map)

        outcome: Optional[ProducerJobOutcome] = None
        direct_err: Optional[FlowMusicError] = None
        try:
            outcome = await self.run_tool_call(
                tool_name="audio__create_song",
                args=args,
                conversation_id=cid,
                client_context=client_ctx,
                timeout=180.0,
            )
        except FlowMusicError as exc:
            if exc.code not in ("FLOWMUSIC_PRODUCER_ERROR", "FLOWMUSIC_TOOL_FAILED", "FLOWMUSIC_NO_CLIPS"):
                raise
            direct_err = exc
            logger.info(
                "Direct audio__create_song failed (%s); falling back to official /conversation path",
                exc.code,
            )

        if outcome is None or not outcome.clip_refs:
            try:
                conv_outcome = await self.run_conversation_song(
                    sound_prompt=final_prompt,
                    lyrics_text=lyrics_text,
                    instrumental=instrumental,
                    duration_s=duration_s,
                    model=selected_model,
                    title=title,
                    conversation_id=None,
                    timeout=180.0,
                )
                outcome = conv_outcome
            except FlowMusicError as conv_exc:
                # Prefer a more specific block/policy/credits error from the co-producer
                if conv_exc.code in ("FLOWMUSIC_BLOCKED", "FLOWMUSIC_OUT_OF_CREDITS", "FLOWMUSIC_RATE_LIMITED"):
                    raise conv_exc from None
                if direct_err is not None:
                    raise direct_err from None
                raise conv_exc from None

        refs = outcome.clip_refs if outcome else []
        if not refs:
            if outcome and outcome.text:
                low_txt = outcome.text.lower()
                if any(tok in low_txt for tok in ("copyright", "artist", "policy", "cannot", "can't", "sorry", "版权", "歌手", "限制")):
                    raise FlowMusicError(
                        "FLOWMUSIC_BLOCKED",
                        f"Flow Music 拒绝了本次生成（可能涉及真实歌手名或版权歌词，请移除歌手名并使用原创歌词）：{outcome.text[:260]}",
                    )
                raise FlowMusicError("FLOWMUSIC_NO_CLIPS", f"Flow Music 未生成音频，服务端回复：{outcome.text[:260]}")
            if direct_err is not None:
                raise direct_err
            raise FlowMusicError("FLOWMUSIC_NO_CLIPS", "Flow Music 未返回音频片段，请调整提示词后重试。")

        clips = await self.wait_for_clips(refs, is_canceled=is_canceled)

        # Best-effort rename when user supplied an explicit title
        if title and title.strip():
            clean_title = title.strip()[:120]
            for clip in clips:
                cid_item = clip.get("id")
                if isinstance(cid_item, str) and cid_item:
                    try:
                        await self.request_json("PATCH", f"/clips/{cid_item}", json_body={"title": clean_title}, timeout=15.0)
                        clip["title"] = clean_title
                    except Exception:
                        pass

        return {
            "conversation_id": outcome.conversation_id,
            "model": selected_model,
            "sound_prompt": final_prompt,
            "clips": clips,
        }

    async def edit_song(
        self,
        *,
        clip_id: str,
        action: str,
        instruction: str = "",
        extend_from_s: Optional[float] = None,
        extend_s: float = 30.0,
        replace_start_s: Optional[float] = None,
        replace_end_s: Optional[float] = None,
        cover_strength: float = 0.65,
        seed: Optional[int] = None,
        title: Optional[str] = None,
        model: Optional[str] = None,
        is_canceled: Optional[Callable[[], bool]] = None,
    ) -> dict[str, Any]:
        """Run Extend / Cover / Replace recipe edit on an existing clip (5 music credits)."""
        await self._respect_paid_cooldown()
        recipe_body = build_edit_recipe(
            clip_id=clip_id,
            action=action,
            instruction=instruction,
            extend_from_s=extend_from_s,
            extend_s=extend_s,
            replace_start_s=replace_start_s,
            replace_end_s=replace_end_s,
            cover_strength=cover_strength,
            seed=seed,
            title=title,
        )
        recipe_res = await self.request_json("POST", "/recipes/create", json_body=recipe_body, timeout=30.0)
        recipe_id = recipe_res.get("recipe_id") or recipe_res.get("id") if isinstance(recipe_res, dict) else None
        if not isinstance(recipe_id, str) or not recipe_id:
            raise FlowMusicError("FLOWMUSIC_RECIPE_FAILED", "创建音频编辑配方失败。")

        out_title = title.strip()[:120] if title and title.strip() else f"Flow Music ({action.strip().capitalize()})"
        args: dict[str, Any] = {
            "recipe_id": recipe_id,
            "title": out_title,
            "image_id": None,
        }

        outcome = await self.run_tool_call(
            tool_name="audio__render_edit",
            args=args,
            client_context={"selected_model": (model or DEFAULT_MUSIC_MODEL).strip() or DEFAULT_MUSIC_MODEL},
            timeout=180.0,
        )
        refs = outcome.clip_refs
        if not refs:
            raise FlowMusicError("FLOWMUSIC_NO_CLIPS", "音频编辑未返回新片段，请重试。")
        clips = await self.wait_for_clips(refs, is_canceled=is_canceled)
        return {
            "conversation_id": outcome.conversation_id,
            "recipe_id": recipe_id,
            "action": action,
            "clips": clips,
        }

    async def split_stems(self, clip_id: str) -> dict[str, dict[str, Any]]:
        """0-credit 4-stem separation (vocals / drums / bass / other)."""
        res = await self.request_json("GET", f"/stems/clip/{clip_id}", timeout=180.0)
        stems_out: dict[str, dict[str, Any]] = {}
        raw_stems = res.get("stems") if isinstance(res, dict) else None

        if isinstance(raw_stems, dict):
            for stem_name, val in raw_stems.items():
                key = str(stem_name).strip().lower()
                if isinstance(val, str) and val.startswith("http"):
                    stems_out[key] = {"url": val}
                elif isinstance(val, str) and len(val) > 64:
                    raw_b64 = val.split(",", 1)[1] if "," in val[:64] else val
                    stems_out[key] = {"bytes": base64.b64decode(raw_b64), "mime": "audio/mp4"}
                elif isinstance(val, dict):
                    if isinstance(val.get("url"), str):
                        stems_out[key] = {"url": val["url"]}
                    elif isinstance(val.get("audio_url"), str):
                        stems_out[key] = {"url": val["audio_url"]}
                    elif isinstance(val.get("clip_id"), str):
                        stems_out[key] = {"clip_id": val["clip_id"], "url": f"{GCS_CLIP_BASE}/{val['clip_id']}.m4a"}
        elif isinstance(raw_stems, list):
            for item in raw_stems:
                if not isinstance(item, dict):
                    continue
                key = str(item.get("stem_type") or item.get("name") or "").strip().lower()
                cid = item.get("clip_id")
                url = item.get("audio_url") or item.get("url") or (f"{GCS_CLIP_BASE}/{cid}.m4a" if cid else None)
                if key and url:
                    stems_out[key] = {"clip_id": cid, "url": url}

        if stems_out:
            return stems_out

        # Fallback: direct producer tool-call `audio__split_stems`
        outcome = await self.run_tool_call(
            tool_name="audio__split_stems",
            args={"clip_id": clip_id},
            timeout=180.0,
        )
        for tr in outcome.tool_returns:
            content = tr.get("content")
            if isinstance(content, dict) and isinstance(content.get("stems"), list):
                for item in content["stems"]:
                    if isinstance(item, dict) and item.get("stem_type") and item.get("clip_id"):
                        key = str(item["stem_type"]).strip().lower()
                        cid = str(item["clip_id"])
                        stems_out[key] = {"clip_id": cid, "url": f"{GCS_CLIP_BASE}/{cid}.m4a"}
        if not stems_out:
            raise FlowMusicError("FLOWMUSIC_STEMS_FAILED", "四轨分轨未返回音轨数据，请稍后重试。")
        return stems_out

    async def apply_effect(
        self,
        *,
        clip_id: str,
        effect: str,
        start_s: Optional[float] = None,
        end_s: Optional[float] = None,
        speed: Optional[float] = None,
        semitones: Optional[int] = None,
        title: Optional[str] = None,
        is_canceled: Optional[Callable[[], bool]] = None,
    ) -> dict[str, Any]:
        """0-credit Trim / TempoShift effect on an existing clip."""
        graph = build_effect_graph(
            clip_id=clip_id,
            effect=effect,
            start_s=start_s,
            end_s=end_s,
            speed=speed,
            semitones=semitones,
        )
        args: dict[str, Any] = {
            "graph": graph,
            "output_title": (title or f"{effect}-{clip_id[:6]}").strip()[:120],
        }
        outcome = await self.run_tool_call(tool_name="audio__apply_effect", args=args, timeout=120.0)
        refs = outcome.clip_refs
        if not refs:
            raise FlowMusicError("FLOWMUSIC_EFFECT_FAILED", "音频效果处理未返回结果片段。")
        clips = await self.wait_for_clips(refs, is_canceled=is_canceled)
        return {"conversation_id": outcome.conversation_id, "effect": effect, "clips": clips}

    async def upload_and_analyze_audio(
        self,
        raw_bytes: bytes,
        filename: str,
        mime: str,
        *,
        remove_vocals: bool = False,
    ) -> dict[str, Any]:
        """Upload audio to Flow Music and run 0-credit style caption + lyrics transcription."""
        upload_res = await self.request_json(
            "POST",
            "/producer/upload-audio",
            files={"file": (filename, raw_bytes, mime)},
            data={"file_type": mime, "filename": filename},
            timeout=90.0,
        )
        if not isinstance(upload_res, dict) or not upload_res.get("clip_id"):
            raise FlowMusicError("FLOWMUSIC_UPLOAD_FAILED", "上传音频到 Flow Music 失败。")

        clip_id = str(upload_res["clip_id"])
        op_id = upload_res.get("operation_id")
        if op_id:
            for _ in range(30):
                st = await self.request_json(
                    "GET",
                    f"/producer/upload-audio/{clip_id}/upload-check-status",
                    params={"operation_id": op_id},
                    timeout=20.0,
                )
                if isinstance(st, dict) and str(st.get("status") or "").lower() in ("complete", "completed", "done"):
                    decision = str(st.get("decision") or "allowed").lower()
                    if decision == "blocked":
                        reason = st.get("reason") or "版权或地区策略限制"
                        raise FlowMusicError("FLOWMUSIC_UPLOAD_BLOCKED", f"参考音频被拦截：{reason}")
                    if decision == "requires_vocal_removal":
                        if remove_vocals:
                            await self.request_json(
                                "POST",
                                f"/producer/upload-audio/{clip_id}/remove-vocals",
                                json_body={"operation_id": op_id},
                                timeout=30.0,
                            )
                        else:
                            raise FlowMusicError(
                                "FLOWMUSIC_REQUIRES_VOCAL_REMOVAL",
                                "检测到参考音频含人声，需勾选「自动去除人声」或改用纯音乐参考。",
                            )
                    else:
                        try:
                            await self.request_json(
                                "POST",
                                f"/producer/upload-audio/{clip_id}/confirm",
                                json_body={"operation_id": op_id},
                                timeout=20.0,
                            )
                        except Exception:
                            pass
                    break
                await asyncio.sleep(2.0)

        audio_url = (
            upload_res.get("url")
            if isinstance(upload_res.get("url"), str) and upload_res["url"].startswith("http")
            else f"{GCS_CLIP_BASE}/{clip_id}.m4a"
        )
        caption_text = ""
        lyrics_text = ""
        try:
            cap_out = await self.run_tool_call(
                tool_name="audio__caption",
                args={"prompt": "Describe genre, mood, instruments, vocal style, and BPM concisely", "audio_url": audio_url},
                timeout=60.0,
            )
            for tr in cap_out.tool_returns:
                c = tr.get("content")
                if isinstance(c, dict) and isinstance(c.get("caption"), str):
                    caption_text = c["caption"].strip()
                    break
        except Exception:
            logger.debug("audio__caption failed for %s", clip_id, exc_info=True)

        try:
            tr_out = await self.run_tool_call(
                tool_name="audio__transcribe",
                args={"audio_url": audio_url},
                timeout=60.0,
            )
            for tr in tr_out.tool_returns:
                c = tr.get("content")
                if isinstance(c, dict) and isinstance(c.get("lyrics"), str):
                    lyrics_text = c["lyrics"].strip()
                    break
        except Exception:
            logger.debug("audio__transcribe failed for %s", clip_id, exc_info=True)

        return {
            "clip_id": clip_id,
            "audio_url": audio_url,
            "caption": caption_text,
            "lyrics": lyrics_text,
        }

    async def download_clip_bytes(
        self,
        clip_id: str,
        *,
        fmt: str = "m4a",
        clip_meta: Optional[dict[str, Any]] = None,
    ) -> tuple[bytes, str]:
        """Download clip audio in m4a/wav (public GCS) or mp3 (server-side transcode)."""
        norm_fmt = (fmt or "m4a").strip().lower()
        if norm_fmt not in ("m4a", "wav", "mp3"):
            norm_fmt = "m4a"

        kwargs = media_service._outbound_httpx_kwargs()
        kwargs["timeout"] = httpx.Timeout(90.0, connect=20.0)

        if norm_fmt == "mp3":
            token = await self.get_access_token(force_refresh=False)
            url = f"{API_BASE}/download/audio/{clip_id}"
            async with httpx.AsyncClient(**kwargs) as client:
                resp = await client.get(
                    url,
                    params={"format": "mp3"},
                    headers={"Authorization": f"Bearer {token}", "Origin": SITE_URL, "Referer": f"{SITE_URL}/"},
                )
            if resp.status_code != 200 or not resp.content:
                raise FlowMusicError("FLOWMUSIC_DOWNLOAD_FAILED", f"下载 MP3 失败（HTTP {resp.status_code}）")
            return resp.content, "audio/mpeg"

        url = None
        if isinstance(clip_meta, dict):
            url = clip_meta.get("wav_url") if norm_fmt == "wav" else clip_meta.get("audio_url")
        if not isinstance(url, str) or not url:
            url = f"{GCS_CLIP_BASE}/{clip_id}.{norm_fmt}"

        async with httpx.AsyncClient(**kwargs) as client:
            resp = await client.get(url)
        if resp.status_code != 200 or not resp.content:
            raise FlowMusicError("FLOWMUSIC_DOWNLOAD_FAILED", f"下载音频文件失败（HTTP {resp.status_code}）")
        mime = "audio/wav" if norm_fmt == "wav" else "audio/mp4"
        return resp.content, mime

    async def download_binary_url(self, url: str) -> tuple[bytes, str]:
        kwargs = media_service._outbound_httpx_kwargs()
        kwargs["timeout"] = httpx.Timeout(60.0, connect=20.0)
        async with httpx.AsyncClient(**kwargs) as client:
            resp = await client.get(url)
        if resp.status_code != 200 or not resp.content:
            raise FlowMusicError("FLOWMUSIC_DOWNLOAD_FAILED", f"拉取媒体资源失败（HTTP {resp.status_code}）")
        ctype = resp.headers.get("content-type", "application/octet-stream").split(";")[0].strip()
        return resp.content, ctype


flowmusic_client = FlowMusicClient()


def get_flowmusic_client() -> FlowMusicClient:
    return flowmusic_client
