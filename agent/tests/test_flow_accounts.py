import asyncio
import json
from pathlib import Path

import pytest
import websockets

from flowboard.db import get_session
from flowboard.db.models import Board, BoardFlowProject, Request
from flowboard.services import flow_accounts, ws_server
from flowboard.services.flow_sdk import resolve_paygate_tier

P1 = "1dfd992a-4149-4f97-9d68-a1ede77d3fc3"
P2 = "3f9fe27f-e91e-4527-8815-a397ecec2a66"


def test_profile_settings_credits_and_switch(client, monkeypatch):
    client.headers["Host"] = "127.0.0.1:8434"
    opened = []
    monkeypatch.setattr(flow_accounts, "launch", lambda profile: opened.append(profile.id))
    with get_session() as session:
        board = Board(name="legacy")
        session.add(board)
        session.commit()
        board_id = board.id
        session.add(BoardFlowProject(board_id=board_id, flow_project_id=P2))
        session.commit()

    def account(name, field):
        response = client.post("/api/flow-accounts", json={"label": name, "project_id": field})
        assert response.status_code == 201, response.text
        body = response.json()
        row = next(row for row in body["accounts"] if row["id"] == body["created_account_id"])
        assert row["label"] == name
        return row

    a = account("工作", f"https://flow.google.com/project/{P1}")
    b = account("个人", None)
    a_url = f'/api/flow-accounts/{a["id"]}'
    b_url = f'/api/flow-accounts/{b["id"]}'
    assert a["project_id"] == P1 and a["credits"] is None
    assert b["credits"] is None
    assert client.patch(a_url, json={"credits": -1}).status_code == 422
    assert client.post(a_url + "/pair").status_code == 409
    assert client.post(a_url + "/activate", headers={"Origin": "https://example.test"}).status_code == 403
    assert client.post(a_url + "/activate").json()["active_account_id"] == a["id"]
    response = client.patch(a_url, json={"credits": 0, "paygate_tier": "PAYGATE_TIER_TWO"})
    row = next(row for row in response.json()["accounts"] if row["id"] == a["id"])
    assert row["credits"] == 0 and row["credits_updated_at"].endswith("+00:00")
    assert resolve_paygate_tier("PAYGATE_TIER_ONE") == "PAYGATE_TIER_TWO"
    board_url = f"/api/boards/{board_id}/project"
    assert client.post(board_url).json() == {"flow_project_id": P1, "created": False, "flow_account_id": a["id"]}
    rejected = client.post('/api/requests', json={"type": "gen_image", "params": {"project_id": P1}, "flow_account_id": b["id"]})
    assert rejected.status_code == 409
    rejected_upload = client.post('/api/upload', data={"project_id": P1, "flow_account_id": b["id"]},
                                  files={"file": ("reference.png", b"test", "image/png")})
    assert rejected_upload.status_code == 409
    assert client.post('/api/requests', json={"type": "gen_image", "params": {"project_id": P1}}).status_code == 409
    with get_session() as session:
        req = Request(type="gen_image", params={}, status="running")
        session.add(req)
        session.commit()
        rid = req.id
    assert client.post(b_url + "/activate").status_code == 409
    assert client.patch(a_url, json={"project_id": P2}).status_code == 409
    with get_session() as session:
        req = session.get(Request, rid)
        req.status = "done"
        session.commit()
    assert client.post(b_url + "/activate").json()["active_account_id"] == b["id"]
    assert client.post(board_url).status_code == 409
    assert opened == [a["id"], b["id"]]
    assert client.post("/api/flow-accounts/legacy").json()["active_account_id"] is None
    assert client.get(board_url).json()["flow_project_id"] == P2


def test_each_create_response_identifies_the_new_account_even_with_shared_labels(client):
    client.headers["Host"] = "127.0.0.1:8434"
    first = client.post("/api/flow-accounts", json={"label": "Flow 账号 1"})
    second = client.post("/api/flow-accounts", json={"label": "Flow 账号 1"})
    assert first.status_code == second.status_code == 201
    first_id = first.json()["created_account_id"]
    second_id = second.json()["created_account_id"]
    assert first_id != second_id
    assert {row["id"] for row in second.json()["accounts"]} == {first_id, second_id}


def test_launch_uses_separate_chrome_directories(monkeypatch, tmp_path):
    from flowboard.db.models import FlowAccount

    calls = []
    monkeypatch.setattr(flow_accounts, "STORAGE_DIR", tmp_path)
    monkeypatch.setattr(flow_accounts, "_chrome", lambda: "chrome.exe")
    monkeypatch.setattr(flow_accounts.subprocess, "Popen", lambda args, **_: calls.append(args))
    flow_accounts.launch(FlowAccount(id="a" * 32, label="A", project_id=P1))
    flow_accounts.launch(FlowAccount(id="b" * 32, label="B"))
    assert calls[0] == ["chrome.exe", f"--user-data-dir={Path(tmp_path, 'flow-browser-profiles', 'a' * 32)}", f"https://flow.google.com/project/{P1}"]
    assert calls[0][1] != calls[1][1]
    assert calls[1][-1] == "https://flow.google.com/"


@pytest.mark.asyncio
async def test_two_live_websocket_profiles_route_only_active(monkeypatch):
    from flowboard.db.models import AppSetting, FlowAccount
    from flowboard.routes.flow_accounts import activate_account

    a, b = "a" * 32, "b" * 32
    with get_session() as session:
        session.add(FlowAccount(id=a, label="A", project_id=P1))
        session.add(FlowAccount(id=b, label="B", project_id=P2))
        session.add(AppSetting(key=flow_accounts.ACTIVE_KEY, value=a))
        session.commit()
    monkeypatch.setattr(flow_accounts, "launch", lambda _: None)
    monkeypatch.setattr(ws_server, "route_lock", asyncio.Lock())

    async def send(ws, **payload):
        await ws.send(json.dumps(payload))

    async def receive(ws, kind):
        data = json.loads(await asyncio.wait_for(ws.recv(), 2))
        assert data["type"] == kind
        return data

    async def pair(ws, account):
        await send(ws, type="profile_hello", profile_id=None)
        code = flow_accounts.issue_code(account)
        await send(ws, type="profile_pair", code=code)
        result = await receive(ws, "profile_paired")
        assert flow_accounts.redeem_code(code) is None
        assert flow_accounts.verify_profile(account, result["profile_token"]) == account
        await send(ws, type="profile_presence", flow_tab_open=True)
        secret = (await receive(ws, "callback_secret"))["secret"]
        return secret, result["profile_token"]

    async with websockets.serve(ws_server._handler, "127.0.0.1", 0) as server:
        uri = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        async with websockets.connect(uri) as first, websockets.connect(uri) as second:
            a_secret, _ = await pair(first, a)
            await activate_account(b)
            assert not ws_server.flow_client.connected
            b_secret, b_token = await pair(second, b)
            assert a_secret != b_secret
            await first.close()
            assert ws_server.flow_client.connected
            assert ws_server.profile_presence(b) == (True, True)
            pending = asyncio.create_task(ws_server.flow_client.batch_rpc("test-rpc", "[]"))
            frame = json.loads(await asyncio.wait_for(second.recv(), 2))
            assert frame["method"] == "batch_rpc"
            ws_server.flow_client.resolve_callback({"id": frame["id"], "result": {"data": "mock"}})
            assert (await asyncio.wait_for(pending, 2))["result"] == {"data": "mock"}
            await send(second, type="profile_presence", flow_tab_open=False)
            await send(second, type="ping")
            await receive(second, "pong")
            assert not ws_server.flow_client.connected
        async with websockets.connect(uri) as reconnect:
            await send(reconnect, type="profile_hello", profile_id=b, profile_token=b_token)
            await send(reconnect, type="profile_presence", flow_tab_open=True)
            assert (await receive(reconnect, "callback_secret"))["secret"] != b_secret


def test_embedded_browser_mode_and_skip_launch_avoid_external_chrome(client, monkeypatch):
    client.headers["Host"] = "127.0.0.1:8434"
    launched = []
    monkeypatch.setattr(flow_accounts.subprocess, "Popen", lambda args, **_: launched.append(args))
    monkeypatch.setattr(flow_accounts, "_chrome", lambda: None)

    created = client.post("/api/flow-accounts", json={"label": "内嵌桌面账号"}).json()
    acc_id = created["created_account_id"]

    # 1. Explicit skip_launch=true works even when Chrome is absent and FLOWBOARD_EMBEDDED_BROWSER is unset
    res = client.post(f"/api/flow-accounts/{acc_id}/activate?skip_launch=true")
    assert res.status_code == 200
    assert res.json()["active_account_id"] == acc_id
    assert res.json()["embedded_browser"] is False
    assert launched == []

    # 2. FLOWBOARD_EMBEDDED_BROWSER=1 skips external Chrome launch even without skip_launch query param
    monkeypatch.setenv("FLOWBOARD_EMBEDDED_BROWSER", "1")
    res2 = client.post(f"/api/flow-accounts/{acc_id}/activate")
    assert res2.status_code == 200
    assert res2.json()["embedded_browser"] is True
    assert res2.json()["accounts"][0]["paired"] is False
    assert launched == []


@pytest.mark.asyncio
async def test_paired_flag_and_presence_auto_binds_project(client, monkeypatch):
    from flowboard.db.models import FlowAccount

    client.headers["Host"] = "127.0.0.1:8434"
    monkeypatch.setattr(flow_accounts, "launch", lambda _: None)
    monkeypatch.setattr(ws_server, "route_lock", asyncio.Lock())

    created = client.post("/api/flow-accounts", json={"label": "Chrome托管账号"}).json()
    acc_id = created["created_account_id"]
    assert created["accounts"][0]["paired"] is False
    assert created["accounts"][0]["project_id"] is None

    assert client.post(f"/api/flow-accounts/{acc_id}/activate").status_code == 200
    pair_code = client.post(f"/api/flow-accounts/{acc_id}/pair").json()["code"]

    async with websockets.serve(ws_server._handler, "127.0.0.1", 0) as server:
        uri = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        async with websockets.connect(uri) as ws:
            await ws.send(json.dumps({"type": "profile_hello", "profile_id": None}))
            await ws.send(json.dumps({"type": "profile_pair", "code": pair_code}))
            paired_msg = json.loads(await asyncio.wait_for(ws.recv(), 2))
            assert paired_msg["type"] == "profile_paired"

            # Send presence with detected project_id -> auto-binds the unbound profile
            await ws.send(json.dumps({
                "type": "profile_presence",
                "flow_tab_open": True,
                "project_id": P1.upper(),
            }))
            secret_msg = json.loads(await asyncio.wait_for(ws.recv(), 2))
            assert secret_msg["type"] == "callback_secret"

            snap = client.get("/api/flow-accounts").json()
            row = next(item for item in snap["accounts"] if item["id"] == acc_id)
            assert row["paired"] is True
            assert row["connected"] is True
            assert row["flow_tab_open"] is True
            assert row["project_id"] == P1

            # Subsequent presence with another project_id must NOT overwrite existing binding
            await ws.send(json.dumps({
                "type": "profile_presence",
                "flow_tab_open": True,
                "project_id": P2,
            }))
            await ws.send(json.dumps({"type": "ping"}))
            assert json.loads(await asyncio.wait_for(ws.recv(), 2))["type"] == "pong"

    with get_session() as session:
        assert session.get(FlowAccount, acc_id).project_id == P1


@pytest.mark.asyncio
async def test_ws_profile_credits_and_sync_route(client, monkeypatch):
    from flowboard.db.models import FlowAccount

    client.headers["Host"] = "127.0.0.1:8434"
    monkeypatch.setattr(flow_accounts, "launch", lambda _: None)
    monkeypatch.setattr(ws_server, "route_lock", asyncio.Lock())

    created = client.post("/api/flow-accounts", json={"label": "自动积分账号"}).json()
    acc_id = created["created_account_id"]
    assert client.post(f"/api/flow-accounts/{acc_id}/activate").status_code == 200
    pair_code = client.post(f"/api/flow-accounts/{acc_id}/pair").json()["code"]

    async with websockets.serve(ws_server._handler, "127.0.0.1", 0) as server:
        uri = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
        async with websockets.connect(uri) as ws:
            await ws.send(json.dumps({"type": "profile_hello", "profile_id": None}))
            await ws.send(json.dumps({"type": "profile_pair", "code": pair_code}))
            paired_msg = json.loads(await asyncio.wait_for(ws.recv(), 2))
            assert paired_msg["type"] == "profile_paired"

            await ws.send(json.dumps({"type": "profile_presence", "flow_tab_open": True}))
            secret_msg = json.loads(await asyncio.wait_for(ws.recv(), 2))
            assert secret_msg["type"] == "callback_secret"

            await ws.send(json.dumps({
                "type": "profile_credits",
                "credits": 1880,
                "paygate_tier": "PAYGATE_TIER_TWO",
            }))
            await ws.send(json.dumps({"type": "ping"}))
            assert json.loads(await asyncio.wait_for(ws.recv(), 2))["type"] == "pong"

            snap = client.get("/api/flow-accounts").json()
            row = next(item for item in snap["accounts"] if item["id"] == acc_id)
            assert row["credits"] == 1880
            assert row["paygate_tier"] == "PAYGATE_TIER_TWO"

    async def fake_sync(force: bool = False):
        flow_accounts.record_account_credits(acc_id, 1850, "PAYGATE_TIER_TWO")
        return {"credits": 1850, "paygate_tier": "PAYGATE_TIER_TWO"}

    monkeypatch.setattr(flow_accounts, "sync_active_credits", fake_sync)
    res = client.post("/api/flow-accounts/sync-credits")
    assert res.status_code == 200
    row2 = next(item for item in res.json()["accounts"] if item["id"] == acc_id)
    assert row2["credits"] == 1850
    with get_session() as session:
        assert session.get(FlowAccount, acc_id).credits == 1850



