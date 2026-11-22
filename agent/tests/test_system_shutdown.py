"""Tests for /api/system/shutdown local-origin boundary and deferred exit."""


def test_shutdown_rejects_cross_origin(client):
    client.headers["Host"] = "127.0.0.1:8434"
    res = client.post(
        "/api/system/shutdown",
        headers={"Origin": "https://example.test"},
        json={"defer_process_exit": True},
    )
    assert res.status_code == 403


def test_shutdown_accepts_local_origin_with_deferred_exit(client):
    client.headers["Host"] = "127.0.0.1:8434"
    res = client.post(
        "/api/system/shutdown",
        headers={"Origin": "http://localhost:5173"},
        json={"defer_process_exit": True, "stop_frontend": False},
    )
    assert res.status_code == 200
    assert res.json() == {"ok": True, "shutting_down": True}
