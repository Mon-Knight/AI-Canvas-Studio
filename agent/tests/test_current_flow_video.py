"""Billing policy at the local queue boundary; never contact a real provider."""
import pytest
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import AppSetting, Board, FlowAccount, Node, Request
from flowboard.services import flow_accounts
from flowboard.services.flow_client import flow_client
from flowboard.worker.processor import WorkerController


@pytest.mark.parametrize("kind", ["gen_video", "gen_video_omni"])
def test_legacy_and_external_payers_never_fall_back(client, kind):
    base = {"type": kind, "params": {"project_id": "abcd1234"}}
    assert client.post("/api/requests", json=base).status_code == 409
    assert client.post("/api/requests", json=base, headers={"Origin": "https://example.invalid"}).status_code == 403
    for old in ("google_video", "muse", "unknown"):
        assert client.post("/api/requests", json={**base, "params": {"media_provider": old}}).status_code == 422
    assert client.get("/api/requests/providers/google-video").status_code == 404
    assert client.put("/api/requests/providers/google-video/key", json={"api_key": "sentinel"}).status_code == 404
    with get_session() as s:
        assert not s.exec(select(Request)).all()


@pytest.mark.asyncio
async def test_only_confirmed_account_and_project_can_be_charged(client, selected_video_account, monkeypatch):
    with get_session() as s:
        board = Board(name="t")
        s.add(board)
        s.commit()
        node = Node(type="video", board_id=board.id, short_id="v1")
        s.add(node)
        account = s.get(FlowAccount, selected_video_account)
        account.credits = 9
        s.add(account)
        s.commit()
        nid = node.id
    body = {"type": "gen_video", "node_id": nid, "flow_account_id": selected_video_account,
            "params": {"project_id": "abcd1234", "prompt": "pan", "start_media_id": "test",
                       "paygate_tier": "PAYGATE_TIER_TWO"}}
    post = lambda data: client.post("/api/requests", json=data)
    assert post({**body, "flow_account_id": "other"}).status_code == 409
    assert post({**body, "params": {**body["params"], "project_id": "old"}}).status_code == 409
    assert post({**body, "params": {**body["params"], "api_key": "no"}}).status_code == 422
    with monkeypatch.context() as mp:
        mp.setattr(flow_client, "_ws", None)
        assert post(body).status_code == 409
    from flowboard.services import ws_server
    with monkeypatch.context() as mp:
        mp.setitem(ws_server._connections, flow_client.extension_socket,
                   ws_server.Connection(profile_id="other", flow_tab_open=True))
        assert post(body).status_code == 409
    with monkeypatch.context() as mp:
        mp.setitem(ws_server._connections, flow_client.extension_socket,
                   ws_server.Connection(profile_id=selected_video_account, flow_tab_open=False))
        assert post(body).status_code == 409
    with monkeypatch.context() as mp:
        mp.setattr("flowboard.services.flow_accounts.active_tier", lambda: (True, "invalid"))
        assert post(body).status_code == 409
    queued = post(body)
    assert queued.is_success, queued.text
    rid = queued.json()["id"]
    stamped = queued.json()["params"]
    assert stamped["paygate_tier"] == "PAYGATE_TIER_ONE"
    assert stamped["flow_account_id"] == selected_video_account and stamped["media_provider"] == "flow"
    with get_session() as s:
        assert s.get(Node, nid).status == "queued"
    assert post(body).status_code == 409  # no double submissions from two tabs
    assert client.post("/api/flow-accounts/legacy").status_code == 409
    # Simulate out-of-band state change prior to dequeue; never send the
    # former account's prompt to another account.
    with get_session() as s:
        row = s.get(AppSetting, flow_accounts.ACTIVE_KEY)
        row.value = "other"
        s.add(row)
        s.commit()
    calls = []
    async def stub(params):
        calls.append(params)
        return {"media_ids": ["wrong-user"]}, None
    await WorkerController(handlers={"gen_video": stub})._process_one(rid)
    assert calls == []
    failed = client.get(f"/api/requests/{rid}").json()
    assert failed["status"] == "failed" and "账号已变化" in failed["error"]
    with get_session() as s:
        assert s.get(FlowAccount, selected_video_account).credits == 9  # manual observation, not a ledger


def test_first_last_text_video_requests_and_history_patch(client, selected_video_account, monkeypatch):
    from flowboard.db.models import Board
    from flowboard.services import ws_server
    from flowboard.worker.processor import _node_completion_patch

    with get_session() as s:
        board = Board(name="t2")
        s.add(board)
        s.commit()
        node = Node(type="video", board_id=board.id, short_id="v2")
        s.add(node)
        s.commit()
        nid = node.id

    with monkeypatch.context() as mp:
        mp.setitem(
            ws_server._connections,
            flow_client.extension_socket,
            ws_server.Connection(profile_id=selected_video_account, flow_tab_open=True),
        )
        r_t2v = client.post(
            "/api/requests",
            json={
                "type": "gen_video_text",
                "node_id": nid,
                "flow_account_id": selected_video_account,
                "params": {"project_id": "abcd1234", "prompt": "日落海边慢镜头", "duration_s": 4},
            },
        )
        assert r_t2v.is_success, r_t2v.text

        with get_session() as s:
            n = s.get(Node, nid)
            n.status = "done"
            s.add(n)
            for row in s.exec(select(Request).where(Request.node_id == nid)).all():
                row.status = "done"
                s.add(row)
            s.commit()

        r_fl = client.post(
            "/api/requests",
            json={
                "type": "gen_video_first_last",
                "node_id": nid,
                "flow_account_id": selected_video_account,
                "params": {
                    "project_id": "abcd1234",
                    "prompt": "平滑转场",
                    "start_media_id": "mid-start",
                    "end_media_id": "mid-end",
                    "duration_s": 8,
                },
            },
        )
        assert r_fl.is_success, r_fl.text

    req1 = Request(type="gen_image", params={"prompt": "第一版", "image_model": "NANO_BANANA_PRO"})
    p1 = _node_completion_patch(req1, {"media_ids": ["mid-v1"]}, existing_data={})
    assert p1["history"][0]["mediaId"] == "mid-v1"

    req2 = Request(type="gen_image", params={"prompt": "第二版", "image_model": "NANO_BANANA_PRO"})
    p2 = _node_completion_patch(
        req2,
        {"media_ids": ["mid-v2"]},
        existing_data={"mediaId": "mid-v1", "mediaIds": ["mid-v1"], "prompt": "第一版", "history": p1["history"]},
    )
    assert [h["mediaId"] for h in p2["history"]] == ["mid-v1", "mid-v2"]


def test_media_upscale_route_records_history(client, monkeypatch):
    from flowboard.db.models import Board

    old_mid = "11111111-1111-1111-1111-111111111111"
    up_mid = "22222222-2222-2222-2222-222222222222"
    with get_session() as s:
        b = Board(name="up")
        s.add(b)
        s.commit()
        n = Node(type="image", board_id=b.id, short_id="up1", status="done", data={"mediaId": old_mid, "prompt": "hi"})
        s.add(n)
        s.commit()
        nid = n.id

    class FakeSdk:
        async def upscale_image(self, media_id, project_id="", resolution="2K"):
            return {"media_id": up_mid, "encoded_image": "", "url": None, "resolution": resolution}

    monkeypatch.setattr("flowboard.routes.media.get_flow_sdk", lambda: FakeSdk())
    res = client.post(
        f"/api/media/{old_mid}/upscale",
        json={"kind": "image", "resolution": "2K", "project_id": "abcd1234", "node_id": nid},
    )
    assert res.is_success, res.text
    assert res.json()["media_id"] == up_mid
    with get_session() as s:
        updated = s.get(Node, nid)
        assert updated.data["mediaId"] == up_mid
        assert [h["mediaId"] for h in updated.data["history"]] == [old_mid, up_mid]
