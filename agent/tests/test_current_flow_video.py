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
