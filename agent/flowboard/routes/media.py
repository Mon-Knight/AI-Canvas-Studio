"""Media cache routes.

`GET /media/:media_id` streams bytes (cache hit → immediate; miss → one-shot
fetch from GCS then cache). `GET /api/media/:media_id/status` exposes cache
state for the frontend to poll while it waits for a URL to arrive.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from flowboard.node_mirror import apply_node_patch
from flowboard.routes.local_only import local_origin
from flowboard.services import flow_accounts, media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import effective_project_id, get_flow_sdk

logger = logging.getLogger(__name__)

bytes_router = APIRouter(tags=["media"])
api_router = APIRouter(prefix="/api/media", tags=["media"])


@bytes_router.get("/media/{media_id:path}")
async def get_media_bytes(media_id: str):
    media_id = media_service.normalize_media_id(media_id)
    if not media_service.is_valid_media_id(media_id):
        raise HTTPException(status_code=400, detail="invalid media_id")

    cached = media_service.cached_path(media_id)
    if cached is not None:
        return FileResponse(
            path=str(cached),
            media_type=media_service._mime_from_ext(cached.suffix),
        )

    # Cache miss — try one fetch through the stored URL.
    result = await media_service.fetch_and_cache(media_id)
    if result is None:
        status = media_service.status(media_id)
        return JSONResponse(status_code=404, content=status)
    _bytes, mime, path = result
    return FileResponse(path=str(path), media_type=mime)


@api_router.get("/{media_id}/status")
def get_media_status(media_id: str):
    media_id = media_service.normalize_media_id(media_id)
    if not media_service.is_valid_media_id(media_id):
        return JSONResponse(
            status_code=400,
            content={"available": False, "has_url": False, "reason": "invalid_id"},
        )
    return media_service.status(media_id)


class UpscaleMediaBody(BaseModel):
    resolution: str
    kind: Literal["image", "video"] = "image"
    project_id: Optional[str] = None
    aspect_ratio: Optional[str] = None
    node_id: Optional[int] = None


def _sniff_upscaled_image_mime(data: bytes) -> str:
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


@api_router.post("/{media_id}/upscale", dependencies=[Depends(local_origin)])
async def upscale_media_asset(media_id: str, body: UpscaleMediaBody):
    """On-demand HD upscale for an existing image (2K/4K) or video (1080p/4K)."""
    clean_id = media_service.normalize_media_id(media_id)
    if not media_service.is_valid_media_id(clean_id):
        raise HTTPException(status_code=400, detail="invalid media_id")

    managed, active_pid = flow_accounts.active_binding()
    pid = (
        body.project_id
        or (active_pid if managed else None)
        or effective_project_id()
        or ""
    ).strip()
    sdk = get_flow_sdk()

    if body.kind == "image":
        res = body.resolution.strip().upper()
        if res not in ("2K", "4K"):
            raise HTTPException(status_code=400, detail="图片仅支持重塑为 2K 或 4K")
        up = await sdk.upscale_image(clean_id, pid, res)
        if up.get("error"):
            raise HTTPException(status_code=502, detail=str(up["error"]))
        final_mid = (
            up.get("media_id")
            if isinstance(up.get("media_id"), str) and up.get("media_id")
            else clean_id
        )
        encoded = up.get("encoded_image")
        url = up.get("url")
        if isinstance(encoded, str) and encoded:
            raw_bytes = base64.b64decode(encoded, validate=False)
            for existing in media_service.MEDIA_CACHE_DIR.glob(f"{final_mid}.*"):
                existing.unlink(missing_ok=True)
            media_service.ingest_inline_bytes(
                final_mid,
                raw_bytes,
                kind="image",
                mime=_sniff_upscaled_image_mime(raw_bytes),
            )
        elif isinstance(url, str) and url:
            for existing in media_service.MEDIA_CACHE_DIR.glob(f"{final_mid}.*"):
                existing.unlink(missing_ok=True)
            media_service.ingest_urls([{"media_id": final_mid, "url": url, "mediaType": "image"}])
        if body.node_id is not None:
            patch: dict = {"resolution": res}
            if final_mid != clean_id:
                patch["mediaId"] = final_mid
            apply_node_patch(body.node_id, data_patch=patch)
        if flow_client.connected:
            asyncio.create_task(flow_accounts.sync_active_credits(force=True))
        return {"ok": True, "media_id": final_mid, "resolution": res}

    norm = body.resolution.strip().lower()
    if norm not in ("1080p", "4k"):
        raise HTTPException(status_code=400, detail="视频仅支持重塑为 1080p 或 4K")
    res_label = "4K" if norm == "4k" else "1080p"
    aspect = body.aspect_ratio or "VIDEO_ASPECT_RATIO_LANDSCAPE"
    up = await sdk.upscale_video(clean_id, pid, aspect_ratio=aspect, resolution=res_label)
    ops = up.get("operation_names") or []
    if up.get("error") or not ops:
        raise HTTPException(status_code=502, detail=str(up.get("error") or "upscale failed"))

    op_name = ops[0]
    new_mid: Optional[str] = None
    for _ in range(24):
        await asyncio.sleep(5.0)
        poll = await sdk.check_async([op_name])
        op = (poll.get("operations") or [{}])[0]
        if op.get("error"):
            raise HTTPException(status_code=502, detail=str(op["error"]))
        if op.get("done"):
            entries = op.get("media_entries") or []
            if entries and isinstance(entries[0], dict):
                ent = entries[0]
                new_mid = ent.get("media_id")
                if ent.get("url"):
                    media_service.ingest_urls([ent])
                if isinstance(ent.get("encoded_video"), str) and isinstance(new_mid, str):
                    media_service.ingest_inline_bytes(
                        new_mid,
                        base64.b64decode(ent["encoded_video"], validate=False),
                        kind="video",
                        mime="video/mp4",
                    )
            break

    if not new_mid:
        raise HTTPException(status_code=504, detail="视频高清重塑超时，请稍后在 Flow 项目中查看")
    if body.node_id is not None:
        from flowboard.db import get_session
        from flowboard.db.models import Node

        patch_data: dict = {"resolution": res_label}
        with get_session() as s:
            n = s.get(Node, body.node_id)
            if n is not None:
                data = n.data or {}
                mids = list(data.get("mediaIds") or [])
                if clean_id in mids:
                    patch_data["mediaIds"] = [new_mid if x == clean_id else x for x in mids]
                if data.get("mediaId") == clean_id or not data.get("mediaId"):
                    patch_data["mediaId"] = new_mid
        apply_node_patch(body.node_id, data_patch=patch_data)
    if flow_client.connected:
        asyncio.create_task(flow_accounts.sync_active_credits(force=True))
    return {"ok": True, "media_id": new_mid, "resolution": res_label}


@api_router.get("/_debug/assets")
def debug_assets():
    """Dev-only dump of every Asset row so we can see what URLs the extension
    has actually pushed to the agent. Remove once media flow is stable.
    """
    from sqlmodel import select as _select

    from flowboard.db import get_session
    from flowboard.db.models import Asset

    with get_session() as s:
        rows = s.exec(_select(Asset)).all()
        return {
            "count": len(rows),
            "rows": [
                {
                    "id": r.id,
                    "media_id": r.uuid_media_id,
                    "has_url": bool(r.url),
                    "url_head": (r.url or "")[:80] if r.url else None,
                    "mime": r.mime,
                    "cached": bool(r.local_path),
                    "node_id": r.node_id,
                }
                for r in rows
            ],
        }
