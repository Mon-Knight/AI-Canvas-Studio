"""Loopback port bindability probe & automatic fallback for Windows Excluded Port Ranges."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import socket
from pathlib import Path
from typing import Sequence

from flowboard.config import STORAGE_DIR

HTTP_PORT_CANDIDATES: tuple[int, ...] = (8434, 18434, 18435, 18436, 28434, 28435, 38434)
WS_PORT_CANDIDATES: tuple[int, ...] = (8355, 18355, 28355, 38355)
FRONTEND_PORT_CANDIDATES: tuple[int, ...] = (5173, 15173, 25173)


def can_bind_loopback(port: int, host: str = "127.0.0.1") -> bool:
    """Return True iff ``(host, port)`` can be exclusively bound right now.

    Detects both normal port collisions (``WSAEADDRINUSE`` / ``10048``) and
    Windows Hyper-V / WSL2 / WinNAT excluded port ranges (``WSAEACCES`` / ``10013``).
    """
    if not (1 <= int(port) <= 65535):
        return False
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        excl = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if excl is not None:
            try:
                sock.setsockopt(socket.SOL_SOCKET, excl, 1)
            except OSError:
                pass
        sock.bind((host, int(port)))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def _allocate_ephemeral_port(host: str = "127.0.0.1") -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])
    finally:
        sock.close()


def pick_bindable_port(
    preferred: int,
    candidates: Sequence[int],
    *,
    host: str = "127.0.0.1",
    disallow: set[int] | None = None,
) -> int:
    blocked = disallow or set()
    ordered: list[int] = []
    for port in (preferred, *candidates):
        p = int(port)
        if 1 <= p <= 65535 and p not in blocked and p not in ordered:
            ordered.append(p)

    for candidate in ordered:
        if can_bind_loopback(candidate, host=host):
            return candidate

    for _ in range(5):
        ephemeral = _allocate_ephemeral_port(host=host)
        if ephemeral not in blocked:
            return ephemeral

    raise RuntimeError(f"Unable to allocate bindable loopback port on {host}")


def active_ports_file(storage_dir: Path | None = None) -> Path:
    return (storage_dir or STORAGE_DIR) / "active-ports.json"


def read_active_ports(storage_dir: Path | None = None) -> dict[str, int]:
    path = active_ports_file(storage_dir)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        out: dict[str, int] = {}
        for key in ("http_port", "ws_port", "frontend_port"):
            val = raw.get(key)
            if isinstance(val, int) and not isinstance(val, bool) and 1 <= val <= 65535:
                out[key] = val
        return out
    except Exception:
        return {}


def write_active_ports(
    *,
    http_port: int | None = None,
    ws_port: int | None = None,
    frontend_port: int | None = None,
    pid: int | None = None,
    storage_dir: Path | None = None,
) -> None:
    target_dir = storage_dir or STORAGE_DIR
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        existing = read_active_ports(target_dir)
        payload: dict[str, object] = {
            **existing,
            "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
        if http_port is not None:
            payload["http_port"] = int(http_port)
        if ws_port is not None:
            payload["ws_port"] = int(ws_port)
        if frontend_port is not None:
            payload["frontend_port"] = int(frontend_port)
        if pid is not None:
            payload["pid"] = int(pid)
        active_ports_file(target_dir).write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )
    except OSError:
        pass


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Resolve bindable local ports for Flowboard")
    parser.add_argument("--mode", choices=("agent", "frontend"), default="agent")
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)

    if args.mode == "agent":
        pref_http = int(os.getenv("FLOWBOARD_HTTP_PORT", "8434") or "8434")
        pref_ws = int(os.getenv("FLOWBOARD_EXT_WS_PORT", "8355") or "8355")
        http_port = pick_bindable_port(pref_http, HTTP_PORT_CANDIDATES, host=args.host)
        ws_port = pick_bindable_port(
            pref_ws,
            WS_PORT_CANDIDATES,
            host=args.host,
            disallow={http_port},
        )
        write_active_ports(http_port=http_port, ws_port=ws_port)
        print(f"HTTP_PORT={http_port}")
        print(f"WS_PORT={ws_port}")
        return 0

    saved = read_active_ports()
    http_port = int(os.getenv("FLOWBOARD_HTTP_PORT", str(saved.get("http_port", 8434))))
    pref_fe = int(os.getenv("FLOWBOARD_FRONTEND_PORT", "5173") or "5173")
    fe_port = pick_bindable_port(
        pref_fe,
        FRONTEND_PORT_CANDIDATES,
        host=args.host,
        disallow={http_port},
    )
    write_active_ports(frontend_port=fe_port)
    print(f"FRONTEND_PORT={fe_port}")
    print(f"HTTP_PORT={http_port}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
