"""Tests for the Flow SDK on Flow's batchexecute transport.

The SDK's entire observable output is the ``f.req`` envelope it hands to
``flow_client.batch_rpc``, so these tests decode that envelope and assert on
the positional slots. That matters more than it sounds: Flow accepts a
well-formed request with a value in the wrong slot without complaining, and
then ignores it. Several tests below exist because a wrong slot looked like it
was working.

Response fixtures come from ``tests.batch_harness``, which also names the slot
indices so the magic numbers live in one place.
"""
import pytest

from flowboard import config
from flowboard.services import flow_batch as fb
from flowboard.services.flow_sdk import (
    DEFAULT_PAYGATE_TIER,
    FlowSDK,
    _extract_media_ids,
    extract_media_entries,
    extract_operation_names,
    extract_video_operations,
    resolve_paygate_tier,
)
from tests.batch_harness import (
    IMG_ASPECT,
    IMG_INPUTS,
    IMG_MODEL,
    IMG_SEED,
    INPUT_TYPE,
    OMNI_MODEL,
    OMNI_REFS,
    SRC_MEDIA_ID,
    VID_ASPECT,
    VID_MODEL,
    VID_SOURCE,
    BatchRecorder,
    batch_envelope,
    batch_error_envelope,
    complaint_detail,
    image_items,
    image_recorder,
    listing_payload_text,
    media_urls_payload,
    operation_payload,
    video_item,
)

TIER = "PAYGATE_TIER_ONE"
PID = "8b62385c-4916-4abd-b01f-b28173d8eb04"
MEDIA = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def _context_of(payload_context) -> tuple:
    """(project_id, captcha_slot) out of the shared generate context block."""
    return payload_context[5], payload_context[10][0]


# ── the tier resolver ─────────────────────────────────────────────────────


def test_resolve_paygate_tier_accepts_the_two_real_plans():
    assert resolve_paygate_tier("PAYGATE_TIER_ONE") == "PAYGATE_TIER_ONE"
    assert resolve_paygate_tier("PAYGATE_TIER_TWO") == "PAYGATE_TIER_TWO"


def test_resolve_paygate_tier_falls_back_to_config_when_unset():
    assert resolve_paygate_tier(None) == DEFAULT_PAYGATE_TIER
    assert resolve_paygate_tier("") == DEFAULT_PAYGATE_TIER


@pytest.mark.parametrize("bad", ["PAYGATE_TIER_ONE ", "tier_one", "FREE", "1"])
def test_resolve_paygate_tier_refuses_anything_else(bad):
    """Guards the silent-downgrade bug in its new form.

    The tier is declared rather than sniffed now, so the failure mode moved
    from "absent" to "wrong" — and a wrong one still picks a video
    checkpoint, so it must raise rather than resolve.
    """
    with pytest.raises(ValueError, match="paygate_tier_invalid"):
        resolve_paygate_tier(bad)


# ── project creation and listing, both unported ───────────────────────────


@pytest.mark.asyncio
async def test_create_project_refuses_when_no_project_is_pinned(monkeypatch):
    # The env default is patched on `config`, not on `flow_sdk`: the SDK
    # resolves the pinned project per call now (flow_project.effective_project_id)
    # so there is no module constant left to shadow.
    monkeypatch.setattr(config, "FLOW_PROJECT_ID", "")
    out = await FlowSDK(client=BatchRecorder()).create_project("Board")
    assert out["error"].startswith("NO_FLOW_PROJECT")
    assert "FLOWBOARD_FLOW_PROJECT_ID" in out["error"]


@pytest.mark.asyncio
async def test_create_project_hands_back_the_pinned_project_marked_reused(monkeypatch):
    """It must not claim to have created something. Boards share one project."""
    monkeypatch.setattr(config, "FLOW_PROJECT_ID", PID)
    out = await FlowSDK(client=BatchRecorder()).create_project("Board")
    assert out["project_id"] == PID
    assert out["reused"] is True
    assert "error" not in out


@pytest.mark.asyncio
async def test_project_listing_reports_unsupported_rather_than_empty():
    """An empty list would read as "this user has no projects"."""
    sdk = FlowSDK(client=BatchRecorder())
    page = await sdk.search_user_projects()
    assert page["projects"] == []
    assert page["error"].startswith("UNSUPPORTED_ON_BATCH_API")

    everything = await sdk.list_user_projects_all()
    assert everything["projects"] == []
    assert everything["error"].startswith("UNSUPPORTED_ON_BATCH_API")


# ── image generation ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gen_image_envelope_carries_project_captcha_and_prompt():
    rec = image_recorder(1)
    out = await FlowSDK(client=rec).gen_image(
        prompt="a sleeping cat", project_id=PID, paygate_tier=TIER,
    )
    assert out["media_ids"] == ["img-0"]

    call = rec.rpcs(fb.RPC_GEN_IMAGE)[0]
    assert call["captcha_action"] == fb.CAPTCHA_IMAGE == "IMAGE_GENERATION"

    payload = rec.payload(fb.RPC_GEN_IMAGE)
    project_id, captcha = _context_of(payload[3])
    assert project_id == PID
    # A placeholder, not a token: the mint has to happen in the page moments
    # before the request leaves, because the token is single-use.
    assert captcha == fb.CAPTCHA_SLOT == "__CAPTCHA__"

    item = image_items(payload)[0]
    assert item[8][0][0][0] == "a sleeping cat"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "nickname,wire",
    [
        ("NANO_BANANA_PRO", "GEM_PIX_2"),
        ("NANO_BANANA_2", "NARWHAL"),
        (None, "GEM_PIX_2"),
    ],
)
async def test_gen_image_resolves_this_projects_model_policy(nickname, wire):
    """Flowboard's model map decides, not flow_batch's default.

    flow_batch is kept byte-identical to flowkit's copy and its own default
    model differs, so the nickname has to be resolved here and passed in
    explicitly. If that ever regresses, generation silently switches model.
    """
    rec = image_recorder(1)
    await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER, image_model=nickname,
    )
    assert image_items(rec.payload(fb.RPC_GEN_IMAGE))[0][IMG_MODEL] == wire


@pytest.mark.asyncio
async def test_gen_image_reference_images_land_in_the_inputs_slot():
    rec = image_recorder(1)
    await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
        ref_media_ids=["ref-1", "ref-2"],
    )
    inputs = image_items(rec.payload(fb.RPC_GEN_IMAGE))[0][IMG_INPUTS]
    assert [i[0] for i in inputs] == ["ref-1", "ref-2"]
    assert all(i[INPUT_TYPE] == fb.REF_TYPE_IMAGE for i in inputs)


@pytest.mark.asyncio
async def test_gen_image_accepts_the_legacy_character_media_ids_kwarg():
    rec = image_recorder(1)
    await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
        character_media_ids=["char-1"],
    )
    inputs = image_items(rec.payload(fb.RPC_GEN_IMAGE))[0][IMG_INPUTS]
    assert [i[0] for i in inputs] == ["char-1"]


@pytest.mark.asyncio
async def test_gen_image_per_variant_prompts_reach_their_own_rpc():
    rec = image_recorder(3)
    await FlowSDK(client=rec).gen_image(
        prompt="fallback", project_id=PID, paygate_tier=TIER, variant_count=3,
        prompts=["first", "", None],
    )
    texts = [
        image_items(rec.payload(fb.RPC_GEN_IMAGE, i))[0][8][0][0][0]
        for i in range(3)
    ]
    # Blank and missing entries fall back to the shared prompt.
    assert texts == ["first", "fallback", "fallback"]


@pytest.mark.asyncio
async def test_gen_image_keeps_the_variants_that_rendered():
    """Three good images must not be thrown away because the fourth failed."""
    rec = BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [
            batch_envelope(fb.RPC_GEN_IMAGE,
                           [["https://flow-content.google/image/ok-1?s=x"]]),
            batch_error_envelope(fb.RPC_GEN_IMAGE),
            batch_envelope(fb.RPC_GEN_IMAGE,
                           [["https://flow-content.google/image/ok-3?s=x"]]),
        ],
    })
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER, variant_count=3,
    )
    assert out.get("error") is None
    assert sorted(out["media_ids"]) == ["ok-1", "ok-3"]
    assert out["raw"]["data"]["failed_variants"][0]["index"] == 2


@pytest.mark.asyncio
async def test_gen_image_reports_an_error_when_every_variant_fails():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [batch_error_envelope(fb.RPC_GEN_IMAGE)],
    })
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
    )
    assert out["error"]
    assert "media_ids" not in out


@pytest.mark.asyncio
async def test_gen_image_propagates_a_bridge_level_error():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [{"error": "CAPTCHA_FAILED: NO_FLOW_TAB"}],
    })
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
    )
    assert "NO_FLOW_TAB" in out["error"]


@pytest.mark.asyncio
async def test_gen_image_errors_when_the_response_has_no_media_url():
    """A 200 with nothing usable in it is a failure, not an empty success.

    Reporting it as success is how a content-filter rejection used to look
    like a generation that produced zero images.
    """
    rec = BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [batch_envelope(fb.RPC_GEN_IMAGE, [None, [], 1])],
    })
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER,
    )
    assert "no media url" in out["error"]


@pytest.mark.asyncio
async def test_gen_image_returns_entries_with_signed_urls():
    rec = image_recorder(2)
    out = await FlowSDK(client=rec).gen_image(
        prompt="x", project_id=PID, paygate_tier=TIER, variant_count=2,
    )
    assert len(out["media_entries"]) == 2
    for entry in out["media_entries"]:
        assert entry["mediaType"] == "image"
        assert entry["url"].startswith("https://flow-content.google/image/")
        assert entry["media_id"] in entry["url"]


@pytest.mark.asyncio
async def test_gen_image_without_a_project_says_so(monkeypatch):
    monkey = BatchRecorder()
    monkeypatch.setattr(config, "FLOW_PROJECT_ID", "")
    out = await FlowSDK(client=monkey).gen_image(
        prompt="x", project_id="", paygate_tier=TIER,
    )
    assert out["error"].startswith("NO_FLOW_PROJECT")
    assert monkey.calls == [], "must not reach the bridge without a project"


# ── video: Veo i2v ────────────────────────────────────────────────────────


def _video_recorder(op_ids):
    return BatchRecorder(responses={
        fb.RPC_GEN_VIDEO: [
            batch_envelope(fb.RPC_GEN_VIDEO, operation_payload(op))
            for op in op_ids
        ],
    })


@pytest.mark.asyncio
async def test_gen_video_envelope_and_captcha():
    rec = _video_recorder(["op-1"])
    out = await FlowSDK(client=rec).gen_video(
        prompt="wave in the wind", project_id=PID, start_media_id="img-abc",
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE", paygate_tier=TIER,
    )
    assert out["operation_names"] == ["op-1"]

    call = rec.rpcs(fb.RPC_GEN_VIDEO)[0]
    assert call["captcha_action"] == fb.CAPTCHA_VIDEO == "VIDEO_GENERATION"

    item = video_item(rec.payload(fb.RPC_GEN_VIDEO))
    assert item[0][2][0][0][0] == "wave in the wind"
    assert item[VID_SOURCE][SRC_MEDIA_ID] == "img-abc"


@pytest.mark.asyncio
async def test_video_aspect_uses_its_own_encoding_not_the_image_one():
    """Trap worth a dedicated test: the two encodings disagree.

    For an image 1 is square, 2 portrait, 3 landscape. For a video 1 is
    PORTRAIT and 2 is landscape. Conflating them renders the wrong shape and
    Flow reports nothing wrong.
    """
    rec = _video_recorder(["op-p", "op-l"])
    sdk = FlowSDK(client=rec)

    await sdk.gen_video(
        prompt="x", project_id=PID, start_media_id="m", paygate_tier=TIER,
        aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
    )
    await sdk.gen_video(
        prompt="x", project_id=PID, start_media_id="m", paygate_tier=TIER,
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
    )
    portrait = video_item(rec.payload(fb.RPC_GEN_VIDEO, 0))[VID_ASPECT]
    landscape = video_item(rec.payload(fb.RPC_GEN_VIDEO, 1))[VID_ASPECT]
    assert (portrait, landscape) == (1, 2)

    # And here is why conflating them is silent rather than loud: the numbers
    # collide. A video portrait (1) is a valid image SQUARE, and a video
    # landscape (2) is a valid image PORTRAIT — so the wrong encoding is never
    # rejected, it just renders the wrong shape.
    assert fb.VIDEO_ASPECT_PORTRAIT == fb.ASPECT_SQUARE == 1
    assert fb.VIDEO_ASPECT_LANDSCAPE == fb.ASPECT_PORTRAIT == 2
    assert fb.ASPECT_LANDSCAPE == 3, "3 is a valid image aspect and a meaningless video one"
    with pytest.raises(ValueError, match="video aspect must be 1 or 2"):
        fb.resolve_video_aspect(fb.ASPECT_LANDSCAPE)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tier,quality,expected",
    [
        ("PAYGATE_TIER_TWO", "fast", "veo_3_1_i2v_s_fast_ultra"),
        ("PAYGATE_TIER_TWO", "lite", "veo_3_1_i2v_lite"),
        ("PAYGATE_TIER_ONE", "lite", "veo_3_1_i2v_lite"),
    ],
)
async def test_gen_video_maps_tier_and_quality_onto_a_batch_model(tier, quality, expected):
    """The suffixed REST names are rejected; only the intent survives."""
    rec = _video_recorder(["op-1"])
    out = await FlowSDK(client=rec).gen_video(
        prompt="x", project_id=PID, start_media_id="m",
        paygate_tier=tier, video_quality=quality,
    )
    assert out["model"] == expected
    assert video_item(rec.payload(fb.RPC_GEN_VIDEO))[VID_MODEL] == expected
    assert expected in fb.VIDEO_MODELS


@pytest.mark.asyncio
async def test_gen_video_batch_dispatches_one_operation_per_source():
    rec = _video_recorder(["op-1", "op-2", "op-3"])
    out = await FlowSDK(client=rec).gen_video(
        prompt="wave", project_id=PID,
        start_media_ids=["src-1", "src-2", "src-3"], paygate_tier=TIER,
    )
    assert out["operation_names"] == ["op-1", "op-2", "op-3"]
    sources = [
        video_item(rec.payload(fb.RPC_GEN_VIDEO, i))[VID_SOURCE][SRC_MEDIA_ID]
        for i in range(3)
    ]
    assert sources == ["src-1", "src-2", "src-3"]


@pytest.mark.asyncio
async def test_gen_video_batch_keeps_the_sources_that_submitted():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO: [
            batch_envelope(fb.RPC_GEN_VIDEO, operation_payload("op-1")),
            batch_error_envelope(fb.RPC_GEN_VIDEO),
        ],
    })
    out = await FlowSDK(client=rec).gen_video(
        prompt="x", project_id=PID, start_media_ids=["src-1", "src-2"],
        paygate_tier=TIER,
    )
    assert out["operation_names"] == ["op-1"]
    assert out["raw"]["data"]["failed_sources"][0]["media_id"] == "src-2"


@pytest.mark.asyncio
async def test_gen_video_falls_back_to_the_single_source_kwarg():
    rec = _video_recorder(["op-1"])
    out = await FlowSDK(client=rec).gen_video(
        prompt="x", project_id=PID, start_media_id="only-1",
        start_media_ids=[], paygate_tier=TIER,
    )
    assert out["operation_names"] == ["op-1"]
    item = video_item(rec.payload(fb.RPC_GEN_VIDEO))
    assert item[VID_SOURCE][SRC_MEDIA_ID] == "only-1"


@pytest.mark.asyncio
async def test_gen_video_errors_when_the_submit_yields_no_operation():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO: [batch_envelope(fb.RPC_GEN_VIDEO, [None, 50, []])],
    })
    out = await FlowSDK(client=rec).gen_video(
        prompt="x", project_id=PID, start_media_id="m", paygate_tier=TIER,
    )
    assert out["error"]
    assert "operation_names" not in out


# ── video: Omni Flash reference-to-video ──────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("duration,model", [
    (4, "abra_r2v_4s"), (6, "abra_r2v_6s"),
    (8, "abra_r2v_8s"), (10, "abra_r2v_10s"),
])
async def test_gen_video_omni_model_key_carries_the_duration(duration, model):
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_REFERENCES: [
            batch_envelope(fb.RPC_GEN_VIDEO_REFERENCES, operation_payload("omni-1")),
        ],
    })
    out = await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=["r-1"],
        duration_s=duration, paygate_tier=TIER,
    )
    assert out["operation_names"] == ["omni-1"]
    assert out["model"] == model
    assert out["duration_s"] == duration
    assert out["resolution"] == "720p"
    assert video_item(rec.payload(fb.RPC_GEN_VIDEO_REFERENCES))[OMNI_MODEL] == model


@pytest.mark.asyncio
async def test_gen_video_omni_references_are_wrapped_pairwise():
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_REFERENCES: [
            batch_envelope(fb.RPC_GEN_VIDEO_REFERENCES, operation_payload("omni-1")),
        ],
    })
    await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=["r-1", "", None, "r-2"],
        duration_s=8, paygate_tier=TIER,
    )
    refs = video_item(rec.payload(fb.RPC_GEN_VIDEO_REFERENCES))[OMNI_REFS]
    assert refs == [[None, "r-1"], [None, "r-2"]]


@pytest.mark.asyncio
async def test_gen_video_omni_requires_a_reference():
    rec = BatchRecorder()
    out = await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=[], duration_s=8,
        paygate_tier=TIER,
    )
    assert out["error"] == "missing_ref_media_ids"
    assert rec.calls == []


@pytest.mark.asyncio
async def test_gen_video_omni_rejects_an_unsupported_duration():
    rec = BatchRecorder()
    out = await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=["r-1"], duration_s=5,
        paygate_tier=TIER,
    )
    assert "5" in out["error"]
    assert rec.calls == []


@pytest.mark.asyncio
async def test_gen_video_omni_rejects_a_square_aspect():
    rec = BatchRecorder()
    out = await FlowSDK(client=rec).gen_video_omni(
        prompt="x", project_id=PID, ref_media_ids=["r-1"], duration_s=8,
        aspect_ratio="VIDEO_ASPECT_RATIO_SQUARE", paygate_tier=TIER,
    )
    assert out["error"] == "omni_aspect_unsupported_VIDEO_ASPECT_RATIO_SQUARE"
    assert rec.calls == []


def test_omni_duration_keys_agree_with_the_envelope_builder():
    """Two places derive the model key; drift between them must be caught.

    flow_sdk validates the duration against its own map, then flow_batch
    builds the key from the same duration. If the two ever disagree, the
    error message would name one model and the wire would carry another.
    """
    from flowboard.services.flow_sdk import OMNI_FLASH_DURATION_KEYS

    for duration, key in OMNI_FLASH_DURATION_KEYS.items():
        freq = fb.omni_reference_video_request(
            "p", PID, ["r-1"], duration_s=duration, resolution="720p",
        )
        import json
        built = json.loads(json.loads(freq)[0][0][1])[0][0][OMNI_MODEL]
        assert built == key, f"{duration}s: flow_batch says {built}, sdk says {key}"


# ── polling ───────────────────────────────────────────────────────────────


def _poll_recorder(op_id, *, status="CAE", detail=None,
                   media_id=MEDIA, video=True, listing=True):
    return BatchRecorder(responses={
        fb.RPC_OPERATION: [batch_envelope(
            fb.RPC_OPERATION,
            operation_payload(op_id, status=status, detail=detail),
        )],
        fb.RPC_PROJECT_MEDIA: [
            listing_payload_text(op_id, media_id) if listing else ""
        ],
        fb.RPC_MEDIA: [batch_envelope(
            fb.RPC_MEDIA, media_urls_payload(media_id, video=video),
        )],
    })


@pytest.mark.asyncio
async def test_check_async_succeeds_once_a_video_url_exists():
    rec = _poll_recorder("op-1")
    out = await FlowSDK(client=rec).check_async(["op-1"])

    (op,) = out["operations"]
    assert op["name"] == "op-1"
    assert op["done"] is True
    assert op["status"] == "MEDIA_GENERATION_STATUS_SUCCESSFUL"
    entry = op["media_entries"][0]
    assert entry["media_id"] == MEDIA
    assert "/video/" in entry["url"]


@pytest.mark.asyncio
async def test_check_async_asks_the_listing_for_a_window_not_the_whole_thing():
    """The listing is past 17 MB; shipping it whole gets it truncated."""
    rec = _poll_recorder("op-1")
    await FlowSDK(client=rec).check_async(["op-1"])
    listing_call = rec.rpcs(fb.RPC_PROJECT_MEDIA)[0]
    assert listing_call["match"] == "op-1"
    assert listing_call["captcha_action"] is None, "a poll must not burn a captcha"


@pytest.mark.asyncio
async def test_check_async_stays_pending_while_only_the_poster_exists():
    """A media id arrives before the clip is fetchable.

    The media record serves the poster image first and grows the /video/ url
    later, so finishing on the id alone downloads a still picture.
    """
    rec = _poll_recorder("op-1", video=False)
    out = await FlowSDK(client=rec).check_async(["op-1"])

    (op,) = out["operations"]
    assert op["done"] is False
    assert op["status"] == "MEDIA_GENERATION_STATUS_PENDING"
    assert op["media_entries"] == []


@pytest.mark.asyncio
async def test_check_async_treats_media_not_found_as_a_complaint_not_a_verdict():
    """Operations report this and still deliver a finished clip.

    Surfacing it as a terminal error is what killed live runs: the worker
    stops polling and the clip lands seconds later with nobody watching.
    """
    rec = _poll_recorder("op-1", detail=complaint_detail("Media not found."))
    out = await FlowSDK(client=rec).check_async(["op-1"])

    (op,) = out["operations"]
    assert op["done"] is True
    assert op["error"] is None, "a complaint must not become a terminal error"
    assert op["media_entries"][0]["media_id"] == MEDIA


@pytest.mark.asyncio
async def test_check_async_reports_pending_when_the_listing_has_no_media_yet():
    rec = _poll_recorder("op-1", listing=False)
    out = await FlowSDK(client=rec).check_async(["op-1"])
    (op,) = out["operations"]
    assert op["done"] is False
    assert rec.rpcs(fb.RPC_MEDIA) == [], "nothing to look up without a media id"


@pytest.mark.asyncio
async def test_check_async_survives_an_unreadable_operation_poll():
    """A decayed operation still appears in the listing, so keep looking."""
    rec = BatchRecorder(responses={
        fb.RPC_OPERATION: [batch_error_envelope(fb.RPC_OPERATION)],
        fb.RPC_PROJECT_MEDIA: [listing_payload_text("op-1", MEDIA)],
        fb.RPC_MEDIA: [batch_envelope(fb.RPC_MEDIA, media_urls_payload(MEDIA))],
    })
    sdk = FlowSDK(client=rec)
    # The listing lookup needs a project; a real submit would have noted one.
    sdk._remember_operation("op-1", PID)
    out = await sdk.check_async(["op-1"])
    assert out["operations"][0]["done"] is True


@pytest.mark.asyncio
async def test_check_async_preserves_the_requested_order_and_reports_gaps():
    """The worker keeps per-op state positionally aligned with this list."""
    rec = _poll_recorder("op-2")
    out = await FlowSDK(client=rec).check_async(["op-1", "op-2"])
    assert [op["name"] for op in out["operations"]] == ["op-1", "op-2"]
    # op-1 was never polled successfully, so it must read as still running.
    assert out["operations"][0]["done"] is False


@pytest.mark.asyncio
async def test_check_async_does_not_repoll_a_resolved_media_id():
    rec = _poll_recorder("op-1")
    sdk = FlowSDK(client=rec)
    await sdk.check_async(["op-1"])
    # Second round: the operation and listing scripts are exhausted, so if the
    # media id were not cached this would raise from the recorder.
    rec.responses[fb.RPC_MEDIA] = [
        batch_envelope(fb.RPC_MEDIA, media_urls_payload(MEDIA))
    ]
    out = await sdk.check_async(["op-1"])
    assert out["operations"][0]["done"] is True
    assert len(rec.rpcs(fb.RPC_OPERATION)) == 1


@pytest.mark.asyncio
async def test_check_async_ignores_pre_migration_workflow_handles():
    """They cannot be resumed; they must not be polled as operations either."""
    rec = _poll_recorder("op-1")
    out = await FlowSDK(client=rec).check_async(
        ["op-1"], workflows=[{"name": "wf-1", "primary_media_id": "m-1"}],
    )
    assert [op["name"] for op in out["operations"]] == ["op-1"]
    assert rec.rpcs(fb.RPC_MEDIA), "the real operation still resolved"


# ── upload ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upload_image_carries_a_captcha_and_returns_the_media_id():
    """Unlike the REST upload, maseQ is gated like a generate is.

    So an upload failing with CAPTCHA_FAILED is a Flow-tab problem, not a
    rejected image — worth asserting, because the two need opposite fixes.
    """
    rec = BatchRecorder(responses={
        fb.RPC_UPLOAD_IMAGE: [
            batch_envelope(fb.RPC_UPLOAD_IMAGE, [[MEDIA, PID, "op-x", "CAE"]]),
        ],
    })
    out = await FlowSDK(client=rec).upload_image(
        image_base64="Zm9v", mime_type="image/png", project_id=PID,
        file_name="hero.png",
    )
    assert out["media_id"] == MEDIA
    assert out["raw"]["data"]["media"]["name"] == MEDIA

    call = rec.rpcs(fb.RPC_UPLOAD_IMAGE)[0]
    assert call["captcha_action"] == fb.CAPTCHA_IMAGE
    payload = rec.payload(fb.RPC_UPLOAD_IMAGE)
    assert payload[1] == "Zm9v"        # bare base64, no data: prefix
    assert payload[2] == "image/png"
    assert payload[8] == "hero.png"
    assert _context_of(payload[0])[0] == PID


@pytest.mark.asyncio
async def test_upload_image_errors_when_no_media_handle_comes_back():
    rec = BatchRecorder(responses={
        fb.RPC_UPLOAD_IMAGE: [batch_envelope(fb.RPC_UPLOAD_IMAGE, [[]])],
    })
    out = await FlowSDK(client=rec).upload_image(
        image_base64="Zm9v", mime_type="image/png", project_id=PID,
    )
    assert "no media id" in out["error"]
    assert "media_id" not in out


# ── pure helpers, unchanged by the migration ──────────────────────────────


def test_resolve_image_model_helper_accepts_known_keys_only():
    from flowboard.services.flow_sdk import resolve_image_model

    assert resolve_image_model("NANO_BANANA_PRO") == "GEM_PIX_2"
    assert resolve_image_model("NANO_BANANA_2") == "NARWHAL"
    # Anything else falls back to Pro — defense-in-depth.
    assert resolve_image_model("UNKNOWN") == "GEM_PIX_2"
    assert resolve_image_model("") == "GEM_PIX_2"
    assert resolve_image_model(None) == "GEM_PIX_2"

def test_resolve_video_model_routes_by_tier_quality_aspect():
    """Video model resolver layers fallback: unknown quality → fast,
    unknown tier → TIER_ONE, unknown aspect → None. So a stale
    frontend can still dispatch *something* instead of silently
    swallowing the request."""
    from flowboard.services.flow_sdk import resolve_video_model

    # Tier 1 fast + landscape
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast"
    ) == "veo_3_1_i2v_s_fast"
    # Tier 1 fast + portrait → separate model
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_PORTRAIT", "fast"
    ) == "veo_3_1_i2v_s_fast_portrait"
    # Tier 2 fast — distinct landscape and portrait models. Both keys
    # verified against real Flow web request bodies (curl exports from
    # labs.google Network tab); never speculate suffixes here. Regression
    # guard for the bug where Tier 2 Portrait Fast was incorrectly mapped
    # to a landscape-only `_ultra_relaxed` model that ignored aspectRatio
    # and forced 1280×720 output even when 9:16 was requested.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast"
    ) == "veo_3_1_i2v_s_fast_ultra"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "fast"
    ) == "veo_3_1_i2v_s_fast_portrait_ultra"

    # Lite — multi-aspect, same key for landscape and portrait. Both
    # tiers share the `veo_3_1_i2v_lite` checkpoint (verified from PRO
    # PLAN curl in video_model.md AND ULTRA PLAN curl in
    # video_model_ultra.md); the per-tier difference is `userPaygateTier`
    # in clientContext, not the model key.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite"
    ) == "veo_3_1_i2v_lite"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "lite"
    ) == "veo_3_1_i2v_lite"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite"
    ) == "veo_3_1_i2v_lite"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_PORTRAIT", "lite"
    ) == "veo_3_1_i2v_lite"

    # Quality — third quality tier (xịn hơn Fast, slower). Both tiers
    # share the `veo_3_1_i2v_s*` family; the difference is the
    # `userPaygateTier` in clientContext, not the model key. Landscape
    # key verified from PRO PLAN curl in video_model.md; portrait key
    # verified from an Ultra labs.google curl and reused for Pro.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "quality"
    ) == "veo_3_1_i2v_s"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "quality"
    ) == "veo_3_1_i2v_s_portrait"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "quality"
    ) == "veo_3_1_i2v_s"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_PORTRAIT", "quality"
    ) == "veo_3_1_i2v_s_portrait"

    # Lite Relaxed — Ultra-only 0-credit low-priority queue. Verified
    # LANDSCAPE key from ULTRA PLAN curl in video_model_ultra.md;
    # portrait reuses the same key (multi-aspect, same as plain lite).
    # Tier 1 has no `lite_relaxed` mapping → falls back to Tier 1 fast.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite_relaxed"
    ) == "veo_3_1_i2v_lite_low_priority"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "lite_relaxed"
    ) == "veo_3_1_i2v_lite_low_priority"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "lite_relaxed"
    ) == "veo_3_1_i2v_s_fast"

    # Fast Relaxed — Ultra-only 0-credit low-priority queue. Verified
    # LANDSCAPE key from ULTRA PLAN curl in video_model_ultra.md;
    # portrait reuses the LANDSCAPE key as best-effort fallback (no
    # portrait curl observed yet). Tier 1 has no `fast_relaxed` mapping
    # → falls back to Tier 1 fast.
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast_relaxed"
    ) == "veo_3_1_i2v_s_fast_ultra_relaxed"
    assert resolve_video_model(
        "PAYGATE_TIER_TWO", "VIDEO_ASPECT_RATIO_PORTRAIT", "fast_relaxed"
    ) == "veo_3_1_i2v_s_fast_ultra_relaxed"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast_relaxed"
    ) == "veo_3_1_i2v_s_fast"

    # Default quality (None / empty) → fast.
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", None
    ) == "veo_3_1_i2v_s_fast"
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", ""
    ) == "veo_3_1_i2v_s_fast"

    # Unknown quality → falls back to fast within the tier.
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "VIDEO_ASPECT_RATIO_LANDSCAPE", "ultra"
    ) == "veo_3_1_i2v_s_fast"

    # Unknown tier → falls back to TIER_ONE.
    assert resolve_video_model(
        "PAYGATE_TIER_BOGUS", "VIDEO_ASPECT_RATIO_LANDSCAPE", "fast"
    ) == "veo_3_1_i2v_s_fast"

    # Unknown aspect → None (caller surfaces a clear error).
    assert resolve_video_model(
        "PAYGATE_TIER_ONE", "BOGUS_ASPECT", "fast"
    ) is None

def test_extract_media_ids_filters_non_dicts():
    assert _extract_media_ids({"data": {"media": [{"name": "a"}, "junk"]}}) == ["a"]
    assert _extract_media_ids({"data": {}}) == []
    assert _extract_media_ids("not a dict") == []

def test_extract_media_entries_pulls_fife_url():
    resp = {
        "data": {
            "media": [
                {
                    "name": "abc123",
                    "image": {
                        "generatedImage": {
                            "fifeUrl": "https://flow-content.google/image/abc123?sig=z",
                        }
                    },
                },
                {"name": "no-url"},
            ],
        },
    }
    entries = extract_media_entries(resp)
    assert len(entries) == 2
    assert entries[0]["media_id"] == "abc123"
    assert entries[0]["url"] == "https://flow-content.google/image/abc123?sig=z"
    assert entries[0]["mediaType"] == "image"
    assert entries[1]["url"] is None

def test_extract_operation_names_tolerates_missing_inner():
    resp = {"data": {"operations": [{"name": "top-level-name"}, {"operation": {"name": "inner"}}]}}
    assert extract_operation_names(resp) == ["top-level-name", "inner"]

def test_extract_video_operations_handles_missing_and_out_of_order():
    resp = {
        "data": {
            "operations": [
                {"operation": {"name": "b", "done": True, "metadata": {"video": {"mediaId": "mb", "fifeUrl": "https://flow-content.google/video/mb?x"}}}},
            ]
        }
    }
    out = extract_video_operations(resp, requested=["a", "b"])
    assert out[0]["name"] == "a"
    assert out[0]["done"] is False
    assert out[1]["name"] == "b"
    assert out[1]["done"] is True

def test_extract_video_operations_recovers_uuid_from_fife_url():
    """Flow's video poll response omits ``metadata.video.mediaId`` — it only
    has ``mediaGenerationId`` (base64 protobuf, NOT UUID). The real UUID is
    embedded in ``fifeUrl`` as ``/video/<UUID>?...``. Without URL recovery
    we'd return media_entries=[] for a perfectly-finished video."""
    resp = {
        "data": {
            "operations": [
                {
                    "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
                    "operation": {
                        "name": "op-1",
                        "metadata": {
                            "video": {
                                "mediaGenerationId": "CAUS-base64-not-a-uuid",
                                "fifeUrl": "https://flow-content.google/video/f0b6561a-73f2-4360-96aa-35e071aac9ce?Expires=1&Signature=x",
                            }
                        },
                    },
                },
            ]
        }
    }
    out = extract_video_operations(resp, requested=["op-1"])
    assert out[0]["done"] is True
    assert out[0]["media_entries"] == [
        {
            "media_id": "f0b6561a-73f2-4360-96aa-35e071aac9ce",
            "url": "https://flow-content.google/video/f0b6561a-73f2-4360-96aa-35e071aac9ce?Expires=1&Signature=x",
            "mediaType": "video",
        }
    ]

def test_extract_video_operations_surfaces_per_op_failure():
    """A real Flow rejection mid-poll: status FAILED at the envelope, plus
    ``operation.error.message: PUBLIC_ERROR_AUDIO_FILTERED`` on the inner
    object. Old code only checked SUCCESSFUL → spent the full 7-min timeout
    polling a doomed op. Worker now treats `error` as terminal."""
    resp = {
        "data": {
            "operations": [
                {
                    "status": "MEDIA_GENERATION_STATUS_FAILED",
                    "operation": {
                        "name": "vid-bad",
                        "error": {"code": 3, "message": "PUBLIC_ERROR_AUDIO_FILTERED"},
                    },
                },
            ]
        }
    }
    out = extract_video_operations(resp, requested=["vid-bad"])
    assert out[0]["done"] is True
    assert out[0]["error"] == "PUBLIC_ERROR_AUDIO_FILTERED"
    # No media_entries should be attached when the op itself errored.
    assert out[0]["media_entries"] == []

def test_extract_video_operations_recognizes_status_successful_envelope():
    """Flow returns operation status at the *outer* envelope level
    (op["status"]), not on the inner operation. Older code only checked
    inner.done and missed legitimately-completed videos."""
    resp = {
        "data": {
            "operations": [
                {
                    "status": "MEDIA_GENERATION_STATUS_SUCCESSFUL",
                    "operation": {
                        "name": "vid-ok",
                        "metadata": {"video": {"mediaId": "abc-123", "fifeUrl": "https://flow-content.google/video/abc?sig"}},
                    },
                },
                {
                    "status": "MEDIA_GENERATION_STATUS_PENDING",
                    "operation": {"name": "vid-pending"},
                },
            ]
        }
    }
    out = extract_video_operations(resp, requested=["vid-ok", "vid-pending"])
    assert out[0]["done"] is True
    assert out[0]["media_entries"] == [
        {"media_id": "abc-123", "url": "https://flow-content.google/video/abc?sig", "mediaType": "video"}
    ]
    assert out[1]["done"] is False
    assert out[1]["media_entries"] == []

@pytest.mark.asyncio
async def test_gen_video_returns_error_when_no_source_provided():
    c = BatchRecorder()
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(prompt="x", project_id=PID, paygate_tier="PAYGATE_TIER_ONE")
    assert out.get("error") == "missing_start_media_id"

@pytest.mark.asyncio
async def test_gen_video_rejects_unknown_tier_aspect_combo():
    c = BatchRecorder()
    sdk = FlowSDK(client=c)  # type: ignore[arg-type]
    out = await sdk.gen_video(
        prompt="x",
        project_id=PID,
        start_media_id="m",
        aspect_ratio="VIDEO_ASPECT_RATIO_WEIRD",
        paygate_tier="PAYGATE_TIER_ONE",
    )
    assert out["error"].startswith("no_video_model_for_tier")
    # No HTTP call attempted.
    assert c.calls == []


@pytest.mark.asyncio
async def test_gen_image_falls_back_to_gem_pix_2_on_ogiZ0b_not_found_5():
    """When Flow rejects NARWHAL with RpcError([5]), auto-fallback retries GEM_PIX_2."""
    rec = BatchRecorder(responses={
        fb.RPC_GEN_IMAGE: [
            batch_error_envelope(fb.RPC_GEN_IMAGE, code=[5]),
            batch_envelope(
                fb.RPC_GEN_IMAGE,
                [[f"https://flow-content.google/image/{MEDIA}?sig=fallback"]],
            ),
        ],
    })
    out = await FlowSDK(client=rec).gen_image(  # type: ignore[arg-type]
        prompt="studio vase",
        project_id=PID,
        paygate_tier=TIER,
        image_model="NANO_BANANA_2",
    )
    assert out.get("error") is None
    assert image_items(rec.payload(fb.RPC_GEN_IMAGE, 0))[0][IMG_MODEL] == "NARWHAL"
    assert image_items(rec.payload(fb.RPC_GEN_IMAGE, 1))[0][IMG_MODEL] == "GEM_PIX_2"
    assert out["media_ids"] == [MEDIA]
    assert len(out["media_entries"]) == 1
    assert out["media_entries"][0]["media_id"] == MEDIA
    assert out["media_entries"][0]["url"] == f"https://flow-content.google/image/{MEDIA}?sig=fallback"
    assert out["media_entries"][0]["mediaType"] == "image"


def test_resolve_new_image_and_omni_1_2_models():
    from flowboard.services.flow_sdk import resolve_image_model, resolve_omni_flash_model

    assert resolve_image_model("NANO_BANANA_PRO") == "GEM_PIX_2"
    assert resolve_image_model("NANO_BANANA_2_1") == "BELUGA"
    assert resolve_image_model("NANO_BANANA_2_1_HIGH") == "BELUGA_THINKING_HIGH"
    assert resolve_image_model("NANO_BANANA_2_LITE") == "HARBOR_SEAL"
    assert resolve_omni_flash_model(12, version="1.2") == "abra_1_2_r2v_12s"
    with pytest.raises(ValueError):
        resolve_omni_flash_model(12, version="1.1")


@pytest.mark.asyncio
async def test_gen_video_supports_variant_count_and_clamps_360p_to_native_720p():
    from flowboard.services.flow_sdk import RPC_UPSCALE_VIDEO  # sanity import

    assert RPC_UPSCALE_VIDEO == "p0UkFb"
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO: [
            batch_envelope(fb.RPC_GEN_VIDEO, operation_payload("op-720-1")),
            batch_envelope(fb.RPC_GEN_VIDEO, operation_payload("op-720-2")),
            batch_envelope(fb.RPC_GEN_VIDEO, operation_payload("op-720-3")),
        ],
    })
    out = await FlowSDK(client=rec).gen_video(  # type: ignore[arg-type]
        prompt="慢镜头行走",
        project_id=PID,
        start_media_id=MEDIA,
        paygate_tier=TIER,
        video_quality="lite",
        variant_count=3,
        resolution="360p",
    )
    assert out.get("error") is None
    assert out["resolution"] == "720p"
    assert out["operation_names"] == ["op-720-1", "op-720-2", "op-720-3"]
    req0 = rec.payload(fb.RPC_GEN_VIDEO, 0)[0][0]
    assert len(req0) == 6


@pytest.mark.asyncio
async def test_gen_video_omni_360p_and_fallback_on_invalid_argument():
    rec_11 = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_REFERENCES: [
            batch_envelope(fb.RPC_GEN_VIDEO_REFERENCES, operation_payload("op-omni-360")),
        ],
    })
    out_11 = await FlowSDK(client=rec_11).gen_video_omni(  # type: ignore[arg-type]
        prompt="角色转身微笑",
        project_id=PID,
        ref_media_ids=[MEDIA],
        duration_s=6,
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier=TIER,
        resolution="360p",
        omni_version="1.1",
    )
    assert out_11.get("error") is None
    assert out_11["resolution"] == "360p"
    req_11 = rec_11.payload(fb.RPC_GEN_VIDEO_REFERENCES, 0)[0][0]
    assert req_11[2] == "abra_r2v_6s_360p"
    assert len(req_11) == 12
    assert req_11[11] == [4]

    rec_12 = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_REFERENCES: [
            batch_error_envelope(fb.RPC_GEN_VIDEO_REFERENCES, code=[3]),
            batch_error_envelope(fb.RPC_GEN_VIDEO_REFERENCES, code=[3]),
            batch_envelope(fb.RPC_GEN_VIDEO_REFERENCES, operation_payload("op-omni-720-fallback")),
        ],
    })
    out_12 = await FlowSDK(client=rec_12).gen_video_omni(  # type: ignore[arg-type]
        prompt="角色转身微笑",
        project_id=PID,
        ref_media_ids=[MEDIA],
        duration_s=8,
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier=TIER,
        resolution="360p",
        omni_version="1.2",
    )
    assert out_12.get("error") is None
    assert out_12["resolution"] == "720p"
    assert out_12["model"] == "abra_1_2_r2v_8s"
    req_fallback = rec_12.payload(fb.RPC_GEN_VIDEO_REFERENCES, 2)[0][0]
    assert len(req_fallback) == 6


@pytest.mark.asyncio
async def test_upscale_image_and_video_envelopes():
    from flowboard.services.flow_sdk import RPC_UPSCALE_VIDEO

    rec = BatchRecorder(responses={
        fb.RPC_UPSCALE_IMAGE: batch_envelope(
            fb.RPC_UPSCALE_IMAGE,
            [[f"https://flow-content.google/image/{MEDIA}?sig=4k"]],
        ),
        RPC_UPSCALE_VIDEO: batch_envelope(
            RPC_UPSCALE_VIDEO,
            operation_payload("op-up-1080p"),
        ),
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    up_img = await sdk.upscale_image(MEDIA, project_id=PID, resolution="4K")
    assert up_img.get("error") is None
    assert up_img["resolution"] == "4K"
    img_payload = rec.payload(fb.RPC_UPSCALE_IMAGE, 0)
    assert img_payload[0] == MEDIA
    assert img_payload[1] == 2

    up_vid = await sdk.upscale_video(MEDIA, project_id=PID, resolution="1080p", seed=12345)
    assert up_vid.get("error") is None
    assert up_vid["resolution"] == "1080p"
    assert up_vid["operation_names"] == ["op-up-1080p"]
    vid_item = rec.payload(RPC_UPSCALE_VIDEO, 0)[0][0]
    assert vid_item[0] == [None, MEDIA]
    assert vid_item[3] == 12345
    assert vid_item[6] == 2
    assert vid_item[31] == "veo_3_1_upsampler_1080p"


def test_parse_credits_payload_handles_int64_strings_and_fallback_sum():
    from flowboard.services.flow_sdk import parse_credits_payload

    parsed = parse_credits_payload(["1250", 2, 10, None, "50", "1200"])
    assert parsed["credits"] == 1250
    assert parsed["paygate_tier"] == "PAYGATE_TIER_TWO"
    assert parsed["subscription_credits"] == 1200
    assert parsed["top_up_credits"] == 50

    summed = parse_credits_payload([None, 1, None, None, 100, 900])
    assert summed["credits"] == 1000
    assert summed["paygate_tier"] == "PAYGATE_TIER_ONE"

    tier1p5 = parse_credits_payload([4500, 8])
    assert tier1p5["credits"] == 4500
    assert tier1p5["paygate_tier"] == "PAYGATE_TIER_TWO"


@pytest.mark.asyncio
async def test_get_credits_queries_nzlxg_rpc():
    from flowboard.services.flow_sdk import RPC_GET_CREDITS

    rec = BatchRecorder(responses={
        RPC_GET_CREDITS: batch_envelope(RPC_GET_CREDITS, [2400, 2, 3, None, 0, 2400]),
    })
    out = await FlowSDK(client=rec).get_credits(PID)  # type: ignore[arg-type]
    assert out.get("error") is None
    assert out["credits"] == 2400
    assert out["paygate_tier"] == "PAYGATE_TIER_TWO"
    assert rec.payload(RPC_GET_CREDITS, 0) == []


@pytest.mark.asyncio
async def test_discover_omni_1_2_macaron_cookie_keys_from_htrjv_catalog():
    from flowboard.services.flow_sdk import RPC_MODEL_CONFIG

    def _usage(wire_key: str, dur: int, *, caps: list[int], res_codes: list[int]) -> list:
        row: list = [None] * 25
        row[0] = wire_key
        row[7] = [[[caps]]]
        row[16] = dur
        row[23] = [res_codes]
        return row

    catalog_root: list = [None] * 6
    catalog_root[4] = [
        [
            "Omni 1.2 Flash",
            [
                _usage("macaron_cookie_start_5s", 5, caps=[5], res_codes=[1]),
                _usage("macaron_cookie_r2v_3s", 3, caps=[6, 20], res_codes=[1, 4]),
                _usage("macaron_cookie_r2v_5s", 5, caps=[6, 20], res_codes=[1]),
                _usage("macaron_cookie_r2v_15s", 15, caps=[6, 20], res_codes=[1]),
            ],
            False,
            "macaron_cookie",
        ],
    ]

    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_REFERENCES: [
            batch_envelope(fb.RPC_GEN_VIDEO_REFERENCES, operation_payload("op-macaron-5s")),
        ],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    sdk._ingest_omni_1_2_catalog([catalog_root])

    assert sdk._omni_1_2_r2v_keys[(3, "720p")] == "macaron_cookie_r2v_3s"
    assert sdk._omni_1_2_r2v_keys[(3, "360p")] == "macaron_cookie_r2v_3s"
    assert sdk._omni_1_2_r2v_keys[(5, "720p")] == "macaron_cookie_r2v_5s"
    assert sdk._omni_1_2_r2v_keys[(15, "720p")] == "macaron_cookie_r2v_15s"

    out = await sdk.gen_video_omni(
        prompt="平滑推进 5 秒镜头",
        project_id=PID,
        ref_media_ids=[MEDIA],
        duration_s=5,
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier=TIER,
        resolution="720p",
        omni_version="1.2",
    )
    assert out.get("error") is None
    assert out["model"] == "macaron_cookie_r2v_5s"
    sent_item = rec.payload(fb.RPC_GEN_VIDEO_REFERENCES, 0)[0][0]
    assert sent_item[2] == "macaron_cookie_r2v_5s"
    assert RPC_MODEL_CONFIG == "HTrJv"


@pytest.mark.asyncio
async def test_gen_video_first_last_submits_nprqif_and_falls_back_on_5():
    end_media = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_FIRST_LAST: [
            batch_envelope(fb.RPC_GEN_VIDEO_FIRST_LAST, operation_payload("op-fl-1")),
        ],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    out = await sdk.gen_video_first_last(
        prompt="平滑渐变过渡",
        project_id=PID,
        start_media_id=MEDIA,
        end_media_id=end_media,
        duration_s=6,
        aspect_ratio="VIDEO_ASPECT_RATIO_PORTRAIT",
        paygate_tier=TIER,
    )
    assert out.get("error") is None
    assert out["operation_names"] == ["op-fl-1"]
    assert out["duration_s"] == 6
    sent = rec.payload(fb.RPC_GEN_VIDEO_FIRST_LAST, 0)[0][0]
    assert sent[1] == "omni_flash_i2v_6s_first_last"
    assert sent[4][1] == MEDIA
    assert sent[5][1] == end_media

    # When nprQif returns [5] NOT_FOUND, automatically falls back to MZZa6b refs [start, end]
    fb_rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_FIRST_LAST: [batch_error_envelope(fb.RPC_GEN_VIDEO_FIRST_LAST, [5])],
        fb.RPC_GEN_VIDEO_REFERENCES: [
            batch_envelope(fb.RPC_GEN_VIDEO_REFERENCES, operation_payload("op-fl-r2v")),
        ],
    })
    out_fb = await FlowSDK(client=fb_rec).gen_video_first_last(  # type: ignore[arg-type]
        prompt="fallback first last",
        project_id=PID,
        start_media_id=MEDIA,
        end_media_id=end_media,
        duration_s=8,
        paygate_tier=TIER,
    )
    assert out_fb.get("error") is None
    assert out_fb["operation_names"] == ["op-fl-r2v"]
    fb_item = fb_rec.payload(fb.RPC_GEN_VIDEO_REFERENCES, 0)[0][0]
    assert fb_item[OMNI_REFS] == [[None, MEDIA], [None, end_media]]


@pytest.mark.asyncio
async def test_gen_video_text_submits_yhhmef_and_polls_as29s():
    t2v_mid = "12121212-3434-5656-7878-909090909090"
    t2v_wf = "wf-t2v-1"
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO_TEXT: [
            batch_envelope(fb.RPC_GEN_VIDEO_TEXT, [None, None, None, [[t2v_mid, PID, t2v_wf, "PENDING"]]]),
        ],
        fb.RPC_MEDIA: [
            batch_envelope(fb.RPC_MEDIA, media_urls_payload(t2v_mid, video=True, image=True)),
        ],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    out = await sdk.gen_video_text(
        prompt="雨夜霓虹街景航拍长镜头",
        project_id=PID,
        duration_s=4,
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier=TIER,
    )
    assert out.get("error") is None
    assert out["operation_names"] == [t2v_wf]
    assert sdk._operation_media[t2v_wf] == t2v_mid
    sent = rec.payload(fb.RPC_GEN_VIDEO_TEXT, 0)[0][0]
    assert sent[1] == "abra_t2v_4s"

    poll = await sdk.check_async([t2v_wf])
    assert poll["operations"][0]["done"] is True
    assert poll["operations"][0]["media_entries"][0]["media_id"] == t2v_mid


# ── video polling regressions (as29s [5] / timeout_waiting_video) ─────────


def test_find_media_id_in_text_ignores_null_slot4_client_uuid_and_adjacent_entries():
    """Regression for the `as29s failed: [5]` + `timeout_waiting_video` bug.

    While an operation is still generating (or failed), slot 4 (`mediaId`) is
    `null` and slot 5 is the uppercase `clientUuid`, producing
    `null,null,null,"<CLIENT_UUID>"`. The old `null,null,"UUID"` regex slipped
    onto `clientUuid` (or bled into the next entry), poisoned `_operation_media`,
    and hammered `as29s` with `[5]` NOT_FOUND for 5 minutes until timeout.
    """
    import json

    op_id = "29382a9f-0b12-488f-a24b-e9a84cb6e1ae"
    client_uuid = "A1B2C3D4-E5F6-4789-ABCD-0123456789AB"
    neighbor_op = "99999999-8888-7777-6666-555555555555"
    neighbor_media = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff"
    real_media = "cccccccc-dddd-eeee-ffff-111111111111"

    # 1. In-progress entry (slot 4 is null, slot 5 is clientUuid) + neighbor entry
    in_progress_payload = [
        [op_id, None, None, ["天台夜景", [1763994033, 0], None, None, None, client_uuid, False], PID],
        [neighbor_op, None, None, ["前一个视频", [1763994000, 0], None, None, neighbor_media, client_uuid, True], PID],
    ]
    raw_wrb = batch_envelope(fb.RPC_PROJECT_MEDIA, in_progress_payload)
    # Simulate old extension slicing straight from `op_id`
    old_slice = raw_wrb[raw_wrb.index(op_id) : raw_wrb.index(op_id) + 800]
    assert fb.find_media_id_in_text(old_slice, op_id) is None
    assert fb.find_media_id_in_text(raw_wrb, op_id) is None

    # 2. Long 301-char Chinese prompt with quotes (both raw UTF-8 and \uXXXX-escaped > 1800 chars)
    long_prompt = (
        '固定机位。0-3秒，ref_image_1中的动漫少女立于天台边缘，她说："我一定会让你们付出代价的"，'
        + "强风呼啸长发与红色裙摆剧烈翻飞" * 16
    )
    completed_entry = [
        [op_id, None, None, [long_prompt, [1763994033, 0], None, None, real_media, client_uuid, True], PID],
    ]
    # ASCII-escaped JSON (each Chinese char becomes \uXXXX -> ~1800+ chars)
    inner_ascii = json.dumps(completed_entry, ensure_ascii=True, separators=(",", ":"))
    wrb_ascii = json.dumps([["wrb.fr", fb.RPC_PROJECT_MEDIA, inner_ascii, None, None, None, "generic"]])
    idx_ascii = wrb_ascii.index(op_id)
    assert fb.find_media_id_in_text(wrb_ascii[idx_ascii : idx_ascii + 4096], op_id) == real_media

    # 3. Trailer mention `["<op_id>"]` before the actual listing entry
    with_trailer = [
        [[op_id]],
        [op_id, None, None, ["title", 1234, None, None, real_media, client_uuid, True], PID],
    ]
    wrb_trailer = batch_envelope(fb.RPC_PROJECT_MEDIA, with_trailer)
    assert fb.find_media_id_in_text(wrb_trailer, op_id) == real_media

    # 4. Truncated slice cutting off right after slot 4 (before closing `]`)
    cut_at = wrb_ascii.index(real_media) + len(real_media) + 5
    assert fb.find_media_id_in_text(wrb_ascii[idx_ascii:cut_at], op_id) == real_media

    # 5. Reversed layout `[mediaId, null, null, [title, ts, null, null, opId, ...]]`
    reversed_payload = [
        [real_media, None, None, ["title", [1763994033, 0], None, None, op_id, client_uuid, True], PID],
    ]
    wrb_rev = batch_envelope(fb.RPC_PROJECT_MEDIA, reversed_payload)
    rev_idx = wrb_rev.index(op_id)
    rev_slice = wrb_rev[max(0, rev_idx - 1024) : rev_idx + 4096]
    assert fb.find_media_id_in_text(rev_slice, op_id) == real_media
    assert fb.find_media_id(reversed_payload, op_id) == real_media


@pytest.mark.asyncio
async def test_check_async_does_not_poison_cache_on_as29s_not_found_and_recovers():
    """An as29s [5] NOT_FOUND must NOT be cached; next poll re-queries jwpduf+Zzl0ze."""
    op_id = "29382a9f-0b12-488f-a24b-e9a84cb6e1ae"
    bad_mid = "11111111-2222-3333-4444-555555555555"
    good_mid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

    rec = BatchRecorder(responses={
        fb.RPC_OPERATION: [
            batch_envelope(fb.RPC_OPERATION, operation_payload(op_id, project_id=PID, status="CAE")),
            batch_envelope(fb.RPC_OPERATION, operation_payload(op_id, project_id=PID, status="CAE")),
        ],
        fb.RPC_PROJECT_MEDIA: [
            listing_payload_text(op_id, bad_mid),
            listing_payload_text(op_id, good_mid),
        ],
        fb.RPC_MEDIA: [
            batch_error_envelope(fb.RPC_MEDIA, code=[5]),
            batch_envelope(fb.RPC_MEDIA, media_urls_payload(good_mid, video=True)),
        ],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]

    poll1 = await sdk.check_async([op_id])
    assert poll1["operations"][0]["done"] is False
    assert "as29s failed: [5]" in poll1["raw"]["data"]["operations"][0]["complaint"]
    assert op_id not in sdk._operation_media, "NOT_FOUND media_id must never poison cache"

    poll2 = await sdk.check_async([op_id])
    assert poll2["operations"][0]["done"] is True
    assert poll2["operations"][0]["media_entries"][0]["media_id"] == good_mid
    assert sdk._operation_media[op_id] == good_mid
    assert len(rec.rpcs(fb.RPC_PROJECT_MEDIA)) == 2


@pytest.mark.asyncio
async def test_check_async_evicts_cached_media_id_on_as29s_not_found_and_reprobes():
    """If a previously cached media_id returns as29s [5], evict and re-probe immediately."""
    op_id = "op-stale-cache"
    stale_mid = "11111111-2222-3333-4444-555555555555"
    fresh_mid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

    rec = BatchRecorder(responses={
        fb.RPC_OPERATION: [
            batch_envelope(fb.RPC_OPERATION, operation_payload(op_id, project_id=PID, status="CAE")),
        ],
        fb.RPC_PROJECT_MEDIA: [
            listing_payload_text(op_id, fresh_mid),
        ],
        fb.RPC_MEDIA: [
            batch_error_envelope(fb.RPC_MEDIA, code=[5]),
            batch_envelope(fb.RPC_MEDIA, media_urls_payload(fresh_mid, video=True)),
        ],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    sdk._remember_operation(op_id, PID)
    sdk._operation_media[op_id] = stale_mid

    poll = await sdk.check_async([op_id])
    assert poll["operations"][0]["done"] is True
    assert poll["operations"][0]["media_entries"][0]["media_id"] == fresh_mid
    assert sdk._operation_media[op_id] == fresh_mid


@pytest.mark.asyncio
async def test_check_async_uses_direct_video_url_from_jwpduf_without_zzl0ze_or_as29s():
    """When jwpduf already carries a signed /video/ CDN URL, resolve immediately."""
    op_id = "op-direct-url"
    direct_payload = [
        None,
        50,
        [[
            op_id,
            PID,
            "11111111-2222-3333-4444-555555555555",
            "CAE",
            None,
            [[1763994033], "prompt", None, None, None, None, None, None, [3]],
            None,
            [[None, 1, None, None, None, None, None, "prompt", f"https://flow-content.google/video/{MEDIA}?sig=direct"]],
        ]],
    ]
    rec = BatchRecorder(responses={
        fb.RPC_OPERATION: [batch_envelope(fb.RPC_OPERATION, direct_payload)],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    poll = await sdk.check_async([op_id])
    assert poll["operations"][0]["done"] is True
    assert poll["operations"][0]["media_entries"][0]["media_id"] == MEDIA
    assert "/video/" in poll["operations"][0]["media_entries"][0]["url"]
    assert rec.rpcs(fb.RPC_PROJECT_MEDIA) == []
    assert rec.rpcs(fb.RPC_MEDIA) == []


@pytest.mark.asyncio
async def test_check_async_fails_fast_on_public_error_and_repeated_policy_rejection():
    """Explicit PUBLIC_ERROR_* fails fast when listing has no media; policy prose fails on 2 strikes."""
    op_pub = "op-public-err"
    rec_pub = BatchRecorder(responses={
        fb.RPC_OPERATION: [
            batch_envelope(
                fb.RPC_OPERATION,
                operation_payload(
                    op_pub,
                    project_id=PID,
                    status="CAE",
                    detail=complaint_detail("PUBLIC_ERROR_UNSAFE_GENERATION"),
                ),
            ),
        ],
        fb.RPC_PROJECT_MEDIA: [""],
    })
    out_pub = await FlowSDK(client=rec_pub).check_async([op_pub])  # type: ignore[arg-type]
    assert out_pub["operations"][0]["done"] is True
    assert out_pub["operations"][0]["status"] == "MEDIA_GENERATION_STATUS_FAILED"
    assert out_pub["operations"][0]["error"] == "PUBLIC_ERROR_UNSAFE_GENERATION"

    op_prose = "op-policy-prose"
    rec_prose = BatchRecorder(responses={
        fb.RPC_OPERATION: [
            batch_envelope(
                fb.RPC_OPERATION,
                operation_payload(
                    op_prose,
                    project_id=PID,
                    status="CAE",
                    detail=complaint_detail("Your prompt may violate our content policy."),
                ),
            ),
            batch_envelope(
                fb.RPC_OPERATION,
                operation_payload(
                    op_prose,
                    project_id=PID,
                    status="CAE",
                    detail=complaint_detail("Your prompt may violate our content policy."),
                ),
            ),
        ],
        fb.RPC_PROJECT_MEDIA: ["", ""],
    })
    sdk_prose = FlowSDK(client=rec_prose)  # type: ignore[arg-type]
    p1 = await sdk_prose.check_async([op_prose])
    assert p1["operations"][0]["done"] is False
    p2 = await sdk_prose.check_async([op_prose])
    assert p2["operations"][0]["done"] is True
    assert p2["operations"][0]["status"] == "MEDIA_GENERATION_STATUS_FAILED"
    assert "content policy" in p2["operations"][0]["error"]


@pytest.mark.asyncio
async def test_check_async_keeps_synthetic_t2v_media_id_across_transient_as29s_not_found():
    """Synthetic t2v:<media_id> handles survive transient as29s [5] until the clip lands."""
    op_id = f"t2v:{MEDIA}"
    rec = BatchRecorder(responses={
        fb.RPC_MEDIA: [
            batch_error_envelope(fb.RPC_MEDIA, code=[5]),
            batch_envelope(fb.RPC_MEDIA, media_urls_payload(MEDIA, video=True)),
        ],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    sdk._operation_media[op_id] = MEDIA

    p1 = await sdk.check_async([op_id])
    assert p1["operations"][0]["done"] is False
    assert sdk._operation_media[op_id] == MEDIA

    p2 = await sdk.check_async([op_id])
    assert p2["operations"][0]["done"] is True
    assert p2["operations"][0]["media_entries"][0]["media_id"] == MEDIA


# ── live Oct/Nov 2026 Flow wire-format regressions (null slot 3 / payload[3]) ─


def _modern_gen_record(wf_id: str, proj_id: str, listing_id: str, outcome: int,
                       *, error_pair=None, prompt: str = "在跳舞"):
    status_cell = [outcome] if error_pair is None else [outcome, list(error_pair), [error_pair[1]]]
    details = [
        [1795496113, 123456000],
        prompt,
        None,
        None,
        None,
        None,
        [None, [["veo_3_1_i2v_lite", 1, None, None, 2, 1]], [[None, None, [[[prompt]]]]], None, 1],
        None,
        status_cell,
        1,
    ]
    return [wf_id, proj_id, listing_id, None, None, details, None, [[None, 123, None, None, None, None, None, prompt, None]]]


@pytest.mark.asyncio
async def test_eb1hjf_modern_submit_extracts_workflow_id_and_polls_outcome3_directly():
    """Live eb1hJf submit returns listing stub at [2] and generation record at [3].

    Reading payload[2][0][0] grabbed the listing id instead of the workflow id,
    which made jwpduf answer "Media not found." forever. Extracting wf_id from
    payload[3] and recognising outcome==3 (with slot 3 == null) resolves the
    clip directly via as29s without downloading Zzl0ze.
    """
    listing_id = "2d26bb29-dfe4-4c39-a31a-ea34813ee976"
    wf_id = "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
    submit_payload = [
        None,
        881,
        [[listing_id, None, None, ["在跳舞", [1795496113, 0], None, None, wf_id, "CLIENT-UUID", [1795496113, 0]], PID]],
        [[_modern_gen_record(wf_id, PID, listing_id, fb.OUTCOME_SUBMITTED)]],
    ]
    rec = BatchRecorder(responses={
        fb.RPC_GEN_VIDEO: [batch_envelope(fb.RPC_GEN_VIDEO, submit_payload)],
        fb.RPC_OPERATION: [
            batch_envelope(fb.RPC_OPERATION, [None, None, [[_modern_gen_record(wf_id, PID, listing_id, fb.OUTCOME_RUNNING)]]]),
            batch_envelope(fb.RPC_OPERATION, [None, None, [[_modern_gen_record(wf_id, PID, listing_id, fb.OUTCOME_OK)]]]),
        ],
        fb.RPC_MEDIA: [
            batch_envelope(fb.RPC_MEDIA, media_urls_payload(wf_id, video=True, image=True)),
        ],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    submitted = await sdk.gen_video(
        prompt="在跳舞",
        project_id=PID,
        start_media_id=MEDIA,
        aspect_ratio="VIDEO_ASPECT_RATIO_LANDSCAPE",
        paygate_tier=TIER,
        video_quality="lite",
    )
    assert submitted.get("error") is None
    assert submitted["operation_names"] == [wf_id]
    assert sdk._operation_submit_media[wf_id] == wf_id

    # Round 1: jwpduf reports outcome 2 (running), slot 3 is null -> PENDING
    p1 = await sdk.check_async([wf_id])
    assert p1["operations"][0]["done"] is False
    assert rec.rpcs(fb.RPC_PROJECT_MEDIA) == []
    assert rec.rpcs(fb.RPC_MEDIA) == []

    # Round 2: jwpduf reports outcome 3 (done), slot 3 is null -> direct as29s -> SUCCESSFUL
    p2 = await sdk.check_async([wf_id])
    assert p2["operations"][0]["done"] is True
    assert p2["operations"][0]["status"] == "MEDIA_GENERATION_STATUS_SUCCESSFUL"
    assert p2["operations"][0]["media_entries"][0]["media_id"] == wf_id
    assert "/video/" in p2["operations"][0]["media_entries"][0]["url"]
    assert rec.rpcs(fb.RPC_PROJECT_MEDIA) == []


def test_read_operation_extracts_workflow_id_from_listing_stub_without_payload3():
    """Even if a submit omits payload[3], extract wf_id from listing stub detail[4]."""
    listing_id = "2d26bb29-dfe4-4c39-a31a-ea34813ee976"
    wf_id = "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
    stub_only = [
        None,
        881,
        [[listing_id, None, None, ["在跳舞", [1, 2], None, None, wf_id, "CLIENT-UUID", [1, 2]], PID]],
    ]
    op = fb.read_operation(stub_only)
    assert op.operation_id == wf_id
    assert op.project_id == PID
    assert op.media_id == wf_id


def test_find_media_id_extracts_wf_id_from_null_slot3_generation_record_and_detail5():
    """Zzl0ze generation records carry [wfId, projId, listingId, null, null, [details...]].

    Because slot 3 changed from "CAE" to null, listingId is followed by
    `",null,null,[` just like a listing stub, while details[4] is null. Both
    find_media_id_in_text and find_media_id must extract wfId at slot 0.
    """
    import json

    listing_id = "2d26bb29-dfe4-4c39-a31a-ea34813ee976"
    wf_id = "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
    gen_rec = _modern_gen_record(wf_id, PID, listing_id, fb.OUTCOME_OK)
    wrb = json.dumps([["wrb.fr", fb.RPC_PROJECT_MEDIA, json.dumps([[gen_rec]]), None, None, None, "generic"]])

    assert fb.find_media_id_in_text(wrb, listing_id) == wf_id
    assert fb.find_media_id([[gen_rec]], listing_id) == wf_id

    # Also handle upstream flowkit's detail[5] == opId -> detail[4] == mediaId shape
    asset_id = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb"
    op_slot5 = "cccccccc-1111-4222-8333-dddddddddddd"
    stub_detail5 = [[asset_id, None, None, ["title", [1, 2], True, None, wf_id, op_slot5, True], PID]]
    wrb_detail5 = json.dumps([["wrb.fr", fb.RPC_PROJECT_MEDIA, json.dumps(stub_detail5), None, None, None, "generic"]])
    assert fb.find_media_id_in_text(wrb_detail5, op_slot5) == wf_id
    assert fb.find_media_id(stub_detail5, op_slot5) == wf_id


@pytest.mark.asyncio
async def test_check_async_fails_fast_on_flow_status4_job_failed_message():
    """gflow-cli #1111: status 4 with gRPC code 13 'Generation job finished with state: FAILED' fails fast."""
    listing_id = "2d26bb29-dfe4-4c39-a31a-ea34813ee976"
    wf_id = "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
    failed_rec = _modern_gen_record(
        wf_id, PID, listing_id, fb.OUTCOME_COMPLAINT,
        error_pair=(13, "Generation job finished with state: FAILED"),
    )
    rec = BatchRecorder(responses={
        fb.RPC_OPERATION: [
            batch_envelope(fb.RPC_OPERATION, [None, None, [[failed_rec]]]),
            batch_envelope(fb.RPC_OPERATION, [None, None, [[failed_rec]]]),
        ],
        fb.RPC_PROJECT_MEDIA: ["", ""],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    p1 = await sdk.check_async([wf_id])
    assert p1["operations"][0]["done"] is False
    p2 = await sdk.check_async([wf_id])
    assert p2["operations"][0]["done"] is True
    assert p2["operations"][0]["status"] == "MEDIA_GENERATION_STATUS_FAILED"
    assert "FAILED" in p2["operations"][0]["error"]


@pytest.mark.asyncio
async def test_check_async_direct_hint_falls_back_to_zzl0ze_on_as29s_not_found():
    """If a direct submit/outcome==3 hint returns as29s [5], immediately fall back to Zzl0ze."""
    wf_id = "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
    listing_id = "2d26bb29-dfe4-4c39-a31a-ea34813ee976"
    real_mid = "eeeeeeee-1111-4222-8333-ffffffffffff"
    done_rec = _modern_gen_record(wf_id, PID, listing_id, fb.OUTCOME_OK)
    rec = BatchRecorder(responses={
        fb.RPC_OPERATION: [batch_envelope(fb.RPC_OPERATION, [None, None, [[done_rec]]])],
        fb.RPC_PROJECT_MEDIA: [listing_payload_text(wf_id, real_mid)],
        fb.RPC_MEDIA: [
            batch_error_envelope(fb.RPC_MEDIA, code=[5]),
            batch_envelope(fb.RPC_MEDIA, media_urls_payload(real_mid, video=True)),
        ],
    })
    sdk = FlowSDK(client=rec)  # type: ignore[arg-type]
    sdk._remember_operation(wf_id, PID, media_id=wf_id)

    out = await sdk.check_async([wf_id])
    assert out["operations"][0]["done"] is True
    assert out["operations"][0]["media_entries"][0]["media_id"] == real_mid
    assert wf_id not in sdk._operation_submit_media
    assert sdk._operation_media[wf_id] == real_mid


