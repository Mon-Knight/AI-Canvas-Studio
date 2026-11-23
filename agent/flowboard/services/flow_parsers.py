"""Response payload parsers for Google Flow batchexecute envelopes."""
from __future__ import annotations

import re
from typing import Any, Optional

PAYGATE_TIER_BY_CODE: dict[int, str] = {
    1: "PAYGATE_TIER_ONE",
    2: "PAYGATE_TIER_TWO",
    8: "PAYGATE_TIER_TWO",
}


def _coerce_nonneg_int(val: Any) -> Optional[int]:
    if isinstance(val, bool) or val is None:
        return None
    if isinstance(val, int):
        return val if val >= 0 else None
    if isinstance(val, float):
        if val >= 0 and val == int(val):
            return int(val)
        return None
    if isinstance(val, str):
        s = val.strip()
        if s.isdigit():
            return int(s)
    return None


def parse_credits_payload(payload: Any) -> dict[str, Any]:
    """Decode Flow's ``nzlxg`` (``_.Sy`` / DleOr) 0-based JSPB response array."""
    if not isinstance(payload, list):
        return {
            "credits": 0,
            "subscription_credits": None,
            "top_up_credits": None,
            "paygate_tier": None,
            "raw_tier_code": None,
            "sku_code": None,
        }
    total = _coerce_nonneg_int(payload[0]) if len(payload) > 0 else None
    tier_code = _coerce_nonneg_int(payload[1]) if len(payload) > 1 else None
    sku_code = _coerce_nonneg_int(payload[2]) if len(payload) > 2 else None
    top_up = _coerce_nonneg_int(payload[4]) if len(payload) > 4 else None
    sub = _coerce_nonneg_int(payload[5]) if len(payload) > 5 else None
    if total is not None:
        credits = total
    elif sub is not None or top_up is not None:
        credits = (sub or 0) + (top_up or 0)
    else:
        credits = 0
    return {
        "credits": credits,
        "subscription_credits": sub,
        "top_up_credits": top_up,
        "paygate_tier": PAYGATE_TIER_BY_CODE.get(tier_code) if tier_code is not None else None,
        "raw_tier_code": tier_code,
        "sku_code": sku_code,
    }


_UUID_IN_URL_RE = re.compile(
    r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)


def _media_id_from_url(url: Optional[str]) -> Optional[str]:
    if not isinstance(url, str):
        return None
    m = _UUID_IN_URL_RE.search(url)
    return m.group(1) if m else None


def extract_operation_names(resp: Any) -> list[str]:
    """Pull ``operation.name`` out of a video-submit envelope.

    Reads ``data.operations[].operation.name``, tolerating a variant that
    inlines the name one level up. This is the shape ``_as_operation_envelope``
    builds, so a submit reads its own operation ids back out through here
    rather than returning them alongside the envelope — the two then cannot
    disagree about what was actually submitted.

    The REST path also had a ``data.workflows[]`` shape for its low-priority
    models, which carried a ``primaryMediaId`` instead of an operation. That
    branch is gone: batchexecute has no such schema, and keeping a parser for
    a response the server will never send again is how the previous migration
    attempt managed to half-work without anyone noticing which path was live.
    """
    if not isinstance(resp, dict):
        return []
    data = resp.get("data")
    if not isinstance(data, dict):
        return []
    names: list[str] = []
    ops = data.get("operations")
    if isinstance(ops, list):
        for op in ops:
            if not isinstance(op, dict):
                continue
            inner = op.get("operation") if isinstance(op.get("operation"), dict) else None
            if inner is None:
                # Some variants inline the name at top level.
                name = op.get("name")
            else:
                name = inner.get("name")
            if isinstance(name, str) and name:
                names.append(name)
    return names


def extract_video_operations(
    resp: Any, *, requested: list[str]
) -> list[dict[str, Any]]:
    """Summarise a ``batchCheckAsync`` response.

    Flow's response shape is::

        {"data": {"operations": [{
            "status": "MEDIA_GENERATION_STATUS_{PENDING,SUCCESSFUL,FAILED}",
            "operation": {"name": "<id>", "metadata": {"video": {
                "mediaId": "<uuid>", "fifeUrl": "https://flow-content..."
            }}}
        }]}}

    flowkit treats ``MEDIA_GENERATION_STATUS_SUCCESSFUL`` as terminal-success;
    we mirror that.

    Returns one entry per *requested* operation name, in order. Missing
    operations are reported as ``done=False`` so the caller can keep polling.
    """
    by_name: dict[str, dict[str, Any]] = {}
    if isinstance(resp, dict):
        data = resp.get("data")
        if isinstance(data, dict):
            ops = data.get("operations")
            if isinstance(ops, list):
                for op in ops:
                    if not isinstance(op, dict):
                        continue
                    inner = op.get("operation") if isinstance(op.get("operation"), dict) else op
                    name = inner.get("name") if isinstance(inner, dict) else None
                    if not isinstance(name, str):
                        continue
                    meta = (inner.get("metadata") or {}) if isinstance(inner, dict) else {}
                    video_meta = meta.get("video") if isinstance(meta.get("video"), dict) else {}
                    media_id = video_meta.get("mediaId") if isinstance(video_meta, dict) else None
                    fife = video_meta.get("fifeUrl") if isinstance(video_meta, dict) else None
                    # Flow's video poll response usually omits `mediaId` and only
                    # provides `mediaGenerationId` (base64 protobuf, NOT a UUID).
                    # The actual UUID is embedded in the `fifeUrl` path. Recover it.
                    if not (isinstance(media_id, str) and media_id):
                        recovered = _media_id_from_url(fife if isinstance(fife, str) else None)
                        if recovered is None and isinstance(video_meta, dict):
                            recovered = _media_id_from_url(video_meta.get("servingBaseUri"))
                        if recovered is not None:
                            media_id = recovered
                    # Flow puts the status at the *top* of each op envelope,
                    # not on the inner operation object — bug we hit before.
                    status = op.get("status") if isinstance(op.get("status"), str) else None
                    # Per-op terminal failure (e.g. PUBLIC_ERROR_AUDIO_FILTERED).
                    # Flow puts the error on the inner operation object as
                    # ``{code, message}``. We surface it so the worker can bail
                    # instead of polling for the full timeout.
                    op_err: Optional[str] = None
                    inner_err = inner.get("error") if isinstance(inner, dict) else None
                    if isinstance(inner_err, dict):
                        msg = inner_err.get("message") or inner_err.get("status") or "operation_failed"
                        op_err = str(msg)
                    if status == "MEDIA_GENERATION_STATUS_FAILED" and op_err is None:
                        op_err = "MEDIA_GENERATION_STATUS_FAILED"
                    done_flag = (
                        status == "MEDIA_GENERATION_STATUS_SUCCESSFUL"
                        or status == "MEDIA_GENERATION_STATUS_FAILED"
                        or bool(inner.get("done"))
                        or bool(media_id and fife)
                    )
                    entries = []
                    if (
                        done_flag
                        and op_err is None
                        and isinstance(media_id, str)
                    ):
                        entries.append(
                            {
                                "media_id": media_id,
                                "url": fife if isinstance(fife, str) else None,
                                "mediaType": "video",
                            }
                        )
                    by_name[name] = {
                        "name": name,
                        "done": done_flag,
                        "media_entries": entries,
                        "status": status,
                        "error": op_err,
                    }

    out: list[dict[str, Any]] = []
    for name in requested:
        out.append(
            by_name.get(
                name, {"name": name, "done": False, "media_entries": []}
            )
        )
    return out


def _extract_media_ids(resp: Any) -> list[str]:
    return [e["media_id"] for e in extract_media_entries(resp)]


def extract_media_entries(resp: Any) -> list[dict[str, Any]]:
    """Pull media entries out of a ``batchGenerateImages`` response.

    Returns a list of ``{media_id, url, mediaType}`` dicts suitable for
    ``media.ingest_urls``. ``url`` may be missing if Flow didn't include a
    ``fifeUrl`` for some reason — caller should handle that.
    """
    if not isinstance(resp, dict):
        return []
    data = resp.get("data")
    if not isinstance(data, dict):
        return []
    media = data.get("media")
    if not isinstance(media, list):
        return []
    out: list[dict[str, Any]] = []
    for m in media:
        if not isinstance(m, dict):
            continue
        media_id = m.get("name")
        if not isinstance(media_id, str) or not media_id:
            continue
        url: Optional[str] = None
        kind = "image"
        image = m.get("image") if isinstance(m.get("image"), dict) else None
        video = m.get("video") if isinstance(m.get("video"), dict) else None
        if image is not None:
            gen = image.get("generatedImage")
            if isinstance(gen, dict):
                candidate = gen.get("fifeUrl")
                if isinstance(candidate, str):
                    url = candidate
            kind = "image"
        elif video is not None:
            gen = video.get("generatedVideo") or video.get("generatedImage")
            if isinstance(gen, dict):
                candidate = gen.get("fifeUrl")
                if isinstance(candidate, str):
                    url = candidate
            kind = "video"
        out.append({"media_id": media_id, "url": url, "mediaType": kind})
    return out
