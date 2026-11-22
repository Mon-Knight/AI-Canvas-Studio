"""Google account identity only; does not grant access to the Flow product."""
from __future__ import annotations

import base64
import hashlib
import os
import re
import secrets
import time
from dataclasses import dataclass, field
from urllib.parse import urlencode, urlsplit
from uuid import uuid4

import httpx
from sqlmodel import select

from flowboard.db import get_session
from flowboard.db.models import FlowAccount, FlowGoogleIdentity

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
CALLBACK_PATH = "/api/flow-accounts/google/callback"
DEFAULT_CALLBACK = "http://127.0.0.1:8434" + CALLBACK_PATH
TTL = 600
MAX_ATTEMPTS = 32


@dataclass(frozen=True)
class Config:
    client_id: str
    client_secret: str = field(repr=False)
    redirect_uri: str


def config() -> Config | None:
    client_id = os.getenv("FLOWBOARD_GOOGLE_CLIENT_ID", "").strip()
    client_secret = os.getenv("FLOWBOARD_GOOGLE_CLIENT_SECRET", "").strip()
    redirect_uri = os.getenv("FLOWBOARD_GOOGLE_REDIRECT_URI", DEFAULT_CALLBACK).strip()
    try:
        uri = urlsplit(redirect_uri)
        valid = (uri.scheme == "http" and uri.hostname in {"localhost", "127.0.0.1", "::1"}
                 and uri.port and not uri.username and not uri.password
                 and uri.path == CALLBACK_PATH and not uri.query and not uri.fragment)
    except ValueError:
        valid = False
    return Config(client_id, client_secret, redirect_uri) if client_id and client_secret and valid else None


@dataclass
class Attempt:
    state: str = field(repr=False)
    verifier: str = field(repr=False)
    config: Config
    expires: float
    claimed: bool = False
    status: str = "pending"
    detail: str | None = None
    account_id: str | None = None


_attempts: dict[str, Attempt] = {}


def prune() -> None:
    now = time.monotonic()
    for key, item in tuple(_attempts.items()):
        if item.expires <= now:
            del _attempts[key]


def begin(cfg: Config) -> tuple[str, str] | None:
    prune()
    if len(_attempts) >= MAX_ATTEMPTS:
        return None
    attempt_id = secrets.token_urlsafe(32)
    attempt = Attempt(secrets.token_urlsafe(32), secrets.token_urlsafe(48), cfg, time.monotonic() + TTL)
    _attempts[attempt_id] = attempt
    challenge = base64.urlsafe_b64encode(hashlib.sha256(attempt.verifier.encode()).digest()).rstrip(b"=").decode()
    query = urlencode({"client_id": cfg.client_id, "redirect_uri": cfg.redirect_uri,
                       "response_type": "code", "scope": "openid email profile", "state": attempt.state,
                       "prompt": "select_account", "access_type": "online",
                       "code_challenge": challenge, "code_challenge_method": "S256"})
    return attempt_id, f"{AUTH_URL}?{query}"


def lookup(attempt_id: str) -> Attempt | None:
    prune()
    return _attempts.get(attempt_id)


def claim(state: str) -> Attempt | None:
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", state):
        return None
    prune()
    for attempt in _attempts.values():
        if not attempt.claimed and secrets.compare_digest(attempt.state, state):
            attempt.claimed = True
            return attempt
    return None


async def read_identity(attempt: Attempt, code: str) -> tuple[str, str, str]:
    cfg = attempt.config
    async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
        token = await client.post(TOKEN_URL, data={"code": code, "client_id": cfg.client_id,
                                  "client_secret": cfg.client_secret, "redirect_uri": cfg.redirect_uri,
                                  "grant_type": "authorization_code", "code_verifier": attempt.verifier})
        token.raise_for_status()
        access_token = token.json()["access_token"]
        if not isinstance(access_token, str) or not access_token:
            raise ValueError("invalid Google access token")
        user = await client.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
        user.raise_for_status()
        identity = user.json()
    sub, email, name = identity.get("sub"), identity.get("email"), identity.get("name")
    if not isinstance(sub, str) or not sub or len(sub) > 255:
        raise ValueError("invalid Google subject")
    if identity.get("email_verified") is not True or not isinstance(email, str) or not email or len(email) > 254:
        raise ValueError("email not verified")
    return sub, email, (name.strip() if isinstance(name, str) else "") or email


def save_identity(sub: str, email: str, name: str) -> str:
    """Deduplicate by Google subject, never guess a match to a manual profile."""
    with get_session() as session:
        identity = session.exec(select(FlowGoogleIdentity).where(FlowGoogleIdentity.subject == sub)).first()
        if identity:
            identity.email = email
            session.add(identity)
            account_id = identity.account_id
        else:
            account_id = uuid4().hex
            session.add(FlowAccount(id=account_id, label=name[:80]))
            session.flush()
            session.add(FlowGoogleIdentity(account_id=account_id, subject=sub, email=email))
        session.commit()
        return account_id
