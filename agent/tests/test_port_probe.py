"""Tests for Windows excluded/occupied loopback port probing & automatic fallback."""
from __future__ import annotations

import socket
from pathlib import Path

from fastapi.testclient import TestClient

from flowboard import port_probe
from flowboard.main import app


def test_can_bind_loopback_detects_occupied_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
    if excl is not None:
        sock.setsockopt(socket.SOL_SOCKET, excl, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(1)
    occupied_port = int(sock.getsockname()[1])
    try:
        assert port_probe.can_bind_loopback(occupied_port) is False
        chosen = port_probe.pick_bindable_port(
            occupied_port,
            (occupied_port, 18434, 18435, 28434),
        )
        assert chosen != occupied_port
        assert port_probe.can_bind_loopback(chosen) is True
    finally:
        sock.close()


def test_pick_bindable_port_falls_back_when_preferred_fails(monkeypatch):
    monkeypatch.setattr(
        port_probe,
        "can_bind_loopback",
        lambda port, host="127.0.0.1": int(port) != 8434,
    )
    chosen = port_probe.pick_bindable_port(8434, port_probe.HTTP_PORT_CANDIDATES)
    assert chosen == 18434


def test_write_and_read_active_ports_roundtrip(tmp_path: Path):
    port_probe.write_active_ports(
        http_port=18434,
        ws_port=18355,
        frontend_port=15173,
        pid=12345,
        storage_dir=tmp_path,
    )
    loaded = port_probe.read_active_ports(tmp_path)
    assert loaded == {"http_port": 18434, "ws_port": 18355, "frontend_port": 15173}


def test_local_origin_accepts_same_loopback_fallback_port():
    client = TestClient(app, base_url="http://127.0.0.1:18434")
    resp = client.get("/api/health", headers={"Origin": "http://127.0.0.1:18434"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["version"] == app.version
    assert isinstance(body["frontend_dist"], str) and body["frontend_dist"]

    blocked = client.get("/api/health", headers={"Origin": "http://127.0.0.1:9999"})
    assert blocked.status_code == 403


def test_serve_frontend_index_disables_http_caching(tmp_path: Path, monkeypatch):
    from flowboard import main as main_mod

    dist_dir = tmp_path / "frontend-dist"
    dist_dir.mkdir()
    (dist_dir / "index.html").write_text("<!doctype html><html><body>v-fresh</body></html>", encoding="utf-8")
    monkeypatch.setattr(main_mod, "_FRONTEND_DIST", dist_dir)

    client = TestClient(app, base_url="http://127.0.0.1:8434")
    resp = client.get("/")
    assert resp.status_code == 200
    cache_ctl = resp.headers.get("cache-control", "").lower()
    assert "no-store" in cache_ctl
    assert "no-cache" in cache_ctl
    assert resp.headers.get("pragma", "").lower() == "no-cache"


def test_resolve_agent_version_prefers_packaged_app_package_json(tmp_path: Path, monkeypatch):
    from flowboard import main as main_mod

    app_dir = tmp_path / "app"
    app_dir.mkdir()
    (app_dir / "package.json").write_text('{"name":"ai-canvas-studio","version":"1.2.9"}', encoding="utf-8")
    monkeypatch.setenv("FLOWBOARD_APP_ROOT", str(tmp_path))
    assert main_mod._resolve_agent_version() == "1.2.9"

