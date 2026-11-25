"""In-process worker that drains queued generation requests.

Scope for Run 3 (Phase 2 bridge): a single handler type `"proxy"` that
forwards `params = {url, method?, headers?, body?}` through the extension
via ``flow_client.api_request``. Further types (gen_image, gen_video,
upload_image, etc.) land in later runs once the full Flow protocol + captcha
round-trip is ported.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

from flowboard.db import get_session
from flowboard.db.models import Node, Request
from flowboard.node_mirror import stage_node_patch
from flowboard.request_types import MEDIA_PRODUCING_TYPES
from flowboard import config
from flowboard.services import flow_accounts, media as media_service, video_routing
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import get_flow_sdk, resolve_paygate_tier

logger = logging.getLogger(__name__)


# type → coroutine(params) → (result_dict, error_or_None)
Handler = Callable[[dict], Awaitable[tuple[dict, Optional[str]]]]


from flowboard.worker.image_handlers import (
    _handle_edit_image,
    _handle_gen_image,
    _is_foreign_media_error,
    _maybe_upscale_image_resp,
    _media_provider_of,
    _orientation_from_aspect,
    _resolve_effective_image_model,
    _sniff_image_mime,
)
from flowboard.worker.video_handlers import (
    _handle_gen_video,
    _handle_gen_video_first_last,
    _handle_gen_video_omni,
    _handle_gen_video_text,
    _is_request_canceled,
    _maybe_upscale_video_slots,
    _poll_and_ingest_video_ops,
)
from flowboard.worker.music_handlers import (
    _handle_edit_music,
    _handle_effect_music,
    _handle_gen_music,
    _handle_split_stems,
)
from flowboard.worker.settlement import (
    _commit_settlement,
    _expects_media,
    _has_media,
    _iso_utc_now,
    _node_completion_patch,
)

_ALLOWED_URL_PREFIXES: tuple[str, ...] = (
    "https://aisandbox-pa.googleapis.com/",
)


async def _handle_proxy(params: dict) -> tuple[dict, Optional[str]]:
    url = params.get("url")
    method = params.get("method", "POST")
    if not isinstance(url, str) or not url:
        return {}, "missing_url"
    # Defense-in-depth: refuse to proxy URLs outside the expected allowlist
    # even if the extension's own check was somehow bypassed.
    if not any(url.startswith(p) for p in _ALLOWED_URL_PREFIXES):
        return {}, "url_not_allowed"
    resp = await flow_client.api_request(
        url=url,
        method=method,
        headers=params.get("headers") or {},
        body=params.get("body"),
    )
    if not isinstance(resp, dict):
        return {"value": resp}, None
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    status = resp.get("status")
    if isinstance(status, int) and status >= 400:
        return resp, f"API_{status}"
    return resp, None


async def _handle_create_project(params: dict) -> tuple[dict, Optional[str]]:
    name = params.get("name") or params.get("title") or "Untitled"
    if not isinstance(name, str) or not name.strip():
        return {}, "missing_name"
    tool = params.get("tool", "PINHOLE")
    resp = await get_flow_sdk().create_project(name.strip(), tool)
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    return resp, None



# Video polling knobs — overridable in tests. 5-minute hard deadline
# (30 cycles × 10s). When the budget runs out without all ops finishing
# the handler returns the ``timeout_waiting_video`` sentinel and the
# worker stamps the row as ``status='timeout'`` (distinct from
# ``failed``) so the UI can render it as a soft auto-cancel rather than
# a generation error.
VIDEO_POLL_INTERVAL_S = 10.0
VIDEO_POLL_MAX_CYCLES = 30



_DEFAULT_HANDLERS: dict[str, Handler] = {
    "proxy": _handle_proxy,
    "create_project": _handle_create_project,
    "gen_image": _handle_gen_image,
    "gen_video": _handle_gen_video,
    "gen_video_omni": _handle_gen_video_omni,
    "gen_video_first_last": _handle_gen_video_first_last,
    "gen_video_text": _handle_gen_video_text,
    "edit_image": _handle_edit_image,
    "gen_music": _handle_gen_music,
    "edit_music": _handle_edit_music,
    "split_stems": _handle_split_stems,
    "effect_music": _handle_effect_music,
}


class WorkerController:
    """Single-consumer async queue worker."""

    def __init__(self, handlers: Optional[dict[str, Handler]] = None) -> None:
        self._queue: asyncio.Queue[int] = asyncio.Queue()
        self._handlers = dict(handlers or _DEFAULT_HANDLERS)
        self._shutdown = asyncio.Event()
        self._active = 0
        self._started_at: Optional[float] = None

    # ── enqueue ────────────────────────────────────────────────────────────
    def enqueue(self, request_id: int) -> None:
        self._queue.put_nowait(request_id)

    # ── lifecycle ──────────────────────────────────────────────────────────
    async def start(self) -> None:
        self._started_at = time.time()
        logger.info("worker started")
        while not self._shutdown.is_set():
            try:
                rid = await asyncio.wait_for(self._queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            await self._process_one(rid)

    def request_shutdown(self) -> None:
        self._shutdown.set()

    async def drain(self) -> None:
        # Wait for any in-flight task to finish.
        while self._active > 0:
            await asyncio.sleep(0.05)

    @property
    def active_count(self) -> int:
        return self._active

    @property
    def uptime_s(self) -> Optional[float]:
        if self._started_at is None:
            return None
        return time.time() - self._started_at

    # ── execution ──────────────────────────────────────────────────────────
    async def _process_one(self, rid: int) -> None:
        self._active += 1
        try:
            with get_session() as s:
                req = s.get(Request, rid)
                if req is None:
                    logger.warning("worker: request %s not found", rid)
                    return
                # Drift guard — the row might have been canceled (or
                # otherwise transitioned out of queued) between enqueue
                # and pop. The cancel endpoint mutates the DB row only;
                # it can't yank the rid back off the in-memory queue, so
                # we re-check here and bail without flipping status.
                if req.status != "queued":
                    logger.info(
                        "worker: skipping rid=%s (status=%s)", rid, req.status
                    )
                    return
                handler = self._handlers.get(req.type)
                if handler is None:
                    _commit_settlement(
                        s,
                        rid=rid,
                        stamp={
                            "status": "failed",
                            "error": f"unknown_request_type:{req.type}",
                            "finished_at": datetime.now(timezone.utc),
                        },
                        node_id=req.node_id,
                        node_status="error",
                    )
                    return

                req.status = "running"
                s.add(req)
                # Persist the processing state so a reloaded board renders
                # the node as busy without needing the browser to remember.
                stage_node_patch(s, req.node_id, status="running")
                # Plain commit, not `_commit_settlement`: this is not a
                # terminal stamp and there is no result to protect yet.
                # If it fails, letting the exception reach the handler
                # below — which marks the row failed — is the right
                # outcome, because nothing has been dispatched.
                s.commit()
                video = req.type in video_routing.TYPES
                params = dict(req.params or {})
                # Enrich with the request's node_id so handlers that need
                # to look up Node.data don't depend on the caller copying
                # it into params explicitly. Underscore prefix avoids
                # colliding with handler-defined fields.
                if req.node_id is not None and "__node_id" not in params:
                    params["__node_id"] = req.node_id
                # Long-running handlers re-check this rid between polls
                # to honor user-initiated cancels.
                params["__request_id"] = rid

            # Release the session during the possibly-long RPC.
            route_error = None
            if video:
                try:
                    params = video_routing.confirmed_params(params, params.get("flow_account_id"))
                except ValueError as exc:
                    route_error = str(exc)
            result, err = ({}, route_error) if route_error else await handler(params)

            with get_session() as s:
                req = s.get(Request, rid)
                if req is None:
                    return
                # Don't overwrite a canceled row with a late-arriving
                # done/failed stamp. The cancel endpoint already set
                # status='canceled' and finished_at; we only persist the
                # partial result for debugging visibility.
                if req.status == "canceled":
                    if isinstance(result, dict):
                        req.result = result
                        s.add(req)
                        s.commit()
                    return
                result_dict = result if isinstance(result, dict) else {"value": result}
                # A media-producing type that came back clean but rendered
                # nothing is a failure, not a success. Deciding that here —
                # on `req.type`, not on "was there media in the envelope" —
                # is what keeps `proxy` / `create_project` (legitimately
                # media-free) out of it. See _expects_media.
                if not err and _expects_media(req.type) and not _has_media(result_dict):
                    err = "no_media_returned"
                stamp: dict = {
                    "result": result_dict,
                    "finished_at": datetime.now(timezone.utc),
                }
                if err:
                    # Video-poll exhaustion gets its own status so the UI
                    # can render "TIMEOUT" instead of a generic failure.
                    stamp["status"] = (
                        "timeout" if err == "timeout_waiting_video" else "failed"
                    )
                    stamp["error"] = err
                else:
                    stamp["status"] = "done"
                    stamp["error"] = None
                # Building the patch is guarded separately from applying it
                # so neither half can throw past the Request stamp.
                node_patch: Optional[dict] = None
                if not err:
                    try:
                        existing_data: Optional[dict] = None
                        if req.node_id is not None:
                            with s.no_autoflush:
                                existing_node = s.get(Node, req.node_id)
                                if existing_node is not None and isinstance(existing_node.data, dict):
                                    existing_data = dict(existing_node.data)
                        node_patch = _node_completion_patch(
                            req, result_dict, existing_data=existing_data
                        )
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "worker: node completion patch failed for rid=%s", rid
                        )
                # Mirror onto the node in the same commit. Node.status uses
                # the vocabulary the cards render (idle|queued|running|
                # done|error), so both terminal failure modes collapse to
                # `error` — the distinction between failed and timeout
                # lives on the request row the activity feed reads.
                _commit_settlement(
                    s,
                    rid=rid,
                    stamp=stamp,
                    node_id=req.node_id,
                    node_status="error" if err else "done",
                    node_data_patch=node_patch,
                )
                if (
                    not err
                    and req.type in MEDIA_PRODUCING_TYPES
                    and flow_client.connected
                ):
                    asyncio.create_task(flow_accounts.sync_active_credits(force=True))
        except Exception as exc:  # noqa: BLE001
            logger.exception("worker exception on rid=%s", rid)
            try:
                with get_session() as s:
                    req = s.get(Request, rid)
                    if req is not None and req.status != "canceled":
                        # Same guarded shape as the happy path: if this
                        # commit is the thing that's broken (a locked DB,
                        # say) the failure stamp still has to land, or the
                        # row is stranded in `running` for good. Without
                        # the node half the card keeps the `running` stamp
                        # from dispatch and a reloaded board spins forever
                        # on a request that already gave up.
                        _commit_settlement(
                            s,
                            rid=rid,
                            stamp={
                                "status": "failed",
                                "error": str(exc)[:500],
                                "finished_at": datetime.now(timezone.utc),
                            },
                            node_id=req.node_id,
                            node_status="error",
                        )
            except Exception:  # noqa: BLE001
                logger.exception("worker: failed to record failure for rid=%s", rid)
        finally:
            self._active -= 1


_worker: Optional[WorkerController] = None


def get_worker() -> WorkerController:
    global _worker
    if _worker is None:
        _worker = WorkerController()
    return _worker
