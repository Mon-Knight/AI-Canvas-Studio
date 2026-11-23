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
    assert resp.json()["ok"] is True

    blocked = client.get("/api/health", headers={"Origin": "http://127.0.0.1:9999"})
    assert blocked.status_code == 403
