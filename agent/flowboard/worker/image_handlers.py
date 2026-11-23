"""Image generation, editing, and SPrCad upscaling handlers for RequestWorker."""
from __future__ import annotations

import logging
from typing import Optional

from flowboard import config
from flowboard.services import media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_sdk import resolve_paygate_tier

logger = logging.getLogger(__name__)


def _proc():
    from flowboard.worker import processor as _mod
    return _mod


def _media_provider_of(params: dict) -> str:
    """Which backend renders this dispatch: "flow" or "muse".

    Per-request `media_provider` (stamped by the GenerationDialog) wins;
    otherwise the `FLOWBOARD_MEDIA_PROVIDER` default. Unknown values fail
    closed to "flow", preserving the existing behaviour.
    """
    raw = params.get("media_provider")
    if isinstance(raw, str):
        lowered = raw.strip().lower()
        if lowered in ("flow", "muse"):
            return lowered
    return "muse" if config.MEDIA_PROVIDER_DEFAULT == "muse" else "flow"


def _orientation_from_aspect(aspect: object) -> Optional[str]:
    """Map Flow aspect enums to the provider-job orientation vocabulary."""
    if not isinstance(aspect, str):
        return None
    upper = aspect.upper()
    if "PORTRAIT" in upper:
        return "VERTICAL"
    if "LANDSCAPE" in upper:
        return "HORIZONTAL"
    return None


# The `proxy` request type is a manual escape hatch, not part of any
# generation path. Its host is the PRE-MIGRATION one: aisandbox-pa needed the
# `Bearer ya29.…` that flow.google.com no longer mints, so a proxy call now
# comes back `NO_FLOW_KEY` from the extension. Kept because it is a documented
# request type with its own tests, and because it is the one place an operator
# can still poke the old host by hand if Google ever turns it back on.
# Everything that generates goes through flow_client.batch_rpc instead.


def _resolve_effective_image_model(params: dict) -> Optional[str]:
    image_model = params.get("image_model")
    if not isinstance(image_model, str) or not image_model.strip():
        return None
    model = image_model.strip()
    thinking = params.get("thinking_level")
    if model == "NANO_BANANA_2_1" and isinstance(thinking, str):
        lvl = thinking.strip().lower()
        if lvl in ("low", "med", "high"):
            return f"NANO_BANANA_2_1_{lvl.upper()}"
    return model


def _sniff_image_mime(data: bytes) -> str:
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 6 and data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return "image/jpeg"


async def _maybe_upscale_image_resp(
    resp: dict,
    project_id: str,
    target_resolution: object,
) -> None:
    """Best-effort 2K/4K SPrCad upscale on generated/edited image variants."""
    res = str(target_resolution or "1K").strip().upper()
    if res not in ("2K", "4K"):
        resp["resolution"] = "1K"
        return

    media_ids = list(resp.get("media_ids") or [])
    if not media_ids:
        resp["resolution"] = "1K"
        return

    import base64 as _b64

    sdk = _proc().get_flow_sdk()
    upscaled_any = False
    warnings: list[str] = []
    entries = list(resp.get("media_entries") or [])

    for idx, mid in enumerate(media_ids):
        if not isinstance(mid, str) or not mid:
            continue
        up = await sdk.upscale_image(mid, project_id, res)
        if up.get("error"):
            warnings.append(str(up["error"])[:120])
            continue
        encoded = up.get("encoded_image")
        new_mid = up.get("media_id") if isinstance(up.get("media_id"), str) and up.get("media_id") else mid
        new_url = up.get("url") if isinstance(up.get("url"), str) and up.get("url") else None
        if isinstance(encoded, str) and encoded:
            try:
                raw_bytes = _b64.b64decode(encoded, validate=False)
                media_service.ingest_inline_bytes(
                    new_mid, raw_bytes, kind="image", mime=_sniff_image_mime(raw_bytes)
                )
                media_ids[idx] = new_mid
                upscaled_any = True
            except Exception as exc:  # noqa: BLE001
                warnings.append(str(exc)[:120])
        elif new_url:
            media_service.ingest_urls([{"media_id": new_mid, "url": new_url, "mediaType": "image"}])
            media_ids[idx] = new_mid
            for ent in entries:
                if isinstance(ent, dict) and ent.get("media_id") == mid:
                    ent["media_id"] = new_mid
                    ent["url"] = new_url
            upscaled_any = True

    resp["media_ids"] = media_ids
    resp["media_entries"] = entries
    resp["resolution"] = res if upscaled_any and not warnings else ("1K" if not upscaled_any else res)
    if warnings:
        resp["upscale_warning"] = "; ".join(warnings)[:200]


def _is_foreign_media_error(err: object) -> bool:
    """Return True when Flow rejects an upstream mediaId as unknown in the current project."""
    if not err:
        return False
    text = str(err).lower()
    return any(tok in text for tok in ("failed: [5]", "failed: [3]", "404", "not found"))


async def _handle_gen_image(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if _media_provider_of(params) == "muse":
        # Muse path needs no Flow project, tier, or model key — the Pax
        # worker renders from prompt + refs alone.
        from flowboard.services.muse_media import run_muse_media

        raw_ref_ids = params.get("ref_media_ids")
        if not isinstance(raw_ref_ids, list):
            raw_ref_ids = params.get("character_media_ids")
        ref_media_ids = None
        if isinstance(raw_ref_ids, list):
            cleaned = [m for m in raw_ref_ids if isinstance(m, str) and m]
            ref_media_ids = cleaned or None
        raw_count = params.get("variant_count")
        variant_count = raw_count if isinstance(raw_count, int) and raw_count > 0 else 1
        raw_prompts = params.get("prompts")
        per_variant_prompts = None
        if isinstance(raw_prompts, list):
            cleaned = [p for p in raw_prompts if isinstance(p, str) and p.strip()]
            per_variant_prompts = cleaned or None
        return await run_muse_media(
            kind="image",
            prompt=prompt.strip(),
            orientation=_orientation_from_aspect(params.get("aspect_ratio")),
            reference_media_ids=ref_media_ids,
            extra={
                "variant_count": variant_count,
                "prompts": per_variant_prompts,
            },
        )
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution: caller-stamped value first (set at dispatch time),
    # then whatever `flow_client` managed to resolve, then the configured
    # default. That last link is new, and it is not a silent default — it is
    # the only remaining source. The live value came from /v1/credits, fetched
    # with the Bearer token the extension sniffed, and flow.google.com mints no
    # Bearer, so `flow_client.paygate_tier` is now permanently None. Keeping
    # the old "fail loud when absent" rule would have meant failing every
    # single dispatch.
    #
    # The concern behind that rule still stands: the tier picks the video
    # checkpoint, and the pre-v1.1.5 hardcoded `PAYGATE_TIER_ONE` silently
    # downgraded Ultra users to Pro and stamped the wrong tier into
    # request.params, which fed back through
    # `_last_observed_paygate_tier_from_db()` and corrupted /api/auth/me for
    # the rest of the session. So the plan is declared once in config
    # (FLOWBOARD_PAYGATE_TIER) and an unrecognised value still fails loud —
    # see flow_sdk.resolve_paygate_tier.
    try:
        tier = resolve_paygate_tier(
            params.get("paygate_tier") or flow_client.paygate_tier
        )
    except ValueError as exc:
        return {}, str(exc)[:200]
    # `ref_media_ids` is the broader name (any upstream image / character /
    # visual_asset feeds in as IMAGE_INPUT_TYPE_REFERENCE). Older callers used
    # `character_media_ids` — accept both.
    raw_ref_ids = params.get("ref_media_ids")
    if not isinstance(raw_ref_ids, list):
        raw_ref_ids = params.get("character_media_ids")
    ref_media_ids: Optional[list[str]] = None
    if isinstance(raw_ref_ids, list):
        cleaned = [m for m in raw_ref_ids if isinstance(m, str) and m]
        ref_media_ids = cleaned or None
    raw_count = params.get("variant_count")
    variant_count = 1
    if isinstance(raw_count, int) and raw_count > 0:
        variant_count = raw_count
    # Per-variant prompts (optional). When provided, each variant gets its
    # own text — used by auto-prompt batch mode so variants don't collapse
    # to the same stance.
    raw_prompts = params.get("prompts")
    per_variant_prompts: Optional[list[str]] = None
    if isinstance(raw_prompts, list):
        cleaned = [p for p in raw_prompts if isinstance(p, str) and p.strip()]
        per_variant_prompts = cleaned or None
    image_model = _resolve_effective_image_model(params)
    raw_seed = params.get("seed")
    seed = raw_seed if isinstance(raw_seed, int) and not isinstance(raw_seed, bool) and raw_seed >= 0 else None
    sdk = _proc().get_flow_sdk()
    resp = await sdk.gen_image(
        prompt=prompt.strip(),
        project_id=project_id,
        aspect_ratio=aspect,
        paygate_tier=tier,
        ref_media_ids=ref_media_ids,
        variant_count=variant_count,
        prompts=per_variant_prompts,
        image_model=image_model,
        seed=seed,
    )
    if (
        resp.get("error")
        and ref_media_ids
        and _is_foreign_media_error(resp.get("error"))
        and any(media_service.cached_path(mid) is not None for mid in ref_media_ids)
    ):
        from flowboard.services.media_project_sync import MediaSyncError, ensure_media_ids_in_project

        try:
            synced_refs, _failures = await ensure_media_ids_in_project(ref_media_ids, project_id)
            if synced_refs:
                resp = await sdk.gen_image(
                    prompt=prompt.strip(),
                    project_id=project_id,
                    aspect_ratio=aspect,
                    paygate_tier=tier,
                    ref_media_ids=synced_refs,
                    variant_count=variant_count,
                    prompts=per_variant_prompts,
                    image_model=image_model,
                    seed=seed,
                )
        except MediaSyncError:
            pass
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    # Flow returns signed fifeUrls directly in the response — persist them
    # immediately so `/media/:id` can serve bytes without any extra round-trip.
    entries_with_urls = [
        e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from gen_image response failed")
    await _maybe_upscale_image_resp(resp, project_id, params.get("image_resolution"))
    return resp, None


async def _handle_edit_image(params: dict) -> tuple[dict, Optional[str]]:
    from flowboard.services.flow_sdk import is_valid_project_id

    prompt = params.get("prompt")
    project_id = params.get("project_id")
    source_media_id = params.get("source_media_id") or params.get("sourceMediaId")
    if not isinstance(prompt, str) or not prompt.strip():
        return {}, "missing_prompt"
    if _media_provider_of(params) == "muse":
        # No Flow project/tier needed — worker edits the source image
        # directly.
        from flowboard.services.muse_media import run_muse_media

        if not isinstance(source_media_id, str) or not source_media_id.strip():
            return {}, "missing_source_media_id"
        raw_refs = params.get("ref_media_ids")
        ref_media_ids = None
        if isinstance(raw_refs, list):
            cleaned = [m for m in raw_refs if isinstance(m, str) and m]
            ref_media_ids = cleaned or None
        return await run_muse_media(
            kind="edit_image",
            prompt=prompt.strip(),
            orientation=_orientation_from_aspect(params.get("aspect_ratio")),
            source_media_ids=[source_media_id.strip()],
            reference_media_ids=ref_media_ids,
        )
    if not isinstance(project_id, str) or not project_id.strip():
        return {}, "missing_project_id"
    project_id = project_id.strip()
    if not is_valid_project_id(project_id):
        return {}, "invalid_project_id"
    if not isinstance(source_media_id, str) or not source_media_id.strip():
        return {}, "missing_source_media_id"
    aspect = params.get("aspect_ratio") or "IMAGE_ASPECT_RATIO_LANDSCAPE"
    # Tier resolution — see _handle_gen_image for rationale. Fail loud,
    # no silent fallback to Pro.
    try:
        tier = resolve_paygate_tier(
            params.get("paygate_tier") or flow_client.paygate_tier
        )
    except ValueError as exc:
        return {}, str(exc)[:200]
    raw_refs = params.get("ref_media_ids")
    ref_ids: Optional[list[str]] = None
    if isinstance(raw_refs, list):
        cleaned = [m for m in raw_refs if isinstance(m, str) and m]
        ref_ids = cleaned or None
    image_model = _resolve_effective_image_model(params)
    raw_seed = params.get("seed")
    seed = raw_seed if isinstance(raw_seed, int) and not isinstance(raw_seed, bool) and raw_seed >= 0 else None

    sdk = _proc().get_flow_sdk()
    clean_source_id = source_media_id.strip()
    resp = await sdk.edit_image(
        prompt=prompt.strip(),
        project_id=project_id,
        source_media_id=clean_source_id,
        ref_media_ids=ref_ids,
        aspect_ratio=aspect,
        paygate_tier=tier,
        image_model=image_model,
        seed=seed,
    )
    if resp.get("error") and _is_foreign_media_error(resp.get("error")):
        check_ids = [clean_source_id, *(ref_ids or [])]
        if any(media_service.cached_path(mid) is not None for mid in check_ids):
            from flowboard.services.media_project_sync import (
                MediaSyncError,
                ensure_media_ids_in_project,
                ensure_media_in_project,
            )

            try:
                synced_source = (
                    await ensure_media_in_project(clean_source_id, project_id)
                    if media_service.cached_path(clean_source_id) is not None
                    else clean_source_id
                )
                synced_refs = ref_ids
                if ref_ids:
                    synced_refs, _ = await ensure_media_ids_in_project(ref_ids, project_id)
                if synced_source != clean_source_id or synced_refs != ref_ids:
                    resp = await sdk.edit_image(
                        prompt=prompt.strip(),
                        project_id=project_id,
                        source_media_id=synced_source,
                        ref_media_ids=synced_refs,
                        aspect_ratio=aspect,
                        paygate_tier=tier,
                        image_model=image_model,
                        seed=seed,
                    )
            except MediaSyncError:
                pass
    if resp.get("error"):
        return resp, str(resp["error"])[:200]
    entries_with_urls = [
        e for e in (resp.get("media_entries") or []) if isinstance(e, dict) and e.get("url")
    ]
    if entries_with_urls:
        try:
            media_service.ingest_urls(entries_with_urls)
        except Exception:  # noqa: BLE001
            logger.exception("auto-ingest from edit_image response failed")
    await _maybe_upscale_image_resp(resp, project_id, params.get("image_resolution"))
    return resp, None
