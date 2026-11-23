"""Boundary for sensitive local UI routes (including paid provider operations)."""
from __future__ import annotations

import hmac
import os
from urllib.parse import urlparse

from fastapi import HTTPException, Request


_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
EXTENSION_ORIGIN_REGEX = r"^chrome-extension://[a-p]{32}$"


def allowed_ui_origins() -> set[str]:
    ports = {5173, 8434}
    if (_extra_port := os.getenv("FLOWBOARD_HTTP_PORT", "").strip()).isdigit():
        ports.add(int(_extra_port))
    if (_fe_port := os.getenv("FLOWBOARD_FRONTEND_PORT", "").strip()).isdigit():
        ports.add(int(_fe_port))
    if ui_url := os.getenv("FLOWBOARD_UI_URL", "").strip():
        parsed = urlparse(ui_url)
        if parsed.hostname in _LOCAL_HOSTS and parsed.port:
            ports.add(parsed.port)
    return {
        f"http://{host}:{port}"
        for host in ("localhost", "127.0.0.1", "[::1]")
        for port in ports
    }


_UI_ORIGINS = allowed_ui_origins()


def _is_google_oauth_return(request: Request) -> bool:
    return (
        request.method in {"GET", "HEAD"}
        and request.url.path in (
            "/api/flow-accounts/google/callback",
            "/api/flow-accounts/google/callback/done",
        )
        and request.headers.get("sec-fetch-mode") in {None, "navigate"}
    )


def local_origin(request: Request) -> None:
    # Enforce Host too: DNS rebinding can deliver attacker-controlled requests
    # from a supposedly same-origin page. Non-browser loopback clients may omit Origin.
    if request.url.hostname not in _LOCAL_HOSTS:
        raise HTTPException(403, "此功能仅供本地画布使用。")
    origin = request.headers.get("origin")
    same_loopback_origin = f"{request.url.scheme}://{request.url.netloc}"
    if origin is not None and origin not in allowed_ui_origins() and origin != same_loopback_origin:
        raise HTTPException(403, "此功能仅供本地画布使用。")
    # Block cross-site browser requests without a trusted local Origin
    # (e.g. no-cors fetches, form posts, or cross-site subresource probes),
    # permitting only the top-level GET return from Google OAuth.
    if (
        request.headers.get("sec-fetch-site") == "cross-site"
        and origin is None
        and not _is_google_oauth_return(request)
    ):
        raise HTTPException(403, "此功能仅供本地画布使用。")


def require_worker_auth(request: Request) -> None:
    """Guard external provider-job worker mutations with optional shared token."""
    local_origin(request)
    expected = os.getenv("FLOWBOARD_WORKER_TOKEN", "").strip()
    if not expected:
        return
    supplied = request.headers.get("x-provider-worker-token", "")
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise HTTPException(401, "invalid worker token")
