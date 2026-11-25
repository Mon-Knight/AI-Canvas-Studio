"""Tests for Google Flow Music personal-credits channel integration."""
from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import pytest

from flowboard.db import get_session
from flowboard.db.models import AppSetting, Board, FlowAccount, Node, Request
from flowboard.services import flow_accounts, media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flowmusic_client import (
    FlowMusicClient,
    FlowMusicError,
    build_edit_recipe,
    build_effect_graph,
    compose_lyrics_payload,
    compose_sound_prompt,
    compute_lyrics_id,
    extract_job_outcome,
    parse_sse_lines,
)
from flowboard.worker.music_handlers import (
    _handle_edit_music,
    _handle_gen_music,
    _handle_split_stems,
)
from flowboard.worker.settlement import _node_completion_patch

_SAMPLE_WAV = b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x80\xbb\x00\x00\x00\x77\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
_SAMPLE_PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4"
    b"\x00\x00\x00\rIDATx\x9cc```\xf8\x0f\x00\x01\x04\x01\x00\x9b\xa7\xd0\xb4"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def test_lyrics_and_prompt_helpers():
    lid = compute_lyrics_id("[Instrumental]")
    assert lid == compute_lyrics_id("[Instrumental]")
    assert len(lid) == 36

    prompt = compose_sound_prompt("cinematic synthwave, neon rain", 108)
    assert prompt == "cinematic synthwave, neon rain, 108 bpm"
    # Don't duplicate BPM when already present
    assert compose_sound_prompt("lofi piano, 82 bpm", 90) == "lofi piano, 82 bpm"

    inst_id, inst_map = compose_lyrics_payload(instrumental=True, duration_s=95)
    assert inst_id is not None
    assert inst_map[inst_id] == "[Instrumental]\n\n[End - 1:35]"

    voc_id, voc_map = compose_lyrics_payload(lyrics="Hello moonlight", instrumental=False, duration_s=120)
    assert voc_id is not None
    assert "Hello moonlight" in voc_map[voc_id]
    assert "[End - 2:00]" in voc_map[voc_id]


def test_recipe_and_effect_builders():
    ext = build_edit_recipe(clip_id="clip-1", action="extend", instruction="epic outro", extend_s=45, extend_from_s=60)
    nodes = ext["recipe"]["nodes"]
    assert nodes[0] == {"type": "Input", "clip_id": "clip-1"}
    assert nodes[1]["type"] == "ExtendSection"
    assert nodes[1]["extend_s"] == 45.0
    assert nodes[1]["extend_from_s"] == 60.0

    cov = build_edit_recipe(clip_id="clip-1", action="cover", instruction="acoustic jazz", cover_strength=0.8)
    assert cov["recipe"]["nodes"][1]["type"] == "CoverSong"
    assert cov["recipe"]["nodes"][1]["strength"] == 0.8

    rep = build_edit_recipe(clip_id="clip-1", action="replace", replace_start_s=20, replace_end_s=35)
    assert rep["recipe"]["nodes"][1]["type"] == "ReplaceSection"
    assert rep["recipe"]["nodes"][1]["masks"] == [{"start_s": 20.0, "end_s": 35.0}]

    trim = build_effect_graph(clip_id="clip-1", effect="trim", start_s=5, end_s=55)
    assert trim[1] == {"type": "Trim", "start_s": 5.0, "end_s": 55.0}

    tempo = build_effect_graph(clip_id="clip-1", effect="tempo", speed=1.15, semitones=2)
    assert tempo[1] == {"type": "TempoShift", "speed": 1.15, "semitones": 2}


def test_sse_parser_extracts_dual_ab_clips():
    sse = [
        "event: conversation_id",
        'data: {"id": "conv-123"}',
        "",
        "event: message",
        'data: {"parts": [{"part_kind": "tool-return", "tool_name": "audio__create_song", "content": {"clip_id": "clip-a", "operation_id": "op-a", "clip_id_b": "clip-b", "operation_id_b": "op-b", "title": "Neon Night"}}]}',
        "",
        "event: complete",
        'data: {"ok": true}',
        "",
    ]
    events = parse_sse_lines(sse)
    outcome = extract_job_outcome("job-1", events)
    assert outcome.conversation_id == "conv-123"
    assert outcome.completed is True
    assert len(outcome.clip_refs) == 2
    assert outcome.clip_refs[0]["clip_id"] == "clip-a"
    assert outcome.clip_refs[1]["clip_id"] == "clip-b"


def test_token_borrowing_never_keeps_refresh_token():
    fm = FlowMusicClient()
    fake_ws = object()
    flow_client.set_music_extension(fake_ws)
    try:
        rpc_mock = AsyncMock(
            return_value={
                "ok": True,
                "access_token": "jwt-short-lived",
                "refresh_token": "MUST_NEVER_BE_STORED",
                "expires_at": int(time.time()) + 3600,
                "email": "creator@example.com",
            }
        )
        with patch.object(flow_client, "music_rpc", rpc_mock):
            tok = asyncio.run(fm.get_access_token())
            assert tok == "jwt-short-lived"
            cached = fm._token_cache[fm._active_cache_key()]
            assert "refresh_token" not in cached
            assert cached["access_token"] == "jwt-short-lived"
    finally:
        flow_client.clear_music_extension()


def test_upload_audio_route_and_huabu_audio_roundtrip(client):
    res = client.post(
        "/api/upload-audio",
        files={"file": ("theme.wav", _SAMPLE_WAV, "audio/wav")},
    )
    assert res.status_code == 200, res.text
    payload = res.json()
    audio_mid = payload["media_id"]
    assert payload["mime"] == "audio/wav"

    # Media endpoint serves the cached WAV back
    served = client.get(f"/media/{audio_mid}")
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("audio/wav")

    # Create board + audio node + export/import .huabu
    board_res = client.post("/api/boards", json={"name": "音频配乐画布"})
    assert board_res.status_code == 200
    bid = board_res.json()["id"]

    cover_mid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    media_service.ingest_inline_bytes(cover_mid, _SAMPLE_PNG, kind="image", mime="image/png")

    node_res = client.post(
        "/api/nodes",
        json={
            "board_id": bid,
            "type": "audio",
            "x": 100,
            "y": 120,
            "data": {
                "title": "片尾主题曲",
                "prompt": "cinematic strings",
                "mediaId": audio_mid,
                "mediaIds": [audio_mid],
                "musicTitle": "片尾主题曲",
                "musicModel": "Lyria 3.5",
                "musicBpm": 96,
                "musicDurationSec": 90,
                "musicInstrumental": True,
                "musicCoverMediaId": cover_mid,
                "musicClipId": "private-clip-should-be-stripped",
            },
            "status": "done",
        },
    )
    assert node_res.status_code == 200, node_res.text

    exp = client.get(f"/api/boards/{bid}/export.huabu?include_media=true")
    assert exp.status_code == 200

    imp = client.post(
        "/api/boards/import-huabu",
        files={"file": ("music.huabu", exp.content, "application/zip")},
    )
    assert imp.status_code == 200, imp.text
    new_bid = imp.json()["board"]["id"]
    loaded = client.get(f"/api/boards/{new_bid}").json()
    audio_nodes = [n for n in loaded["nodes"] if n["type"] == "audio"]
    assert len(audio_nodes) == 1
    d = audio_nodes[0]["data"]
    assert d["mediaId"] == audio_mid
    assert d["musicCoverMediaId"] == cover_mid
    assert d["musicBpm"] == 96
    # Private account-bound clip IDs are stripped from portable .huabu recipes
    assert "musicClipId" not in d


def test_music_handlers_and_settlement_preserve_stems(client):
    fake_client = FlowMusicClient()
    fake_client.create_song = AsyncMock(
        return_value={
            "conversation_id": "conv-9",
            "model": "Lyria 3.5",
            "sound_prompt": "ambient neon piano, 88 bpm",
            "clips": [
                {
                    "id": "clip-a1",
                    "title": "霓虹雨夜",
                    "duration": 92.5,
                    "lyrics": "[Instrumental]",
                    "audio_url": "https://storage.googleapis.com/producer-app-public/clips/clip-a1.m4a",
                    "image_url": "https://storage.googleapis.com/producer-app-public/assets/c1.jpg",
                },
                {
                    "id": "clip-b2",
                    "title": "霓虹雨夜",
                    "duration": 91.0,
                    "lyrics": "[Instrumental]",
                    "audio_url": "https://storage.googleapis.com/producer-app-public/clips/clip-b2.m4a",
                },
            ],
        }
    )
    fake_client.download_clip_bytes = AsyncMock(return_value=(_SAMPLE_WAV, "audio/wav"))
    fake_client.download_binary_url = AsyncMock(return_value=(_SAMPLE_PNG, "image/png"))
    fake_client.split_stems = AsyncMock(
        return_value={
            "vocals": {"bytes": _SAMPLE_WAV, "mime": "audio/wav"},
            "drums": {"bytes": _SAMPLE_WAV, "mime": "audio/wav"},
            "bass": {"bytes": _SAMPLE_WAV, "mime": "audio/wav"},
            "other": {"bytes": _SAMPLE_WAV, "mime": "audio/wav"},
        }
    )
    fake_client.sync_credits = AsyncMock(return_value={"credits": 9995, "plan": "pro"})

    with patch("flowboard.worker.music_handlers.get_flowmusic_client", return_value=fake_client):
        result, err = asyncio.run(
            _handle_gen_music(
                {
                    "prompt": "ambient neon piano",
                    "instrumental": True,
                    "bpm": 88,
                    "duration_s": 90,
                    "music_model": "Lyria 3.5",
                }
            )
        )
        assert err is None
        assert len(result["media_ids"]) == 2
        assert result["clip_id"] == "clip-a1"
        assert result["cover_media_id"] is not None

        req = Request(type="gen_music", params={"prompt": "ambient neon piano"})
        patch_data = _node_completion_patch(req, result, existing_data={})
        assert patch_data["mediaId"] == result["media_ids"][0]
        assert patch_data["musicClipId"] == "clip-a1"
        assert patch_data["musicCoverMediaId"] == result["cover_media_id"]
        assert patch_data["musicTitle"] == "霓虹雨夜"
        assert patch_data["musicInstrumental"] is True

        # Now run 0-credit 4-stem separation and ensure settlement preserves primary mediaId
        stem_res, stem_err = asyncio.run(
            _handle_split_stems(
                {"clip_id": "clip-a1", "media_id": result["media_ids"][0]}
            )
        )
        assert stem_err is None
        assert set(stem_res["stems"].keys()) == {"vocals", "drums", "bass", "other"}

        stem_req = Request(type="split_stems", params={"clip_id": "clip-a1"})
        stem_patch = _node_completion_patch(stem_req, stem_res, existing_data=patch_data)
        assert "mediaId" not in stem_patch
        assert set(stem_patch["musicStems"].keys()) == {"vocals", "drums", "bass", "other"}


def test_music_status_and_credits_persist_on_account(client):
    acct_id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
    with get_session() as s:
        s.add(FlowAccount(id=acct_id, label="主账号"))
        s.add(AppSetting(key=flow_accounts.ACTIVE_KEY, value=acct_id))
        s.commit()

    flow_accounts.record_account_music_credits(acct_id, 10000, "pro")

    accts = client.get("/api/flow-accounts").json()
    row = next(a for a in accts["accounts"] if a["id"] == acct_id)
    assert row["music_credits"] == 10000
    assert row["music_plan"] == "pro"
    assert row["music_tab_open"] is False

    st = client.get("/api/music/status").json()
    assert st["music_credits"] == 10000
    assert st["music_plan"] == "pro"


def test_reference_library_accepts_audio_kind(client):
    res = client.post(
        "/api/references",
        json={
            "media_id": "99999999-8888-7777-6666-555555555555",
            "kind": "audio",
            "label": "赛博雨夜主题曲",
            "ai_brief": "92 BPM synthwave instrumental",
        },
    )
    assert res.status_code == 200
    assert res.json()["kind"] == "audio"
