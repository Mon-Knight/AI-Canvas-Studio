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


def _media_id_from_url(url: Optional[str]) -> Optional[str]:
    if not isinstance(url, str):
        return None
    m = _UUID_IN_URL_RE.search(url)
    return m.group(1) if m else None


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


def _as_operation_envelope(operation_ids: list[str]) -> dict:
    return {
        "status": 200,
        "data": {"operations": [_pending_operation(op) for op in operation_ids]},
    }


class FlowSDK:
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
        #: operation id -> media id, once the project listing has revealed it
        self._operation_media: dict[str, str] = {}
        #: operation id -> how many rounds we have polled it
        self._operation_polls: dict[str, int] = {}
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
            tier = resolve_paygate_tier(paygate_tier)
            pid = self._project_id(project_id)
        except (ValueError, fb.FlowBatchError) as exc:
            return _batch_failure(exc)

        legacy_key = resolve_video_model(tier, aspect_ratio, video_quality)
        if not legacy_key:
            return {
                "raw": None,
                "error": (
                    f"no_video_model_for_tier_{tier}"
                    f"_quality_{video_quality or DEFAULT_VIDEO_QUALITY}"
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
            sources = sources * max(1, min(variant_count, MAX_VARIANT_COUNT))

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
                RPC_MODEL_CONFIG, fb.build_envelope(RPC_MODEL_CONFIG, []), timeout=15.0
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
            resolve_paygate_tier(paygate_tier)
            pid = self._project_id(project_id)
        except (ValueError, fb.FlowBatchError) as exc:
            return _batch_failure(exc)

        if aspect_ratio not in OMNI_FLASH_VALID_ASPECTS:
            return {"raw": None, "error": f"omni_aspect_unsupported_{aspect_ratio}"}
        refs = [
            mid for mid in (ref_media_ids or []) if isinstance(mid, str) and mid
        ]
        if not refs:
            return {"raw": None, "error": "missing_ref_media_ids"}

        ver = "1.2" if str(omni_version).strip() == "1.2" else "1.1"
        res = "360p" if str(resolution or "720p").strip().lower() == "360p" else "720p"
        try:
            model = resolve_omni_flash_model(duration_s, version=ver)
        except ValueError as exc:
            return {"raw": None, "error": str(exc)[:200]}

        if ver == "1.2":
            await self._discover_omni_1_2_keys()
            model = self._omni_1_2_r2v_keys.get((duration_s, res), model + ("_360p" if res == "360p" else ""))

        count = (
            max(1, min(int(variant_count), MAX_VARIANT_COUNT))
            if isinstance(variant_count, int) and not isinstance(variant_count, bool)
            else 1
        )

        def build_mzza6b_freq(wire_model: str, wire_res: str) -> str:
            if ver == "1.1" and duration_s in OMNI_FLASH_DURATION_KEYS and wire_model.startswith("abra_r2v_"):
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
                    if not _is_rpc_invalid_or_not_found(exc) or not fallback_pairs:
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
                            if not _is_rpc_invalid_or_not_found(retry_exc):
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
            return _batch_failure(exc)

        norm = str(resolution or "1080p").strip().lower()
        if norm == "4k":
            res_code = VIDEO_RESOLUTION_CODES["4k"]
            upsampler_model = "veo_3_1_upsampler_4k"
            res_label = "4K"
        elif norm == "1080p":
            res_code = VIDEO_RESOLUTION_CODES["1080p"]
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
            RPC_UPSCALE_VIDEO,
            [[item], fb._context(pid), [fb._client_uuid(), 2]],
        )
        try:
            payload = await self._payload(
                RPC_UPSCALE_VIDEO, freq, fb.CAPTCHA_VIDEO, timeout=120.0
            )
            operation = fb.read_operation(payload)
        except Exception as exc:  # broad by design: reported, never swallowed
            return _batch_failure(exc)

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
            return _batch_failure(
                failures[0][1] if failures
                else fb.FlowBatchError("video submit returned no operation")
            )
        resp = _as_operation_envelope(operation_ids)
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
                entries.append(_pending_operation(name, complaint=str(exc)[:200]))

        resp = {"status": 200, "data": {"operations": entries}}
        return {
            "raw": resp,
            "operations": extract_video_operations(
                resp, requested=list(operation_names or [])
            ),
        }

    async def _poll_operation(self, operation_id: str) -> dict:
        """One poll round for one operation, as a REST operation envelope.

        Three signals have to agree before a clip can be downloaded, and they
        arrive out of order:

        * the operation poll says how the job is going — but it can sit at no
          status at all on a job that finished, and a ``"Media not found."``
          complaint on it is survivable rather than fatal;
        * the project listing is what actually gains a media id;
        * the media record serves the poster image first and grows the
          ``/video/`` url in later.

        So an operation reports SUCCESSFUL only once a video url exists.
        Everything short of that is PENDING, and the worker owns the timeout.
        """
        media_id = self._operation_media.get(operation_id)
        complaint: Optional[str] = None

        if not media_id:
            media_id, complaint = await self._find_operation_media(operation_id)
            if not media_id:
                return _pending_operation(operation_id, complaint=complaint)
            self._operation_media[operation_id] = media_id

        urls = await self._media_urls(media_id)
        if not urls.video:
            # The id landed but the clip is still being written. Downloading on
            # the id alone here saves the poster still, not the video.
            return _pending_operation(
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
    ) -> tuple[Optional[str], Optional[str]]:
        """Ask the operation how it is doing, then the listing where its media is.

        The listing is the authority — a poll has been observed never to report
        a finished job the listing already knew about — but it is also the
        expensive call, so it is consulted only when the poll says something
        happened, when the poll is unreadable, or every third round regardless.
        """
        rounds = self._operation_polls.get(operation_id, 0) + 1
        self._operation_polls[operation_id] = rounds

        project_id = (
            self._operation_projects.get(operation_id) or effective_project_id()
        )
        complaint: Optional[str] = None
        worth_looking = rounds % 3 == 0
        try:
            operation = fb.read_operation(
                await self._payload(
                    fb.RPC_OPERATION,
                    fb.operation_request(operation_id),
                    timeout=60.0,
                )
            )
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
            return None, complaint
        if not project_id:
            return None, "no project id for the listing lookup"
        return await self._media_id_for(operation_id, project_id), complaint

    async def _media_id_for(
        self, operation_id: str, project_id: str
    ) -> Optional[str]:
        """Find an operation's media id in the project listing.

        Asks the extension for an 800-byte window around the operation id
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


_sdk: Optional[FlowSDK] = None


def get_flow_sdk() -> FlowSDK:
    global _sdk
    if _sdk is None:
        _sdk = FlowSDK()
    return _sdk
