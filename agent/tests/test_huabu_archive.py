"""Tests for portable .huabu workflow archive export/import, recipes, and media sync fallback."""
from __future__ import annotations

import asyncio
import io
import json
import zipfile
from unittest.mock import AsyncMock, patch

from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import (
    Asset,
    Board,
    BoardFlowProject,
    ChatMessage,
    Edge,
    Node,
)
from flowboard.services import media as media_service
from flowboard.worker import processor

_SAMPLE_PNG = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4"
    b"\x00\x00\x00\rIDATx\x9cc```\xf8\x0f\x00\x01\x04\x01\x00\x9b\xa7\xd0\xb4"
    b"\x00\x00\x00\x00IEND\xaeB`\x82"
)


def test_huabu_roundtrip_export_import_strips_secrets(client):
    media_id = "11111111-2222-3333-4444-555555555555"
    media_service.ingest_inline_bytes(media_id, _SAMPLE_PNG, kind="image", mime="image/png")

    with get_session() as s:
        board = Board(name="分镜测试画布·中文标题")
        s.add(board)
        s.commit()
        s.refresh(board)
        assert board.id is not None

        s.add(BoardFlowProject(board_id=board.id, flow_project_id="secret-flow-proj-999"))
        s.add(ChatMessage(board_id=board.id, role="user", content="private prompt chat", mentions=[]))

        n1 = Node(
            board_id=board.id,
            short_id="a1b2",
            type="character",
            x=100,
            y=120,
            w=240,
            h=180,
            status="done",
            data={
                "title": "主角三视图",
                "prompt": "赛璐璐动漫角色设定",
                "mediaId": media_id,
                "mediaIds": [media_id],
                "flow_project_id": "secret-project",
                "flow_account_id": "secret-account",
                "apiKey": "sk-secret-key",
                "thumbnailUrl": "https://flow-content.google/signed?token=secret",
            },
        )
        n2 = Node(
            board_id=board.id,
            short_id="c3d4",
            type="video",
            x=440,
            y=120,
            w=240,
            h=180,
            status="running",
            data={
                "title": "镜头一",
                "prompt": "角色缓缓转身微笑",
                "videoQuality": "omni",
                "omniVersion": "1.2",
                "durationSeconds": 6,
            },
        )
        s.add(n1)
        s.add(n2)
        s.flush()
        assert n1.id is not None and n2.id is not None

        s.add(Edge(board_id=board.id, source_id=n1.id, target_id=n2.id, kind="ref", source_variant_idx=0))
        s.commit()
        src_board_id = board.id

    res = client.get(f"/api/boards/{src_board_id}/export.huabu?include_media=true")
    assert res.status_code == 200
    assert "filename*=UTF-8''" in res.headers["content-disposition"]

    zf = zipfile.ZipFile(io.BytesIO(res.content), "r")
    names = zf.namelist()
    assert "manifest.json" in names
    assert f"media/{media_id}.png" in names

    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    assert manifest["format"] == "ai-canvas-studio.huabu"
    assert manifest["board"]["name"] == "分镜测试画布·中文标题"
    assert len(manifest["nodes"]) == 2
    assert len(manifest["edges"]) == 1
    assert manifest["edges"][0]["source_variant_idx"] == 0

    exported_n1 = next(n for n in manifest["nodes"] if n["type"] == "character")
    for secret_key in ("flow_project_id", "flow_account_id", "apiKey", "thumbnailUrl"):
        assert secret_key not in exported_n1["data"]
    assert exported_n1["data"]["mediaId"] == media_id
    assert "secret-flow-proj-999" not in json.dumps(manifest, ensure_ascii=False)
    assert "private prompt chat" not in json.dumps(manifest, ensure_ascii=False)

    exported_n2 = next(n for n in manifest["nodes"] if n["type"] == "video")
    assert exported_n2["status"] == "idle"

    # Remove local cached media to verify import restores it
    cached = media_service.cached_path(media_id)
    assert cached is not None
    cached.unlink()
    with get_session() as s:
        for row in s.exec(select(Asset).where(Asset.uuid_media_id == media_id)).all():
            s.delete(row)
        s.commit()

    imp = client.post(
        "/api/boards/import-huabu",
        files={"file": ("test.huabu", res.content, "application/octet-stream")},
    )
    assert imp.status_code == 200
    body = imp.json()
    assert body["nodes_count"] == 2
    assert body["edges_count"] == 1
    assert body["media_count"] == 1
    imported_board_id = body["board"]["id"]
    assert imported_board_id != src_board_id
    assert media_service.cached_path(media_id) is not None

    detail = client.get(f"/api/boards/{imported_board_id}").json()
    assert len(detail["nodes"]) == 2
    assert len(detail["edges"]) == 1
    assert detail["edges"][0]["source_variant_idx"] == 0


def test_huabu_export_without_media_strips_media_ids(client):
    media_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    media_service.ingest_inline_bytes(media_id, _SAMPLE_PNG, kind="image", mime="image/png")

    with get_session() as s:
        board = Board(name="Pure Params")
        s.add(board)
        s.flush()
        assert board.id is not None
        s.add(
            Node(
                board_id=board.id,
                short_id="p1p1",
                type="image",
                status="done",
                data={"title": "主视觉", "prompt": "cyberpunk city", "mediaId": media_id, "mediaIds": [media_id]},
            )
        )
        s.commit()
        bid = board.id

    res = client.get(f"/api/boards/{bid}/export.huabu?include_media=false")
    assert res.status_code == 200
    manifest = json.loads(zipfile.ZipFile(io.BytesIO(res.content)).read("manifest.json"))
    assert manifest["media"] == []
    assert "mediaId" not in manifest["nodes"][0]["data"]
    assert "mediaIds" not in manifest["nodes"][0]["data"]
    assert manifest["nodes"][0]["status"] == "idle"


def test_huabu_import_rejects_corrupt_or_path_traversal(client):
    bad = client.post(
        "/api/boards/import-huabu",
        files={"file": ("bad.huabu", b"not-a-zip", "application/octet-stream")},
    )
    assert bad.status_code == 400

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("../../evil.txt", "boom")
        zf.writestr("manifest.json", json.dumps({"format": "ai-canvas-studio.huabu", "nodes": []}))
    traversal = client.post(
        "/api/boards/import-huabu",
        files={"file": ("evil.huabu", buf.getvalue(), "application/octet-stream")},
    )
    assert traversal.status_code == 400


def test_import_recipe_reuses_empty_board_and_creates_when_nonempty(client):
    empty_board = client.post("/api/boards", json={"name": "未命名项目"}).json()
    payload = {
        "name": "番剧角色锁脸示例",
        "target_board_id": empty_board["id"],
        "nodes": [
            {"key": "subj", "type": "character", "x": 80, "y": 100, "data": {"title": "主角设定", "prompt": "三视图"}},
            {"key": "vid", "type": "video", "x": 420, "y": 100, "data": {"title": "镜头一", "prompt": "转身"}},
        ],
        "edges": [{"source_key": "subj", "target_key": "vid"}],
    }
    r1 = client.post("/api/boards/import-recipe", json=payload)
    assert r1.status_code == 200
    assert r1.json()["board"]["id"] == empty_board["id"]
    assert r1.json()["board"]["name"] == "番剧角色锁脸示例"
    assert r1.json()["nodes_count"] == 2
    assert r1.json()["edges_count"] == 1

    # Calling again against now non-empty target_board_id creates a fresh board
    r2 = client.post("/api/boards/import-recipe", json=payload)
    assert r2.status_code == 200
    assert r2.json()["board"]["id"] != empty_board["id"]


def test_gen_image_cross_project_sync_fallback():
    foreign_mid = "99999999-8888-7777-6666-555555555555"
    synced_mid = "12121212-3434-5656-7878-909090909090"
    media_service.ingest_inline_bytes(foreign_mid, _SAMPLE_PNG, kind="image", mime="image/png")

    calls = []

    async def fake_gen_image(**kwargs):
        calls.append(kwargs.get("ref_media_ids"))
        if len(calls) == 1:
            return {"error": "RpcError: eb1hJf failed: [5] Requested entity was not found"}
        return {"media_entries": [{"media_id": "new-out-id", "url": "https://flow-content.google/out.png"}]}

    fake_sdk = type("FakeSdk", (), {"gen_image": staticmethod(fake_gen_image)})()

    with (
        patch.object(processor, "get_flow_sdk", return_value=fake_sdk),
        patch(
            "flowboard.services.media_project_sync.ensure_media_ids_in_project",
            new=AsyncMock(return_value=([synced_mid], [])),
        ) as mock_sync,
    ):
        resp, err = asyncio.run(
            processor._handle_gen_image(
                {
                    "prompt": "test ref",
                    "project_id": "11111111-1111-1111-1111-111111111111",
                    "ref_media_ids": [foreign_mid],
                    "paygate_tier": "PAYGATE_TIER_ONE",
                }
            )
        )

    assert err is None
    assert mock_sync.await_count == 1
    assert calls == [[foreign_mid], [synced_mid]]
    assert resp["media_entries"][0]["media_id"] == "new-out-id"
