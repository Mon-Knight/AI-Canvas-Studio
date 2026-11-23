"""Security boundary tests for local_origin, CORS allowlist, and extension callback."""
from __future__ import annotations

from flowboard.services.flow_client import flow_client


def test_cross_origin_requests_blocked_across_all_ui_routes(client):
    evil = {"Origin": "https://evil.example"}
    checks = [
        ("GET", "/api/boards", None),
        ("POST", "/api/boards", {"name": "hack"}),
        ("PATCH", "/api/boards/1", {"name": "hack"}),
        ("DELETE", "/api/boards/1", None),
        ("POST", "/api/nodes", {"board_id": 1, "type": "note"}),
        ("PATCH", "/api/nodes/1", {"data": {}}),
        ("DELETE", "/api/nodes/1", None),
        ("POST", "/api/edges", {"board_id": 1, "source_id": 1, "target_id": 2}),
        ("DELETE", "/api/edges/1", None),
        ("POST", "/api/upload-url", {"url": "https://example.com/a.png"}),
        ("GET", "/api/auth/me", None),
        ("POST", "/api/auth/logout", None),
        ("POST", "/api/auth/scan", None),
        ("GET", "/api/flow/projects", None),
        ("PUT", "/api/flow/projects/pinned", {"project_id": "abcd"}),
        ("GET", "/api/references", None),
        ("POST", "/api/references", {"media_id": "a" * 32, "kind": "image"}),
        ("GET", "/api/activity", None),
        ("GET", "/api/provider-jobs", None),
        ("POST", "/api/provider-jobs", {"provider": "muse", "kind": "llm"}),
        ("GET", "/api/health", None),
    ]
    for method, path, payload in checks:
        resp = client.request(method, path, headers=evil, json=payload)
        assert resp.status_code == 403, f"{method} {path} returned {resp.status_code}"


def test_untrusted_local_port_and_dns_rebinding_blocked(client):
    assert client.get("/api/boards", headers={"Origin": "http://localhost:3000"}).status_code == 403
    assert client.get("/api/boards", headers={"Host": "rebind.evil.example"}).status_code == 403
    assert client.get("/api/boards", headers={"Origin": "http://127.0.0.1:5173"}).status_code == 200


def test_cross_site_fetch_without_origin_blocked_except_google_oauth_return(client):
    no_cors_get = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors"}
    assert client.get("/api/boards", headers=no_cors_get).status_code == 403
    assert client.post("/api/auth/logout", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403

    # Google OAuth top-level redirect has Sec-Fetch-Site: cross-site + navigate and no Origin;
    # local_origin must let it reach the OAuth handler (which returns 400 on missing state/code, not 403).
    oauth_nav = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"}
    resp = client.get("/api/flow-accounts/google/callback", headers=oauth_nav)
    assert resp.status_code != 403


def test_cors_preflight_allows_ui_and_mv3_extension_only(client):
    ext_origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    r_ext = client.options(
        "/api/ext/callback",
        headers={
            "Origin": ext_origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-callback-secret",
        },
    )
    assert r_ext.status_code == 200
    assert r_ext.headers.get("access-control-allow-origin") == ext_origin

    r_ui = client.options(
        "/api/boards",
        headers={
            "Origin": "http://127.0.0.1:5173",
            "Access-Control-Request-Method": "DELETE",
        },
    )
    assert r_ui.status_code == 200
    assert r_ui.headers.get("access-control-allow-origin") == "http://127.0.0.1:5173"

    r_evil = client.options(
        "/api/boards",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "DELETE",
        },
    )
    assert "access-control-allow-origin" not in r_evil.headers


def test_extension_callback_works_from_mv3_extension_origin(client):
    ext_origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    resp = client.post(
        "/api/ext/callback",
        headers={
            "Origin": ext_origin,
            "X-Callback-Secret": flow_client.callback_secret,
        },
        json={"id": "nonexistent-probe", "result": {}},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": False}


def test_provider_worker_token_enforced_when_configured(client, monkeypatch):
    monkeypatch.setenv("FLOWBOARD_WORKER_TOKEN", "secret-worker-tok")
    r_missing = client.post("/api/provider-jobs/next?provider=muse", json={"worker_id": "w1"})
    assert r_missing.status_code == 401

    r_wrong = client.post(
        "/api/provider-jobs/next?provider=muse",
        headers={"X-Provider-Worker-Token": "wrong"},
        json={"worker_id": "w1"},
    )
    assert r_wrong.status_code == 401

    # Valid token reaches the handler (404 because queue is empty).
    r_ok = client.post(
        "/api/provider-jobs/next?provider=muse",
        headers={"X-Provider-Worker-Token": "secret-worker-tok"},
        json={"worker_id": "w1"},
    )
    assert r_ok.status_code == 404
