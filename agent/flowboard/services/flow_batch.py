"""Flow's batchexecute API — the transport Flow moved to in September 2026.

The old world was a REST call to ``aisandbox-pa.googleapis.com`` carrying a
``Bearer ya29.…`` the extension sniffed off the page. That token no longer
exists: the rewritten frontend on ``flow.google.com`` signs every call with the
session cookie plus a per-page ``at`` token, against a single batchexecute
endpoint. Nothing can be replayed from outside the browser — a generate call
also carries a **single-use** reCAPTCHA token, and a replayed one comes back
``PUBLIC_ERROR_UNUSUAL_ACTIVITY``.

So this module never touches the network. It builds request envelopes and reads
responses; issuing the request is the job of the Chrome extension, which runs
the payload inside the Flow tab (see ``FlowClient.batch_rpc``).

The wire format is Google's usual batchexecute:

    f.req = [[[rpcid, "<inner payload as a JSON string>", null, "generic"]]]

and the response is a ``)]}'`` sentinel followed by length-prefixed chunks of
``["wrb.fr", rpcid, "<payload as a JSON string>", …]`` envelopes.

Ported verbatim from flowkit's ``agent/services/flow_batch.py`` (v1.2.0), which
in turn came from postforge/bridges/flowgen — see that repo's MIGRATION.md for
the traps behind each of the comments below. Kept byte-identical to flowkit's
copy on purpose: it is the one module here that has been exercised against live
Flow across three projects, so a future upstream fix should diff cleanly rather
than needing a re-port. Flowboard's own model policy does NOT live here — it
stays in flow_sdk.py, which resolves a nickname to a wire id before calling in.
"""
from __future__ import annotations

import json
import random
import re
import uuid
from dataclasses import dataclass
from typing import Any, Optional

BATCH_PATH = "/_/AiSandboxAngularFrontend/data/batchexecute"
MEDIA_HOST = "flow-content.google"

RPC_GEN_IMAGE = "ogiZ0b"
RPC_GEN_VIDEO = "eb1hJf"
RPC_GEN_VIDEO_TEXT = "YhhmEf"
RPC_GEN_VIDEO_FIRST_LAST = "nprQif"
RPC_GEN_VIDEO_REFERENCES = "MZZa6b"
RPC_OPERATION = "jwpduf"
RPC_PROJECT_MEDIA = "Zzl0ze"
RPC_MEDIA = "as29s"
RPC_UPLOAD_IMAGE = "maseQ"
RPC_UPSCALE_IMAGE = "SPrCad"

CAPTCHA_IMAGE = "IMAGE_GENERATION"
CAPTCHA_VIDEO = "VIDEO_GENERATION"

#: The extension substitutes a freshly minted reCAPTCHA token for this marker.
#: It has to be a placeholder rather than a real token because the mint has to
#: happen in the page, moments before the request leaves.
CAPTCHA_SLOT = "__CAPTCHA__"

#: Current image model wire ids observed in the Flow frontend. Unknown future
#: ids are accepted by ``resolve_image_model`` instead of being silently
#: replaced by the default, so callers can opt into a newly exposed model
#: before Flow Kit itself ships another release.
IMAGE_MODELS = {"GEM_PIX_2", "NARWHAL", "HARBOR_SEAL"}
IMAGE_MODEL = "GEM_PIX_2"

#: Friendly aliases. Exact Flow wire ids work too.
IMAGE_MODEL_BY_NICKNAME = {
    "NANO_BANANA_PRO": "GEM_PIX_2",
    "NANO_BANANA_2": "NARWHAL",
    "NANO_BANANA_2_LITE": "HARBOR_SEAL",
    "NANO_BANANA_LITE": "HARBOR_SEAL",
}
IMAGE_MODEL_ID_RE = re.compile(r"^[A-Z][A-Z0-9_]{1,95}$")

#: Image aspect ratios, measured by generating one of each and reading the
#: JPEG header. This slot was mistaken for a variant count at first — 1 means
#: square, which is why a `count=1` request looked like it was working.
ASPECT_SQUARE = 1           # 1024x1024
ASPECT_PORTRAIT = 2         # 768x1376  (9:16)
ASPECT_LANDSCAPE = 3        # 1376x768  (16:9)
ASPECT_PORTRAIT_4_3 = 4     # 896x1200  (3:4)
ASPECT_LANDSCAPE_4_3 = 5    # 1200x896  (4:3)

#: The names the REST payload used, so callers can keep speaking them.
ASPECT_BY_NAME = {
    "IMAGE_ASPECT_RATIO_SQUARE": ASPECT_SQUARE,
    "IMAGE_ASPECT_RATIO_PORTRAIT": ASPECT_PORTRAIT,
    "IMAGE_ASPECT_RATIO_LANDSCAPE": ASPECT_LANDSCAPE,
    # Current spelling plus the old Flow Kit alias for compatibility.
    "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR": ASPECT_PORTRAIT_4_3,
    "IMAGE_ASPECT_RATIO_PORTRAIT_FOUR_THREE": ASPECT_PORTRAIT_4_3,
    "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE": ASPECT_LANDSCAPE_4_3,
    # Friendly API aliases.
    "1:1": ASPECT_SQUARE,
    "9:16": ASPECT_PORTRAIT,
    "16:9": ASPECT_LANDSCAPE,
    "3:4": ASPECT_PORTRAIT_4_3,
    "4:3": ASPECT_LANDSCAPE_4_3,
}

#: Video models this path accepts. The REST-era map was keyed by
#: [tier][quality][aspect] and carried `…_portrait` / `…_fl` / `…_relaxed`
#: variants; those are gone — aspect is its own slot now, and the suffixed
#: names are rejected.
VIDEO_MODEL = "veo_3_1_i2v_lite_low_priority"
VIDEO_MODELS = {
    "veo_3_1_i2v_lite_low_priority",
    "veo_3_1_i2v_lite",
    "veo_3_1_i2v_s_fast_ultra",
}

#: Video aspect, and note it does NOT share the image encoding: here 1 is
#: portrait, where for an image 1 is square. Measured by rendering one of each
#: from the same portrait still — 720x1280 against 1280x720.
VIDEO_ASPECT_PORTRAIT = 1
VIDEO_ASPECT_LANDSCAPE = 2

VIDEO_ASPECT_BY_NAME = {
    "VIDEO_ASPECT_RATIO_PORTRAIT": VIDEO_ASPECT_PORTRAIT,
    "VIDEO_ASPECT_RATIO_LANDSCAPE": VIDEO_ASPECT_LANDSCAPE,
}

#: `CAE` was the operation's legacy terminal marker (replaced by `null` on
#: 2026-10-06; live completion is signalled by `details[8][0] == OUTCOME_OK`).
STATUS_DONE = "CAE"

#: Outcome codes seen in the operation's status block (`record[5][8][0]`):
#: 6 = submitted, 2 = running, 3 = done, 4 = failed/complaint.
#: Code 4 can carry a survivable `"Media not found."` complaint — jobs that
#: report it can still finish in the listing, while `PUBLIC_ERROR_*` or
#: explicit failure text indicates a real rejection.
OUTCOME_RUNNING = 2
OUTCOME_OK = 3
OUTCOME_COMPLAINT = 4
OUTCOME_SUBMITTED = 6

#: Surface id the web client stamps on every call. Constant in every capture.
SURFACE_ID = 22

#: Crop box on the reference image, verbatim from the current Flow UI when
#: nothing was reframed by hand (live-captured 2026-09-23 / Nov 2026).
FULL_FRAME_CROP = [None, None, 1, 1]

#: Image inputs put the media id first and the input type four slots later.
#: Type 1 is a reference; type 2 is the image being edited (BASE_IMAGE).
REF_TYPE_IMAGE = 1
BASE_TYPE_IMAGE = 2
IMAGE_UPSCALE_RESOLUTIONS = {"2K": 1, "4K": 2}


class RpcError(RuntimeError):
    """A batchexecute envelope came back with an error slot instead of data."""

    def __init__(self, rpcid: str, detail: Any):
        super().__init__(f"{rpcid} failed: {detail!r}")
        self.rpcid = rpcid
        self.detail = detail


class FlowBatchError(RuntimeError):
    """The call succeeded but the payload did not hold what we came for."""


@dataclass(frozen=True)
class RpcResult:
    rpcid: str
    data: Any
    error: Any = None

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass(frozen=True)
class GeneratedImage:
    media_id: str
    url: str


@dataclass(frozen=True)
class Operation:
    operation_id: str
    project_id: Optional[str]
    status: Optional[str]
    error: Optional[str] = None
    outcome: Optional[int] = None
    media_id: Optional[str] = None

    @property
    def done(self) -> bool:
        return self.status == STATUS_DONE or self.outcome == OUTCOME_OK

    @property
    def complained(self) -> bool:
        """The poll grumbled. Observed to be survivable — check the listing."""
        return self.error is not None


@dataclass(frozen=True)
class MediaUrls:
    media_id: str
    video: Optional[str] = None
    image: Optional[str] = None


# ── model / aspect resolvers ─────────────────────────────────────────────────

def resolve_image_model(key: Optional[str]) -> str:
    """Nickname or wire id in, wire id out.

    Flow can add image models independently of Flow Kit releases. A
    syntactically valid, previously unseen wire id therefore passes through
    unchanged instead of being silently replaced by the default model.
    """
    if isinstance(key, str):
        normalized = key.strip().upper().replace("-", "_")
        if normalized in IMAGE_MODEL_BY_NICKNAME:
            return IMAGE_MODEL_BY_NICKNAME[normalized]
        if IMAGE_MODEL_ID_RE.fullmatch(normalized):
            return normalized
    return IMAGE_MODEL


def resolve_video_model(key: Optional[str]) -> str:
    """Map a REST-era model key onto one the batch path accepts.

    The old keys encoded tier, quality, aspect and chaining in the name
    (``veo_3_1_i2v_s_fast_ultra_relaxed``, ``…_portrait``, ``…_fl``). Aspect
    and chaining are their own slots now and the suffixed names are rejected,
    so the tier/quality intent is all that survives: anything that asked for
    "ultra" gets the ultra model, anything else lands on the lite default.
    """
    if isinstance(key, str):
        if key in VIDEO_MODELS:
            return key
        if "ultra" in key:
            return "veo_3_1_i2v_s_fast_ultra"
        if "lite_low_priority" in key:
            return "veo_3_1_i2v_lite_low_priority"
        if "lite" in key:
            return "veo_3_1_i2v_lite"
    return VIDEO_MODEL


def resolve_aspect(aspect: Any) -> int:
    """Take a current/legacy wire name, friendly ratio, or integer 1-5."""
    if isinstance(aspect, int):
        if aspect not in (1, 2, 3, 4, 5):
            raise ValueError(f"image aspect must be 1-5, got {aspect}")
        return aspect
    try:
        return ASPECT_BY_NAME[aspect]
    except KeyError:
        raise ValueError(
            f"unknown aspect {aspect!r} — use one of {sorted(ASPECT_BY_NAME)} or 1-5"
        ) from None


def resolve_video_aspect(aspect: Any) -> int:
    if isinstance(aspect, int):
        if aspect not in (VIDEO_ASPECT_PORTRAIT, VIDEO_ASPECT_LANDSCAPE):
            # 3 is a perfectly good IMAGE aspect and a meaningless video one
            raise ValueError(f"video aspect must be 1 or 2, got {aspect}")
        return aspect
    try:
        return VIDEO_ASPECT_BY_NAME[aspect]
    except KeyError:
        raise ValueError(
            f"unknown video aspect {aspect!r} — use one of "
            f"{sorted(VIDEO_ASPECT_BY_NAME)} or 1-2"
        ) from None


# ── envelope codec ───────────────────────────────────────────────────────────

def build_envelope(rpcid: str, inner: Any) -> str:
    """Wrap an inner payload as the ``f.req`` string batchexecute expects."""
    return json.dumps(
        [[[rpcid, json.dumps(inner, separators=(",", ":"), ensure_ascii=False), None, "generic"]]],
        separators=(",", ":"),
        ensure_ascii=False,
    )


def parse_envelope(text: str) -> list[RpcResult]:
    """Unwrap the `)]}'` sentinel and the length-prefixed chunks.

    The chunk lengths count characters, but a payload can disagree with them by
    a byte or two once escapes are involved, so the JSON is decoded by scanning
    rather than by trusting the prefix.
    """
    if not text:
        return []
    body = text.split("\n", 1)[1] if text.startswith(")]}'") else text
    decoder = json.JSONDecoder()
    results: list[RpcResult] = []
    index = 0
    while index < len(body):
        start = body.find("[", index)
        if start == -1:
            break
        try:
            chunk, consumed = decoder.raw_decode(body[start:])
        except json.JSONDecodeError:
            # step past this `[` and keep scanning — a chunk boundary landing
            # mid-token should not cost us the envelopes that follow it
            index = start + 1
            continue
        index = start + consumed
        for entry in chunk if isinstance(chunk, list) else []:
            if not isinstance(entry, list) or not entry or entry[0] != "wrb.fr":
                continue
            rpcid = entry[1] if len(entry) > 1 else "?"
            payload = entry[2] if len(entry) > 2 else None
            if payload is None:
                # index 5 is the error slot; it is `[5]`-style codes, not text
                results.append(RpcResult(rpcid, None, entry[5] if len(entry) > 5 else True))
                continue
            results.append(
                RpcResult(rpcid, json.loads(payload) if isinstance(payload, str) else payload)
            )
    return results


def first_payload(text: str, rpcid: str) -> Any:
    """The payload of the first matching envelope, or raise what went wrong."""
    results = parse_envelope(text)
    for result in results:
        if result.rpcid != rpcid:
            continue
        if not result.ok:
            raise RpcError(rpcid, result.error)
        return result.data
    raise FlowBatchError(f"no {rpcid} envelope in response ({len(results)} others)")


# ── request builders ─────────────────────────────────────────────────────────

def _client_uuid() -> str:
    """Client-side request ids. The UI sends them upper-case; match it."""
    return str(uuid.uuid4()).upper()


def _context(project_id: str) -> list:
    """The surface/project/captcha envelope every generate call repeats."""
    return [None, SURFACE_ID, None, None, None, project_id, None, None, None, None,
            [CAPTCHA_SLOT, 1]]


def _image_input(media_id: str, input_type: int) -> list:
    return [media_id, None, None, None, input_type]


def _reference(media_id: str) -> list:
    return _image_input(media_id, REF_TYPE_IMAGE)


def _base_image(media_id: str) -> list:
    return _image_input(media_id, BASE_TYPE_IMAGE)


def image_request(prompt: str, project_id: str, count: int = 1,
                  aspect: Any = ASPECT_SQUARE, seed: Optional[int] = None,
                  prompts: Optional[list[str]] = None,
                  model: str = IMAGE_MODEL,
                  ref_media_ids: Optional[list[str]] = None,
                  base_media_id: Optional[str] = None) -> str:
    """One request item per variant, exactly as the REST payload did it.

    There is no "how many" field: Flow returns one image per item in the list,
    so `count` replicates the item under fresh seeds. `ref_media_ids` conditions
    the result on images already in the project — this is what keeps a character
    the same person from beat to beat.
    """
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 4:
        raise ValueError("image count must be an integer from 1 to 4")
    ratio = resolve_aspect(aspect)
    resolved_model = resolve_image_model(model)
    base = seed if seed is not None else random.randint(1, 10**9)
    items = []
    for index in range(count):
        text = prompts[index] if prompts and index < len(prompts) else prompt
        image_inputs = []
        if base_media_id:
            image_inputs.append(_base_image(base_media_id))
        image_inputs.extend(
            _reference(mid) for mid in (ref_media_ids or []) if mid != base_media_id
        )
        items.append([None, None, image_inputs or None, base + index * 9973, ratio,
                      resolved_model, None, _context(project_id), [[[text]]],
                      None, None, None, _client_uuid(), _client_uuid()])
    return build_envelope(RPC_GEN_IMAGE, [None, items, 1, _context(project_id),
                                          [_client_uuid()]])


def image_upscale_request(media_id: str, resolution: str = "2K") -> str:
    """Build the current FlowService.UpsampleImage request (RPC SPrCad)."""
    key = str(resolution).strip().upper()
    if key.startswith("UPSAMPLE_IMAGE_RESOLUTION_"):
        key = key.removeprefix("UPSAMPLE_IMAGE_RESOLUTION_")
    try:
        code = IMAGE_UPSCALE_RESOLUTIONS[key]
    except KeyError:
        raise ValueError("image upscale resolution must be 2K or 4K") from None
    return build_envelope(RPC_UPSCALE_IMAGE, [media_id, code, _context(None)])


def video_request(prompt: str, project_id: str, source_media_id: str,
                  crop: Optional[list] = None,
                  aspect: Any = VIDEO_ASPECT_LANDSCAPE,
                  model: str = VIDEO_MODEL) -> str:
    inner = [
        [[[None, None, [[[prompt]]]], model, resolve_video_aspect(aspect), None,
          [None, source_media_id, None, None, None,
           FULL_FRAME_CROP if crop is None else crop],
          [None, None, None, None, _client_uuid(), _client_uuid()]]],
        _context(project_id),
        [_client_uuid(), 2],
    ]
    return build_envelope(RPC_GEN_VIDEO, inner)


def omni_first_frame_request(prompt: str, project_id: str, source_media_id: str,
                             *, duration_s: int = 8, resolution: str = "720p",
                             aspect: Any = VIDEO_ASPECT_LANDSCAPE,
                             crop: Optional[list] = None) -> str:
    """Build current Omni first-frame I2V (RPC ``eb1hJf``).

    Live-captured from Flow on 2026-09-14. 720p uses ``abra_i2v_<N>s``;
    360p appends ``_360p`` and carries the UI's low-resolution option slot.
    """
    if duration_s not in (4, 6, 8, 10):
        raise ValueError("Omni duration must be 4, 6, 8 or 10 seconds")
    res = str(resolution).strip().lower()
    if res not in {"360p", "720p"}:
        raise ValueError("Omni resolution must be 360p or 720p")
    model = f"abra_i2v_{duration_s}s" + ("_360p" if res == "360p" else "")
    request = [
        [None, None, [[[prompt]]]],
        model,
        resolve_video_aspect(aspect),
        None,
        [None, source_media_id, None, None, None,
         FULL_FRAME_CROP if crop is None else crop],
        [None, None, None, None, _client_uuid(), _client_uuid()],
    ]
    if res == "360p":
        request.extend([None, None, None, [4]])
    return build_envelope(RPC_GEN_VIDEO, [
        [request],
        _context(project_id),
        [_client_uuid(), 2],
    ])


def omni_first_last_request(prompt: str, project_id: str,
                            start_media_id: str, end_media_id: str,
                            *, duration_s: int = 8, resolution: str = "720p",
                            aspect: Any = VIDEO_ASPECT_LANDSCAPE,
                            start_crop: Optional[list] = None,
                            end_crop: Optional[list] = None) -> str:
    """Build Omni First+Last frames submit (RPC ``nprQif``)."""
    if duration_s not in (4, 6, 8, 10):
        raise ValueError("Omni duration must be 4, 6, 8 or 10 seconds")
    res = str(resolution).strip().lower()
    if res not in {"360p", "720p"}:
        raise ValueError("Omni resolution must be 360p or 720p")
    model = f"omni_flash_i2v_{duration_s}s_first_last" + ("_360p" if res == "360p" else "")
    request = [
        [None, None, [[[prompt]]]],
        model,
        resolve_video_aspect(aspect),
        None,
        [None, start_media_id, None, None, None,
         FULL_FRAME_CROP if start_crop is None else start_crop],
        [None, end_media_id, None, None, None,
         FULL_FRAME_CROP if end_crop is None else end_crop],
        [None, None, None, None, _client_uuid(), _client_uuid()],
    ]
    return build_envelope(RPC_GEN_VIDEO_FIRST_LAST, [
        [request],
        _context(project_id),
        [_client_uuid(), 2],
    ])


def omni_reference_video_request(prompt: str, project_id: str,
                                 reference_media_ids: list[str],
                                 *, duration_s: int = 8, resolution: str = "720p",
                                 aspect: Any = VIDEO_ASPECT_LANDSCAPE) -> str:
    """Build Omni Ingredients/reference-to-video submit (RPC ``MZZa6b``)."""
    refs = [str(mid) for mid in reference_media_ids if str(mid)]
    if not refs:
        raise ValueError("Omni reference-to-video requires at least one reference image")
    if duration_s not in (4, 6, 8, 10):
        raise ValueError("Omni duration must be 4, 6, 8 or 10 seconds")
    res = str(resolution).strip().lower()
    if res not in {"360p", "720p"}:
        raise ValueError("Omni resolution must be 360p or 720p")
    model = f"abra_r2v_{duration_s}s" + ("_360p" if res == "360p" else "")
    request = [
        [None, None, [[[prompt]]]],
        [[None, mid] for mid in refs],
        model,
        resolve_video_aspect(aspect),
        None,
        [None, None, None, None, _client_uuid(), _client_uuid()],
    ]
    if res == "360p":
        request.extend([None, None, None, None, None, [4]])
    return build_envelope(RPC_GEN_VIDEO_REFERENCES, [
        [request],
        _context(project_id),
        [_client_uuid(), 2],
    ])


def text_video_request(prompt: str, project_id: str,
                       aspect: Any = VIDEO_ASPECT_LANDSCAPE,
                       model: str = "abra_t2v_4s") -> str:
    """Build the migrated text-to-video submit (YhhmEf)."""
    request = [
        [None, None, [[[prompt]]]],
        model,
        resolve_video_aspect(aspect),
        None,
        [None, None, None, None, _client_uuid(), _client_uuid()],
    ]
    return build_envelope(RPC_GEN_VIDEO_TEXT, [
        [request],
        _context(project_id),
        [_client_uuid(), 1],
    ])


def upload_request(image_b64: str, project_id: str, mime_type: str = "image/jpeg",
                   file_name: str = "upload.jpg") -> str:
    """Put a local image into the project so it can be used as a reference.

    The bytes ride inside the RPC as plain base64 — no data: prefix, no separate
    upload endpoint — and the call carries a captcha like a generate does.
    """
    return build_envelope(RPC_UPLOAD_IMAGE, [
        _context(project_id), image_b64, mime_type, 1, None, None, None, None,
        file_name, None, _client_uuid(), _client_uuid(),
    ])


def operation_request(operation_id: str) -> str:
    return build_envelope(RPC_OPERATION, [None, None, [[operation_id]]])


def project_media_request(project_id: str) -> str:
    return build_envelope(RPC_PROJECT_MEDIA, [f"projects/{project_id}", None, None, None, [1]])


def media_request(media_id: str) -> str:
    return build_envelope(RPC_MEDIA, [media_id])


# ── response readers ─────────────────────────────────────────────────────────

def _walk_strings(node: Any):
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for item in node:
            yield from _walk_strings(item)


def _walk_lists(node: Any):
    if isinstance(node, list):
        yield node
        for item in node:
            yield from _walk_lists(item)


def read_images(payload: Any) -> list[GeneratedImage]:
    """Signed CDN urls come back inline on the image call — one per variant.

    The media id is read out of the url path rather than from a fixed index:
    the url is the thing we actually need, and pairing them at the source keeps
    a reshuffled response from mismatching ids to pictures.
    """
    images: list[GeneratedImage] = []
    seen: set[str] = set()
    for text in _walk_strings(payload):
        if MEDIA_HOST + "/image/" not in text:
            continue
        media_id = text.split("/image/", 1)[1].split("?", 1)[0]
        if media_id in seen:
            continue
        seen.add(media_id)
        images.append(GeneratedImage(media_id=media_id, url=text))
    return images


def read_uploaded_media_id(payload: Any) -> str:
    """`[[mediaId, projectId, operationId, "CAE", …]]` — the id is the handle a
    later generate passes as a reference."""
    record = payload[0] if isinstance(payload, list) and payload else None
    media_id = record[0] if isinstance(record, list) and record else None
    if not isinstance(media_id, str) or not media_id:
        raise FlowBatchError("upload response carried no media id")
    return media_id


_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

_ENTRY_HEAD_RE = re.compile(
    r'\[\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\?",\s*(?:null|\\?"[^"\\]*\\?"),\s*null,\s*\[',
    re.IGNORECASE,
)

_GEN_RECORD_PREFIX_RE = re.compile(
    r'\[\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\?",\s*'
    r'\\?"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\?",\s*\\?"$',
    re.IGNORECASE,
)

_GEN_RECORD_SUFFIX_RE = re.compile(
    r'^\\?",\s*(?:null|\\?"CAE\\?"),\s*null,\s*\[',
    re.IGNORECASE,
)


def _is_uuid(value: Any) -> bool:
    return isinstance(value, str) and bool(_UUID_RE.fullmatch(value))


def _is_generation_record(node: Any) -> bool:
    """True for Flow's `[wfId, projectId, listingId, status|null, null, [details...], ...]` record.

    Slot 3 became `null` (formerly `"CAE"`) on 2026-10-06, so records are
    identified by three UUIDs in slots 0..2 plus the details list at slot 5.
    """
    return (
        isinstance(node, list)
        and len(node) >= 6
        and _is_uuid(node[0])
        and _is_uuid(node[1])
        and _is_uuid(node[2])
        and isinstance(node[5], list)
    )


def _find_generation_record(node: Any) -> Optional[list]:
    for item in _walk_lists(node):
        if _is_generation_record(item):
            return item
    return None


def read_text_video_submit(payload: Any) -> dict:
    """Read YhhmEf's submitted media/workflow record.

    Handles both single-nested (`payload[3] = [[media, proj, wf, status]]`) and
    double-nested (`payload[3] = [[[media, proj, wf, status, ...]]]`) envelopes.
    """
    records = payload[3] if isinstance(payload, list) and len(payload) > 3 else None
    record = _find_generation_record(records)
    if record is None:
        candidate = records[0] if isinstance(records, list) and records else None
        if isinstance(candidate, list) and candidate and isinstance(candidate[0], list):
            candidate = candidate[0]
        record = candidate
    if not isinstance(record, list) or not record:
        raise FlowBatchError("text-video submit carried no generation record")
    media_id = record[0] if len(record) > 0 else None
    project_id = record[1] if len(record) > 1 else None
    workflow_id = record[2] if len(record) > 2 else None
    status = record[3] if len(record) > 3 else None
    if not isinstance(media_id, str) or not media_id:
        raise FlowBatchError("text-video submit carried no media id")
    return {
        "media_id": media_id,
        "project_id": project_id if isinstance(project_id, str) else None,
        "workflow_id": workflow_id if isinstance(workflow_id, str) else media_id,
        "status": status if isinstance(status, str) else None,
    }


def read_upscaled_image(payload: Any) -> str:
    """Return the base64 image body from FlowService.UpsampleImage."""
    encoded = payload[1] if isinstance(payload, list) and len(payload) > 1 else None
    if not isinstance(encoded, str) or len(encoded) < 100:
        raise FlowBatchError("image upscale response carried no encoded image")
    return encoded


def read_operation_outcome(record: list) -> Optional[int]:
    """Read the integer outcome code at ``record[5][8][0]`` (6=sub, 2=run, 3=ok, 4=err)."""
    detail = record[5] if len(record) > 5 else None
    if not isinstance(detail, list) or len(detail) <= 8:
        return None
    block = detail[8]
    if isinstance(block, list) and block and isinstance(block[0], int) and not isinstance(block[0], bool):
        return block[0]
    return None


def read_operation(payload: Any) -> Operation:
    """Decode a video submit or ``jwpduf`` status-poll payload.

    Live ``flow.google.com`` submit replies (`eb1hJf`, `MZZa6b`, `nprQif`,
    `YhhmEf`) carry a listing stub at ``payload[2]`` keyed by the listing/tile
    UUID and the real generation record at ``payload[3]`` keyed by the
    workflow/media UUID that both ``jwpduf`` and ``as29s`` expect. Reading the
    listing UUID from ``payload[2][0][0]`` instead causes ``jwpduf`` to answer
    ``"Media not found."`` and ``as29s`` to answer ``[5]`` NOT_FOUND forever.
    """
    if isinstance(payload, list) and len(payload) > 3:
        gen_rec = _find_generation_record(payload[3])
        if gen_rec is not None:
            return Operation(
                operation_id=gen_rec[0],
                project_id=gen_rec[1],
                status=gen_rec[3] if isinstance(gen_rec[3], str) else None,
                error=read_operation_error(gen_rec),
                outcome=read_operation_outcome(gen_rec),
                media_id=gen_rec[0],
            )

    records = payload[2] if isinstance(payload, list) and len(payload) > 2 else None
    record = records[0] if isinstance(records, list) and records else None
    if isinstance(record, list) and record and isinstance(record[0], list):
        record = record[0]
    if not isinstance(record, list) or not record:
        raise FlowBatchError("operation payload carried no record")

    # Listing stub without a sibling payload[3] generation record:
    # `[listingId, null, null, [title, ts, null, null, wfId, clientUuid, ts], projectId]`
    if (
        len(record) >= 4
        and record[1] is None
        and record[2] is None
        and isinstance(record[3], list)
    ):
        proj = record[4] if len(record) > 4 and isinstance(record[4], str) else None
        wf_id = record[3][4] if len(record[3]) > 4 and _is_uuid(record[3][4]) else None
        if wf_id:
            return Operation(
                operation_id=wf_id,
                project_id=proj,
                status=None,
                error=None,
                outcome=None,
                media_id=wf_id,
            )
        return Operation(
            operation_id=record[0],
            project_id=proj,
            status=None,
            error=None,
            outcome=None,
        )

    outcome = read_operation_outcome(record)
    status_val = record[3] if len(record) > 3 and isinstance(record[3], str) else None
    return Operation(
        operation_id=record[0],
        project_id=record[1] if len(record) > 1 and isinstance(record[1], str) else None,
        status=status_val,
        error=read_operation_error(record),
        outcome=outcome,
        media_id=record[0] if _is_generation_record(record) else None,
    )


def read_operation_error(record: list) -> Optional[str]:
    """The complaint attached to this operation, if it carries one.

    It hides in the detail block's status slot as
    ``[4, [null, "Media not found."], ["Media not found."]]`` or
    ``[4, [13, "Generation job finished with state: FAILED"], [...]]``.
    Measured behaviour: an operation can report ``"Media not found."`` and still
    deliver a finished clip, while ``PUBLIC_ERROR_*`` codes and explicit job
    failure messages indicate terminal failures.
    """
    detail = record[5] if len(record) > 5 else None
    if not isinstance(detail, list) or len(detail) <= 8:
        return None
    block = detail[8]
    if not isinstance(block, list) or not block:
        return None
    if block[0] != OUTCOME_COMPLAINT:
        # Also surface explicit PUBLIC_ERROR_* codes if Flow reports them
        # under another non-OK outcome code.
        if block[0] != OUTCOME_OK:
            for text in _walk_strings(block):
                if "PUBLIC_ERROR_" in text.upper():
                    return text
        return None
    texts = [t for t in _walk_strings(block) if t]
    for text in texts:
        if "PUBLIC_ERROR_" in text.upper():
            return text
    if texts:
        return texts[0]
    return "operation failed without a message"


def find_media_id(payload: Any, operation_id: str) -> Optional[str]:
    """Look an operation up in the project listing and take its media/workflow id.

    Handles all observed ``Zzl0ze`` record shapes:
    1. Forward listing stub:
       ``[opId, folderOrNull, null, [title, ts, isVideoOrNull, null, mediaId, ...], projectId]``
    2. Generation record (live Oct/Nov 2026 Flow):
       ``[wfId, projectId, opId, null|"CAE", null, [details...], ...]``
    3. ``detail[5]`` match:
       ``[assetId, folderOrNull, null, [title, ts, ..., mediaId, opId, ...], projectId]``
    4. Reversed listing stub:
       ``[mediaId, null, null, [title, ts, null, null, opId, ...], projectId]``
    """
    if not operation_id:
        return None
    op_lower = operation_id.lower()
    nodes = list(_walk_lists(payload))

    # 1. Forward listing stub: node[0] == operation_id -> detail[4]
    for node in nodes:
        if len(node) < 4 or not isinstance(node[0], str) or node[0].lower() != op_lower:
            continue
        detail = node[3]
        if (
            isinstance(detail, list)
            and len(detail) > 4
            and isinstance(detail[4], str)
            and detail[4]
            and detail[4].lower() != op_lower
        ):
            return detail[4]

    # 2. Generation record: [wfId, projectId, opId, null|"CAE", null, [details...]] -> wfId
    for node in nodes:
        if _is_generation_record(node) and node[2].lower() == op_lower and node[0].lower() != op_lower:
            return node[0]

    # 3. detail[5] == operation_id -> detail[4]
    for node in nodes:
        if len(node) < 4 or not isinstance(node[3], list):
            continue
        detail = node[3]
        if (
            len(detail) > 5
            and isinstance(detail[5], str)
            and detail[5].lower() == op_lower
            and isinstance(detail[4], str)
            and detail[4]
            and detail[4].lower() != op_lower
            and _is_uuid(detail[4])
        ):
            return detail[4]

    # 4. Reversed listing stub: [mediaId, null, null, [..., opId, ...]] -> mediaId
    for node in nodes:
        if (
            len(node) < 4
            or not _is_uuid(node[0])
            or node[0].lower() == op_lower
            or node[1] is not None
            or node[2] is not None
        ):
            continue
        detail = node[3]
        if (
            isinstance(detail, list)
            and len(detail) > 4
            and isinstance(detail[4], str)
            and detail[4].lower() == op_lower
        ):
            return node[0]
    return None


def _unescape_wrb_fragment(fragment: str) -> str:
    """Unescape the interior of a JSON-encoded ``wrb.fr`` payload string slice.

    Stops cleanly at an unescaped closing quote or incomplete trailing escape
    so truncated listing windows never raise.
    """
    out: list[str] = []
    i = 0
    n = len(fragment)
    simple = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        "b": "\b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
    }
    while i < n:
        ch = fragment[i]
        if ch == '"':
            break
        if ch == "\\":
            if i + 1 >= n:
                break
            nxt = fragment[i + 1]
            if nxt in simple:
                out.append(simple[nxt])
                i += 2
                continue
            if nxt == "u" and i + 6 <= n:
                try:
                    code = int(fragment[i + 2 : i + 6], 16)
                except ValueError:
                    break
                if (
                    0xD800 <= code <= 0xDBFF
                    and i + 12 <= n
                    and fragment[i + 6 : i + 8] == "\\u"
                ):
                    try:
                        low = int(fragment[i + 8 : i + 12], 16)
                    except ValueError:
                        low = 0
                    if 0xDC00 <= low <= 0xDFFF:
                        out.append(
                            chr(0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00))
                        )
                        i += 12
                        continue
                out.append(chr(code))
                i += 6
                continue
            break
        out.append(ch)
        i += 1
    return "".join(out)


def _parse_entry_detail_slots(after_id: str) -> tuple[Optional[str], Optional[str]]:
    """Decode ``, elem1, elem2, [d0, d1, d2, d3, d4, d5, ...]`` and return ``(d4, d5)``.

    Strict slot parsing prevents two bugs that the old ``null,null,"UUID"``
    regex hit in production:
    1. When an operation is still generating or failed, ``d4`` is ``null`` and
       ``d5`` is the uppercase ``clientUuid`` (``null,null,null,"<clientUuid>"``);
       the regex slipped onto ``d5`` and made ``as29s`` fail with ``[5]`` forever.
    2. When an entry had no media id, scanning forward bled across ``]`` into
       an adjacent listing entry and stole its UUID.
    """
    decoder = json.JSONDecoder()
    n = len(after_id)
    pos = 0

    def _skip_ws(idx: int) -> int:
        while idx < n and after_id[idx] in " \t\r\n":
            idx += 1
        return idx

    for _ in range(2):
        pos = _skip_ws(pos)
        if pos >= n or after_id[pos] != ",":
            return None, None
        pos = _skip_ws(pos + 1)
        if pos >= n:
            return None, None
        try:
            _, pos = decoder.raw_decode(after_id, pos)
        except json.JSONDecodeError:
            return None, None

    pos = _skip_ws(pos)
    if pos >= n or after_id[pos] != ",":
        return None, None
    pos = _skip_ws(pos + 1)
    if pos >= n or after_id[pos] != "[":
        return None, None
    pos += 1

    slot4: Optional[str] = None
    slot5: Optional[str] = None
    for slot in range(6):
        pos = _skip_ws(pos)
        if pos >= n or after_id[pos] == "]":
            break
        if slot > 0:
            if after_id[pos] != ",":
                break
            pos = _skip_ws(pos + 1)
            if pos >= n or after_id[pos] == "]":
                break
        try:
            value, pos = decoder.raw_decode(after_id, pos)
        except json.JSONDecodeError:
            break
        if slot == 4:
            slot4 = value if isinstance(value, str) and value else None
        elif slot == 5:
            slot5 = value if isinstance(value, str) and value else None
    return slot4, slot5


def _extract_entry_slots(text: str, id_end: int) -> tuple[Optional[str], Optional[str]]:
    """Read ``(detail[4], detail[5])`` starting right after ``node[0]``."""
    after = text[id_end : id_end + 8192]
    if after.startswith('\\"'):
        body = _unescape_wrb_fragment(after[2:])
    elif after.startswith('"'):
        body = after[1:]
    else:
        return None, None
    return _parse_entry_detail_slots(body)


def _extract_entry_slot4(text: str, id_end: int) -> Optional[str]:
    return _extract_entry_slots(text, id_end)[0]


def find_media_id_in_text(text: str, operation_id: str) -> Optional[str]:
    """Same lookup as :func:`find_media_id`, but on an unparsed listing window.

    Handles:
    1. Forward listing stub: ``["<opId>", ..., [..., "<mediaId>", ...]]``
    2. Live generation record: ``["<wfId>", "<projId>", "<opId>", null|"CAE", null, [...]]``
    3. Reversed / ``detail[5]`` listing stub match.
    """
    if not text or not operation_id:
        return None

    lower_text = text.lower()
    lower_op = operation_id.lower()
    occurrences: list[int] = []
    search_from = 0
    while search_from < len(lower_text):
        start = lower_text.find(lower_op, search_from)
        if start == -1:
            break
        search_from = start + len(operation_id)
        if start > 0 and text[start - 1] != '"':
            continue
        occurrences.append(start)

        # 1. Forward listing stub: `["<opId>", ...` (or start==0 slice from an older extension) -> detail[4]
        head_before = text[max(0, start - 4) : start]
        if start == 0 or head_before.endswith('["') or head_before.endswith('[\\"'):
            slot4 = _extract_entry_slot4(text, start + len(operation_id))
            if slot4 and slot4.lower() != lower_op and _is_uuid(slot4):
                return slot4

    # 2. Generation record: `["<wfId>","<projId>","<opId>",null|"CAE",null,[` -> wfId
    for start in occurrences:
        prefix = text[max(0, start - 160) : start]
        suffix = text[start + len(operation_id) : start + len(operation_id) + 32]
        m = _GEN_RECORD_PREFIX_RE.search(prefix)
        if m and _GEN_RECORD_SUFFIX_RE.match(suffix):
            cand = m.group(1)
            if cand.lower() != lower_op:
                return cand

    # 3. Fallback: listing stub where opId sits at detail[5] or detail[4]
    for start in occurrences:
        prefix_offset = max(0, start - 2048)
        prefix = text[prefix_offset:start]
        matches = list(_ENTRY_HEAD_RE.finditer(prefix))
        for m in reversed(matches):
            cand = m.group(1)
            cand_end = prefix_offset + m.end(1)
            slot4, slot5 = _extract_entry_slots(text, cand_end)
            if slot5 and slot5.lower() == lower_op and slot4 and slot4.lower() != lower_op and _is_uuid(slot4):
                return slot4
            if cand.lower() != lower_op and slot4 and slot4.lower() == lower_op:
                return cand
    return None


def read_media_urls(payload: Any, media_id: str) -> MediaUrls:
    video = image = None
    for text in _walk_strings(payload):
        if not text.startswith("https://"):
            continue
        if MEDIA_HOST + "/video/" in text and video is None:
            video = text
        elif MEDIA_HOST + "/image/" in text and image is None:
            image = text
    return MediaUrls(media_id=media_id, video=video, image=image)
