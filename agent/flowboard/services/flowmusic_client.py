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
import json
import logging
import os
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


def compose_sound_prompt(sound_prompt: str, bpm: Optional[int] = None) -> str:
    base = (sound_prompt or "").strip()
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
        text = (lyrics or "").strip()

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
    """Build the 3-node recipe graph expected by `POST /__api/recipes/create`."""
    act = (action or "").strip().lower()
    input_node: dict[str, Any] = {"type": "Input", "clip_id": clip_id}

    if act == "extend":
        op_node: dict[str, Any] = {
            "type": "ExtendSection",
            "extend_s": max(10.0, min(120.0, float(extend_s or 30.0))),
            "instruction": instruction or "Naturally continue and develop the musical piece",
        }
        if extend_from_s is not None and extend_from_s >= 0:
            op_node["extend_from_s"] = float(extend_from_s)
    elif act == "replace":
        start_s = max(0.0, float(replace_start_s or 0.0))
        end_s = max(start_s + 2.0, float(replace_end_s or (start_s + 15.0)))
        op_node = {
            "type": "ReplaceSection",
            "masks": [{"start_s": start_s, "end_s": end_s}],
            "instruction": instruction or "Rewrite this section with stronger musical energy",
        }
    elif act == "cover":
        op_node = {
            "type": "CoverSong",
            "strength": max(0.1, min(1.0, float(cover_strength))),
            "instruction": instruction or "Re-arrange in a fresh genre while keeping the melody",
        }
    else:
        raise FlowMusicError("invalid_edit_action", f"不支持的音频编辑类型：{action}")

    if seed is not None:
        op_node["seed"] = int(seed)

    output_node: dict[str, Any] = {
        "type": "Output",
        "generate_image": True,
    }
    if title:
        output_node["title"] = title.strip()[:120]

    return {
        "recipe": {
            "nodes": [input_node, op_node, output_node],
            "instruction": instruction or act,
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
    eff = (effect or "").strip().lower()
    if eff == "trim":
        st = max(0.0, float(start_s or 0.0))
        ed = max(st + 1.0, float(end_s or (st + 30.0)))
        op_node: dict[str, Any] = {"type": "Trim", "start_s": st, "end_s": ed}
    elif eff in ("tempo", "speed", "tempo_shift"):
        op_node = {
            "type": "TempoShift",
            "speed": max(0.5, min(2.0, float(speed if speed is not None else 1.0))),
            "semitones": max(-12, min(12, int(semitones if semitones is not None else 0))),
        }
    else:
        raise FlowMusicError("invalid_effect", f"不支持的音频效果类型：{effect}")
    return [{"type": "Input", "clip_id": clip_id}, op_node, {"type": "Output"}]


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


def extract_job_outcome(job_id: str, events: Iterable[SSEEvent]) -> ProducerJobOutcome:
    out = ProducerJobOutcome(job_id=job_id)
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
            if kind == "tool-call" and status == "final":
                out.tool_calls.append(part)
            elif kind == "tool-return":
                out.tool_returns.append(part)
            elif kind == "text" and status == "final":
                txt = part.get("content")
                if isinstance(txt, str) and txt:
                    out.text = f"{out.text}\n\n{txt}".strip()
        elif ev.event == "message" and isinstance(d.get("parts"), list):
            for part in d["parts"]:
                if not isinstance(part, dict):
                    continue
                kind = part.get("part_kind")
                if kind == "tool-call":
                    out.tool_calls.append(part)
                elif kind == "tool-return":
                    out.tool_returns.append(part)
                elif kind == "text":
                    txt = part.get("content")
                    if isinstance(txt, str) and txt:
                        out.text = f"{out.text}\n\n{txt}".strip()
        elif ev.event == "complete":
            out.completed = True
        elif ev.event == "error":
            msg = d.get("message") or d.get("detail") or str(ev.data)
            out.error = str(msg)
    return out


def _extract_credits_and_plan(credits_payload: Any, sub_payload: Any = None) -> tuple[Optional[int], Optional[str]]:
    credits: Optional[int] = None
    plan: Optional[str] = None
    if isinstance(credits_payload, dict):
        for key in ("credits", "remaining_credits", "balance", "total_credits", "available_credits"):
            val = credits_payload.get(key)
            if isinstance(val, (int, float)) and not isinstance(val, bool) and val >= 0:
                credits = int(val)
                break
        if credits is None and isinstance(credits_payload.get("data"), dict):
            inner = credits_payload["data"]
            for key in ("credits", "remaining_credits", "balance"):
                val = inner.get(key)
                if isinstance(val, (int, float)) and not isinstance(val, bool) and val >= 0:
                    credits = int(val)
                    break
        for pkey in ("plan", "tier", "plan_name", "subscription_tier"):
            pv = credits_payload.get(pkey)
            if isinstance(pv, str) and pv.strip():
                plan = pv.strip()
                break
    if plan is None and isinstance(sub_payload, dict):
        for pkey in ("plan", "tier", "plan_name", "name", "status"):
            pv = sub_payload.get(pkey)
            if isinstance(pv, str) and pv.strip():
                plan = pv.strip()
                break
    return credits, plan


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
        self._last_paid_dispatch: dict[str, float] = {}
        self._dispatch_lock = asyncio.Lock()

    def clear_cached_tokens(self) -> None:
        self._token_cache.clear()

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

    async def get_access_token(self, *, force_refresh: bool = False) -> str:
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
            {"refreshIfExpired": True},
            timeout=30.0,
        )
        if not isinstance(resp, dict) or resp.get("error") or not resp.get("access_token"):
            err = str((resp or {}).get("error") or "FLOWMUSIC_NOT_LOGGED_IN")
            if err == "extension_disconnected":
                raise FlowMusicError(
                    "FLOWMUSIC_EXTENSION_DISCONNECTED",
                    "扩展连接已断开，请先在右上角确认 Chrome 伴侣已就绪。",
                )
            if err == "FLOWMUSIC_NOT_LOGGED_IN":
                raise FlowMusicError(
                    "FLOWMUSIC_NOT_LOGGED_IN",
                    "当前 Google 账号尚未登录 Flow Music。请点击「开启 Flow Music 通道」在 Chrome 中完成一次 Google 登录。",
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
        """Issue an authenticated call against `/__api/*`, refreshing once on HTTP 401."""
        if self._transport_mode() == "extension_fetch" and files is None and data is None:
            full_path = f"/__api/{path.lstrip('/')}"
            if params:
                from urllib.parse import urlencode

                qs = urlencode({k: v for k, v in params.items() if v is not None})
                if qs:
                    full_path = f"{full_path}?{qs}"
            res = await flow_client.music_rpc(
                "flowmusic_fetch",
                {"path": full_path, "method": method, "body": json_body, "asText": False},
                timeout=timeout,
            )
            if not isinstance(res, dict) or res.get("error"):
                raise FlowMusicError(
                    str((res or {}).get("error") or "FLOWMUSIC_FETCH_FAILED"),
                    f"Flow Music 同源代理请求失败：{(res or {}).get('error')}",
                )
            st = int(res.get("status") or 200)
            if st >= 400:
                raise _map_http_error(st, json.dumps(res.get("data"), ensure_ascii=False))
            return res.get("data")

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
                raise FlowMusicError(
                    "FLOWMUSIC_NETWORK_ERROR",
                    f"连接 Flow Music 失败：{exc}",
                    retryable=True,
                ) from exc

            if resp.status_code == 401 and not refreshed:
                refreshed = True
                self._token_cache.pop(self._active_cache_key(), None)
                continue

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
        if self._transport_mode() == "extension_fetch":
            res = await flow_client.music_rpc(
                "flowmusic_fetch",
                {
                    "path": f"/__api/messages/{job_id}/stream?last_id=0&tool_progress=true",
                    "method": "GET",
                    "asText": True,
                },
                timeout=timeout,
            )
            if not isinstance(res, dict) or res.get("error"):
                raise FlowMusicError(
                    str((res or {}).get("error") or "FLOWMUSIC_SSE_FAILED"),
                    f"读取 Flow Music 生成流失败：{(res or {}).get('error')}",
                )
            st = int(res.get("status") or 200)
            if st >= 400:
                raise _map_http_error(st, str(res.get("text") or ""))
            return parse_sse_lines(str(res.get("text") or "").splitlines())

        refreshed = False
        while True:
            token = await self.get_access_token(force_refresh=refreshed)
            url = f"{API_BASE}/messages/{job_id}/stream"
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
                        params={"last_id": "0", "tool_progress": "true"},
                        headers=headers,
                    ) as resp:
                        if resp.status_code == 401 and not refreshed:
                            refreshed = True
                            self._token_cache.pop(self._active_cache_key(), None)
                            continue
                        if resp.status_code >= 400:
                            body = (await resp.aread()).decode("utf-8", errors="replace")
                            raise _map_http_error(resp.status_code, body)
                        lines: list[str] = []
                        async for line in resp.aiter_lines():
                            lines.append(line)
                        return parse_sse_lines(lines)
            except httpx.HTTPError as exc:
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

        signed_in = False
        email: Optional[str] = None
        models: list[dict[str, str]] = list(DEFAULT_MODELS_CATALOG)
        error_msg: Optional[str] = None

        if ext_connected and (refresh_remote or music_tab_open):
            try:
                await self.get_access_token(force_refresh=False)
                signed_in = True
                cached = self._token_cache.get(self._active_cache_key()) or {}
                email = cached.get("email")
                if refresh_remote:
                    synced = await self.sync_credits()
                    if synced.get("credits") is not None:
                        saved_credits = synced["credits"]
                    if synced.get("plan"):
                        saved_plan = synced["plan"]
                    if synced.get("models"):
                        models = synced["models"]
                    if synced.get("email"):
                        email = synced["email"]
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
        account_id = flow_accounts.active_id()
        credits_data, models_data, me_data = await asyncio.gather(
            self.request_json("GET", "/billing/credits", timeout=20.0),
            self.request_json("GET", "/models", timeout=20.0),
            self.request_json("GET", "/users/me", timeout=20.0),
            return_exceptions=True,
        )
        if isinstance(credits_data, FlowMusicError):
            raise credits_data
        if isinstance(credits_data, Exception):
            raise FlowMusicError("FLOWMUSIC_CREDITS_FAILED", f"同步 Flow Music 积分失败：{credits_data}")

        sub_data: Any = None
        try:
            sub_data = await self.request_json("GET", "/subscription", timeout=15.0)
        except Exception:
            sub_data = None

        credits, plan = _extract_credits_and_plan(credits_data, sub_data)
        models = _extract_models(models_data) if not isinstance(models_data, Exception) else list(DEFAULT_MODELS_CATALOG)
        email = me_data.get("email") if isinstance(me_data, dict) else None
        if account_id:
            flow_accounts.record_account_music_credits(account_id, credits, plan)
        return {
            "credits": credits,
            "plan": plan,
            "models": models,
            "email": email,
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
        payload = {
            "conversation_id": cid,
            "part": {
                "tool_name": tool_name,
                "args": args,
                "part_kind": "tool-call",
                "tool_call_id": f"call_{uuid.uuid4().hex[:16]}",
            },
            "client_context": client_context or {},
        }
        res = await self.request_json("POST", "/producer/tool-call", json_body=payload, timeout=45.0)
        job_id = res.get("job_id") if isinstance(res, dict) else None
        if not isinstance(job_id, str) or not job_id:
            raise FlowMusicError("FLOWMUSIC_JOB_START_FAILED", f"提交 Flow Music 工具 {tool_name} 失败。")

        events = await self.stream_job_events(job_id, timeout=timeout)
        outcome = extract_job_outcome(job_id, events)
        if not outcome.conversation_id:
            outcome.conversation_id = cid
        if outcome.error:
            raise FlowMusicError("FLOWMUSIC_PRODUCER_ERROR", f"Flow Music 生成报错：{outcome.error}")
        if outcome.failures:
            first = outcome.failures[0]
            msg = first.get("message") or first.get("reason") or first.get("error") or str(first)
            raise FlowMusicError("FLOWMUSIC_TOOL_FAILED", f"Flow Music 执行失败：{msg}")
        return outcome

    async def generate_lyrics(self, prompt: str, *, lyrics_id: Optional[str] = None) -> dict[str, str]:
        """0-credit lyrics creation or revision via Flow Music's built-in lyricist."""
        clean = (prompt or "").strip()
        if not clean:
            raise FlowMusicError("FLOWMUSIC_EMPTY_PROMPT", "请输入歌词主题或修改要求。")
        tool = "lyrics__edit" if lyrics_id else "lyrics__create"
        args: dict[str, Any] = {"prompt": clean}
        if lyrics_id:
            args["lyrics_id"] = lyrics_id
        outcome = await self.run_tool_call(tool_name=tool, args=args, timeout=90.0)
        for tr in outcome.tool_returns:
            content = tr.get("content")
            if isinstance(content, dict) and isinstance(content.get("lyrics"), str):
                return {
                    "title": str(content.get("title") or "").strip(),
                    "lyrics": content["lyrics"].strip(),
                    "lyrics_id": str(content.get("lyrics_id") or compute_lyrics_id(content["lyrics"].strip())),
                }
        if outcome.text:
            return {
                "title": outcome.title or "",
                "lyrics": outcome.text,
                "lyrics_id": compute_lyrics_id(outcome.text),
            }
        raise FlowMusicError("FLOWMUSIC_LYRICS_EMPTY", "Flow Music 未返回歌词内容，请调整描述后重试。")

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
        """Generate a full song or instrumental BGM via Direct Tool-Call (5 music credits)."""
        await self._respect_paid_cooldown()
        final_prompt = compose_sound_prompt(sound_prompt, bpm)
        if not final_prompt:
            raise FlowMusicError("FLOWMUSIC_EMPTY_PROMPT", "请输入曲风、乐器或情绪描述。")

        lyrics_id, lyrics_map = compose_lyrics_payload(
            lyrics=lyrics,
            instrumental=instrumental,
            duration_s=duration_s,
        )
        args: dict[str, Any] = {"sound_prompt": final_prompt}
        if lyrics_id:
            args["lyrics_id"] = lyrics_id
        if seed is not None:
            args["seed"] = int(seed)

        client_ctx: dict[str, Any] = {
            "selected_model": (model or DEFAULT_MUSIC_MODEL).strip() or DEFAULT_MUSIC_MODEL,
        }
        if lyrics_map:
            client_ctx["lyrics_id_map"] = lyrics_map

        outcome = await self.run_tool_call(
            tool_name="audio__create_song",
            args=args,
            client_context=client_ctx,
            timeout=180.0,
        )
        refs = outcome.clip_refs
        if not refs:
            raise FlowMusicError("FLOWMUSIC_NO_CLIPS", "Flow Music 未返回音频片段，请调整提示词后重试。")

        clips = await self.wait_for_clips(refs, is_canceled=is_canceled)

        # Best-effort rename when user supplied an explicit title
        if title and title.strip():
            clean_title = title.strip()[:120]
            for clip in clips:
                cid = clip.get("id")
                if isinstance(cid, str) and cid:
                    try:
                        await self.request_json("PATCH", f"/clips/{cid}", json_body={"title": clean_title}, timeout=15.0)
                        clip["title"] = clean_title
                    except Exception:
                        pass

        return {
            "conversation_id": outcome.conversation_id,
            "model": client_ctx["selected_model"],
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

        args: dict[str, Any] = {"recipe_id": recipe_id}
        if title and title.strip():
            args["title"] = title.strip()[:120]

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
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "mp3"
        upload_res = await self.request_json(
            "POST",
            "/producer/upload-audio",
            files={"file": (filename, raw_bytes, mime)},
            data={"file_type": ext, "filename": filename},
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

        audio_url = f"{GCS_CLIP_BASE}/{clip_id}.m4a"
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
