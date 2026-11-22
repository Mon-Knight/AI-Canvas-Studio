"""Boundary for sensitive local UI routes (including paid provider operations)."""
import os
from fastapi import HTTPException, Request


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_ALLOWED_PORTS = {5173, 8434}
if (_extra_port := os.getenv("FLOWBOARD_HTTP_PORT", "").strip()).isdigit():
    _ALLOWED_PORTS.add(int(_extra_port))
_UI_ORIGINS = {f"http://{host}:{port}" for host in ("localhost", "127.0.0.1", "[::1]")
               for port in _ALLOWED_PORTS}


def local_origin(request: Request) -> None:
    # Enforce Host too: DNS rebinding can deliver attacker-controlled requests
    # from a supposedly same-origin page. Non-browser loopback clients may omit Origin.
    if request.url.hostname not in _LOCAL_HOSTS:
        raise HTTPException(403, "此功能仅供本地画布使用。")
    origin = request.headers.get("origin")
    if origin is not None and origin not in _UI_ORIGINS:
        raise HTTPException(403, "此功能仅供本地画布使用。")
    # Permit top-level GET returns from the Google OAuth flow (no Origin).
    if (request.method not in {"GET", "HEAD"}
            and request.headers.get("sec-fetch-site") == "cross-site" and origin is None):
        raise HTTPException(403, "此功能仅供本地画布使用。")
