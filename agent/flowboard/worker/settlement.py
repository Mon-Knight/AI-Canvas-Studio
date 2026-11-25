"""Node state mirroring and atomic request settlement helpers."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

from flowboard.db import get_session
from flowboard.db.models import Node, Request
from flowboard.node_mirror import stage_node_patch
from flowboard.request_types import MEDIA_PRODUCING_TYPES
from flowboard.services import video_routing

logger = logging.getLogger(__name__)

# ── Node mirroring ────────────────────────────────────────────────────────
# Until this landed, the browser was the ONLY place a generation's live
# state lived. `Request.status` moved queued→running→done in the DB, but
# `Node.status` was never written — the frontend poll loop held "running"
# in zustand and PATCHed the finished media onto the node itself. Both
# halves died with the tab: hit F5 mid-generation and the board reloaded
# from a DB that still said the node was idle, and when the request landed
# a few seconds later there was no poll left to write the media anywhere.
# The generation was paid for and rendered, and the result was dropped.
#
# The worker is the one observer that survives a reload, so it now writes
# both: `Node.status` on every transition and the completion payload into
# `Node.data`. The frontend still PATCHes the same values when the tab is
# alive (see frontend/src/store/generation.ts) — that write is now a
# redundant mirror of this one rather than the system of record.
#
# Everything here is best-effort. `_process_one`'s Request stamp is what
# stops a request being stranded in `running` forever, so a Node write must
# never raise past this boundary: a stale node card is a cosmetic problem,
# an unsettled request is a dead generation.


def _iso_utc_now() -> str:
    """`renderedAt` in the same shape the frontend writes it.

    The frontend stamps `new Date().toISOString()` (always `…Z`), and
    ResultViewer parses it straight back through `new Date()`. Emitting the
    `+00:00` spelling would parse too, but keeping one format on the column
    means nothing downstream has to know which writer produced the value.
    """
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# The shared type set is why the zero-media check lives on `req.type` and
# not on the result: `_handle_gen_image` returns `(resp, None)` for any
# envelope without a top-level `"error"`, and `_extract_media_ids` yields
# `[]` when nothing actually rendered. Judging by the result alone, that
# pair reads as a clean success, `_node_completion_patch` returns `{}` (it
# has no media to write), and the node flips to `done` still wearing the
# PREVIOUS run's `mediaIds` / `renderedAt`. The UI shows nothing until F5,
# then shows the old images as if they were the new ones.
def _expects_media(request_type: str) -> bool:
    """True when a clean result from this type MUST carry rendered media."""
    return request_type in MEDIA_PRODUCING_TYPES


def _has_media(result: dict) -> bool:
    """True when `result` carries at least one real (non-placeholder) id.

    `media_ids` uses positional `None`s for variants that were blocked or
    timed out, so a list of nothing but placeholders is still "nothing
    rendered".
    """
    media_ids = result.get("media_ids")
    if not isinstance(media_ids, list):
        return False
    return any(isinstance(m, str) and m for m in media_ids)


def _node_completion_patch(
    req: Request,
    result: dict,
    existing_data: Optional[dict] = None,
) -> dict:
    """Build the `Node.data` delta for a successfully completed request.

    Deliberately mirrors the payload `generation.ts` PATCHes on `done` so
    nothing downstream has to learn a second shape. Two rules keep it safe:

      * Only keys we can actually derive are present. A key we know nothing
        about is absent from the patch and survives the merge untouched.
      * `None` is the "delete this key" sentinel, matching what the
        PATCH /api/nodes/{id} merge documents. Used to clear keys that
        belong to the *previous* run and would otherwise be read as
        describing this one (`error`, `aiBrief`).
    """
    params = req.params or {}
    media_ids = result.get("media_ids")
    if not isinstance(media_ids, list) or not media_ids:
        # Nothing media-shaped came back. `proxy` / `create_project` rows
        # look like this, and so would any future handler with a bare
        # envelope. Writing the media keys anyway would blank whatever the
        # node is currently showing, so write nothing at all.
        return {}

    rendered_at = _iso_utc_now()
    patch: dict = {
        "mediaIds": media_ids,
        "renderedAt": rendered_at,
        # A stale "✨ …" brief from a previous run would otherwise render
        # underneath a fresh image as if it described it. The frontend
        # clears it with the same `null` sentinel on every completion.
        "aiBrief": None,
    }
    # `media_ids` carries positional `null` placeholders for variants that
    # were blocked or timed out; the first real id is the node's primary.
    media_id = next((m for m in media_ids if isinstance(m, str) and m), None)
    if media_id:
        patch["mediaId"] = media_id
    # `variantCount` drives how many tiles NodeCard lays out, and it wins
    # over `mediaIds.length` when both are present — so leaving a previous
    # run's value in place is not neutral. A 1-variant run after a
    # 4-variant one reloads as four tiles with three broken; the other way
    # round it HIDES three generated images. The dispatched
    # `variant_count` is the authority where there is one (only `gen_image`
    # sets it); every other type falls through to `len(media_ids)`, which
    # is the right answer there because that list keeps its positional
    # `null`s and so still describes the full slot layout.
    raw_count = params.get("variant_count")
    patch["variantCount"] = (
        raw_count if isinstance(raw_count, int) and raw_count > 0 else len(media_ids)
    )
    slot_errors = result.get("slot_errors")
    if isinstance(slot_errors, list):
        patch["slotErrors"] = slot_errors
    # A partial batch stays `done` — some variants rendered — but carries a
    # one-line summary of what got blocked. `None` clears the key when this
    # run was clean.
    partial_error = result.get("partial_error")
    patch["error"] = partial_error if isinstance(partial_error, str) and partial_error else None

    prompt = params.get("prompt")
    if isinstance(prompt, str) and prompt:
        patch["prompt"] = prompt
    aspect = params.get("aspect_ratio")
    if isinstance(aspect, str) and aspect:
        patch["aspectRatio"] = aspect

    # Model stamp — which checkpoint actually rendered this, so the detail
    # panel can say "Banana Pro" / "Quality" instead of guessing from the
    # user's *current* settings. Read from the dispatched params, which are
    # what the request was submitted with.
    if req.type in video_routing.TYPES:
        patch["mediaProvider"] = params.get("media_provider") or "flow"
        patch["durationSeconds"] = result.get("duration_s") or params.get("duration_s")
    res_label = result.get("resolution") or params.get("resolution") or params.get("image_resolution")
    if isinstance(res_label, str) and res_label:
        patch["resolution"] = res_label
    if req.type in ("gen_image", "edit_image"):
        image_model = params.get("image_model")
        if isinstance(image_model, str) and image_model:
            patch["imageModel"] = image_model
    elif req.type == "gen_video":
        # For Veo the dispatched quality IS the model selector.
        video_quality = params.get("video_quality")
        if isinstance(video_quality, str) and video_quality:
            patch["videoQuality"] = video_quality
    elif req.type == "gen_video_omni":
        # Omni Flash is duration-scoped: v1.1 supports {4,6,8,10}s, v1.2 supports 3..15s.
        from flowboard.services.flow_sdk import OMNI_1_2_VALID_DURATIONS, OMNI_FLASH_DURATION_KEYS

        duration_s = params.get("duration_s")
        omni_ver = str(result.get("omni_version") or params.get("omni_version") or "1.1")
        patch["omniVersion"] = omni_ver
        if isinstance(duration_s, int) and not isinstance(duration_s, bool):
            if omni_ver == "1.2" and duration_s in OMNI_1_2_VALID_DURATIONS:
                patch["videoQuality"] = f"omni_1.2_{duration_s}s"
            elif omni_ver != "1.2" and duration_s in OMNI_FLASH_DURATION_KEYS:
                patch["videoQuality"] = OMNI_FLASH_DURATION_KEYS[duration_s]
    elif req.type == "gen_video_first_last":
        dur = patch.get("durationSeconds") or 8
        patch["videoQuality"] = f"first_last_{dur}s"
    elif req.type == "gen_video_text":
        dur = patch.get("durationSeconds") or 4
        patch["videoQuality"] = f"t2v_{dur}s"
    elif req.type in ("gen_music", "edit_music", "effect_music", "split_stems"):
        if req.type == "split_stems" and result.get("preserve_primary_media"):
            stems = result.get("stems")
            stem_patch: dict = {"error": None}
            if isinstance(stems, dict) and stems:
                stem_patch["musicStems"] = stems
            return stem_patch
        if isinstance(result.get("clip_id"), str) and result["clip_id"]:
            patch["musicClipId"] = result["clip_id"]
        if isinstance(result.get("clip_ids"), list) and result["clip_ids"]:
            patch["musicClipIds"] = result["clip_ids"]
        if isinstance(result.get("cover_media_id"), str) and result["cover_media_id"]:
            patch["musicCoverMediaId"] = result["cover_media_id"]
        if isinstance(result.get("music_title"), str) and result["music_title"]:
            patch["musicTitle"] = result["music_title"]
            patch["title"] = result["music_title"]
        if isinstance(result.get("music_lyrics"), str):
            patch["musicLyrics"] = result["music_lyrics"]
        if isinstance(result.get("music_duration_s"), (int, float)):
            patch["musicDurationSec"] = float(result["music_duration_s"])
        if isinstance(result.get("music_bpm"), int):
            patch["musicBpm"] = result["music_bpm"]
        if isinstance(result.get("music_instrumental"), bool):
            patch["musicInstrumental"] = result["music_instrumental"]
        if isinstance(result.get("music_model"), str) and result["music_model"]:
            patch["musicModel"] = result["music_model"]
        if isinstance(result.get("music_edit_mode"), str) and result["music_edit_mode"]:
            patch["musicEditMode"] = result["music_edit_mode"]
        if isinstance(result.get("conversation_id"), str) and result["conversation_id"]:
            patch["musicConversationId"] = result["conversation_id"]
        # Clear stems from an earlier song version when regenerating a fresh track
        patch["musicStems"] = None

    # Append non-destructive per-node version history (keeps up to last 10 versions).
    if media_id:
        prior = existing_data if isinstance(existing_data, dict) else {}
        history = [
            dict(item)
            for item in (prior.get("history") or [])
            if isinstance(item, dict) and isinstance(item.get("mediaId"), str) and item.get("mediaId")
        ]
        prev_mid = prior.get("mediaId")
        if isinstance(prev_mid, str) and prev_mid and not any(h.get("mediaId") == prev_mid for h in history):
            history.append({
                "mediaId": prev_mid,
                "mediaIds": prior.get("mediaIds") if isinstance(prior.get("mediaIds"), list) else [prev_mid],
                "prompt": prior.get("prompt"),
                "renderedAt": prior.get("renderedAt"),
                "aspectRatio": prior.get("aspectRatio"),
                "imageModel": prior.get("imageModel"),
                "videoQuality": prior.get("videoQuality"),
            })
        history = [h for h in history if h.get("mediaId") != media_id]
        history.append({
            "mediaId": media_id,
            "mediaIds": media_ids,
            "prompt": patch.get("prompt") or prior.get("prompt"),
            "renderedAt": rendered_at,
            "aspectRatio": patch.get("aspectRatio") or prior.get("aspectRatio"),
            "imageModel": patch.get("imageModel"),
            "videoQuality": patch.get("videoQuality"),
        })
        patch["history"] = history[-10:]
    return patch


def _commit_settlement(
    session,
    *,
    rid: int,
    stamp: dict,
    node_id: Optional[int],
    node_status: Optional[str] = None,
    node_data_patch: Optional[dict] = None,
) -> None:
    """Write a request's terminal outcome, mirroring onto its node if it can.

    ``stamp`` is the set of ``Request`` columns the outcome consists of
    (``status`` / ``error`` / ``result`` / ``finished_at``). It is passed
    as data rather than applied by the caller because it may have to be
    replayed into a second session.

    The happy path is one commit: Request and Node land together or
    neither does. When that commit fails — ``StaleDataError`` because the
    Node was deleted between the lookup and the flush, ``OperationalError:
    database is locked``, anything else — the Request stamp is **not**
    negotiable. It is the only thing standing between the user and a
    request stranded in ``running`` forever, and when the outcome is
    ``done`` it carries ``result`` with the media ids of a generation that
    has already been paid for. So we roll back, drop the node half
    entirely, and re-apply the same stamp to the Request alone in a fresh
    session. The node mirror is strictly best-effort; the Request stamp is
    the system of record.

    Two properties of that recovery are load-bearing, and both are easy to
    undo by accident:

      * It replays the **actual** outcome. The exception must not escape to
        ``_process_one``'s outer handler, which hardcodes ``failed`` — that
        would flatten ``timeout`` into a generic error and bin the
        ``result`` of a generation that succeeded. Everything the outcome
        consists of travels in ``stamp`` for exactly this reason.
      * It writes **no node**. Whatever broke the first commit may still be
        broken (a sustained ``database is locked`` is the obvious case), and
        a second node write would raise again, get swallowed, and strand the
        request in ``running`` — the original bug, one level down.

    ``test_a_failing_node_write_preserves_the_requests_real_outcome`` and
    the listener it runs under pin both.

    Once the Request is safe, the node gets one more attempt in a third
    session — see the comment at that point for why nothing else would
    ever reconcile it.
    """
    req = session.get(Request, rid)
    if req is None:
        return
    for key, value in stamp.items():
        setattr(req, key, value)
    session.add(req)
    stage_node_patch(session, node_id, status=node_status, data_patch=node_data_patch)
    try:
        session.commit()
        return
    except Exception:  # noqa: BLE001
        logger.exception(
            "worker: settlement commit failed for rid=%s (node_id=%s); "
            "retrying the request stamp without the node mirror",
            rid, node_id,
        )
        # Guarded, because `rollback()` itself can raise on an invalidated
        # connection — and an exception escaping here would reach
        # `_process_one`'s outer handler, which hardcodes `failed`. That is
        # the one outcome this whole function exists to prevent, so it does
        # not get to happen through a bare two-line gap. A Session we
        # couldn't roll back is one we simply stop using; the retry below
        # opens its own.
        try:
            session.rollback()
        except Exception:  # noqa: BLE001
            logger.exception(
                "worker: rollback after a failed settlement commit also "
                "failed for rid=%s; abandoning this session", rid,
            )

    try:
        with get_session() as retry:
            req = retry.get(Request, rid)
            if req is None:
                return
            for key, value in stamp.items():
                setattr(req, key, value)
            retry.add(req)
            retry.commit()
    except Exception:  # noqa: BLE001
        # Nothing left to try. The startup sweep in main.py will pick the
        # row up as an orphan on the next boot.
        logger.exception("worker: request stamp retry failed for rid=%s", rid)
        return

    # The Request is safe. Now go back for the node, in a third session of
    # its own.
    #
    # Dropping the node half is what saves the result, but nothing else
    # ever reconciles it: `/requests?active=true` won't return this row
    # (it is terminal now) and the startup sweep only looks at in-flight
    # requests, so a node left stamped `running` stays that way. A live tab
    # papers over it — its poll PATCHes the same values — but a reloaded or
    # closed tab is exactly the case this mirror exists for, and it would
    # come back to a card spinning on a generation that finished.
    #
    # One more attempt, fully guarded, clears the common transient cause (a
    # brief `database is locked` on the node UPDATE).
    if node_id is None:
        return
    try:
        with get_session() as reconcile:
            stage_node_patch(
                reconcile, node_id, status=node_status, data_patch=node_data_patch
            )
            reconcile.commit()
    except Exception:  # noqa: BLE001
        # The floor: Request correct, node stale. Logged loudly because
        # from the outside it looks like a hung generation — the card sits
        # on its old state while the request says done — and this line is
        # the only thing that says otherwise.
        logger.exception(
            "worker: node %s could not be reconciled after rid=%s settled "
            "as %s; the card will keep rendering its previous state until "
            "something writes to it again",
            node_id, rid, stamp.get("status"),
        )
