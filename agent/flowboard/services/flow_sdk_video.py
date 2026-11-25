"""Video generation, upscaling, and async operation polling mixin for FlowSDK."""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Optional

from flowboard.services import flow_batch as fb
from flowboard.services.flow_project import effective_project_id
from flowboard.services.flow_parsers import (
    extract_operation_names,
    extract_video_operations,
)

logger = logging.getLogger(__name__)


def _sdk():
    from flowboard.services import flow_sdk as _mod
    return _mod


class FlowSDKVideoMixin:
    """Video generation and async operation polling methods mixed into FlowSDK."""

    # ── video generation (eb1hJf i2v, MZZa6b reference-to-video) ───────────
    async def gen_video(
        self,
        prompt: str,
        project_id: str,
        start_media_id: Optional[str] = None,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: Optional[str] = None,
        scene_id: Optional[str] = None,
        start_media_ids: Optional[list[str]] = None,
        video_quality: Optional[str] = None,
        variant_count: int = 1,
        resolution: str = "720p",
    ) -> dict[str, Any]:
        """Kick off i2v operation(s); the caller polls :meth:`check_async`.

        ``start_media_ids`` dispatches one operation per source image, so a
        4-variant upstream image yields four clips. Submits are sequential
        rather than concurrent: each one mints a single-use reCAPTCHA inside
        the page, and serialising them keeps that mint predictable.
        When a single source still is given and ``variant_count > 1``, it
        dispatches ``min(variant_count, 4)`` takes from that source.
        """
        try:
            tier = _sdk().resolve_paygate_tier(paygate_tier)
            pid = self._project_id(project_id)
        except (ValueError, fb.FlowBatchError) as exc:
            return _sdk()._batch_failure(exc)

        legacy_key = _sdk().resolve_video_model(tier, aspect_ratio, video_quality)
        if not legacy_key:
            return {
                "raw": None,
                "error": (
                    f"no_video_model_for_tier_{tier}"
                    f"_quality_{video_quality or _sdk().DEFAULT_VIDEO_QUALITY}"
                    f"_aspect_{aspect_ratio}"
                ),
            }
        model = fb.resolve_video_model(legacy_key)
        # Veo 3.1 on Flow batchexecute (eb1hJf) natively supports 720p only;
        # sending slot-9 `[4]` (360p) triggers gRPC [3] INVALID_ARGUMENT.
        # 1080p/4K upscaling runs after base 720p generation via `upscale_video`.

        sources = [
            mid for mid in (start_media_ids or []) if isinstance(mid, str) and mid
        ]
        if not sources and isinstance(start_media_id, str) and start_media_id:
            sources = [start_media_id]
        if not sources:
            return {"raw": None, "error": "missing_start_media_id"}
        if len(sources) == 1 and isinstance(variant_count, int) and variant_count > 1:
            sources = sources * max(1, min(variant_count, _sdk().MAX_VARIANT_COUNT))

        operation_ids: list[str] = []
        failures: list[tuple[str, Exception]] = []
        for mid in sources:
            try:
                freq = fb.video_request(
                    prompt, pid, mid, aspect=aspect_ratio, model=model
                )
                payload = await self._payload(
                    fb.RPC_GEN_VIDEO, freq, fb.CAPTCHA_VIDEO, timeout=120.0
                )
                operation = fb.read_operation(payload)
            except Exception as exc:  # broad by design: reported, never swallowed
                failures.append((mid, exc))
                continue
            self._remember_operation(operation.operation_id, pid)
            operation_ids.append(operation.operation_id)

        out = self._video_submit_result(
            operation_ids, failures, model=model, sources=len(sources)
        )
        if not out.get("error"):
            out["resolution"] = "720p"
        return out

    async def _discover_omni_1_2_keys(self) -> None:
        """Best-effort one-shot read of live Flow HTrJv model catalog for Omni 1.2 keys."""
        if self._omni_1_2_r2v_keys or hasattr(self._client, "responses"):
            return
        try:
            payload = await self._payload(
                _sdk().RPC_MODEL_CONFIG, fb.build_envelope(_sdk().RPC_MODEL_CONFIG, []), timeout=15.0
            )
        except Exception:  # noqa: BLE001
            return
        self._ingest_omni_1_2_catalog(payload)

    def _ingest_omni_1_2_catalog(self, payload: Any) -> None:
        """Parse Flow HTrJv catalog response for Omni 1.2 (macaron_cookie) duration keys."""
        def _walk_ints(node: Any) -> list[int]:
            out: list[int] = []
            if isinstance(node, int) and not isinstance(node, bool):
                out.append(node)
            elif isinstance(node, list):
                for item in node:
                    out.extend(_walk_ints(item))
            return out

        candidates: list[Any] = []
        if isinstance(payload, list):
            if payload and isinstance(payload[0], list):
                candidates.append(payload[0])
            candidates.append(payload)

        for root in candidates:
            if not isinstance(root, list) or len(root) <= 4 or not isinstance(root[4], list):
                continue
            for fam in root[4]:
                if not isinstance(fam, list) or len(fam) < 2 or not isinstance(fam[1], list):
                    continue
                display_name = str(fam[0] or "").lower() if isinstance(fam[0], str) else ""
                fam_id = (
                    str(fam[3] or "").lower()
                    if len(fam) > 3 and isinstance(fam[3], str)
                    else ""
                )
                if not (
                    "1.2" in display_name
                    or "macaron" in fam_id
                    or "1_2" in fam_id
                ):
                    continue
                for u in fam[1]:
                    if not isinstance(u, list) or not u or not isinstance(u[0], str):
                        continue
                    wire_key = u[0]
                    caps = set(_walk_ints(u[7])) if len(u) > 7 and u[7] is not None else set()
                    has_ref_cap = 6 in caps
                    dur: Optional[int] = None
                    if len(u) > 16 and isinstance(u[16], int) and not isinstance(u[16], bool) and 3 <= u[16] <= 15:
                        dur = u[16]
                    else:
                        m = re.search(r"(\d+)s", wire_key.lower())
                        if m:
                            cand_dur = int(m.group(1))
                            if 3 <= cand_dur <= 15:
                                dur = cand_dur
                    if dur is None:
                        continue
                    res_codes = (
                        set(_walk_ints(u[23][0]))
                        if len(u) > 23 and isinstance(u[23], list) and u[23]
                        else set()
                    )
                    res_slot = "360p" if "_360p" in wire_key.lower() else "720p"
                    if has_ref_cap:
                        self._omni_1_2_r2v_keys[(dur, res_slot)] = wire_key
                    else:
                        self._omni_1_2_r2v_keys.setdefault((dur, res_slot), wire_key)
                    if 4 in res_codes:
                        if has_ref_cap:
                            self._omni_1_2_r2v_keys.setdefault((dur, "360p"), wire_key)
                        else:
                            self._omni_1_2_r2v_keys.setdefault((dur, "360p"), wire_key)

        for text in fb._walk_strings(payload):
            low = text.lower()
            if "r2v" not in low or (
                "1_2" not in low and "omni" not in low and "1.2" not in low and "macaron" not in low
            ):
                continue
            m = re.search(r"(\d+)s", low)
            if not m:
                continue
            dur = int(m.group(1))
            if not 3 <= dur <= 15:
                continue
            res = "360p" if "_360p" in low else "720p"
            self._omni_1_2_r2v_keys.setdefault((dur, res), text)

    async def gen_video_omni(
        self,
        prompt: str,
        project_id: str,
        ref_media_ids: list[str],
        duration_s: int,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_PORTRAIT",
        paygate_tier: Optional[str] = None,
        seed: Optional[int] = None,
        resolution: str = "720p",
        omni_version: str = "1.1",
        variant_count: int = 1,
    ) -> dict[str, Any]:
        """Kick off Omni Flash reference-to-video (RPC ``MZZa6b``).

        Supports Omni 1.1 Flash (4/6/8/10s) and Omni 1.2 Flash (3..15s) across
        1-4 variants, automatically falling back if the 1.2 wire key returns [5].
        """
        try:
            _sdk().resolve_paygate_tier(paygate_tier)
            pid = self._project_id(project_id)
        except (ValueError, fb.FlowBatchError) as exc:
            return _sdk()._batch_failure(exc)

        if aspect_ratio not in _sdk().OMNI_FLASH_VALID_ASPECTS:
            return {"raw": None, "error": f"omni_aspect_unsupported_{aspect_ratio}"}
        refs = [
            mid for mid in (ref_media_ids or []) if isinstance(mid, str) and mid
        ]
        if not refs:
            return {"raw": None, "error": "missing_ref_media_ids"}

        ver = "1.2" if str(omni_version).strip() == "1.2" else "1.1"
        res = "360p" if str(resolution or "720p").strip().lower() == "360p" else "720p"
        try:
            model = _sdk().resolve_omni_flash_model(duration_s, version=ver)
        except ValueError as exc:
            return {"raw": None, "error": str(exc)[:200]}

        if ver == "1.2":
            await self._discover_omni_1_2_keys()
            model = self._omni_1_2_r2v_keys.get((duration_s, res), model + ("_360p" if res == "360p" else ""))

        count = (
            max(1, min(int(variant_count), _sdk().MAX_VARIANT_COUNT))
            if isinstance(variant_count, int) and not isinstance(variant_count, bool)
            else 1
        )

        def build_mzza6b_freq(wire_model: str, wire_res: str) -> str:
            if ver == "1.1" and duration_s in _sdk().OMNI_FLASH_DURATION_KEYS and wire_model.startswith("abra_r2v_"):
                return fb.omni_reference_video_request(
                    prompt, pid, refs, duration_s=duration_s,
                    resolution=wire_res, aspect=aspect_ratio,
                )
            item: list[Any] = [
                [None, None, [[[prompt]]]],
                [[None, mid] for mid in refs],
                wire_model,
                fb.resolve_video_aspect(aspect_ratio),
                None,
                [None, None, None, None, fb._client_uuid(), fb._client_uuid()],
            ]
            if wire_res == "360p":
                item.extend([None, None, None, None, None, [4]])
            return fb.build_envelope(
                fb.RPC_GEN_VIDEO_REFERENCES,
                [[item], fb._context(pid), [fb._client_uuid(), 2]],
            )

        nearest = min((4, 6, 8, 10), key=lambda d: abs(d - duration_s))
        suffix = "_360p" if res == "360p" else ""
        candidates: list[tuple[str, str]] = [(model, res)]
        if ver == "1.2":
            for cand in (f"abra_r2v_{duration_s}s{suffix}", f"abra_r2v_{nearest}s{suffix}"):
                if (cand, res) not in candidates:
                    candidates.append((cand, res))
        if res == "360p":
            base_720 = model.removesuffix("_360p") if model.endswith("_360p") else model
            if (base_720, "720p") not in candidates:
                candidates.append((base_720, "720p"))
            if ver == "1.2":
                for cand720 in (f"abra_r2v_{duration_s}s", f"abra_r2v_{nearest}s"):
                    if (cand720, "720p") not in candidates:
                        candidates.append((cand720, "720p"))

        active_model, active_res = candidates[0]
        fallback_pairs = candidates[1:]
        operation_ids: list[str] = []
        failures: list[tuple[str, Exception]] = []
        for idx in range(count):
            try:
                try:
                    payload = await self._payload(
                        fb.RPC_GEN_VIDEO_REFERENCES,
                        build_mzza6b_freq(active_model, active_res),
                        fb.CAPTCHA_VIDEO,
                        timeout=120.0,
                    )
                except fb.RpcError as exc:
                    if not _sdk()._is_rpc_invalid_or_not_found(exc) or not fallback_pairs:
                        raise
                    payload = None
                    last_exc: Exception = exc
                    for fb_model, fb_res in fallback_pairs:
                        logger.warning(
                            "MZZa6b returned error (%r) for model=%s res=%s; retrying %s (%s)",
                            exc.detail, active_model, active_res, fb_model, fb_res,
                        )
                        try:
                            payload = await self._payload(
                                fb.RPC_GEN_VIDEO_REFERENCES,
                                build_mzza6b_freq(fb_model, fb_res),
                                fb.CAPTCHA_VIDEO,
                                timeout=120.0,
                            )
                            active_model = fb_model
                            active_res = fb_res
                            break
                        except fb.RpcError as retry_exc:
                            last_exc = retry_exc
                            if not _sdk()._is_rpc_invalid_or_not_found(retry_exc):
                                raise
                    if payload is None:
                        raise last_exc
                operation = fb.read_operation(payload)
            except Exception as exc:  # broad by design: reported, never swallowed
                failures.append((f"variant-{idx + 1}", exc))
                continue
            self._remember_operation(operation.operation_id, pid)
            operation_ids.append(operation.operation_id)

        out = self._video_submit_result(
            operation_ids, failures, model=active_model, sources=count
        )
        if not out.get("error"):
            out["duration_s"] = duration_s
            out["resolution"] = active_res
            out["omni_version"] = ver
        return out

    async def gen_video_first_last(
        self,
        prompt: str,
        project_id: str,
        start_media_id: str,
        end_media_id: str,
        duration_s: int = 8,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: Optional[str] = None,
        resolution: str = "720p",
        variant_count: int = 1,
    ) -> dict[str, Any]:
        """Kick off native Omni First+Last frame locked video (RPC ``nprQif``)."""
        try:
            _sdk().resolve_paygate_tier(paygate_tier)
            pid = self._project_id(project_id)
        except (ValueError, fb.FlowBatchError) as exc:
            return _sdk()._batch_failure(exc)

        clean_start = (start_media_id or "").strip()
        clean_end = (end_media_id or "").strip()
        if not clean_start or not clean_end:
            return {"raw": None, "error": "missing_first_last_media_id"}

        dur = min((4, 6, 8, 10), key=lambda d: abs(d - int(duration_s or 8)))
        res = "360p" if str(resolution or "720p").strip().lower() == "360p" else "720p"
        count = (
            max(1, min(int(variant_count), _sdk().MAX_VARIANT_COUNT))
            if isinstance(variant_count, int) and not isinstance(variant_count, bool)
            else 1
        )
        active_res = res
        active_rpc = fb.RPC_GEN_VIDEO_FIRST_LAST
        active_model = f"omni_flash_i2v_{dur}s_first_last" + ("_360p" if res == "360p" else "")
        operation_ids: list[str] = []
        failures: list[tuple[str, Exception]] = []

        for idx in range(count):
            try:
                try:
                    freq = fb.omni_first_last_request(
                        prompt,
                        pid,
                        clean_start,
                        clean_end,
                        duration_s=dur,
                        resolution=active_res,
                        aspect=aspect_ratio,
                    )
                    payload = await self._payload(
                        fb.RPC_GEN_VIDEO_FIRST_LAST,
                        freq,
                        fb.CAPTCHA_VIDEO,
                        timeout=120.0,
                    )
                except fb.RpcError as exc:
                    if not _sdk()._is_rpc_invalid_or_not_found(exc):
                        raise
                    payload = None
                    if active_res == "360p":
                        try:
                            freq720 = fb.omni_first_last_request(
                                prompt,
                                pid,
                                clean_start,
                                clean_end,
                                duration_s=dur,
                                resolution="720p",
                                aspect=aspect_ratio,
                            )
                            payload = await self._payload(
                                fb.RPC_GEN_VIDEO_FIRST_LAST,
                                freq720,
                                fb.CAPTCHA_VIDEO,
                                timeout=120.0,
                            )
                            active_res = "720p"
                            active_model = f"omni_flash_i2v_{dur}s_first_last"
                        except fb.RpcError as retry_exc:
                            if not _sdk()._is_rpc_invalid_or_not_found(retry_exc):
                                raise
                    if payload is None:
                        logger.warning(
                            "nprQif rejected (%r); falling back to MZZa6b first+last refs",
                            exc.detail,
                        )
                        freq_r2v = fb.omni_reference_video_request(
                            prompt,
                            pid,
                            [clean_start, clean_end],
                            duration_s=dur,
                            resolution="720p",
                            aspect=aspect_ratio,
                        )
                        payload = await self._payload(
                            fb.RPC_GEN_VIDEO_REFERENCES,
                            freq_r2v,
                            fb.CAPTCHA_VIDEO,
                            timeout=120.0,
                        )
                        active_res = "720p"
                        active_rpc = fb.RPC_GEN_VIDEO_REFERENCES
                        active_model = f"abra_r2v_{dur}s"
                operation = fb.read_operation(payload)
            except Exception as exc:  # broad by design: surfaced cleanly
                failures.append((f"variant-{idx + 1}", exc))
                continue
            self._remember_operation(operation.operation_id, pid)
            operation_ids.append(operation.operation_id)

        out = self._video_submit_result(
            operation_ids, failures, model=active_model, sources=count
        )
        if not out.get("error"):
            out["duration_s"] = dur
            out["resolution"] = active_res
            out["rpc"] = active_rpc
        return out

    async def gen_video_text(
        self,
        prompt: str,
        project_id: str,
        duration_s: int = 4,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: Optional[str] = None,
        variant_count: int = 1,
    ) -> dict[str, Any]:
        """Kick off pure text-to-video generation without reference images (RPC ``YhhmEf``)."""
        try:
            _sdk().resolve_paygate_tier(paygate_tier)
            pid = self._project_id(project_id)
        except (ValueError, fb.FlowBatchError) as exc:
            return _sdk()._batch_failure(exc)

        clean_prompt = (prompt or "").strip()
        if not clean_prompt:
            return {"raw": None, "error": "missing_prompt"}

        want_8s = isinstance(duration_s, int) and not isinstance(duration_s, bool) and duration_s >= 7
        candidates = ("abra_t2v_8s", "abra_t2v_4s") if want_8s else ("abra_t2v_4s",)
        count = (
            max(1, min(int(variant_count), _sdk().MAX_VARIANT_COUNT))
            if isinstance(variant_count, int) and not isinstance(variant_count, bool)
            else 1
        )
        active_model = candidates[0]
        operation_ids: list[str] = []
        failures: list[tuple[str, Exception]] = []

        for idx in range(count):
            try:
                payload = None
                last_exc: Optional[Exception] = None
                for cand_model in candidates:
                    try:
                        freq = fb.text_video_request(
                            clean_prompt,
                            pid,
                            aspect=aspect_ratio,
                            model=cand_model,
                        )
                        payload = await self._payload(
                            fb.RPC_GEN_VIDEO_TEXT,
                            freq,
                            fb.CAPTCHA_VIDEO,
                            timeout=120.0,
                        )
                        active_model = cand_model
                        break
                    except fb.RpcError as exc:
                        last_exc = exc
                        if not _sdk()._is_rpc_invalid_or_not_found(exc):
                            raise
                if payload is None:
                    raise last_exc or fb.FlowBatchError("text video submit returned no payload")

                try:
                    info = fb.read_text_video_submit(payload)
                    op_id = info.get("workflow_id") or f"t2v:{info['media_id']}"
                    target_pid = info.get("project_id") or pid
                    self._remember_operation(op_id, target_pid)
                    self._operation_media[op_id] = info["media_id"]
                except (fb.FlowBatchError, ValueError, KeyError, IndexError, TypeError):
                    operation = fb.read_operation(payload)
                    op_id = operation.operation_id
                    self._remember_operation(op_id, pid)
            except Exception as exc:  # broad by design: surfaced cleanly
                failures.append((f"variant-{idx + 1}", exc))
                continue
            operation_ids.append(op_id)

        out = self._video_submit_result(
            operation_ids, failures, model=active_model, sources=count
        )
        if not out.get("error"):
            out["resolution"] = "720p"
            out["duration_s"] = 8 if active_model.endswith("8s") else 4
        return out

    async def upscale_video(
        self,
        media_id: str,
        project_id: str,
        aspect_ratio: str = "VIDEO_ASPECT_RATIO_LANDSCAPE",
        resolution: str = "1080p",
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """Upscale a generated video to 1080p or 4K via UPSAMPLE_VIDEO (p0UkFb)."""
        try:
            pid = self._project_id(project_id)
        except fb.FlowBatchError as exc:
            return _sdk()._batch_failure(exc)

        norm = str(resolution or "1080p").strip().lower()
        if norm == "4k":
            res_code = _sdk().VIDEO_RESOLUTION_CODES["4k"]
            upsampler_model = "veo_3_1_upsampler_4k"
            res_label = "4K"
        elif norm == "1080p":
            res_code = _sdk().VIDEO_RESOLUTION_CODES["1080p"]
            upsampler_model = "veo_3_1_upsampler_1080p"
            res_label = "1080p"
        else:
            return {"raw": None, "error": "video upscale resolution must be 1080p or 4K"}

        base_seed = (
            int(seed)
            if isinstance(seed, int) and not isinstance(seed, bool) and seed >= 0
            else int(time.time() * 1000) % 1_000_000
        )
        item: list[Any] = [None] * 32
        item[0] = [None, media_id]
        item[2] = fb.resolve_video_aspect(aspect_ratio)
        item[3] = base_seed
        item[6] = res_code
        item[31] = upsampler_model
        freq = fb.build_envelope(
            _sdk().RPC_UPSCALE_VIDEO,
            [[item], fb._context(pid), [fb._client_uuid(), 2]],
        )
        try:
            payload = await self._payload(
                _sdk().RPC_UPSCALE_VIDEO, freq, fb.CAPTCHA_VIDEO, timeout=120.0
            )
            operation = fb.read_operation(payload)
        except Exception as exc:  # broad by design: reported, never swallowed
            return _sdk()._batch_failure(exc)

        self._remember_operation(operation.operation_id, pid)
        out = self._video_submit_result(
            [operation.operation_id], [], model=upsampler_model, sources=1
        )
        out["resolution"] = res_label
        return out

    def _video_submit_result(
        self,
        operation_ids: list[str],
        failures: list,
        *,
        model: str,
        sources: int,
    ) -> dict[str, Any]:
        """Shape a video submit, tolerating a partly-failed batch."""
        if not operation_ids:
            return _sdk()._batch_failure(
                failures[0][1] if failures
                else fb.FlowBatchError("video submit returned no operation")
            )
        resp = _sdk()._as_operation_envelope(operation_ids)
        if failures:
            resp["data"]["failed_sources"] = [
                {"media_id": mid, "error": str(exc)[:200]} for mid, exc in failures
            ]
            logger.warning(
                "video submit: %d of %d source(s) failed — %s",
                len(failures), sources,
                "; ".join(str(exc)[:80] for _, exc in failures),
            )
        return {
            "raw": resp,
            # Read back out of the envelope rather than returned alongside it,
            # so the two can never disagree about what was submitted.
            "operation_names": extract_operation_names(resp),
            "model": model,
        }

    # ── polling (jwpduf -> Zzl0ze -> as29s) ────────────────────────────────
    async def check_async(
        self,
        operation_names: list[str],
        workflows: Optional[list[dict[str, Any]]] = None,
    ) -> dict[str, Any]:
        """Poll one or more video operations. No captcha.

        Returns ``{raw, operations: [{name, done, media_entries, status,
        error}]}`` — one entry per *requested* name, in the order given, so the
        worker keeps positional alignment with its per-op state.

        ``workflows`` is inert. It carried ``{name, primary_media_id}`` pairs
        from the REST path's low-priority schema, which polled
        ``/v1/media/<id>`` for inline MP4 bytes. The batch transport has no
        such schema — every submit yields a real operation id — so a non-empty
        list means a pre-migration handle and is reported rather than polled.
        """
        if workflows:
            logger.warning(
                "check_async: ignoring %d workflow handle(s) — the workflow "
                "schema belonged to the REST transport, which no longer exists. "
                "These are almost certainly operations submitted before the "
                "migration; they cannot be resumed.",
                len(workflows),
            )
        entries: list[dict[str, Any]] = []
        for name in operation_names or []:
            if not isinstance(name, str) or not name:
                continue
            try:
                entries.append(await self._poll_operation(name))
            except Exception as exc:  # broad by design: reported, never swallowed
                # A hiccup on one poll round costs a round, not the job.
                logger.warning("operation %s poll failed: %s", name[:20], exc)
                entries.append(_sdk()._pending_operation(name, complaint=str(exc)[:200]))

        resp = {"status": 200, "data": {"operations": entries}}
        return {
            "raw": resp,
            "operations": extract_video_operations(
                resp, requested=list(operation_names or [])
            ),
        }

    @staticmethod
    def _is_terminal_public_error(complaint: Optional[str]) -> bool:
        """True for explicit Flow ``PUBLIC_ERROR_*`` safety/policy rejections."""
        if not isinstance(complaint, str) or not complaint.strip():
            return False
        return bool(re.search(r"PUBLIC_ERROR_[A-Z0-9_]+", complaint, re.IGNORECASE))

    @staticmethod
    def _is_policy_rejection_text(complaint: Optional[str]) -> bool:
        """True for explicit safety/policy refusal text (never ``Media not found.``)."""
        if not isinstance(complaint, str) or not complaint.strip():
            return False
        low = complaint.lower()
        if "media not found" in low:
            return False
        return any(
            kw in low
            for kw in (
                "violat",
                "content policy",
                "safety",
                "unsafe",
                "prohibited",
                "policy",
                "harmful",
                "self-harm",
                "audio_filtered",
                "prominent_people",
            )
        )

    def _maybe_terminal_failure(
        self, operation_id: str, complaint: Optional[str]
    ) -> Optional[dict]:
        """Turn an explicit policy/safety rejection with no media into FAILED."""
        if not complaint:
            self._operation_policy_strikes.pop(operation_id, None)
            return None
        if self._is_terminal_public_error(complaint):
            self._operation_policy_strikes.pop(operation_id, None)
            return _sdk()._failed_operation(operation_id, complaint)
        if self._is_policy_rejection_text(complaint):
            strikes = self._operation_policy_strikes.get(operation_id, 0) + 1
            self._operation_policy_strikes[operation_id] = strikes
            if strikes >= 2:
                self._operation_policy_strikes.pop(operation_id, None)
                return _sdk()._failed_operation(operation_id, complaint)
            return None
        self._operation_policy_strikes.pop(operation_id, None)
        return None

    async def _poll_operation(self, operation_id: str) -> dict:
        """One poll round for one operation, as a REST operation envelope.

        Three signals have to agree before a clip can be downloaded, and they
        arrive out of order:

        * the operation poll says how the job is going — it may carry the
          signed ``/video/`` url directly, sit at no status on a job that
          finished, carry a survivable ``"Media not found."`` complaint, or
          report an explicit ``PUBLIC_ERROR_*`` safety/policy rejection;
        * the project listing is what actually gains a media id when ``jwpduf``
          omits the url;
        * the media record serves the poster image first and grows the
          ``/video/`` url in later.

        A ``media_id`` is cached ONLY after ``as29s`` confirms it exists (no
        gRPC ``[5]`` NOT_FOUND), so an uncommitted or mis-parsed id can never
        trap the worker in a 5-minute ``as29s failed: [5]`` loop.
        """
        media_id = self._operation_media.get(operation_id)
        from_cache = bool(media_id)
        complaint: Optional[str] = None

        if not media_id:
            media_id, complaint, direct_result = await self._find_operation_media(
                operation_id
            )
            if direct_result is not None:
                return direct_result
            if not media_id:
                terminal = self._maybe_terminal_failure(operation_id, complaint)
                if terminal is not None:
                    return terminal
                return _sdk()._pending_operation(operation_id, complaint=complaint)

        try:
            urls = await self._media_urls(media_id)
        except fb.RpcError as exc:
            if not _sdk()._is_rpc_not_found(exc):
                raise
            logger.warning(
                "operation %s as29s NOT_FOUND [5] for media_id=%s (cached=%s)",
                operation_id[:20], media_id[:20], from_cache,
            )
            if operation_id.startswith("t2v:"):
                return _sdk()._pending_operation(
                    operation_id, complaint=complaint or str(exc)[:200]
                )
            # Evict unverified/stale media_id so the next round re-checks
            # jwpduf and Zzl0ze instead of looping on [5] until timeout.
            self._operation_media.pop(operation_id, None)
            if from_cache:
                fresh_mid, fresh_complaint, direct_result = (
                    await self._find_operation_media(operation_id)
                )
                if direct_result is not None:
                    return direct_result
                if fresh_mid and fresh_mid != media_id:
                    try:
                        urls = await self._media_urls(fresh_mid)
                        media_id = fresh_mid
                        complaint = fresh_complaint
                    except fb.RpcError as retry_exc:
                        if not _sdk()._is_rpc_not_found(retry_exc):
                            raise
                        terminal = self._maybe_terminal_failure(
                            operation_id, fresh_complaint
                        )
                        if terminal is not None:
                            return terminal
                        return _sdk()._pending_operation(
                            operation_id,
                            complaint=fresh_complaint or str(retry_exc)[:200],
                        )
                else:
                    terminal = self._maybe_terminal_failure(
                        operation_id, fresh_complaint
                    )
                    if terminal is not None:
                        return terminal
                    return _sdk()._pending_operation(
                        operation_id,
                        complaint=fresh_complaint or str(exc)[:200],
                    )
            else:
                terminal = self._maybe_terminal_failure(operation_id, complaint)
                if terminal is not None:
                    return terminal
                return _sdk()._pending_operation(
                    operation_id, complaint=complaint or str(exc)[:200]
                )

        # Cache only once as29s has actually recognised the media record.
        self._operation_media[operation_id] = media_id
        self._operation_policy_strikes.pop(operation_id, None)

        if not urls.video:
            # The id landed but the clip is still being written. Downloading on
            # the id alone here saves the poster still, not the video.
            return _sdk()._pending_operation(
                operation_id, complaint=complaint, media_id=media_id
            )

        # The media id stays cached rather than cleared: a batch re-polls its
        # finished operations alongside the pending ones, and a cleared entry
        # would report them PENDING again. Growth is bounded by _CACHE_LIMIT.
        return {
            "operation": {
                "name": operation_id,
                "metadata": {
                    "video": {"mediaId": media_id, "fifeUrl": urls.video},
                },
            },
            "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
        }

    async def _find_operation_media(
        self, operation_id: str
    ) -> tuple[Optional[str], Optional[str], Optional[dict]]:
        """Ask the operation how it is doing, then the listing where its media is.

        The listing is the authority — a poll has been observed never to report
        a finished job the listing already knew about — but it is also the
        expensive call, so it is consulted only when the poll says something
        happened, when the poll is unreadable, or every third round regardless.
        If ``jwpduf`` already carries a signed ``/video/`` CDN url, return it
        immediately without waiting on ``Zzl0ze`` or ``as29s``.
        """
        rounds = self._operation_polls.get(operation_id, 0) + 1
        self._operation_polls[operation_id] = rounds

        project_id = (
            self._operation_projects.get(operation_id) or effective_project_id()
        )
        complaint: Optional[str] = None
        worth_looking = rounds % 3 == 0
        try:
            op_payload = await self._payload(
                fb.RPC_OPERATION,
                fb.operation_request(operation_id),
                timeout=60.0,
            )
            direct_urls = fb.read_media_urls(op_payload, "")
            if direct_urls.video:
                direct_mid = _sdk()._media_id_from_url(direct_urls.video)
                if direct_mid:
                    self._operation_media[operation_id] = direct_mid
                    self._operation_policy_strikes.pop(operation_id, None)
                    return (
                        direct_mid,
                        None,
                        {
                            "operation": {
                                "name": operation_id,
                                "metadata": {
                                    "video": {
                                        "mediaId": direct_mid,
                                        "fifeUrl": direct_urls.video,
                                    },
                                },
                            },
                            "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
                        },
                    )
            operation = fb.read_operation(op_payload)
            complaint = operation.error
            project_id = operation.project_id or project_id
            if project_id:
                self._remember_operation(operation_id, project_id)
            worth_looking = (
                worth_looking or operation.done or operation.complained
            )
        except Exception as exc:  # broad by design: reported, never swallowed
            # An operation that has decayed to a bare id still appears in the
            # listing, so a failed poll is a reason to look there, not to stop.
            logger.debug(
                "operation %s poll unreadable (%s), trying the listing",
                operation_id[:20], exc,
            )
            worth_looking = True

        if not worth_looking:
            return None, complaint, None
        if not project_id:
            return None, "no project id for the listing lookup", None
        return await self._media_id_for(operation_id, project_id), complaint, None

    async def _media_id_for(
        self, operation_id: str, project_id: str
    ) -> Optional[str]:
        """Find an operation's media id in the project listing.

        Asks the extension for a compact window around the operation id
        rather than the whole listing: that payload is past 17 MB and grows
        with every generation, so anything shipping it whole gets truncated and
        loses roughly half of all lookups depending on where the id sorts.
        """
        result = await self._client.batch_rpc(
            fb.RPC_PROJECT_MEDIA,
            fb.project_media_request(project_id),
            match=operation_id,
            timeout=120.0,
        )
        if not isinstance(result, dict) or result.get("error"):
            detail = result.get("error") if isinstance(result, dict) else result
            raise fb.FlowBatchError(f"{fb.RPC_PROJECT_MEDIA}: {detail}")
        raw = result.get("data") or ""
        media_id = fb.find_media_id_in_text(raw, operation_id)
        if not media_id and raw.lstrip().startswith(")]}"):
            # An extension too old to filter hands back the whole envelope.
            try:
                media_id = fb.find_media_id(
                    fb.first_payload(raw, fb.RPC_PROJECT_MEDIA), operation_id
                )
            except (fb.FlowBatchError, fb.RpcError, ValueError):
                media_id = None
        return media_id

    async def _media_urls(self, media_id: str) -> Any:
        payload = await self._payload(
            fb.RPC_MEDIA, fb.media_request(media_id), timeout=60.0
        )
        return fb.read_media_urls(payload, media_id)

