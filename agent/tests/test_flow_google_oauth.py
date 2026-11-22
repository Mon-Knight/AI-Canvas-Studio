"""Mocked official Google OAuth path; never uses a Google account or Flow session."""
import base64
import hashlib
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from flowboard.main import app
from flowboard.services import flow_google_oauth as google

ROOT = "/api/flow-accounts/google"


@pytest.fixture
def local(monkeypatch):
    monkeypatch.setenv("FLOWBOARD_GOOGLE_CLIENT_ID", "mock-client")
    monkeypatch.setenv("FLOWBOARD_GOOGLE_CLIENT_SECRET", "mock-secret")
    monkeypatch.setenv("FLOWBOARD_GOOGLE_REDIRECT_URI", google.DEFAULT_CALLBACK)
    monkeypatch.setattr(google, "_attempts", {})
    return TestClient(app, base_url="http://127.0.0.1:8434")


def start(local):
    response = local.post(f"{ROOT}/start", headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 200, response.text
    body = response.json()
    url = urlsplit(body["authorization_url"])
    params = {key: val[0] for key, val in parse_qs(url.query).items()}
    assert url.netloc == "accounts.google.com"
    assert params["redirect_uri"] == google.DEFAULT_CALLBACK
    assert params["scope"] == "openid email profile"
    assert params["code_challenge_method"] == "S256"
    assert body["attempt_id"] != params["state"] and "mock-secret" not in response.text
    return body["attempt_id"], params


def test_login_creates_labeled_account_preserves_settings_and_does_not_activate(local, monkeypatch):
    responses = {"code-a": ("google-sub-a", "creator@example.com", "创作者"),
                 "code-b": ("google-sub-b", "studio@example.com", "工作室"),
                 "code-a2": ("google-sub-a", "creator-new@example.com", "新名称")}
    received = []

    async def read(attempt, code):
        received.append(code)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(attempt.verifier.encode()).digest()).rstrip(b"=").decode()
        assert challenge == params["code_challenge"]
        return responses[code]

    monkeypatch.setattr(google, "read_identity", read)
    attempt, params = start(local)
    assert local.get(f"{ROOT}/status/{attempt}").json()["status"] == "pending"
    assert local.get(f"{ROOT}/callback", params={"state": "wrong", "code": "code-a"}, follow_redirects=False).status_code == 303
    assert not received
    callback = local.get(f"{ROOT}/callback", params={"state": params["state"], "code": "code-a"}, follow_redirects=False)
    assert callback.headers["location"] == f"{ROOT}/callback/done?result=success"
    assert callback.headers["referrer-policy"] == "no-referrer"
    saved = local.get(f"{ROOT}/status/{attempt}").json()
    assert saved["status"] == "success"
    account = saved["account_id"]
    data = local.get("/api/flow-accounts").json()
    assert data["active_account_id"] is None
    row = data["accounts"][0]
    assert row["label"] == "创作者" and row["google_email"] == "creator@example.com"
    assert row["project_id"] is None and row["credits"] is None and row["paygate_tier"] is None
    assert local.patch(f"/api/flow-accounts/{account}", json={"credits": 0, "label": "自定义"}).status_code == 200
    local.get(f"{ROOT}/callback", params={"state": params["state"], "code": "code-a"})
    assert received == ["code-a"]
    for code in ("code-a2", "code-b"):
        attempt, params = start(local)
        local.get(f"{ROOT}/callback", params={"state": params["state"], "code": code})
        assert local.get(f"{ROOT}/status/{attempt}").json()["status"] == "success"
    rows = {row["id"]: row for row in local.get("/api/flow-accounts").json()["accounts"]}
    assert len(rows) == 2 and rows[account]["credits"] == 0 and rows[account]["label"] == "自定义"
    assert rows[account]["google_email"] == "creator-new@example.com"


def test_cancel_expiry_config_and_remote_host(local, monkeypatch):
    assert local.post(f"{ROOT}/start", headers={"Origin": "https://example.org"}).status_code == 403
    assert local.get(f"{ROOT}/config", headers={"Host": "example.org"}).status_code == 403
    assert local.get("/api/flow-accounts", headers={"Host": "example.org"}).status_code == 403
    attempt, params = start(local)
    local.get(f"{ROOT}/callback", params={"state": params["state"], "error": "access_denied"})
    assert local.get(f"{ROOT}/status/{attempt}").json()["status"] == "error"
    google._attempts[attempt].expires = 0
    assert "过期" in local.get(f"{ROOT}/status/{attempt}").json()["detail"]
    monkeypatch.setenv("FLOWBOARD_GOOGLE_REDIRECT_URI", "https://example.org/callback")
    assert local.get(f"{ROOT}/config").json()["configured"] is False
    assert local.post(f"{ROOT}/start").status_code == 503


@pytest.mark.asyncio
async def test_userinfo_token_exchange_is_ephemeral(local, monkeypatch):
    _, params = start(local)
    attempt = google.claim(params["state"])
    accepted = True

    def respond(request):
        if str(request.url) == google.TOKEN_URL:
            form = parse_qs(request.content.decode())
            assert form["code_verifier"] == [attempt.verifier]
            assert form["redirect_uri"] == [google.DEFAULT_CALLBACK]
            return httpx.Response(200, json={"access_token": "mock-ephemeral-token"})
        assert str(request.url) == google.USERINFO_URL
        assert request.headers["Authorization"] == "Bearer mock-ephemeral-token"
        return httpx.Response(200, json={"sub": "identity", "email": "user@example.com", "email_verified": accepted})

    async_client = httpx.AsyncClient
    monkeypatch.setattr(google.httpx, "AsyncClient", lambda **kwargs: async_client(transport=httpx.MockTransport(respond), **kwargs))
    assert await google.read_identity(attempt, "code") == ("identity", "user@example.com", "user@example.com")
    assert "mock-ephemeral-token" not in repr(attempt)
    accepted = False
    with pytest.raises(ValueError, match="not verified"):
        await google.read_identity(attempt, "code")


def test_callback_query_is_removed_from_access_log():
    import logging

    from flowboard.main import _RedactOAuthCallbackQuery

    record = logging.LogRecord("uvicorn.access", logging.INFO, "", 1, '%s - "%s %s HTTP/%s" %d',
                               ("local", "GET", f"{ROOT}/callback?code=secret-code&state=secret-state", "1.1", 303), None)
    assert _RedactOAuthCallbackQuery().filter(record)
    assert "secret-code" not in record.getMessage()
    assert "secret-state" not in record.getMessage()
