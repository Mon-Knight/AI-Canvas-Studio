"""Wire the real HTTP routes, provider registry and chat run together, mock only upstream I/O."""
import json
from unittest.mock import patch

import httpx
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import Node, ChatRun
from flowboard.services.llm import registry


def test_analyze_direct_api_once_with_image_no_cli_tools_or_key_leak(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(tmp_path / "secrets.json"))
    key = "not-a-real-key"
    assert client.put("/api/llm/providers/openai_api", json={"apiKey": key}).json() == {"ok": True}
    pin = {"provider": "openai_api", "model": "test-model"}
    assert client.put("/api/llm/config", json={"chat_agent": pin}).is_success
    board_id = client.post("/api/boards", json={"name": "广告分镜"}).json()["id"]
    with get_session() as s:
        s.add(Node(board_id=board_id, short_id="ref1", type="image",
                   data={"aiBrief": "柔和侧光", "aspectRatio": "9:16"}))
        s.commit()
    buf = b"\x89PNG\r\n\x1a\n" + bytes(32)
    uploaded = client.post("/api/chat/attachments", data={"board_id": board_id},
                           files={"files": ("a.png", buf, "image/png")}).json()["assets"][0]["id"]
    calls = []
    # A tool-shaped answer is displayed as plain text, never executed in analysis mode.
    answer = '{"tool":"create_node","args":{"type":"video"}}'

    def upstream(request):
        calls.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": answer}}]})

    real_client = httpx.AsyncClient
    def stub(**kw):
        return real_client(transport=httpx.MockTransport(upstream), **kw)

    with (patch.object(httpx, "AsyncClient", side_effect=stub),
          patch.object(registry.get_provider("openai_api"), "_probe_cli", side_effect=AssertionError)):
        res = client.post("/api/chat", json={"board_id": board_id, "message": "分析这张图",
                                             "attachment_ids": [uploaded], "mentions": ["ref1"], "mode": "analyze"})
    assert res.is_success
    assert len(calls) == 1
    req = calls[0]
    assert str(req.url) == "https://api.openai.com/v1/chat/completions"
    assert req.headers["Authorization"] == "Bearer " + key
    body = json.loads(req.content)
    assert body["model"] == "test-model"
    content = body["messages"][-1]["content"]
    assert "分析这张图" in content[0]["text"] and "chat_uploads" not in content[0]["text"]
    assert "#ref1" in content[0]["text"] and "柔和侧光" in content[0]["text"] and "9:16" in content[0]["text"]
    assert content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "tools" not in body
    history = client.get(f"/api/boards/{board_id}/chat")
    assert history.json()[-1]["content"] == answer and key not in history.text
    with get_session() as s:
        assert [n.short_id for n in s.exec(select(Node).where(Node.board_id == board_id))] == ["ref1"]
        assert s.get(ChatRun, res.json()["run_id"]).status == "done"


def test_analysis_ignores_other_provider_pins_and_errors_do_not_echo_upstream(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(tmp_path / "secrets.json"))
    key = "private-test-value"
    client.put("/api/llm/providers/openai", json={"apiKey": key})
    assert client.put("/api/llm/config", json={"chat_agent": {"provider": "claude"},
                                               "planner": {"provider": "claude"}}).is_success
    assert client.put("/api/llm/config", json={"chat_agent": {"provider": None}}).is_success
    assert client.get("/api/llm/config").json()["chat_agent"]["provider"] is None
    board_id = client.post("/api/boards", json={"name": "test"}).json()["id"]
    real_client = httpx.AsyncClient
    def stub(**kw):
        return real_client(transport=httpx.MockTransport(lambda req: httpx.Response(
            401, json={"error": {"message": "bad key " + key}})), **kw)
    with (patch.object(httpx, "AsyncClient", side_effect=stub),
          patch("flowboard.services.chat_agent.run_llm", side_effect=AssertionError("unexpected CLI routing"))):
        res = client.post("/api/chat", json={"board_id": board_id, "mode": "analyze", "message": "test"})
    with get_session() as s:
        run = s.get(ChatRun, res.json()["run_id"])
        assert run.status == "failed"
        assert "401" in run.error and key not in run.error
    assert key not in client.get(f"/api/boards/{board_id}/chat").text


def test_analysis_with_no_key_does_not_fallback_to_creation_or_muse(client, tmp_path, monkeypatch):
    monkeypatch.setenv("FLOWBOARD_SECRETS_PATH", str(tmp_path / "empty.json"))
    board = client.post("/api/boards", json={"name": "analysis"}).json()["id"]
    with (patch("flowboard.services.chat_agent.run_llm", side_effect=AssertionError("unexpected fallback")),
          patch.object(httpx, "AsyncClient", side_effect=AssertionError("unexpected network"))):
        response = client.post("/api/chat", json={"board_id": board, "mode": "analyze", "message": "分析光线"})
    with get_session() as session:
        run = session.get(ChatRun, response.json()["run_id"])
        assert run.status == "failed" and "API Key" in run.error
        assert not session.exec(select(Node).where(Node.board_id == board)).all()


def test_other_board_upload_and_unknown_mode_rejected_before_scheduling(client):
    a, b = [client.post("/api/boards", json={"name": x}).json()["id"] for x in ("A", "B")]
    buf = b"\x89PNG\r\n\x1a\n" + bytes(32)
    aid = client.post("/api/chat/attachments", data={"board_id": a},
                      files={"files": ("a.png", buf, "image/png")}).json()["assets"][0]["id"]
    assert client.post("/api/chat", json={"board_id": b, "mode": "analyze",
                                           "message": "test", "attachment_ids": [aid]}).status_code == 400
    assert client.post("/api/chat", json={"board_id": b, "mode": "typo", "message": "test"}).status_code == 422


def test_nonlocal_origin_and_host_rejected_before_paid_calls_or_key_changes(client):
    bad = {"Origin": "https://example.invalid"}
    assert client.put("/api/llm/providers/openai_api", headers=bad, json={"apiKey": "x"}).status_code == 403
    assert client.post("/api/llm/providers/openai_api/test", headers=bad).status_code == 403
    assert client.post("/api/chat", headers=bad, json={"board_id": 1, "message": "test"}).status_code == 403
    for path in ("/api/prompt/auto", "/api/prompt/auto-batch", "/api/vision/describe", "/api/plans/1/run"):
        assert client.post(path, headers=bad, json={}).status_code == 403
    assert client.get("/api/llm/config", headers={"Host": "example.invalid"}).status_code == 403
    assert client.get("/api/llm/config", headers={"Origin": "http://localhost:5173"}).status_code == 200
