"""Tests for Google Flow Music personal-credits channel integration."""
from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from flowboard.db import get_session
from flowboard.db.models import AppSetting, Board, FlowAccount, Node, Request
from flowboard.services import flow_accounts, media as media_service
from flowboard.services.flow_client import flow_client
from flowboard.services.flowmusic_client import (
    FlowMusicClient,
    FlowMusicError,
    _clean_and_validate_lyrics,
    _extract_credits_and_plan,
    _extract_email_or_username,
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
    assert nodes[0] == {"node_type": "Input", "clip_id": "clip-1", "input_ids": [], "output_ids": ["input"]}
    assert nodes[1]["node_type"] == "ExtendSection"
    assert nodes[1]["input_ids"] == ["input"]
    assert nodes[1]["output_ids"] == ["processing"]
    assert nodes[1]["extend_s"] == 45.0
    assert nodes[1]["extend_from_s"] == 60.0
    assert nodes[2]["node_type"] == "Output"
    assert nodes[2]["input_ids"] == ["processing"]
    assert nodes[2]["output_ids"] == ["output"]

    cov = build_edit_recipe(
        clip_id="clip-1",
        action="cover",
        instruction="• 舒缓城市流行\u200c\n• 温暖钢琴",
        cover_strength=0.8,
    )
    assert cov["recipe"]["nodes"][1]["node_type"] == "CoverSong"
    assert cov["recipe"]["nodes"][1]["strength"] == 0.8
    assert "\u200c" not in cov["recipe"]["nodes"][1]["instruction"]
    assert "•" not in cov["recipe"]["nodes"][1]["instruction"]

    rep = build_edit_recipe(clip_id="clip-1", action="replace", replace_start_s=20, replace_end_s=35)
    assert rep["recipe"]["nodes"][1]["node_type"] == "ReplaceSection"
    assert rep["recipe"]["nodes"][1]["masks"] == [{"start_s": 20.0, "end_s": 35.0}]

    trim = build_effect_graph(clip_id="clip-1", effect="trim", start_s=5, end_s=55)
    assert trim[0] == {"node_type": "Input", "node_id": "input", "track_id": "clip-1"}
    assert trim[1] == {"node_type": "Trim", "node_id": "trim", "input_ids": ["input"], "start_s": 5.0, "end_s": 55.0}
    assert trim[2] == {"node_type": "Output", "input_ids": ["trim"]}

    tempo = build_effect_graph(clip_id="clip-1", effect="tempo", speed=1.15, semitones=2)
    assert tempo[1] == {"node_type": "TempoShift", "node_id": "fx", "input_ids": ["input"], "speed": 1.15, "semitones": 2}
    assert tempo[2] == {"node_type": "Output", "input_ids": ["fx"]}


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


def test_extract_credits_and_plan_real_flowmusic_payload():
    credits_payload = {
        "data": {
            "credits_remaining": 150.0,
            "tokens_remaining": 150.0,
        },
        "add_token_transactions": [],
    }
    sub_payload = {
        "data": {
            "subscription_tier": "MEMBER",
            "status": "active",
        }
    }
    credits, plan = _extract_credits_and_plan(credits_payload, sub_payload)
    assert credits == 150
    assert plan == "MEMBER"

    # Tokens-only fallback and string number coercion
    credits2, plan2 = _extract_credits_and_plan({"data": {"tokens_remaining": "85"}}, None)
    assert credits2 == 85
    assert plan2 is None

    # Nested /users/me identity fallback (email preferred, username fallback)
    assert _extract_email_or_username({"data": {"email": "v@example.com", "username": "ValleyNexus4"}}) == "v@example.com"
    assert _extract_email_or_username({"data": {"username": "ValleyNexus4"}}) == "ValleyNexus4"


def test_get_status_probes_without_music_tab_and_auto_syncs_credits(client):
    fm = FlowMusicClient()
    fake_ws = object()
    flow_client.set_music_extension(fake_ws)
    try:
        rpc_mock = AsyncMock(
            return_value={
                "ok": True,
                "access_token": "jwt-live-token-for-status-test",
                "expires_at": int(time.time()) + 3600,
                "email": "valley@example.com",
            }
        )

        async def fake_request_json(method, path, **kwargs):
            if path == "/billing/credits":
                return {"data": {"credits_remaining": 145, "tokens_remaining": 145}}
            if path == "/billing/subscription":
                return {"data": {"subscription_tier": "MEMBER"}}
            if path == "/models":
                return {"models": [{"name": "Lyria 3.5", "display_name": "Lyria 3.5"}]}
            if path == "/users/me":
                return {"data": {"username": "ValleyNexus4"}}
            return {}

        with patch.object(flow_client, "music_rpc", rpc_mock), patch.object(
            fm, "request_json", side_effect=fake_request_json
        ):
            st = asyncio.run(fm.get_status(refresh_remote=False))
            assert st["extension_connected"] is True
            assert st["music_tab_open"] is False
            assert st["signed_in"] is True
            assert st["music_credits"] == 145
            assert st["music_plan"] == "MEMBER"
            assert st["email"] == "ValleyNexus4"
            # Passive status poll must NOT force-reload the user's open Flow Music tab
            rpc_mock.assert_awaited_once_with(
                "flowmusic_get_token",
                {"refreshIfExpired": False},
                timeout=30.0,
            )
    finally:
        flow_client.clear_music_extension()


def test_request_json_auto_falls_back_to_extension_fetch_on_network_error_or_403():
    fm = FlowMusicClient()
    fake_ws = object()
    flow_client.set_music_extension(fake_ws)
    try:
        fm._token_cache[fm._active_cache_key()] = {
            "access_token": "jwt-cached-valid-token",
            "expires_at": int(time.time()) + 3600,
            "email": "user@example.com",
        }
        proxy_reply = {
            "status": 200,
            "data": {"data": {"credits_remaining": 200}},
        }
        rpc_mock = AsyncMock(return_value=proxy_reply)

        # Case 1: direct httpx raises ConnectError (e.g., Chrome-only proxy on Windows)
        with patch.object(
            fm, "_httpx_request", side_effect=httpx.ConnectError("direct network blocked")
        ), patch.object(flow_client, "music_rpc", rpc_mock):
            out = asyncio.run(fm.request_json("GET", "/billing/credits", timeout=15.0))
            assert out == {"data": {"credits_remaining": 200}}
            rpc_mock.assert_awaited_once()
            assert rpc_mock.await_args.args[0] == "flowmusic_fetch"

        # Case 2: direct httpx returns HTTP 403 Cloudflare block
        rpc_mock.reset_mock()
        fake_403 = httpx.Response(403, text="Just a moment... Cloudflare")
        with patch.object(
            fm, "_httpx_request", AsyncMock(return_value=fake_403)
        ), patch.object(flow_client, "music_rpc", rpc_mock):
            out = asyncio.run(fm.request_json("GET", "/billing/credits", timeout=15.0))
            assert out == {"data": {"credits_remaining": 200}}
            rpc_mock.assert_awaited_once()
    finally:
        flow_client.clear_music_extension()


def test_get_access_token_actionable_diagnostics():
    fm = FlowMusicClient()
    fake_ws = object()
    flow_client.set_music_extension(fake_ws)
    try:
        with patch.object(flow_client, "music_rpc", AsyncMock(return_value={"error": "timeout"})):
            with pytest.raises(FlowMusicError) as exc_info:
                asyncio.run(fm.get_access_token())
            assert exc_info.value.code == "FLOWMUSIC_EXTENSION_OUTDATED"
            assert "chrome://extensions" in exc_info.value.message

        with patch.object(
            flow_client,
            "music_rpc",
            AsyncMock(
                return_value={
                    "error": "FLOWMUSIC_NOT_LOGGED_IN",
                    "diag": {"has_cookies_api": False, "ext_version": "0.1.6", "tab_count": 1, "cookie_names": []},
                }
            ),
        ):
            with pytest.raises(FlowMusicError) as exc_info:
                asyncio.run(fm.get_access_token())
            assert exc_info.value.code == "FLOWMUSIC_EXTENSION_PERMISSION"
            assert "chrome://extensions" in exc_info.value.message
    finally:
        flow_client.clear_music_extension()


def test_sse_outcome_parses_json_tool_return_and_strips_thinking_and_ui_hidden():
    sse = [
        "event: part",
        'data: {"index": 0, "status": "final", "part": {"part_kind": "thinking", "content": "Ci8KMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5"}}',
        "",
        "event: part",
        'data: {"index": 1, "status": "final", "part": {"part_kind": "tool-return", "tool_name": "lyrics__create", "content": "{\\"title\\": \\"雨夜微光\\", \\"lyrics\\": \\"[Verse 1]\\\\n霓虹洒在雨街\\\\n风吹过旧招牌\\\\n\\\\n[Chorus]\\\\n穿过黑夜奔向天亮\\"}"}}',
        "",
        "event: part",
        'data: {"index": 2, "status": "final", "part": {"part_kind": "text", "content": "<ui-hidden>internal</ui-hidden>已为您生成歌词"}}',
        "",
        "event: final",
        'data: {"ok": true}',
        "",
    ]
    outcome = extract_job_outcome("job-lyr-1", parse_sse_lines(sse))
    assert outcome.completed is True
    assert len(outcome.tool_returns) == 1
    assert isinstance(outcome.tool_returns[0]["content"], dict)
    assert outcome.tool_returns[0]["content"]["title"] == "雨夜微光"
    assert "Ci8KMjM" not in outcome.text
    assert "<ui-hidden>" not in outcome.text


def test_clean_and_validate_lyrics_rejects_gibberish_mojibake_and_signatures():
    # Base64 / thought_signature gibberish must be rejected
    assert _clean_and_validate_lyrics("Ci8KMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5\nhello", prefer_chinese=True) is None
    # UTF-8 -> Latin-1 mojibake must be rejected
    assert _clean_and_validate_lyrics("[Verse 1]\né\x9c\x93è\x99¹é\x9b¨å¤\x9c\nå\x85\x89å½±", prefer_chinese=True) is None
    # Raw technical JSON without lyrics must be rejected
    assert _clean_and_validate_lyrics('{"part_kind": "tool-call", "tool_call_id": "tc-1"}', prefer_chinese=True) is None
    # Non-Chinese output when Chinese prompt was given must be rejected
    assert _clean_and_validate_lyrics("[Verse 1]\nNeon lights in the rain\n[Chorus]\nRunning till dawn", prefer_chinese=True) is None

    # Valid structured Chinese lyrics pass cleanly
    zh = "[Verse 1]\n雨落霓虹倒映长街\n旧伞下藏着未完心愿\n\n[Chorus]\n穿过暗夜微光初现\n风起时再与你并肩"
    assert _clean_and_validate_lyrics(zh, prefer_chinese=True) == zh

    # Valid English lyrics pass when prefer_chinese=False
    en = "[Verse 1]\nNeon lights reflect across the rain\n\n[Chorus]\nRunning fast until the morning comes"
    assert _clean_and_validate_lyrics(en, prefer_chinese=False) == en


def test_compose_prompt_uses_real_run_llm_with_vision_and_chinese_fallback(client):
    from flowboard.services.llm import LLMError

    img_mid = "11112222-3333-4444-5555-666677778888"
    media_service.ingest_inline_bytes(img_mid, _SAMPLE_PNG, kind="image", mime="image/png")

    # 1. With configured LLM + cached reference image -> invokes run_llm with vision attachment & returns Chinese
    llm_reply = json.dumps(
        {
            "sound_prompt": "新中式仙侠电影纯音乐配乐，空灵竹笛与古筝泛音开场，中段融入柔和二胡与交响弦乐推进云海御剑高潮，宽广山水空间混响，纯音乐无主唱人声",
            "suggested_bpm": 86,
            "suggested_title": "青云剑影",
        },
        ensure_ascii=False,
    )
    mock_run = AsyncMock(return_value=llm_reply)
    with patch("flowboard.routes.music.run_llm", mock_run):
        res = client.post(
            "/api/music/compose-prompt",
            json={
                "context_texts": ["[画面] 古风白衣剑客立于云海竹林之巅"],
                "media_ids": [img_mid],
                "user_hint": "",
                "instrumental": True,
                "target_duration_s": 90,
            },
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["used_llm"] is True
        assert data["used_vision"] is True
        assert data["suggested_bpm"] == 86
        assert data["suggested_title"] == "青云剑影"
        assert "竹笛" in data["sound_prompt"]
        assert "Cinematic instrumental" not in data["sound_prompt"]
        assert mock_run.await_count == 1
        assert len(mock_run.await_args.kwargs.get("attachments") or []) == 1

    # 2. Without configured LLM -> falls back to scene-aware Simplified Chinese (never English boilerplate)
    with patch("flowboard.routes.music.run_llm", AsyncMock(side_effect=LLMError("not configured"))):
        res2 = client.post(
            "/api/music/compose-prompt",
            json={
                "context_texts": ["[画面] 赛博朋克霓虹雨夜高架桥追逐"],
                "user_hint": "",
                "instrumental": True,
            },
        )
        assert res2.status_code == 200
        d2 = res2.json()
        assert d2["used_llm"] is False
        assert "赛博" in d2["sound_prompt"]
        assert "Cinematic" not in d2["sound_prompt"]


def test_lyrics_route_prefers_llm_chinese_lyrics_and_rejects_gibberish_fallback(client):
    from flowboard.services.llm import LLMError

    # 1. Primary path: configured LLM writes clean structured Chinese lyrics
    llm_lyrics_json = json.dumps(
        {
            "title": "霓虹雨夜",
            "lyrics": "[Verse 1]\n雨滴敲打玻璃窗沿\n街角霓虹晕开思念\n\n[Chorus]\n穿过黑夜拥抱光年\n心跳在副歌里蔓延",
        },
        ensure_ascii=False,
    )
    with patch("flowboard.routes.music.run_llm", AsyncMock(return_value=llm_lyrics_json)):
        res = client.post(
            "/api/music/lyrics",
            json={
                "prompt": "赛博雨夜抒情流行女声",
                "context_texts": ["[画面] 雨夜霓虹街道独行女孩"],
                "target_duration_s": 90,
            },
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["source"] == "llm"
        assert body["title"] == "霓虹雨夜"
        assert "[Verse 1]" in body["lyrics"]
        assert "[Chorus]" in body["lyrics"]
        assert len(body["lyrics_id"]) == 36

    # 2. Fallback when LLM unavailable and Flow Music returns gibberish -> clean error (never leaks gibberish)
    fm = FlowMusicClient()
    fm.run_tool_call = AsyncMock(
        return_value=extract_job_outcome(
            "job-bad",
            parse_sse_lines(
                [
                    "event: part",
                    'data: {"index": 0, "status": "final", "part": {"part_kind": "text", "content": "Ci8KMjM0NTY3ODkwYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5\\ngarbage"}}',
                    "",
                ]
            ),
        )
    )
    with patch("flowboard.routes.music.run_llm", AsyncMock(side_effect=LLMError("no provider"))), patch(
        "flowboard.routes.music.get_flowmusic_client", return_value=fm
    ):
        res_bad = client.post("/api/music/lyrics", json={"prompt": "古风剑客江湖梦"})
        assert res_bad.status_code == 502
        assert "未返回有效歌词" in res_bad.json()["detail"]


def test_compose_prompt_and_lyrics_strip_object_replacement_and_bullets():
    dirty_prompt = "🎵 曲风：粤语说唱\ufffc\ufffc\n• 钢琴：温暖和声\n• 吉他：轻柔铺底"
    cleaned = compose_sound_prompt(dirty_prompt, 85)
    assert "\ufffc" not in cleaned
    assert "🎵" not in cleaned
    assert "•" not in cleaned
    assert "85 bpm" in cleaned

    lid, lmap = compose_lyrics_payload(lyrics="第一句\ufffc\n第二句\u200b", instrumental=False, duration_s=120)
    assert lid is not None
    assert "\ufffc" not in lmap[lid]
    assert "\u200b" not in lmap[lid]
    assert "[End - 2:00]" in lmap[lid]


def test_create_song_registers_lyrics_and_falls_back_to_conversation_on_streaming_error():
    fm = FlowMusicClient()
    fm.create_conversation = AsyncMock(return_value="conv-100")
    fm.register_lyrics = AsyncMock(return_value=("server-lyr-uuid", "conv-100"))
    fm.run_tool_call = AsyncMock(
        side_effect=FlowMusicError(
            "FLOWMUSIC_PRODUCER_ERROR",
            "Flow Music 服务端流式生成中断（Error while streaming parts）",
            retryable=True,
        )
    )
    conv_outcome = extract_job_outcome(
        "job-conv-1",
        parse_sse_lines(
            [
                "event: conversation_id",
                'data: {"id": "conv-200"}',
                "",
                "event: part",
                'data: {"index": 0, "status": "final", "part": {"part_kind": "tool-return", "tool_name": "audio__create_song", "content": {"clip_id": "clip-fallback-1", "operation_id": "op-1"}}}',
                "",
                "event: final",
                'data: {"ok": true}',
                "",
            ]
        ),
    )
    fm.run_conversation_song = AsyncMock(return_value=conv_outcome)
    fm.wait_for_clips = AsyncMock(return_value=[{"id": "clip-fallback-1", "audio_url": "https://example.com/a.m4a"}])

    out = asyncio.run(
        fm.create_song(
            sound_prompt="舒缓城市流行粤语说唱，钢琴与木吉他",
            lyrics="[Verse 1]\n雨落维港夜色温柔\n\n[Chorus]\n霓虹下与你慢慢走",
            instrumental=False,
            duration_s=120,
            model="Lyria 3.5",
        )
    )
    assert out["clips"][0]["id"] == "clip-fallback-1"
    fm.register_lyrics.assert_awaited_once()
    fm.run_tool_call.assert_awaited_once()
    fm.run_conversation_song.assert_awaited_once()

    # Moderation / copyright error from co-producer must surface FLOWMUSIC_BLOCKED clearly
    fm.run_conversation_song = AsyncMock(
        return_value=extract_job_outcome(
            "job-refused",
            parse_sse_lines(
                [
                    "event: part",
                    'data: {"index": 0, "status": "final", "part": {"part_kind": "text", "content": "Sorry, I cannot generate songs referencing real artists or copyrighted lyrics."}}',
                    "",
                ]
            ),
        )
    )
    with pytest.raises(FlowMusicError) as exc_info:
        asyncio.run(
            fm.create_song(
                sound_prompt="粤语说唱",
                lyrics="版权歌词测试",
                instrumental=False,
            )
        )
    assert exc_info.value.code == "FLOWMUSIC_BLOCKED"
    assert "版权" in exc_info.value.message



