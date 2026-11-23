"""Video generation (Veo i2v, Omni r2v, First-Last, T2V), polling, and upscaling handlers."""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

from flowboard.db import get_session
from flowboard.db.models import Request
from flowboard.services import media as media_service, video_routing
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import resolve_paygate_tier
from flowboard.worker.image_handlers import _is_foreign_media_error

logger = logging.getLogger(__name__)


def _proc():
    from flowboard.worker import processor as _mod
    return _mod


async def _maybe_upscale_video_slots(
    sdk,
    *,
    positional_ids: list[Optional[str]],
    succeeded_entries: list[dict],
    project_id: str,
    aspect_ratio: str,
    requested_resolution: str,
    base_resolution: str = "720p",
    rid: Optional[int] = None,
) -> tuple[list[Optional[str]], list[dict], str, Optional[str]]:
    """Best-effort 1080p/4K UPSAMPLE_VIDEO pass after base 720p clips settle."""
    norm = str(requested_resolution or "720p").strip().lower()
    if norm not in ("1080p", "4k"):
        actual_base = "360p" if str(base_resolution).strip().lower() == "360p" else "720p"
        return positional_ids, succeeded_entries, actual_base, None

    target_label = "4K" if norm == "4k" else "1080p"
    slot_to_op: dict[int, str] = {}
    submit_errors: list[str] = []

    for idx, mid in enumerate(positional_ids):
        if not isinstance(mid, str) or not mid:
            continue
        up = await sdk.upscale_video(
            mid, project_id, aspect_ratio=aspect_ratio, resolution=target_label
        )
        ops = up.get("operation_names") or []
        if up.get("error") or not ops:
            submit_errors.append(str(up.get("error") or "upscale_submit_failed")[:120])
            continue
        slot_to_op[idx] = ops[0]

    if not slot_to_op:
        return positional_ids, succeeded_entries, "720p", "; ".join(submit_errors)[:200] or None

    op_names = list(slot_to_op.values())
    done_by_op: dict[str, bool] = {op: False for op in op_names}
    entry_by_op: dict[str, dict] = {}
    attempts = 0
    while attempts < _proc().VIDEO_POLL_MAX_CYCLES and not all(done_by_op.values()):
        await asyncio.sleep(_proc().VIDEO_POLL_INTERVAL_S)
        attempts += 1
        if _is_request_canceled(rid):
            break
        poll = await sdk.check_async(op_names)
        if poll.get("error"):
            continue
        for op in poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_op.get(name, False):
                continue
            if op.get("error"):
                done_by_op[name] = True
                submit_errors.append(str(op["error"])[:120])
                continue
            if op.get("done"):
                done_by_op[name] = True
                for ent in op.get("media_entries") or []:
                    if isinstance(ent, dict) and ent.get("media_id"):
                        entry_by_op[name] = ent
                        break

    new_entries_map = {e.get("media_id"): e for e in succeeded_entries if isinstance(e, dict)}
    upscaled_any = False
    for idx, op_name in slot_to_op.items():
        ent = entry_by_op.get(op_name)
        if not isinstance(ent, dict) or not isinstance(ent.get("media_id"), str):
            continue
        old_mid = positional_ids[idx]
        new_mid = ent["media_id"]
        if ent.get("url"):
            try:
                media_service.ingest_urls([ent])
            except Exception:  # noqa: BLE001
                logger.exception("upscaled video url ingest failed")
        if isinstance(ent.get("encoded_video"), str):
            try:
                import base64 as _b64
                media_service.ingest_inline_bytes(
                    new_mid,
                    _b64.b64decode(ent["encoded_video"], validate=False),
                    kind="video",
                    mime="video/mp4",
                )
            except Exception:  # noqa: BLE001
                logger.exception("upscaled video inline ingest failed")
        if old_mid and old_mid in new_entries_map:
            del new_entries_map[old_mid]
        new_entries_map[new_mid] = ent
        positional_ids[idx] = new_mid
        upscaled_any = True

    actual_res = target_label if upscaled_any else "720p"
    warning = "; ".join(submit_errors)[:200] if submit_errors else None
    return positional_ids, list(new_entries_map.values()), actual_res, warning


def _is_request_canceled(rid: Optional[int]) -> bool:
    """Return True iff the cancel endpoint flipped this row to canceled.

    Long-running handlers call this between polls so a user-initiated
    cancel takes effect mid-flight (we can't abort the Flow HTTP calls
    themselves, but we can stop polling and let _process_one keep the
    canceled status intact).
    """
    if not isinstance(rid, int):
        return False
    with get_session() as s:
        req = s.get(Request, rid)
        if req is None:
            return True
        return req.status == "canceled"


async def _handle_gen_video(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    start_media_id = params.get("start_media_id") or params.get("startMediaId")
    raw_starts = params.get("start_media_ids")
    start_media_ids: Optional[list[str]] = None
    if isinstance(raw_starts, list):
        cleaned = [m for m in raw_starts if isinstance(m, str) and m.strip()]
        start_media_ids = [m.strip() for m in cleaned] or None

    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if params.get("media_provider", "flow") != "flow":
        return {}, video_routing.WRONG_ENGINE
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    # Either a single start_media_id OR a non-empty start_media_ids list.
    if start_media_ids is None and (
        not isinstance(start_media_id, str) or not start_media_id.strip()
    ):
        return {}, "missing_start_media_id"
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution — see the matching block in _handle_gen_image. This is
    # the handler the tier actually still matters for: it reaches
    # `resolve_video_model`, which is what separates an Ultra checkpoint from
    # a lite one.
    try:
        tier = resolve_paygate_tier(
            params.get("paygate_tier") or flow_client.paygate_tier
        )
    except ValueError as exc:
        return {}, str(exc)[:200]
    video_quality = params.get("video_quality")
    if not isinstance(video_quality, str) or not video_quality.strip():
        video_quality = None
    raw_count = params.get("variant_count")
    variant_count = raw_count if isinstance(raw_count, int) and not isinstance(raw_count, bool) and raw_count > 0 else 1
    requested_res = str(params.get("resolution") or "720p").strip()
    # Veo 3.1 only generates natively at 720p (1080p/4K via post-upscale).
    native_res = "720p"

    sdk = _proc().get_flow_sdk()
    clean_start_id = (
        start_media_id.strip()
        if isinstance(start_media_id, str) and start_media_id.strip()
        else None
    )
    dispatch = await sdk.gen_video(
        prompt=prompt.strip(),
        project_id=project_id,
        start_media_id=clean_start_id,
        start_media_ids=start_media_ids,
        aspect_ratio=aspect,
        paygate_tier=tier,
        video_quality=video_quality,
        variant_count=variant_count,
        resolution=native_res,
    )
    if dispatch.get("error") and _is_foreign_media_error(dispatch.get("error")):
        check_ids = list(start_media_ids or ([clean_start_id] if clean_start_id else []))
        if check_ids and any(media_service.cached_path(mid) is not None for mid in check_ids):
            from flowboard.services.media_project_sync import (
                MediaSyncError,
                ensure_media_ids_in_project,
                ensure_media_in_project,
            )

            try:
                synced_single = (
                    await ensure_media_in_project(clean_start_id, project_id)
                    if clean_start_id and media_service.cached_path(clean_start_id) is not None
                    else clean_start_id
                )
                synced_multi = start_media_ids
                if start_media_ids:
                    synced_multi, _ = await ensure_media_ids_in_project(start_media_ids, project_id)
                if synced_single != clean_start_id or (synced_multi and synced_multi != start_media_ids):
                    dispatch = await sdk.gen_video(
                        prompt=prompt.strip(),
                        project_id=project_id,
                        start_media_id=synced_single,
                        start_media_ids=synced_multi or None,
                        aspect_ratio=aspect,
                        paygate_tier=tier,
                        video_quality=video_quality,
                        variant_count=variant_count,
                        resolution=native_res,
                    )
            except MediaSyncError:
                pass
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"
    # NEW low-priority models return workflows (`{name, primary_media_id}`)
    # instead of operations; the SDK surfaces them on `dispatch["workflows"]`
    # so we can route the poll to /v1/media/<id> instead of batchCheckAsync.
    workflows = dispatch.get("workflows") or None

    poll_attempts = 0
    last_poll: dict = {}
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    entry_by_name: dict[str, dict] = {}
    op_errors: dict[str, str] = {}
    rid = params.get("__request_id")

    # Per-op resolution: each operation in the batch resolves
    # independently (success, content-filter rejection, or timeout). We
    # used to break the whole loop on the first per-op error, which
    # collapsed a 4-variant gen into a hard failure even when 3/4 clips
    # had already rendered. Now we let every op terminate on its own
    # and aggregate the outcome at the end so partial batches still
    # surface the variants that did succeed.
    while (
        poll_attempts < _proc().VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
    ):
        await asyncio.sleep(_proc().VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        if _is_request_canceled(rid):
            # User canceled mid-poll. Bail with the special error code
            # so _process_one knows to leave the row's canceled status
            # intact (the cancel endpoint already stamped finished_at +
            # error='canceled'). Any partial state we collected is
            # preserved on `result` for the detail viewer.
            return (
                {
                    "raw_dispatch": dispatch,
                    "last_poll": last_poll,
                    "operation_names": op_names,
                    "done": done_by_name,
                    "canceled": True,
                },
                "canceled",
            )
        last_poll = await sdk.check_async(op_names, workflows=workflows)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_name.get(name, False):
                continue
            # Per-op terminal failure (e.g. content filter
            # PUBLIC_ERROR_UNSAFE_GENERATION / PUBLIC_ERROR_AUDIO_FILTERED).
            # Mark this op resolved-with-error and keep polling the rest.
            err = op.get("error")
            if isinstance(err, str) and err:
                done_by_name[name] = True
                op_errors[name] = err
                continue
            if op.get("done"):
                done_by_name[name] = True
                # Each op is expected to yield exactly one media entry
                # on success; capture the first valid one.
                for e in op.get("media_entries") or []:
                    if isinstance(e, dict) and e.get("media_id"):
                        entry_by_name[name] = e
                        break

    # Slots still unresolved after the max cycles — record as timeout
    # so the partial summary names them alongside any filter failures.
    for name in op_names:
        if not done_by_name.get(name) and name not in op_errors:
            op_errors[name] = "timeout_waiting_video"

    # Build positional outcome aligned to dispatch order. Slot i in
    # `media_ids` corresponds to slot i in the original
    # `start_media_ids` array, so the frontend can keep upstream-image
    # variant ↔ video-variant alignment even when middle slots fail.
    # `slot_errors` mirrors the same indexing — `None` for succeeded
    # slots, error code for blocked ones — so the detail viewer can
    # render the exact filter reason on the blocked tile without
    # having to know the internal Flow op-name keys.
    positional_ids: list[Optional[str]] = []
    slot_errors: list[Optional[str]] = []
    succeeded_entries: list[dict] = []
    for name in op_names:
        e = entry_by_name.get(name)
        if isinstance(e, dict) and isinstance(e.get("media_id"), str):
            positional_ids.append(e["media_id"])
            succeeded_entries.append(e)
            slot_errors.append(None)
        else:
            positional_ids.append(None)
            slot_errors.append(op_errors.get(name))

    success_count = sum(1 for x in positional_ids if x)
    total = len(op_names)

    if success_count == 0:
        # No op produced a clip — surface the first error verbatim.
        # When all errors are "timeout_waiting_video" this matches the
        # legacy single-op timeout contract; tests rely on it.
        first_err = next(iter(op_errors.values()), "timeout_waiting_video")
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
                "op_errors": op_errors,
            },
            first_err,
        )

    # ≥1 op succeeded — ingest only the bytes we actually have.
    entries_with_urls = [
        e for e in succeeded_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_video response failed")
    # Workflow-mode (Low Priority) deliveries arrive inline as base64 MP4
    # bytes on the `/v1/media/<id>` poll — there is no GCS URL to chase.
    # Plant the bytes in the local cache directly so the `/media/<id>` route
    # serves them like any URL-backed asset.
    for entry in succeeded_entries:
        if not isinstance(entry, dict):
            continue
        encoded = entry.get("encoded_video")
        mid = entry.get("media_id")
        if not isinstance(encoded, str) or not isinstance(mid, str):
            continue
        try:
            import base64 as _b64
            media_service.ingest_inline_bytes(
                mid, _b64.b64decode(encoded, validate=False),
                kind="video", mime="video/mp4",
            )
        except Exception:  # noqa: BLE001
            logger.exception("inline ingest from workflow-mode poll failed for %s", mid)

    partial_error: Optional[str] = None
    if op_errors:
        # De-dup distinct error codes for a compact one-line summary
        # (e.g. "1/4 variants blocked: PUBLIC_ERROR_UNSAFE_GENERATION").
        unique_errs = sorted({err for err in op_errors.values()})
        partial_error = (
            f"{len(op_errors)}/{total} variants blocked: {', '.join(unique_errs)}"
        )

    positional_ids, succeeded_entries, actual_res, upscale_warning = await _maybe_upscale_video_slots(
        sdk,
        positional_ids=positional_ids,
        succeeded_entries=succeeded_entries,
        project_id=project_id,
        aspect_ratio=aspect,
        requested_resolution=requested_res,
        base_resolution=str(dispatch.get("resolution") or "720p"),
        rid=rid,
    )

    out_result: dict[str, Any] = {
        "raw_dispatch": dispatch,
        "last_poll": last_poll,
        "operation_names": op_names,
        "media_ids": positional_ids,
        "media_entries": succeeded_entries,
        "op_errors": op_errors,
        "slot_errors": slot_errors,
        "partial_error": partial_error,
        "resolution": actual_res,
    }
    if upscale_warning:
        out_result["upscale_warning"] = upscale_warning
    return out_result, None


# ── Omni Flash r2v ────────────────────────────────────────────────────────
# Variable-duration video model with a distinct endpoint + body shape from
# Veo i2v. See agent/flowboard/services/flow_sdk.py::gen_video_omni for the
# request assembly. Single operation per request (no multi-source batching
# like Veo's start_media_ids), so the polling logic collapses to a single
# op + first-error-wins, simpler than _handle_gen_video.

async def _handle_gen_video_omni(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id
    from flowboard.services.media_project_sync import (
        MediaSyncError,
        ensure_media_ids_in_project,
    )

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    raw_refs = params.get("ref_media_ids")
    if not isinstance(raw_refs, list):
        # Also accept the legacy single-source field for symmetry with
        # Veo's start_media_id, so the same upstream-walk on the frontend
        # works without a special-case.
        raw_refs = (
            [params.get("start_media_id")]
            if isinstance(params.get("start_media_id"), str)
            else []
        )
    ref_media_ids = [m for m in raw_refs if isinstance(m, str) and m.strip()]
    duration_s = params.get("duration_s")
    omni_version = "1.2" if str(params.get("omni_version") or "1.1").strip() == "1.2" else "1.1"
    raw_count = params.get("variant_count")
    variant_count = raw_count if isinstance(raw_count, int) and not isinstance(raw_count, bool) and raw_count > 0 else 1
    requested_res = str(params.get("resolution") or "720p").strip()
    native_res = "360p" if requested_res.lower() == "360p" else "720p"

    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if params.get("media_provider", "flow") != "flow":
        return {}, video_routing.WRONG_ENGINE
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if not ref_media_ids:
        return {}, "missing_ref_media_ids"
    valid_durs = range(3, 16) if omni_version == "1.2" else (4, 6, 8, 10)
    if not isinstance(duration_s, int) or isinstance(duration_s, bool) or duration_s not in valid_durs:
        return {}, "invalid_duration_s"
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_PORTRAIT"
    try:
        tier = resolve_paygate_tier(
            params.get("paygate_tier") or flow_client.paygate_tier
        )
    except ValueError as exc:
        return {}, str(exc)[:200]

    # ── Cross-project ref sync ────────────────────────────────────────
    # Flow scopes mediaIds to the project they were uploaded in. When
    # the user references media generated under another board's project
    # (the cross-board Reference library case), Flow returns 404 because
    # the asset is unknown in this project. Re-upload bytes from the
    # local cache and substitute the project-local id before dispatch.
    # First sync hits the Flow upload endpoint per ref; subsequent
    # syncs use the MediaProjectMapping cache and are free.
    try:
        synced_refs, sync_failures = await ensure_media_ids_in_project(
            ref_media_ids, project_id
        )
    except MediaSyncError as exc:
        return {}, f"sync_failed: {exc}"[:200]
    if not synced_refs:
        # Every ref failed to sync — surface the first reason.
        first = sync_failures[0][1] if sync_failures else "no_refs_synced"
        return (
            {"sync_failures": sync_failures},
            f"sync_failed: {first}"[:200],
        )
    if sync_failures:
        # Partial sync — log; proceed with the refs that worked.
        logger.warning(
            "gen_video_omni: %d ref(s) failed to sync, proceeding with %d",
            len(sync_failures), len(synced_refs),
        )

    sdk = _proc().get_flow_sdk()
    dispatch = await sdk.gen_video_omni(
        prompt=prompt.strip(),
        project_id=project_id,
        ref_media_ids=synced_refs,
        duration_s=duration_s,
        aspect_ratio=aspect,
        paygate_tier=tier,
        resolution=native_res,
        omni_version=omni_version,
        variant_count=variant_count,
    )
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"
    workflows = dispatch.get("workflows") or None

    poll_attempts = 0
    last_poll: dict = {}
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    entry_by_name: dict[str, dict] = {}
    op_errors: dict[str, str] = {}
    rid = params.get("__request_id")

    while (
        poll_attempts < _proc().VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
    ):
        await asyncio.sleep(_proc().VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        if _is_request_canceled(rid):
            return (
                {
                    "raw_dispatch": dispatch,
                    "last_poll": last_poll,
                    "operation_names": op_names,
                    "done": done_by_name,
                    "canceled": True,
                },
                "canceled",
            )
        last_poll = await sdk.check_async(op_names, workflows=workflows)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_name.get(name, False):
                continue
            err = op.get("error")
            if isinstance(err, str) and err:
                done_by_name[name] = True
                op_errors[name] = err
                continue
            if op.get("done"):
                done_by_name[name] = True
                for e in op.get("media_entries") or []:
                    if isinstance(e, dict) and e.get("media_id"):
                        entry_by_name[name] = e
                        break

    for name in op_names:
        if not done_by_name.get(name) and name not in op_errors:
            op_errors[name] = "timeout_waiting_video"

    positional_ids: list[Optional[str]] = []
    slot_errors: list[Optional[str]] = []
    succeeded_entries: list[dict] = []
    for name in op_names:
        e = entry_by_name.get(name)
        if isinstance(e, dict) and isinstance(e.get("media_id"), str):
            positional_ids.append(e["media_id"])
            succeeded_entries.append(e)
            slot_errors.append(None)
        else:
            positional_ids.append(None)
            slot_errors.append(op_errors.get(name))

    if not any(positional_ids):
        first_err = next(iter(op_errors.values()), "timeout_waiting_video")
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
                "op_errors": op_errors,
            },
            first_err,
        )

    entries_with_urls = [
        e for e in succeeded_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_video_omni response failed")
    # Omni Flash uses workflow-mode polling: Flow delivers the rendered MP4
    # inline as base64 on `/v1/media/<id>` with no signed GCS URL. Plant the
    # bytes in the local cache so `/media/<id>` can serve them.
    for entry in succeeded_entries:
        if not isinstance(entry, dict):
            continue
        encoded = entry.get("encoded_video")
        mid = entry.get("media_id")
        if not isinstance(encoded, str) or not isinstance(mid, str):
            continue
        try:
            import base64 as _b64
            media_service.ingest_inline_bytes(
                mid, _b64.b64decode(encoded, validate=False),
                kind="video", mime="video/mp4",
            )
        except Exception:  # noqa: BLE001
            logger.exception("inline ingest from omni workflow poll failed for %s", mid)

    positional_ids, succeeded_entries, actual_res, upscale_warning = await _maybe_upscale_video_slots(
        sdk,
        positional_ids=positional_ids,
        succeeded_entries=succeeded_entries,
        project_id=project_id,
        aspect_ratio=aspect,
        requested_resolution=requested_res,
        base_resolution=str(dispatch.get("resolution") or native_res),
        rid=rid,
    )

    out_result: dict[str, Any] = {
        "raw_dispatch": dispatch,
        "last_poll": last_poll,
        "operation_names": op_names,
        "media_ids": positional_ids,
        "media_entries": succeeded_entries,
        "op_errors": op_errors,
        "slot_errors": slot_errors,
        "duration_s": duration_s,
        "resolution": actual_res,
        "omni_version": omni_version,
    }
    if upscale_warning:
        out_result["upscale_warning"] = upscale_warning
    return out_result, None


async def _poll_and_ingest_video_ops(
    sdk,
    *,
    dispatch: dict[str, Any],
    project_id: str,
    aspect: str,
    requested_res: str,
    default_base_res: str,
    rid: Optional[int],
    extra_result: Optional[dict[str, Any]] = None,
) -> tuple[dict, Optional[str]]:
    """Shared poll + URL/inline ingest + post-upscale pipeline for batch video RPCs."""
    op_names = dispatch.get("operation_names") or []
    if not op_names:
        return dispatch, "no_operations_returned"
    workflows = dispatch.get("workflows") or None

    poll_attempts = 0
    last_poll: dict = {}
    done_by_name: dict[str, bool] = {name: False for name in op_names}
    entry_by_name: dict[str, dict] = {}
    op_errors: dict[str, str] = {}

    while (
        poll_attempts < _proc().VIDEO_POLL_MAX_CYCLES
        and not all(done_by_name.values())
    ):
        await asyncio.sleep(_proc().VIDEO_POLL_INTERVAL_S)
        poll_attempts += 1
        if _is_request_canceled(rid):
            return (
                {
                    "raw_dispatch": dispatch,
                    "last_poll": last_poll,
                    "operation_names": op_names,
                    "done": done_by_name,
                    "canceled": True,
                },
                "canceled",
            )
        last_poll = await sdk.check_async(op_names, workflows=workflows)
        if last_poll.get("error"):
            continue
        for op in last_poll.get("operations") or []:
            if not isinstance(op, dict):
                continue
            name = op.get("name")
            if not isinstance(name, str) or done_by_name.get(name, False):
                continue
            err = op.get("error")
            if isinstance(err, str) and err:
                done_by_name[name] = True
                op_errors[name] = err
                continue
            if op.get("done"):
                done_by_name[name] = True
                for e in op.get("media_entries") or []:
                    if isinstance(e, dict) and e.get("media_id"):
                        entry_by_name[name] = e
                        break

    for name in op_names:
        if not done_by_name.get(name) and name not in op_errors:
            op_errors[name] = "timeout_waiting_video"

    positional_ids: list[Optional[str]] = []
    slot_errors: list[Optional[str]] = []
    succeeded_entries: list[dict] = []
    for name in op_names:
        e = entry_by_name.get(name)
        if isinstance(e, dict) and isinstance(e.get("media_id"), str):
            positional_ids.append(e["media_id"])
            succeeded_entries.append(e)
            slot_errors.append(None)
        else:
            positional_ids.append(None)
            slot_errors.append(op_errors.get(name))

    if not any(positional_ids):
        first_err = next(iter(op_errors.values()), "timeout_waiting_video")
        return (
            {
                "raw_dispatch": dispatch,
                "last_poll": last_poll,
                "operation_names": op_names,
                "done": done_by_name,
                "op_errors": op_errors,
            },
            first_err,
        )

    entries_with_urls = [
        e for e in succeeded_entries if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from video response failed")

    for entry in succeeded_entries:
        if not isinstance(entry, dict):
            continue
        encoded = entry.get("encoded_video")
        mid = entry.get("media_id")
        if not isinstance(encoded, str) or not isinstance(mid, str):
            continue
        try:
            import base64 as _b64

            media_service.ingest_inline_bytes(
                mid,
                _b64.b64decode(encoded, validate=False),
                kind="video",
                mime="video/mp4",
            )
        except Exception:  # noqa: BLE001
            logger.exception("inline ingest from video poll failed for %s", mid)

    positional_ids, succeeded_entries, actual_res, upscale_warning = await _maybe_upscale_video_slots(
        sdk,
        positional_ids=positional_ids,
        succeeded_entries=succeeded_entries,
        project_id=project_id,
        aspect_ratio=aspect,
        requested_resolution=requested_res,
        base_resolution=str(dispatch.get("resolution") or default_base_res),
        rid=rid,
    )

    out_result: dict[str, Any] = {
        "raw_dispatch": dispatch,
        "last_poll": last_poll,
        "operation_names": op_names,
        "media_ids": positional_ids,
        "media_entries": succeeded_entries,
        "op_errors": op_errors,
        "slot_errors": slot_errors,
        "resolution": actual_res,
    }
    if extra_result:
        out_result.update(extra_result)
    if upscale_warning:
        out_result["upscale_warning"] = upscale_warning
    return out_result, None


async def _handle_gen_video_first_last(params: dict) -> tuple[dict, Optional[str]]:
    """Native Omni first+last frame locked video generation (RPC ``nprQif``)."""
    from flowboard.services.flow_sdk import is_valid_project_id
    from flowboard.services.media_project_sync import (
        MediaSyncError,
        ensure_media_ids_in_project,
    )

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    start_media_id = params.get("start_media_id") or params.get("startMediaId")
    end_media_id = params.get("end_media_id") or params.get("endMediaId")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if params.get("media_provider", "flow") != "flow":
        return {}, video_routing.WRONG_ENGINE
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if (
        not isinstance(start_media_id, str)
        or not start_media_id.strip()
        or not isinstance(end_media_id, str)
        or not end_media_id.strip()
    ):
        return {}, "missing_first_last_media_id"

    raw_dur = params.get("duration_s")
    dur = (
        min((4, 6, 8, 10), key=lambda d: abs(d - raw_dur))
        if isinstance(raw_dur, int) and not isinstance(raw_dur, bool)
        else 8
    )
    raw_count = params.get("variant_count")
    variant_count = (
        raw_count
        if isinstance(raw_count, int) and not isinstance(raw_count, bool) and raw_count > 0
        else 1
    )
    requested_res = str(params.get("resolution") or "720p").strip()
    native_res = "360p" if requested_res.lower() == "360p" else "720p"
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_LANDSCAPE"
    try:
        tier = resolve_paygate_tier(
            params.get("paygate_tier") or flow_client.paygate_tier
        )
    except ValueError as exc:
        return {}, str(exc)[:200]

    clean_start = start_media_id.strip()
    clean_end = end_media_id.strip()
    sdk = _proc().get_flow_sdk()
    dispatch = await sdk.gen_video_first_last(
        prompt=prompt.strip(),
        project_id=project_id,
        start_media_id=clean_start,
        end_media_id=clean_end,
        duration_s=dur,
        aspect_ratio=aspect,
        paygate_tier=tier,
        resolution=native_res,
        variant_count=variant_count,
    )
    if dispatch.get("error") and _is_foreign_media_error(dispatch.get("error")):
        if any(media_service.cached_path(mid) is not None for mid in (clean_start, clean_end)):
            from flowboard.services.media_project_sync import (
                MediaSyncError,
                ensure_media_in_project,
            )

            try:
                synced_start = (
                    await ensure_media_in_project(clean_start, project_id)
                    if media_service.cached_path(clean_start) is not None
                    else clean_start
                )
                synced_end = (
                    await ensure_media_in_project(clean_end, project_id)
                    if media_service.cached_path(clean_end) is not None
                    else clean_end
                )
                if synced_start != clean_start or synced_end != clean_end:
                    dispatch = await sdk.gen_video_first_last(
                        prompt=prompt.strip(),
                        project_id=project_id,
                        start_media_id=synced_start,
                        end_media_id=synced_end,
                        duration_s=dur,
                        aspect_ratio=aspect,
                        paygate_tier=tier,
                        resolution=native_res,
                        variant_count=variant_count,
                    )
            except MediaSyncError:
                pass
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    return await _poll_and_ingest_video_ops(
        sdk,
        dispatch=dispatch,
        project_id=project_id,
        aspect=aspect,
        requested_res=requested_res,
        default_base_res=native_res,
        rid=params.get("__request_id"),
        extra_result={"duration_s": dispatch.get("duration_s") or dur},
    )


async def _handle_gen_video_text(params: dict) -> tuple[dict, Optional[str]]:
    """Native text-to-video generation without reference images (RPC ``YhhmEf``)."""
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if params.get("media_provider", "flow") != "flow":
        return {}, video_routing.WRONG_ENGINE
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"

    raw_dur = params.get("duration_s")
    dur = (
        8
        if isinstance(raw_dur, int) and not isinstance(raw_dur, bool) and raw_dur >= 7
        else 4
    )
    raw_count = params.get("variant_count")
    variant_count = (
        raw_count
        if isinstance(raw_count, int) and not isinstance(raw_count, bool) and raw_count > 0
        else 1
    )
    requested_res = str(params.get("resolution") or "720p").strip()
    aspect = params.get("aspect_ratio") or "VIDEO_ASPECT_RATIO_LANDSCAPE"
    try:
        tier = resolve_paygate_tier(
            params.get("paygate_tier") or flow_client.paygate_tier
        )
    except ValueError as exc:
        return {}, str(exc)[:200]

    sdk = _proc().get_flow_sdk()
    dispatch = await sdk.gen_video_text(
        prompt=prompt.strip(),
        project_id=project_id,
        duration_s=dur,
        aspect_ratio=aspect,
        paygate_tier=tier,
        variant_count=variant_count,
    )
    if dispatch.get("error"):
        return dispatch, str(dispatch["error"])[:200]

    return await _poll_and_ingest_video_ops(
        sdk,
        dispatch=dispatch,
        project_id=project_id,
        aspect=aspect,
        requested_res=requested_res,
        default_base_res="720p",
        rid=params.get("__request_id"),
        extra_result={"duration_s": dispatch.get("duration_s") or dur},
    )
