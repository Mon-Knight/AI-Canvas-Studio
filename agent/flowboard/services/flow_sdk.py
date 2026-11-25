"""Google Flow SDK wrapper, on Flow's batchexecute transport.

Google moved Flow to ``flow.google.com`` in September 2026 and rewrote the
frontend. The REST API this module used to call — ``POST
aisandbox-pa.googleapis.com/...`` carrying a ``Bearer ya29.…`` the extension
sniffed off the page — has no caller any more, and the token is not expired but
*no longer minted*. The two ``labs.google`` tRPC endpoints went the same way.

Everything now goes through one endpoint, signed in the page:

    POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute

so this module builds request envelopes and reads responses, while the Chrome
extension issues them inside a signed-in Flow tab (``flow_client.batch_rpc``).
The envelope codec lives in ``flow_batch``; the method bodies here are the Flow
semantics on top of it.

Two deliberate properties of this port:

* **Every public method kept its signature and its return shape.** The worker,
  the routes and the whole frontend were written against the REST envelopes, so
  the readers below (``extract_media_entries``, ``extract_video_operations``,
  ``extract_operation_names``) still parse exactly what they always did — the
  batch path is re-shaped back into those envelopes before they see it. Nothing
  outside this file and the extension had to learn that the transport changed.
* **Flowboard's model policy stays here, not in ``flow_batch``.** That module is
  kept byte-identical to flowkit's copy, and its defaults are flowkit's. A
  nickname is resolved to a wire id here first and passed in explicitly, so
  this project's choices (see ``IMAGE_MODELS``, ``VIDEO_MODEL_KEYS``) survive an
  upstream re-port.

``raw`` is still preserved on every return so callers — and the request-worker
that persists it to the DB — can inspect what Flow actually said.

Three capabilities have no batch replacement, because no payload for them has
ever been captured off the new UI: creating a Flow project, listing a user's
Flow projects, and reading the paygate tier / credit balance. They fail with a
``UNSUPPORTED_ON_BATCH_API`` / ``NO_FLOW_PROJECT`` prefix rather than reaching
for the dead Bearer. See ``docs/migrations/flow-batchexecute.md``.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, Optional

from flowboard.config import DEFAULT_PAYGATE_TIER
from flowboard.services import flow_batch as fb
from flowboard.services.flow_project import effective_project_id
from flowboard.services.flow_client import FlowClient, flow_client

logger = logging.getLogger(__name__)

# Endpoints -----------------------------------------------------------------
#
# There is exactly one now, and it is not reachable from here: the extension
# POSTs it from inside the Flow page (``flow_batch.BATCH_PATH``). The RPC ids
# that replaced the old REST routes:
#
#   generate image            ogiZ0b   signed CDN url comes back inline
#   generate video (i2v)      eb1hJf   returns an operation id
#   reference-to-video (Omni) MZZa6b   abra_r2v_<duration>s
#   poll an operation         jwpduf   status CAE means finished
#   operation -> media id     Zzl0ze   the project listing; ~17 MB
#   media id -> signed urls   as29s    /video/ plus a poster /image/
#   upload an image           maseQ    base64 inline, captcha like a generate
#
# The old constants are gone rather than kept as dead strings: leaving a
# reachable `https://aisandbox-pa.googleapis.com/...` in the tree is what let
# the previous migration attempt half-work and mask which path was live.

# Unsupported-capability messages. Prefixed so the frontend and the operator can
# tell "Flow will never do this on the current transport" apart from a transient
# failure worth retrying.
_CAPTURE_HINT = (
    "record its payload off the new Flow UI to port it — "
    "see docs/migrations/flow-batchexecute.md"
)
NO_FLOW_PROJECT = (
    "NO_FLOW_PROJECT: Flow's project.createProject endpoint went with the "
    "September 2026 migration, so Flowboard cannot create a Flow project any "
    "more. Make one in the Flow UI, then pin its uuid as "
    "FLOWBOARD_FLOW_PROJECT_ID or pass flow_project_id explicitly."
)
UNSUPPORTED_PROJECT_LISTING = (
    "UNSUPPORTED_ON_BATCH_API: listing a user's Flow projects used the "
    f"labs.google tRPC frontend, which the migration unauthenticated; {_CAPTURE_HINT}."
)


# Omni Flash — variable-duration r2v video model. Each duration maps to a
# distinct Flow model key. Credit cost scales with duration. Same key on
# Pro (TIER_ONE) and Ultra (TIER_TWO) per owner; revisit if Google ships
# a per-tier Ultra variant.
OMNI_FLASH_DURATION_KEYS: dict[int, str] = {
    4: "abra_r2v_4s",
    6: "abra_r2v_6s",
    8: "abra_r2v_8s",
    10: "abra_r2v_10s",
}
OMNI_FLASH_VALID_ASPECTS: set[str] = {
    "VIDEO_ASPECT_RATIO_PORTRAIT",
    "VIDEO_ASPECT_RATIO_LANDSCAPE",
}
# Informational — backend doesn't enforce, frontend surfaces to the user
# at dispatch time so the credit cost is visible before submit.
OMNI_FLASH_CREDIT_COST: dict[int, int] = {4: 15, 6: 20, 8: 25, 10: 30}


OMNI_1_2_VALID_DURATIONS: tuple[int, ...] = tuple(range(3, 16))
RPC_MODEL_CONFIG = "HTrJv"
RPC_UPSCALE_VIDEO = "p0UkFb"
RPC_GET_CREDITS = "nzlxg"
VIDEO_RESOLUTION_CODES: dict[str, int] = {
    "720p": 1,
    "1080p": 2,
    "4k": 3,
    "360p": 4,
}
# Matches Flow frontend's `XRa` paygate tier enum.
PAYGATE_TIER_BY_CODE: dict[int, str] = {
    1: "PAYGATE_TIER_ONE",
    2: "PAYGATE_TIER_TWO",
    8: "PAYGATE_TIER_TWO",
}


from flowboard.services.flow_parsers import (
    _coerce_nonneg_int,
    _extract_media_ids,
    _media_id_from_url,
    extract_media_entries,
    extract_operation_names,
    extract_video_operations,
    parse_credits_payload,
)
from flowboard.services.flow_sdk_video import FlowSDKVideoMixin

def resolve_omni_flash_model(duration_s: int, version: str = "1.1") -> str:
    """Map a duration → Flow model key for Omni Flash.
    Raises if the duration is unsupported."""
    if version == "1.2":
        if not isinstance(duration_s, int) or isinstance(duration_s, bool) or not 3 <= duration_s <= 15:
            raise ValueError(
                f"Omni 1.2 Flash duration {duration_s}s unsupported (valid: 3..15)"
            )
        return f"abra_1_2_r2v_{duration_s}s"
    key = OMNI_FLASH_DURATION_KEYS.get(duration_s)
    if not key:
        raise ValueError(
            f"Omni Flash duration {duration_s}s unsupported "
            f"(valid: {sorted(OMNI_FLASH_DURATION_KEYS)})"
        )
    return key


# Image model keys, indexed by the user-facing nickname used in
# flowkit's models.json. Pro (`GEM_PIX_2`) is Flow's flagship high-precision
# model; Nano Banana 2.1 (`BELUGA` + thinking levels) is the newer iteration;
# Nano Banana 2 Lite (`HARBOR_SEAL`) is the fast/economical tier;
# Nano Banana 2 (`NARWHAL`) is legacy and auto-falls back to Pro on [5].
IMAGE_MODELS: dict[str, str] = {
    "NANO_BANANA_PRO": "GEM_PIX_2",
    "NANO_BANANA_2_1": "BELUGA",
    "NANO_BANANA_2_1_LOW": "BELUGA_THINKING_LOW",
    "NANO_BANANA_2_1_MED": "BELUGA_THINKING_MED",
    "NANO_BANANA_2_1_HIGH": "BELUGA_THINKING_HIGH",
    "NANO_BANANA_2_LITE": "HARBOR_SEAL",
    "NANO_BANANA_2": "NARWHAL",
}
DEFAULT_IMAGE_MODEL_KEY = "NANO_BANANA_PRO"


def resolve_image_model(key: Optional[str]) -> str:
    """Map a nickname (`NANO_BANANA_PRO` / `NANO_BANANA_2`) to the actual
    Flow model identifier. Falls back to the Pro default for unknown /
    missing keys so a stale frontend can't break dispatch."""
    if isinstance(key, str) and key in IMAGE_MODELS:
        return IMAGE_MODELS[key]
    return IMAGE_MODELS[DEFAULT_IMAGE_MODEL_KEY]


def _is_rpc_not_found(exc: BaseException) -> bool:
    """True when Flow batchexecute rejected a call with gRPC NOT_FOUND (`[5]`)."""
    if not isinstance(exc, fb.RpcError):
        return False
    detail = exc.detail
    if detail == [5] or detail == 5:
        return True
    return isinstance(detail, list) and len(detail) > 0 and detail[0] == 5


def _is_rpc_invalid_or_not_found(exc: BaseException) -> bool:
    """True when Flow batchexecute rejected a call with INVALID_ARGUMENT (`[3]`) or NOT_FOUND (`[5]`)."""
    if not isinstance(exc, fb.RpcError):
        return False
    detail = exc.detail
    if detail in ([3], 3, [5], 5):
        return True
    return isinstance(detail, list) and len(detail) > 0 and detail[0] in (3, 5)

# Video model keys nested by [tier][quality][aspect]. All values verified
# against real Flow web request bodies (curl exports from labs.google's
# Network tab) — do NOT speculate suffixes here, only use observed keys.
#
# `quality` is "fast" (default), "lite", "quality", or — Ultra only —
# "lite_relaxed" / "fast_relaxed" (0-credit low-priority queue).
#   - Lite (`veo_3_1_i2v_lite`) is shared by Tier 1 and Tier 2; verified
#     from PRO PLAN and ULTRA PLAN curls (see video_model.md and
#     video_model_ultra.md). Multi-aspect — same key for both 16:9 and
#     9:16; the model adapts via the aspectRatio field.
#   - Quality (`veo_3_1_i2v_s` / `veo_3_1_i2v_s_portrait`) is also shared
#     across both tiers; the difference is the `userPaygateTier` in
#     clientContext (rate limits / queue priority), not the model key.
#   - Tier 2 Fast naming pattern: Tier 1 Fast key + `_ultra` suffix
#     (e.g. `veo_3_1_i2v_s_fast` → `veo_3_1_i2v_s_fast_ultra`,
#     `veo_3_1_i2v_s_fast_portrait` → `veo_3_1_i2v_s_fast_portrait_ultra`).
#   - Tier 2 "low priority" 0-credit models (Ultra-only fallback when the
#     user wants to keep their daily credit budget): Lite uses the
#     `_low_priority` suffix (`veo_3_1_i2v_lite_low_priority`); Fast uses
#     the `_relaxed` suffix on the ultra family (`veo_3_1_i2v_s_fast_ultra_relaxed`).
#     Verified from ULTRA PLAN curls. PORTRAIT keys for these are not yet
#     observed — we reuse the LANDSCAPE key for both aspects (Lite is
#     genuinely multi-aspect; Fast Relaxed portrait will need a real curl
#     to confirm, but Flow's portrait variants typically follow the
#     `_portrait` suffix convention if separate keys are required).
VIDEO_MODEL_KEYS: dict[str, dict[str, dict[str, str]]] = {
    # Tier 1 (Pro) — three quality levels, all verified from real PRO
    # PLAN curls (see video_model.md). Lite shares `veo_3_1_i2v_lite`
    # with Tier 2; Quality shares `veo_3_1_i2v_s` with Tier 2 — paygate
    # tier in clientContext drives any per-tier difference. No 0-credit
    # low-priority option here — that's a Tier 2 (Ultra) perk.
    "PAYGATE_TIER_ONE": {
        "lite": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_lite",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_lite",
        },
        "fast": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s_fast",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_fast_portrait",
        },
        "quality": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_portrait",
        },
    },
    # Tier 2 (Ultra) — five quality levels:
    #   - lite: `veo_3_1_i2v_lite` (5 credits, multi-aspect)
    #   - fast: `_fast_ultra` family (10 credits, default, balanced)
    #   - quality: `veo_3_1_i2v_s*` family (highest fidelity, slowest)
    #   - lite_relaxed: `veo_3_1_i2v_lite_low_priority` (0 credits,
    #     low-priority queue, Ultra-only)
    #   - fast_relaxed: `veo_3_1_i2v_s_fast_ultra_relaxed` (0 credits,
    #     low-priority queue, Ultra-only).
    #   PORTRAIT keys for the `_relaxed` family are not yet verified
    #   from a real curl; we reuse the LANDSCAPE key as a best-effort
    #   fallback. If Flow rejects portrait dispatches, capture a portrait
    #   curl and add the proper key here.
    "PAYGATE_TIER_TWO": {
        "lite": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_lite",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_lite",
        },
        "fast": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s_fast_ultra",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_fast_portrait_ultra",
        },
        "quality": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_portrait",
        },
        "lite_relaxed": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_lite_low_priority",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_lite_low_priority",
        },
        "fast_relaxed": {
            "VIDEO_ASPECT_RATIO_LANDSCAPE": "veo_3_1_i2v_s_fast_ultra_relaxed",
            "VIDEO_ASPECT_RATIO_PORTRAIT": "veo_3_1_i2v_s_fast_ultra_relaxed",
        },
    },
}

DEFAULT_VIDEO_QUALITY = "fast"


def resolve_video_model(
    paygate_tier: str, aspect_ratio: str, quality: Optional[str] = None
) -> Optional[str]:
    """Resolve a Flow video model key from tier + aspect + quality.

    Falls back through (quality → fast) → (tier → TIER_ONE) → None so
    a stale frontend or unknown tier can't break dispatch silently.
    """
    q = (quality or DEFAULT_VIDEO_QUALITY).lower()
    tier_map = (
        VIDEO_MODEL_KEYS.get(paygate_tier)
        or VIDEO_MODEL_KEYS.get("PAYGATE_TIER_ONE")
        or {}
    )
    quality_map = tier_map.get(q) or tier_map.get(DEFAULT_VIDEO_QUALITY) or {}
    return quality_map.get(aspect_ratio)

# project_id must match the shape Google Flow returns (UUID-ish). Validated at
# handler boundaries to prevent path traversal into arbitrary API URLs.
_PROJECT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

# Flow CDN URLs embed the UUID media_id in the path:
#   https://flow-content.google/video/<UUID>?Expires=...&Signature=...
# When the polling response omits `metadata.video.mediaId` (it usually does for
# video — only `mediaGenerationId` which is a base64 protobuf, NOT a UUID),
# we recover the UUID from the URL exactly like flowkit does.
_UUID_IN_URL_RE = re.compile(
    r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.IGNORECASE,
)


def is_valid_project_id(project_id: str) -> bool:
    return bool(_PROJECT_ID_RE.fullmatch(project_id))

# Captcha action strings recognised by Google Flow.
CAPTCHA_IMAGE = "IMAGE_GENERATION"
CAPTCHA_VIDEO = "VIDEO_GENERATION"

# Image variants per dispatch are capped server-side as defence-in-depth — the
# UI clamps to 4 too. Any value above this is silently coerced down.
MAX_VARIANT_COUNT = 4

# Flow's own UI starts image variants as separate single-image RPCs on a short
# cadence rather than as one burst, and each RPC carries its own single-use
# reCAPTCHA. Matching that cadence measurably reduced transient rejections
# upstream, so it is reproduced here. Index = position within the wave.
IMAGE_UI_SUBMIT_OFFSETS_S = (0.0, 0.5, 1.5, 2.5)

_VALID_TIERS = {"PAYGATE_TIER_ONE", "PAYGATE_TIER_TWO"}


def resolve_paygate_tier(requested: Optional[str] = None) -> str:
    """Settle on the account's Flow plan, or raise saying why we cannot.

    This used to be discovered: the extension sniffed a Bearer token and the
    agent asked ``/v1/credits`` which tier it belonged to. ``flow.google.com``
    mints no Bearer, so there is nothing left to ask — see
    ``FlowClient.fetch_paygate_tier``.

    The tier is not cosmetic, which is why this resolves rather than defaults
    at each call site: it still picks the video checkpoint, because
    ``resolve_video_model`` keys on it and ``flow_batch.resolve_video_model``
    then maps Tier 2 "fast" onto ``veo_3_1_i2v_s_fast_ultra`` while everything
    else lands on a lite model. Silently guessing would hand an Ultra account
    the low-priority queue — exactly the regression the pre-v1.1.5 default
    caused, when it was a hardcoded ``PAYGATE_TIER_ONE``.

    So the plan is declared once, in config, and an unrecognised value fails
    loudly here instead of quietly changing which model renders.
    """
    from flowboard.services.flow_accounts import active_tier

    managed, configured = active_tier()
    tier = (configured if managed else requested) or DEFAULT_PAYGATE_TIER
    if tier not in _VALID_TIERS:
        raise ValueError(
            f"paygate_tier_invalid: {tier!r} is not one of {sorted(_VALID_TIERS)} "
            "— set FLOWBOARD_PAYGATE_TIER to the account's Flow plan"
        )
    return tier


def _batch_failure(exc: Exception) -> dict:
    """An exception from the batch path, in the error shape callers expect.

    ``FlowBatchError`` and ``ValueError`` already carry a readable sentence —
    often one with a ``NO_FLOW_PROJECT`` / ``UNSUPPORTED_ON_BATCH_API`` /
    ``paygate_tier_invalid`` prefix the frontend keys on — so they are passed
    through as-is. Anything else gets its class name, because a bare
    ``KeyError: 3`` from a shifted response slot is unreadable without it.
    """
    message = str(exc) if isinstance(exc, (fb.FlowBatchError, ValueError)) \
        else f"{type(exc).__name__}: {exc}"
    return {"raw": {"status": 502, "error": message}, "error": message[:200]}


def _as_media_envelope(images: list) -> dict:
    """Generated images, back in the REST ``data.media[]`` shape.

    ``extract_media_entries`` and every caller downstream of it were written
    against the REST response, so the batch payload is re-shaped here rather
    than teaching the rest of the app a second schema.
    """
    return {
        "status": 200,
        "data": {
            "media": [
                {
                    "name": image.media_id,
                    "image": {
                        "generatedImage": {
                            "mediaId": image.media_id,
                            "fifeUrl": image.url,
                        },
                    },
                }
                for image in images
            ],
        },
    }


def _pending_operation(
    operation_id: str,
    complaint: Optional[str] = None,
    media_id: Optional[str] = None,
) -> dict:
    """An operation that has not produced a fetchable clip yet.

    ``complaint`` is carried, not acted on. A poll can report
    ``"Media not found."`` and still deliver a finished eight-second clip, so
    it lives here to make a timeout message useful and is deliberately NOT
    written to the ``error`` slot ``extract_video_operations`` treats as
    terminal. Putting it there is what killed live runs before.
    """
    entry: dict[str, Any] = {
        "operation": {"name": operation_id},
        "status": "MEDIA_GENERATION_STATUS_PENDING",
    }
    if media_id:
        entry["operation"]["metadata"] = {"video": {"mediaId": media_id}}
    if complaint:
        entry["complaint"] = complaint
    return entry


def _failed_operation(operation_id: str, message: str) -> dict:
    """A terminal per-operation failure reported by Flow (e.g. policy block)."""
    return {
        "operation": {
            "name": operation_id,
            "error": {"code": 3, "message": message[:300]},
        },
        "status": "MEDIA_GENERATION_STATUS_FAILED",
    }


def _as_operation_envelope(operation_ids: list[str]) -> dict:
    return {
        "status": 200,
        "data": {"operations": [_pending_operation(op) for op in operation_ids]},
    }


class FlowSDK(FlowSDKVideoMixin):
    """Flow semantics on top of ``flow_client.batch_rpc``.

    No longer stateless, and it cannot be: turning a finished operation into a
    downloadable clip needs to know which Flow project the operation belongs
    to, and the batch poll does not reliably say — an operation that has aged
    decays to a bare id. So the project is noted at submit time. See
    ``_remember_operation``.
    """

    #: Bound on the per-operation caches. They are caches and the pinned
    #: project is always a workable fallback, so dropping the lot is safe.
    _CACHE_LIMIT = 512

    def __init__(self, client: Optional[FlowClient] = None) -> None:
        self._client = client or flow_client
        #: operation id -> Flow project id, noted at submit time
        self._operation_projects: dict[str, str] = {}
        #: operation id -> media id, once as29s or jwpduf has confirmed it
        self._operation_media: dict[str, str] = {}
        #: operation id -> how many rounds we have polled it
        self._operation_polls: dict[str, int] = {}
        #: operation id -> consecutive policy/safety complaint count on jwpduf
        self._operation_policy_strikes: dict[str, int] = {}
        #: cached Omni 1.2 wire keys discovered from live Flow HTrJv config
        self._omni_1_2_r2v_keys: dict[tuple[int, str], str] = {}

    # ── transport plumbing ─────────────────────────────────────────────────
    async def _payload(
        self,
        rpcid: str,
        freq: str,
        captcha_action: Optional[str] = None,
        timeout: float = 300.0,
    ) -> Any:
        """One RPC, unwrapped to its inner payload. Raises on anything else."""
        result = await self._client.batch_rpc(
            rpcid, freq, captcha_action, timeout=timeout
        )
        if not isinstance(result, dict):
            raise fb.FlowBatchError(
                f"{rpcid}: bridge returned {type(result).__name__}, expected a dict"
            )
        if result.get("error"):
            raise fb.FlowBatchError(f"{rpcid}: {result['error']}")
        return fb.first_payload(result.get("data") or "", rpcid)

    def _project_id(self, project_id: Any) -> str:
        """The Flow project this RPC is scoped to.

        Every batchexecute call carries one — there is no project-less mode any
        more. Boards store a real Flow uuid, but a few call sites pass an empty
        value for project-less work; those fall back to the pinned project.
        """
        from flowboard.services.flow_accounts import active_project

        managed, profile_project = active_project()
        if managed:
            if not profile_project:
                raise fb.FlowBatchError("请先在 Flow 账号设置中绑定项目。")
            if project_id and project_id != profile_project:
                raise fb.FlowBatchError("Flow 账号或项目已切换，请重新提交任务。")
            return profile_project
        candidate = str(project_id or "").strip()
        if candidate and is_valid_project_id(candidate):
            return candidate
        # Resolved, not imported: the pinned project is settable at runtime,
        # and a module-level constant would pin it to whatever .env said at
        # boot while the dashboard reported the override. See flow_project.
        pinned = effective_project_id()
        if pinned:
            return pinned
        raise fb.FlowBatchError(NO_FLOW_PROJECT)

    def _remember_operation(self, operation_id: str, project_id: str) -> None:
        """Note which project an operation belongs to, for the listing lookup."""
        if not operation_id:
            return
        if len(self._operation_projects) > self._CACHE_LIMIT:
            self._operation_projects.clear()
            self._operation_media.clear()
            self._operation_polls.clear()
            self._operation_policy_strikes.clear()
        self._operation_projects[operation_id] = project_id

    # ── project listing / creation (both unported) ─────────────────────────
    async def search_user_projects(
        self,
        cursor: Optional[str] = None,
        page_size: int = 20,
        tool: str = "PINHOLE",
    ) -> dict[str, Any]:
        """Unported. Kept so the route answers with a reason, not a stack trace.

        This was ``project.searchUserProjects`` on the labs.google tRPC
        frontend. The migration unauthenticated that frontend and no
        batchexecute equivalent has been captured off the new UI — the only
        project-scoped listing RPC that has (``Zzl0ze``) lists the *media*
        inside one project you already know the uuid of, not the projects
        themselves.
        """
        return {
            "raw": None,
            "projects": [],
            "next_page_token": None,
            "error": UNSUPPORTED_PROJECT_LISTING,
        }

    async def list_user_projects_all(
        self, tool: str = "PINHOLE", max_pages: int = 10
    ) -> dict[str, Any]:
        """Unported — see :meth:`search_user_projects`."""
        return {
            "projects": [],
            "truncated": False,
            "error": UNSUPPORTED_PROJECT_LISTING,
        }

    async def create_project(
        self, title: str, tool: str = "PINHOLE"
    ) -> dict[str, Any]:
        """Hand back the pinned Flow project. Flow will not make a new one.

        ``project.createProject`` was tRPC too, so this cannot create anything.
        Returning the pinned project instead of an error keeps generation
        working, but it means Flowboard boards now *share* one Flow project
        rather than each owning one. That is a real consequence — the media
        listing inside Flow is shared, and deleting the Flow project affects
        every board — so it is reported as ``reused`` instead of letting the
        caller believe a fresh project was created.
        """
        from flowboard.services.flow_accounts import active_project

        managed, project_id = active_project()
        pinned = project_id if managed else effective_project_id()
        if pinned:
            logger.info(
                "create_project(%r): reusing pinned Flow project %s — Flow no "
                "longer exposes project creation",
                title, pinned[:12],
            )
            return {"raw": None, "project_id": pinned, "reused": True}
        return {"raw": None, "error": NO_FLOW_PROJECT}

    # ── image generation (ogiZ0b) ──────────────────────────────────────────
    async def gen_image(
        self,
        prompt: str,
        project_id: str,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: Optional[str] = None,
        ref_media_ids: Optional[list[str]] = None,
        variant_count: int = 1,
        character_media_ids: Optional[list[str]] = None,  # legacy alias
        prompts: Optional[list[str]] = None,
        image_model: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """Generate ``variant_count`` images (1-4), conditioned on references.

        Variants are separate RPCs under distinct seeds, because the batch
        image request has no "how many" field: Flow returns one image per item,
        and slot 4 of the item — which reads like a count — is the aspect ratio.
        A request with ``count=1`` looked correct for exactly that reason,
        since 1 there means square.

        ``paygate_tier`` is accepted and validated but does not reach the wire:
        the image payload has no tier slot on this transport. It stays in the
        signature so the worker's resolution chain is uniform across handlers
        and a bad value is still caught before dispatch.
        """
        return await self._generate_images(
            prompt=prompt,
            project_id=project_id,
            aspect_ratio=aspect_ratio,
            paygate_tier=paygate_tier,
            ref_media_ids=(
                ref_media_ids if ref_media_ids is not None else character_media_ids
            ),
            variant_count=variant_count,
            prompts=prompts,
            image_model=image_model,
            base_media_id=None,
            seed=seed,
        )

    async def edit_image(
        self,
        prompt: str,
        project_id: str,
        source_media_id: str,
        ref_media_ids: Optional[list[str]] = None,
        aspect_ratio: str = "IMAGE_ASPECT_RATIO_LANDSCAPE",
        paygate_tier: Optional[str] = None,
        image_model: Optional[str] = None,
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """Refine an image, with the source as Flow's BASE_IMAGE input.

        Sending the source as a plain reference instead conditions a fresh
        generation on it; BASE_IMAGE (input type 2, against a reference's 1) is
        the shape the current Flow editor uses for an actual edit. Extra
        references stay REFERENCE inputs and the source is never duplicated
        into them.
        """
        if not isinstance(source_media_id, str) or not source_media_id.strip():
            return {"raw": None, "error": "missing_source_media_id"}
        return await self._generate_images(
            prompt=prompt,
            project_id=project_id,
            aspect_ratio=aspect_ratio,
            paygate_tier=paygate_tier,
            ref_media_ids=ref_media_ids,
            variant_count=1,
            prompts=None,
            image_model=image_model,
            base_media_id=source_media_id.strip(),
            seed=seed,
        )

    async def _generate_images(
        self,
        *,
        prompt: str,
        project_id: str,
        aspect_ratio: str,
        paygate_tier: Optional[str],
        ref_media_ids: Optional[list[str]],
        variant_count: int,
        prompts: Optional[list[str]],
        image_model: Optional[str],
        base_media_id: Optional[str],
        seed: Optional[int] = None,
    ) -> dict[str, Any]:
        """Shared body for :meth:`gen_image` and :meth:`edit_image`."""
        try:
            resolve_paygate_tier(paygate_tier)
            pid = self._project_id(project_id)
            count = max(1, min(int(variant_count), MAX_VARIANT_COUNT))
            # Flowboard's own model policy, resolved to a wire id here so that
            # flow_batch can stay byte-identical to flowkit's copy (whose
            # default model is a different one).
            model = resolve_image_model(image_model)
            refs = [
                mid for mid in (ref_media_ids or [])
                if isinstance(mid, str) and mid and mid != base_media_id
            ] or None
            texts = [
                prompts[i]
                if (prompts and i < len(prompts)
                    and isinstance(prompts[i], str) and prompts[i])
                else prompt
                for i in range(count)
            ]
            base_seed = (
                int(seed)
                if isinstance(seed, int) and not isinstance(seed, bool) and seed >= 0
                else int(time.time() * 1000) % 1_000_000
            )
        except (ValueError, TypeError, fb.FlowBatchError) as exc:
            return _batch_failure(exc)

        async def submit(index: int) -> Any:
            offset = IMAGE_UI_SUBMIT_OFFSETS_S[
                min(index, len(IMAGE_UI_SUBMIT_OFFSETS_S) - 1)
            ]
            if offset:
                await asyncio.sleep(offset)
            freq = fb.image_request(
                texts[index], pid, count=1, aspect=aspect_ratio,
                seed=base_seed + index * 9973, model=model,
                ref_media_ids=refs, base_media_id=base_media_id,
            )
            try:
                payload = await self._payload(
                    fb.RPC_GEN_IMAGE, freq, fb.CAPTCHA_IMAGE
                )
            except fb.RpcError as exc:
                if model != "GEM_PIX_2" and _is_rpc_not_found(exc):
                    logger.warning(
                        "ogiZ0b returned NOT_FOUND [5] for model=%s; automatically falling back to GEM_PIX_2",
                        model,
                    )
                    freq = fb.image_request(
                        texts[index], pid, count=1, aspect=aspect_ratio,
                        seed=base_seed + index * 9973, model="GEM_PIX_2",
                        ref_media_ids=refs, base_media_id=base_media_id,
                    )
                    payload = await self._payload(
                        fb.RPC_GEN_IMAGE, freq, fb.CAPTCHA_IMAGE
                    )
                else:
                    raise
            images = fb.read_images(payload)
            if not images:
                raise fb.FlowBatchError("image generation returned no media url")
            return images[0]

        settled = await asyncio.gather(
            *(submit(i) for i in range(count)), return_exceptions=True
        )
        images = [r for r in settled if not isinstance(r, BaseException)]
        failures = [
            (i, r) for i, r in enumerate(settled) if isinstance(r, BaseException)
        ]
        if not images:
            return _batch_failure(
                failures[0][1] if failures
                else fb.FlowBatchError("image generation returned no media")
            )

        resp = _as_media_envelope(images)
        if failures:
            # A partly-successful wave returns the variants that did render.
            # Collapsing three good images into a hard failure because the
            # fourth was rejected is worth avoiding.
            resp["data"]["failed_variants"] = [
                {"index": i + 1, "error": str(exc)[:200]} for i, exc in failures
            ]
            logger.warning(
                "image wave: %d of %d variant(s) failed — %s",
                len(failures), count,
                "; ".join(str(exc)[:80] for _, exc in failures),
            )
        return {
            "raw": resp,
            "media_ids": _extract_media_ids(resp),
            "media_entries": extract_media_entries(resp),
        }

    # ── image upscaling (SPrCad) ───────────────────────────────────────────
    async def upscale_image(
        self,
        media_id: str,
        project_id: str = "",
        resolution: str = "2K",
    ) -> dict[str, Any]:
        """Upscale a generated image to 2K or 4K via FlowService.UpsampleImage (SPrCad)."""
        key = str(resolution or "2K").strip().upper()
        if key not in fb.IMAGE_UPSCALE_RESOLUTIONS:
            return {"raw": None, "error": "image upscale resolution must be 2K or 4K"}
        code = fb.IMAGE_UPSCALE_RESOLUTIONS[key]
        try:
            pid = self._project_id(project_id) if project_id or effective_project_id() else None
        except fb.FlowBatchError as exc:
            return _batch_failure(exc)
        try:
            freq = fb.build_envelope(fb.RPC_UPSCALE_IMAGE, [media_id, code, fb._context(pid)])
            payload = await self._payload(
                fb.RPC_UPSCALE_IMAGE, freq, fb.CAPTCHA_IMAGE, timeout=120.0
            )
            images = fb.read_images(payload)
            if images:
                return {
                    "raw": payload,
                    "media_id": images[0].media_id,
                    "url": images[0].url,
                    "encoded_image": None,
                    "resolution": key,
                }
            encoded = fb.read_upscaled_image(payload)
            return {
                "raw": payload,
                "media_id": media_id,
                "url": None,
                "encoded_image": encoded,
                "resolution": key,
            }
        except Exception as exc:  # broad by design: surfaced cleanly
            return _batch_failure(exc)

    # ── image upload (maseQ) ───────────────────────────────────────────────
    async def upload_image(
        self,
        image_base64: str,
        mime_type: str,
        project_id: str,
        file_name: str = "upload.png",
    ) -> dict[str, Any]:
        """Put a local image into a Flow project so it can be referenced.

        ``image_base64`` is a bare base64 payload — no ``data:`` prefix, no
        separate upload endpoint; the bytes ride inside the RPC.

        Unlike the REST upload this one carries a reCAPTCHA: ``maseQ`` is gated
        exactly like a generate. An upload that fails with ``CAPTCHA_FAILED``
        is therefore a tab problem, not a rejected image.
        """
        try:
            pid = self._project_id(project_id)
            payload = await self._payload(
                fb.RPC_UPLOAD_IMAGE,
                fb.upload_request(image_base64, pid, mime_type, file_name),
                fb.CAPTCHA_IMAGE,
                timeout=120.0,
            )
            media_id = fb.read_uploaded_media_id(payload)
        except Exception as exc:  # broad by design: reported, never swallowed
            # Most common cause of a well-formed response with no media handle
            # is a silent content-filter rejection (logos, watermarks, branded
            # imagery); next most common is a Flow schema change. Log enough to
            # tell them apart without dumping the image bytes.
            logger.error(
                "upload_image failed (project_id=%s, file=%s, mime=%s): %s",
                project_id, file_name, mime_type, exc,
            )
            return _batch_failure(exc)
        return {
            "raw": {"status": 200, "data": {"media": {"name": media_id}}},
            "media_id": media_id,
        }

    # ── account credits query (nzlxg) ──────────────────────────────────────
    async def get_credits(self, project_id: Optional[str] = None) -> dict[str, Any]:
        """Query the user's current Flow credit balance & paygate tier via RPC ``nzlxg``."""
        try:
            try:
                payload = await self._payload(
                    RPC_GET_CREDITS,
                    fb.build_envelope(RPC_GET_CREDITS, []),
                    timeout=20.0,
                )
            except fb.RpcError:
                pid = project_id or effective_project_id() or ""
                payload = await self._payload(
                    RPC_GET_CREDITS,
                    fb.build_envelope(
                        RPC_GET_CREDITS,
                        [[None, fb.SURFACE_ID, None, None, None, pid]],
                    ),
                    timeout=20.0,
                )
        except Exception as exc:  # broad by design: reported cleanly
            return _batch_failure(exc)
        return {"raw": payload, **parse_credits_payload(payload)}


_sdk: Optional[FlowSDK] = None


def get_flow_sdk() -> FlowSDK:
    global _sdk
    if _sdk is None:
        _sdk = FlowSDK()
    return _sdk
