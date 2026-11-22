"""Manage local Flow browser profiles and manual credit snapshots."""
from __future__ import annotations

from datetime import datetime, timezone
import logging
import os
import time
from uuid import uuid4
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
import httpx
from pydantic import BaseModel, Field
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import AppSetting, FlowAccount, FlowGoogleIdentity
from flowboard.services import flow_accounts as accounts
from flowboard.services import flow_google_oauth as google
from flowboard.services.flow_client import flow_client
from flowboard.services.flow_project import normalize_project_id
from flowboard.services.ws_server import profile_presence, route_lock, refresh_route_locked
from .local_only import local_origin


logger = logging.getLogger(__name__)


router = APIRouter(prefix="/api/flow-accounts", dependencies=[Depends(local_origin)])


Tier = Literal["PAYGATE_TIER_ONE", "PAYGATE_TIER_TWO"]


class CreateAccount(BaseModel):
    label: str = Field(max_length=80)
    project_id: str | None = Field(default=None, max_length=512)
    paygate_tier: Tier | None = None


class UpdateAccount(BaseModel):
    label: str | None = Field(default=None, max_length=80)
    project_id: str | None = Field(default=None, max_length=512)
    paygate_tier: Tier | None = None
    credits: int | None = Field(default=None, ge=0, le=1_000_000_000, strict=True)


def _label(value: str | None) -> str:
    value = (value or "").strip()
    if not value:
        raise HTTPException(400, "请输入账号名称。")
    return value


def _project(value: str | None) -> str | None:
    if not value or not value.strip():
        return None
    project_id = normalize_project_id(value)
    if not project_id:
        raise HTTPException(400, "请输入 Flow 项目链接或项目 ID。")
    return project_id


def _get(session, profile_id: str) -> FlowAccount:
    row = session.get(FlowAccount, profile_id)
    if row is None:
        raise HTTPException(404, "未找到此 Flow 账号。")
    return row


def _check_idle() -> None:
    if flow_client.has_pending_calls or accounts.flow_work_in_progress():
        raise HTTPException(409, "画布任务正在排队或运行，请等待完成后再切换账号或项目。")


@router.get("")
async def list_accounts() -> dict:
    with get_session() as session:
        rows = session.exec(select(FlowAccount).order_by(FlowAccount.label, FlowAccount.id)).all()
        active = session.get(AppSetting, accounts.ACTIVE_KEY)
        identities = {item.account_id: item.email for item in session.exec(select(FlowGoogleIdentity)).all()}
        result = []
        for row in rows:
            connected, tab = profile_presence(row.id)
            updated = row.credits_updated_at
            result.append({"id": row.id, "label": row.label, "project_id": row.project_id,
                           "paygate_tier": row.paygate_tier, "paired": bool(row.pair_digest),
                           "connected": connected, "flow_tab_open": tab, "credits": row.credits,
                           "google_email": identities.get(row.id),
                           "credits_updated_at": updated.replace(tzinfo=timezone.utc).isoformat() if updated else None})
        return {"active_account_id": active.value if active else None,
                "accounts": result, "extension_path": str(accounts.EXTENSION_PATH),
                "embedded_browser": os.getenv("FLOWBOARD_EMBEDDED_BROWSER") == "1"}


@router.post("", status_code=201)
async def create_account(body: CreateAccount) -> dict:
    profile_id = uuid4().hex
    with get_session() as session:
        session.add(FlowAccount(id=profile_id, label=_label(body.label), project_id=_project(body.project_id), paygate_tier=body.paygate_tier))
        session.commit()
    return {**await list_accounts(), "created_account_id": profile_id}


@router.patch("/{profile_id}")
async def update_account(profile_id: str, body: UpdateAccount) -> dict:
    with get_session() as session:
        row = _get(session, profile_id)
        fields = body.model_fields_set
        if "label" in fields:
            row.label = _label(body.label)
        if "project_id" in fields:
            project_id = _project(body.project_id)
            if row.project_id != project_id and accounts.active_id() == profile_id:
                _check_idle()
            row.project_id = project_id
        if "paygate_tier" in fields:
            if row.paygate_tier != body.paygate_tier and accounts.active_id() == profile_id:
                _check_idle()
            row.paygate_tier = body.paygate_tier
        if "credits" in fields:
            row.credits = body.credits
            row.credits_updated_at = datetime.now(timezone.utc) if body.credits is not None else None
        session.add(row)
        session.commit()
    return await list_accounts()


@router.post("/{profile_id}/activate")
async def activate_account(profile_id: str, skip_launch: bool = False) -> dict:
    async with route_lock:
        with get_session() as session:
            row = _get(session, profile_id)
            active = session.get(AppSetting, accounts.ACTIVE_KEY)
            switching = active is None or active.value != profile_id
            if switching:
                _check_idle()
            if not skip_launch:
                try:
                    accounts.launch(row)
                except (OSError, ValueError) as exc:
                    raise HTTPException(503, str(exc)) from exc
            if switching:
                if active is None:
                    active = AppSetting(key=accounts.ACTIVE_KEY, value=profile_id)
                active.value = profile_id
                session.add(active)
                session.commit()
                # Invalidate the old socket before any await can let a caller send.
                flow_client.clear_extension()
                flow_client.rotate_callback_secret()
        await refresh_route_locked()
    return await list_accounts()


@router.post("/legacy")
async def use_legacy_connection() -> dict:
    async with route_lock:
        with get_session() as session:
            row = session.get(AppSetting, accounts.ACTIVE_KEY)
            if row is not None:
                _check_idle()
                session.delete(row)
                session.commit()
                flow_client.clear_extension()
                flow_client.rotate_callback_secret()
        await refresh_route_locked()
    return await list_accounts()


@router.post("/sync-credits")
async def sync_credits() -> dict:
    """Query the active Flow browser tab for current credits and return updated accounts."""
    await accounts.sync_active_credits(force=True)
    return await list_accounts()


@router.post("/{profile_id}/pair")
async def pair_account(profile_id: str) -> dict:
    if accounts.active_id() != profile_id:
        raise HTTPException(409, "请先打开此账号的独立 Flow 窗口。")
    with get_session() as session:
        _get(session, profile_id)
    return {"code": accounts.issue_code(profile_id), "expires_in": accounts.PAIR_TTL}


# All callback pages are static: never reflect provider query parameters into HTML.
_OAUTH_HEADERS = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
                  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
                  "X-Content-Type-Options": "nosniff"}


@router.get("/google/config")
async def google_config():
    cfg = google.config()
    return {"configured": cfg is not None, "redirect_uri": cfg.redirect_uri if cfg else google.DEFAULT_CALLBACK}


@router.post("/google/start")
async def google_start():
    cfg = google.config()
    if cfg is None:
        raise HTTPException(503, "请先配置 Google OAuth 客户端并重启本地服务。")
    result = google.begin(cfg)
    if not result:
        raise HTTPException(429, "登录请求过多，请稍后重试。")
    attempt_id, authorization_url = result
    return JSONResponse({"attempt_id": attempt_id, "authorization_url": authorization_url}, headers=_OAUTH_HEADERS)


@router.get("/google/status/{attempt_id}")
async def google_status(attempt_id: str):
    attempt = google.lookup(attempt_id)
    if not attempt:
        return JSONResponse({"status": "error", "detail": "登录请求已过期，请重新发起。"}, headers=_OAUTH_HEADERS)
    return JSONResponse({"status": attempt.status, "detail": attempt.detail, "account_id": attempt.account_id}, headers=_OAUTH_HEADERS)


@router.get("/google/callback")
async def google_callback(state: str = "", code: str = "", error: str = ""):
    attempt = google.claim(state)
    if attempt:
        try:
            if error or not code or len(code) > 2048:
                attempt.status, attempt.detail = "error", "Google 登录已取消或未完成。"
            else:
                identity = await google.read_identity(attempt, code)
                if attempt.expires <= time.monotonic():
                    raise ValueError("attempt expired")
                attempt.account_id = google.save_identity(*identity)
                attempt.status = "success"
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError) as exc:
            logger.warning("Google account verification failed: %s", type(exc).__name__)
            attempt.status, attempt.detail = "error", "未能验证 Google 账号，请检查 OAuth 配置并重新登录。"
        except Exception as exc:
            logger.error("Google account could not be saved: %s", type(exc).__name__)
            attempt.status, attempt.detail = "error", "保存 Google 账号失败，请重试。"
    outcome = "success" if attempt and attempt.status == "success" else "error"
    return RedirectResponse(f"{google.CALLBACK_PATH}/done?result={outcome}", status_code=303, headers=_OAUTH_HEADERS)


@router.get("/google/callback/done", response_class=HTMLResponse)
async def google_done(result: str = ""):
    title = "Google 登录完成" if result == "success" else "Google 登录未完成"
    return HTMLResponse(f'<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>{title}</title>'
                        f'<h1>{title}</h1><p>请关闭此页并返回画布。</p></html>', headers=_OAUTH_HEADERS)
