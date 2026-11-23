"""Loopback WebSocket bridge. Only the selected profile can receive work."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass

import websockets

from flowboard.config import EXTENSION_WS_PORT, WS_HOST
from flowboard.port_probe import WS_PORT_CANDIDATES, write_active_ports
from flowboard.db import get_session
from flowboard.db.models import FlowAccount
from flowboard.services import flow_accounts
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_project import normalize_project_id

logger = logging.getLogger(__name__)


def _auto_bind_project_if_empty(profile_id: str, project_id: str) -> None:
    """Persist a detected Flow project UUID onto an unbound profile once."""
    try:
        with get_session() as session:
            row = session.get(FlowAccount, profile_id)
            if row is not None and not row.project_id:
                row.project_id = project_id
                session.add(row)
                session.commit()
    except Exception:
        logger.debug("Auto-bind project skipped for profile %s", profile_id, exc_info=True)


@dataclass
class Connection:
    profile_id: str | None = None
    legacy: bool = False
    flow_tab_open: bool = False


_connections: dict = {}
route_lock = asyncio.Lock()


def profile_presence(profile_id: str) -> tuple[bool, bool]:
    peers = [peer for peer in _connections.values() if peer.profile_id == profile_id]
    return bool(peers), any(peer.flow_tab_open for peer in peers)


def selected_tab_connected(profile_id: str) -> bool:
    """Check the routed socket, not merely the presence of some open tab."""
    routed = _connections.get(flow_client.extension_socket)
    return bool(routed and routed.profile_id == profile_id and routed.flow_tab_open)


async def refresh_route_locked() -> None:
    selected = flow_accounts.active_id()
    current = flow_client.extension_socket

    def eligible(peer: Connection) -> bool:
        return peer.profile_id == selected and peer.flow_tab_open if selected else peer.legacy

    if current in _connections and eligible(_connections[current]):
        return
    if current is not None:
        flow_client.clear_extension()
        flow_client.rotate_callback_secret()
    chosen = next((ws for ws, peer in _connections.items() if eligible(peer)), None)
    if chosen is not None:
        http_port = os.getenv("FLOWBOARD_HTTP_PORT", "8434").strip() or "8434"
        callback_url = f"http://127.0.0.1:{http_port}/api/ext/callback"
        try:
            await chosen.send(
                json.dumps(
                    {
                        "type": "callback_secret",
                        "secret": flow_client.callback_secret,
                        "callback_url": callback_url,
                    }
                )
            )
        except websockets.ConnectionClosed:
            return
        flow_client.set_extension(chosen)


async def refresh_route() -> None:
    async with route_lock:
        await refresh_route_locked()


async def _handler(websocket) -> None:
    request = getattr(websocket, "request", None)
    headers = request.headers if request else websocket.request_headers
    origin = headers.get("Origin")
    # A regular webpage must not impersonate the local extension. Non-browser
    # loopback clients remain supported for diagnostics and tests.
    if origin is not None and not origin.startswith("chrome-extension://"):
        await websocket.close(code=1008, reason="extension origin required")
        return
    peer = _connections[websocket] = Connection()
    greeted = False
    try:
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(data, dict):
                continue
            kind = data.get("type")
            if kind == "profile_hello" and not greeted:
                greeted = True
                peer.profile_id = flow_accounts.verify_profile(data.get("profile_id"), data.get("profile_token"))
                peer.legacy = data.get("profile_id") is None
                await refresh_route()
            elif kind == "profile_pair":
                if peer.profile_id is not None:
                    await websocket.send(json.dumps({"type": "profile_pair_error", "detail": "此浏览器已配对，请在对应账号的独立窗口中操作。"}, ensure_ascii=False))
                    continue
                async with route_lock:
                    if flow_client.has_pending_calls or flow_accounts.flow_work_in_progress():
                        result = None
                    else:
                        result = flow_accounts.redeem_code(data.get("code"))
                    if not result:
                        await websocket.send(json.dumps({"type": "profile_pair_error", "detail": "配对码无效、已过期，或有任务正在运行。请确认当前账号后重试。"}, ensure_ascii=False))
                        continue
                    profile_id, token = result
                    for other in _connections.values():
                        if other.profile_id == profile_id:
                            other.profile_id = None
                    peer.profile_id = profile_id
                    peer.legacy = False
                    # Wait for a new presence report after Chrome stores the profile.
                    peer.flow_tab_open = False
                    greeted = True
                    await refresh_route_locked()
                    await websocket.send(json.dumps({"type": "profile_paired", "profile_id": profile_id, "profile_token": token}))
            elif kind == "profile_presence" and greeted:
                peer.flow_tab_open = data.get("flow_tab_open") is True
                raw_project = data.get("project_id")
                if peer.profile_id and isinstance(raw_project, str):
                    detected = normalize_project_id(raw_project)
                    if detected:
                        _auto_bind_project_if_empty(peer.profile_id, detected)
                await refresh_route()
            elif kind == "profile_credits" and greeted:
                raw_credits = data.get("credits")
                raw_tier = data.get("paygate_tier")
                if (
                    isinstance(raw_credits, int)
                    and not isinstance(raw_credits, bool)
                    and 0 <= raw_credits <= 1_000_000_000
                ):
                    flow_accounts.record_account_credits(
                        peer.profile_id,
                        raw_credits,
                        raw_tier if isinstance(raw_tier, str) else None,
                    )
            elif kind == "ping":
                await websocket.send('{"type":"pong"}')
            else:
                # Before the extension upgrade older versions greet with extension_ready.
                if not greeted and kind == "extension_ready":
                    greeted = peer.legacy = True
                    await refresh_route()
                if flow_client.extension_socket is websocket and (peer.legacy or data.get("id")):
                    await flow_client.handle_message(data)
    except websockets.ConnectionClosed:
        pass
    finally:
        _connections.pop(websocket, None)
        await refresh_route()


async def run_ws_server() -> None:
    # 32 MiB frame ceiling matches extension/MAX_RPC_TEXT for large project payloads
    # and any WebSocket callback fallback without tripping 1009 Message Too Big.
    candidates: list[int] = []
    preferred = int(os.getenv("FLOWBOARD_EXT_WS_PORT", str(EXTENSION_WS_PORT)) or str(EXTENSION_WS_PORT))
    for p in (preferred, *WS_PORT_CANDIDATES):
        if p not in candidates:
            candidates.append(p)

    last_err: OSError | None = None
    for idx, port in enumerate(candidates):
        try:
            async with websockets.serve(
                _handler,
                WS_HOST,
                port,
                max_size=32 * 1024 * 1024,
            ):
                if port != preferred:
                    os.environ["FLOWBOARD_EXT_WS_PORT"] = str(port)
                    write_active_ports(ws_port=port)
                    logger.warning(
                        "WS port %d unavailable; auto-switched extension bridge to ws://%s:%d",
                        preferred,
                        WS_HOST,
                        port,
                    )
                else:
                    logger.info("WebSocket server listening on ws://%s:%d", WS_HOST, port)
                await asyncio.Future()
                return
        except OSError as exc:
            last_err = exc
            if idx + 1 < len(candidates):
                continue
            raise
    if last_err is not None:
        raise last_err
