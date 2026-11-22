"""Local Flow browser profiles; Google sign-in stays entirely in Chrome."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import hmac
import logging
import os
import re
import secrets
import shutil
import subprocess
import time
from pathlib import Path

from sqlmodel import select

from flowboard.config import ROOT, STORAGE_DIR
from flowboard.db import get_session
from flowboard.db.models import AppSetting, FlowAccount, PipelineRun, Request

logger = logging.getLogger(__name__)

ACTIVE_KEY = "active_flow_account"
EXTENSION_PATH = ROOT / "extension"
FLOW_URL = "https://flow.google.com/"
PAIR_TTL = 300
_pair_codes: dict[str, tuple[str, float]] = {}
_credits_sync_lock = asyncio.Lock()
_last_credits_sync: dict[str, float] = {}
_CREDITS_SYNC_COOLDOWN_S = 45.0


def active_id() -> str | None:
    with get_session() as session:
        row = session.get(AppSetting, ACTIVE_KEY)
        return row.value if row else None


def active_binding() -> tuple[str | None, str | None]:
    with get_session() as session:
        row = session.get(AppSetting, ACTIVE_KEY)
        if not row:
            return None, None
        account = session.get(FlowAccount, row.value)
        return row.value, account.project_id if account else None


def active_project() -> tuple[bool, str | None]:
    account_id, project_id = active_binding()
    return account_id is not None, project_id


def active_tier() -> tuple[bool, str | None]:
    with get_session() as session:
        row = session.get(AppSetting, ACTIVE_KEY)
        account = session.get(FlowAccount, row.value) if row else None
        return row is not None, account.paygate_tier if account else None


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def verify_profile(profile_id: object, token: object) -> str | None:
    if not isinstance(profile_id, str) or not re.fullmatch(r"[0-9a-f]{32}", profile_id):
        return None
    if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
        return None
    with get_session() as session:
        row = session.get(FlowAccount, profile_id)
        if row and row.pair_digest and hmac.compare_digest(row.pair_digest, _digest(token)):
            return row.id
    return None


def issue_code(profile_id: str) -> str:
    now = time.monotonic()
    for code, (account, expires) in list(_pair_codes.items()):
        if expires <= now or account == profile_id:
            _pair_codes.pop(code)
    code = secrets.token_hex(6).upper()
    _pair_codes[code] = (profile_id, now + PAIR_TTL)
    return code


def redeem_code(code: object) -> tuple[str, str] | None:
    if not isinstance(code, str) or len(code) > 32:
        return None
    key = code.strip().upper()
    entry = _pair_codes.get(key)
    if not entry or entry[1] <= time.monotonic():
        _pair_codes.pop(key, None)
        return None
    with get_session() as session:
        account = session.get(FlowAccount, entry[0])
        if account is None or active_id() != account.id:
            return None
        token = secrets.token_urlsafe(32)
        account.pair_digest = _digest(token)
        session.add(account)
        session.commit()
    _pair_codes.pop(key, None)
    return entry[0], token


def _chrome() -> str | None:
    roots = [os.environ.get(key) for key in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
    candidates = [Path(root) / "Google/Chrome/Application/chrome.exe" for root in roots if root]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return next((exe for name in ("chrome", "google-chrome", "chromium") if (exe := shutil.which(name))), None)


def launch(account: FlowAccount) -> None:
    if not re.fullmatch(r"[0-9a-f]{32}", account.id):
        raise ValueError("无效的浏览器配置编号。")
    if os.getenv("FLOWBOARD_EMBEDDED_BROWSER") == "1":
        return
    chrome = _chrome()
    if not chrome:
        raise OSError("找不到 Google Chrome，请先安装后再打开 Flow。")
    # Separate user-data roots also isolate extension storage and sign-in cookies.
    directory = (STORAGE_DIR / "flow-browser-profiles" / account.id).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    url = f"{FLOW_URL}project/{account.project_id}" if account.project_id else FLOW_URL
    subprocess.Popen([chrome, f"--user-data-dir={directory}", url],
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def flow_work_in_progress() -> bool:
    from flowboard.worker.processor import get_worker

    if get_worker().active_count:
        return True
    with get_session() as session:
        if session.exec(select(Request.id).where(Request.status.in_(("queued", "running"))).limit(1)).first() is not None:
            return True
        return session.exec(select(PipelineRun.id).where(PipelineRun.status.in_(("pending", "running"))).limit(1)).first() is not None


def record_account_credits(
    profile_id: str | None,
    credits: int,
    paygate_tier: str | None = None,
) -> None:
    """Persist the latest Flow credit balance onto the client cache and account row."""
    from flowboard.services.flow_client import flow_client

    if not isinstance(credits, int) or isinstance(credits, bool) or not 0 <= credits <= 1_000_000_000:
        return

    valid_tier = paygate_tier if paygate_tier in ("PAYGATE_TIER_ONE", "PAYGATE_TIER_TWO") else None
    flow_client._credits = credits
    if valid_tier:
        flow_client._paygate_tier = valid_tier

    if not profile_id:
        return
    with get_session() as session:
        row = session.get(FlowAccount, profile_id)
        if row is None:
            return
        row.credits = credits
        row.credits_updated_at = datetime.now(timezone.utc)
        if row.paygate_tier is None and valid_tier:
            row.paygate_tier = valid_tier
        session.add(row)
        session.commit()


async def sync_active_credits(force: bool = False) -> dict | None:
    """Fetch credits via the active browser tab using Flow RPC `nzlxg` and persist it."""
    from flowboard.services.flow_client import flow_client
    from flowboard.services.flow_sdk import get_flow_sdk

    if not flow_client.connected:
        return None

    account_id, project_id = active_binding()
    cache_key = account_id or "__legacy__"
    now = time.monotonic()
    if not force:
        last = _last_credits_sync.get(cache_key, 0.0)
        if now - last < _CREDITS_SYNC_COOLDOWN_S:
            return None

    async with _credits_sync_lock:
        if not flow_client.connected:
            return None
        if not force:
            last = _last_credits_sync.get(cache_key, 0.0)
            if time.monotonic() - last < _CREDITS_SYNC_COOLDOWN_S:
                return None
        _last_credits_sync[cache_key] = time.monotonic()
        try:
            res = await get_flow_sdk().get_credits(project_id)
        except Exception:  # noqa: BLE001
            logger.debug("sync_active_credits failed", exc_info=True)
            return None
        if isinstance(res, dict) and not res.get("error") and isinstance(res.get("credits"), int):
            record_account_credits(
                account_id,
                res["credits"],
                res.get("paygate_tier") if isinstance(res.get("paygate_tier"), str) else None,
            )
            return res
    return None
