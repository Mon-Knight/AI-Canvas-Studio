"""Local secret storage for the multi-LLM provider layer.

Schema of ``~/.flowboard/secrets.json``:

```json
{
  "apiKeys": {"openai": "sk-..."},
  "featureConfig": {
    "auto_prompt": {"provider": "gemini", "model": "gemini-3.8-flash-low", "effort": "low"},
    "vision":      {"provider": "gemini", "model": "gemini-3.8-flash-high", "effort": "high"},
    "planner":     {"provider": "claude", "model": "sonnet", "effort": "medium"}
  },
  "activeProviders": {
    "auto_prompt": "gemini",
    "vision": "gemini",
    "planner": "claude"
  }
}
```

**Why two blocks for the same thing.** ``activeProviders`` is the original
"which provider serves this feature" map. ``featureConfig`` is its
superset: same routing plus the per-feature model and reasoning effort.
Both are maintained, deliberately:

- **Read** prefers ``featureConfig`` and falls back to ``activeProviders``
  (provider only; model and effort come back ``None``). An install that
  upgraded from a pre-``featureConfig`` version keeps routing exactly
  where it was routing before, with the CLIs' own model defaults applying
  until the user picks something.
- **Write** updates *both*. If the user later downgrades Flowboard, the
  older build still finds ``activeProviders`` and keeps working instead of
  presenting a bricked, seemingly-unconfigured install.

The duplication costs a few bytes in a single-user JSON file and buys a
lossless upgrade/downgrade path in both directions. Drop ``activeProviders``
only once downgrades are no longer a concern.

Stored as plain JSON with file mode ``0o600`` (owner read/write only).
Single-user local app — OS-level file permissions are sufficient. We
deliberately don't encrypt; encryption adds a key-management surface
area without real benefit when the only attacker that matters has
already won (root on this user's box).

Writes are atomic (`tmp + replace`) so a crash mid-write can't corrupt
the file — readers either see the old contents or the new contents,
never a half-written file.
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


_DEFAULT_PATH = Path.home() / ".flowboard" / "secrets.json"


def _path() -> Path:
    """Indirection so tests can monkeypatch the location.

    Tests typically set ``FLOWBOARD_SECRETS_PATH`` to a tmp file. Production
    callers leave the env var unset and the default ``~/.flowboard/secrets.json``
    applies.
    """
    override = os.environ.get("FLOWBOARD_SECRETS_PATH")
    return Path(override) if override else _DEFAULT_PATH


def read() -> dict:
    """Load the full secrets document. Empty dict if file doesn't exist
    or is corrupt — callers must handle missing keys themselves."""
    p = _path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("secrets: file unreadable, treating as empty (%s)", exc)
        return {}


def _windows_tool(name: str) -> str:
    return str(Path(os.environ["SystemRoot"]) / "System32" / name)


@lru_cache(maxsize=1)
def _windows_user_sid() -> str:
    proc = subprocess.run([_windows_tool("whoami.exe"), "/user", "/fo", "csv", "/nh"],
                          capture_output=True, check=True, timeout=5,
                          creationflags=subprocess.CREATE_NO_WINDOW)
    match = re.search(rb'"(S-\d+(?:-\d+)+)"\s*$', proc.stdout.strip())
    if not match:
        raise OSError("未能识别当前 Windows 用户，已取消保存密钥。")
    return match[1].decode("ascii")


def write(payload: dict) -> None:
    """Apply owner-only access *before* writing secret bytes; replace atomically."""
    p = _path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=p.parent, suffix=".tmp")
    tmp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            if os.name == "nt":
                # chmod on Windows only toggles read-only; it does not set an ACL.
                subprocess.run([_windows_tool("icacls.exe"), name, "/inheritance:r",
                                "/grant:r", f"*{_windows_user_sid()}:(F)"],
                               check=True, capture_output=True, timeout=5,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            json.dump(payload, stream, indent=2)
        tmp.replace(p)
    finally:
        tmp.unlink(missing_ok=True)


# ── API key helpers ────────────────────────────────────────────────────

def get_api_key(provider: str) -> Optional[str]:
    """None if the key is unset OR if the file doesn't exist."""
    doc = read()
    keys = doc.get("apiKeys") or {}
    val = keys.get(provider)
    return val if isinstance(val, str) and val else None


def set_api_key(provider: str, key: Optional[str]) -> None:
    """Set or clear (key=None) a provider's API key.

    Clearing removes the entry entirely so ``get_api_key`` returns None
    cleanly without falsy-empty-string ambiguity.
    """
    doc = read()
    keys = dict(doc.get("apiKeys") or {})
    if key is None or not key:
        keys.pop(provider, None)
    else:
        keys[provider] = key
    doc["apiKeys"] = keys
    write(doc)


def get_base_url(provider: str) -> Optional[str]:
    """Return the custom Base URL saved for ``provider``, or None when unset."""
    doc = read()
    urls = doc.get("baseUrls") or {}
    val = urls.get(provider)
    if not isinstance(val, str):
        return None
    cleaned = val.strip().rstrip("/")
    return cleaned or None


def set_base_url(provider: str, url: Optional[str]) -> None:
    """Set or clear (url=None) a custom Base URL for ``provider``."""
    doc = read()
    urls = dict(doc.get("baseUrls") or {})
    cleaned = url.strip().rstrip("/") if isinstance(url, str) else ""
    if not cleaned:
        urls.pop(provider, None)
    else:
        urls[provider] = cleaned
    if urls:
        doc["baseUrls"] = urls
    else:
        doc.pop("baseUrls", None)
    write(doc)


# ── Feature-config helpers ─────────────────────────────────────────────

# Features the UI configures. Order matters only for display; iteration
# order in this module is deterministic on Python 3.7+.
_FEATURES: tuple[str, ...] = ("auto_prompt", "vision", "planner")


def _clean_str(val: object) -> Optional[str]:
    """Non-empty strings pass through; everything else becomes None.

    Guards every read path against a hand-edited secrets.json holding
    ``42`` or ``null`` where a provider / model / effort belongs.
    """
    return val if isinstance(val, str) and val else None


def read_feature_config() -> dict[str, dict]:
    """Return ``{feature: {"provider", "model", "effort"}}`` for every
    feature the user has configured.

    ``featureConfig`` wins when present. Otherwise the legacy
    ``activeProviders`` map supplies the provider and ``model``/``effort``
    come back ``None`` — see the module docstring for why both blocks
    exist. A feature with no provider anywhere is simply absent from the
    result; callers treat absence as "not configured" rather than
    substituting a default, so an unconfigured feature fails loudly in the
    dispatch path instead of silently routing somewhere the user didn't
    pick.
    """
    doc = read()
    feature_cfg = doc.get("featureConfig")
    if not isinstance(feature_cfg, dict):
        feature_cfg = {}
    legacy = doc.get("activeProviders")
    if not isinstance(legacy, dict):
        legacy = {}

    # File order, featureConfig first — deterministic without imposing an
    # order the file itself doesn't have.
    features = list(feature_cfg) + [f for f in legacy if f not in feature_cfg]

    out: dict[str, dict] = {}
    for feature in features:
        entry = feature_cfg.get(feature)
        if isinstance(entry, dict):
            provider = _clean_str(entry.get("provider"))
            if provider is not None:
                out[feature] = {
                    "provider": provider,
                    "model": _clean_str(entry.get("model")),
                    "effort": _clean_str(entry.get("effort")),
                }
                continue
        # Back-compat: a pre-featureConfig install, or a featureConfig
        # entry hand-edited into something unusable. The legacy block
        # carries the provider and nothing else, so model/effort stay
        # None rather than borrowing values from a mismatched entry.
        provider = _clean_str(legacy.get(feature))
        if provider is not None:
            out[feature] = {"provider": provider, "model": None, "effort": None}
    return out


def read_active_providers() -> dict[str, str]:
    """Return ``{feature: provider_name}`` for features the user has
    explicitly picked. No defaults — missing keys are absent.

    A thin projection of :func:`read_feature_config` kept for callers that
    only care about routing. Callers must handle the missing case (a
    feature with no provider pinned can't dispatch). The HTTP layer
    surfaces this via the ``configured`` flag on ``GET /api/llm/config``;
    the dispatch layer raises ``LLMError`` so the user sees a clear "open
    settings" message instead of silently falling back to a provider they
    didn't pick.
    """
    return {f: cfg["provider"] for f, cfg in read_feature_config().items()}


def is_active_providers_configured() -> bool:
    """True when every feature has a provider pinned.

    This used to additionally require all three features to point at the
    *same* provider (a single-provider UI invariant). That invariant is
    gone: the user now configures each feature independently — provider,
    model and reasoning effort — so a mixed config is the expected shape,
    not a legacy accident to nag about. The flag now means exactly what
    the forced-setup gate needs it to mean: "is there anywhere to route
    every feature?"
    """
    saved = read_feature_config()
    return all(f in saved for f in _FEATURES)


def set_feature_config(
    feature: str,
    provider: str,
    model: Optional[str] = None,
    effort: Optional[str] = None,
) -> None:
    """Pin one feature to a provider + optional model + optional effort.

    Caller validates all three (see ``routes/llm.py``). Writes both the
    ``featureConfig`` entry and the legacy ``activeProviders`` entry so a
    downgrade to an older Flowboard build still finds its routing — see
    the module docstring.

    ``model``/``effort`` of ``None`` are stored as JSON null rather than
    omitted, so "the user explicitly cleared this" and "this key predates
    the field" stay indistinguishable at the only place that matters:
    both mean "don't pass the flag".
    """
    doc = read()
    feature_cfg = dict(doc.get("featureConfig") or {})
    feature_cfg[feature] = {
        "provider": provider,
        "model": model,
        "effort": effort,
    }
    doc["featureConfig"] = feature_cfg

    legacy = dict(doc.get("activeProviders") or {})
    legacy[feature] = provider
    doc["activeProviders"] = legacy

    write(doc)


def clear_feature_config(feature: str) -> None:
    """Remove an optional pin from both current and downgrade-compatible maps."""
    doc = read()
    for key in ("featureConfig", "activeProviders"):
        if isinstance(doc.get(key), dict):
            doc[key].pop(feature, None)
    write(doc)


def set_feature_provider(feature: str, provider: str) -> None:
    """Pin one feature to one provider, leaving model/effort unset.

    Convenience wrapper over :func:`set_feature_config` for callers that
    only route (and for the many existing tests that predate model/effort
    selection).
    """
    set_feature_config(feature, provider)
