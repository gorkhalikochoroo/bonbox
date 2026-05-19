"""
Apple Sign-In identity token verifier (Task #65).

Verifies the JWT identity_token Apple returns after a Sign-in-with-Apple
flow. Built on top of python-jose so we don't bring a new JWT lib into
the codebase.

Used by:
  • app.routers.auth_oauth POST /auth/oauth/apple — the new, unified
    OAuth endpoint that handles BOTH Apple + Google with the same
    find-or-create / link semantics.
  • (Legacy) app.routers.auth POST /auth/apple kept independently for
    back-compat with the existing iOS Capacitor flow.

Multi-layer defense:
  1. Algorithm whitelist — we require RS256 from Apple. Any other alg
     (incl. "none") in the JWT header is rejected before we go near
     the signature.
  2. JWKS lookup — we fetch Apple's published public keys and verify
     the signature against the matching kid. Force-refresh once on
     miss so a rotated key doesn't cause a sustained outage.
  3. Issuer check — the `iss` claim MUST be https://appleid.apple.com.
  4. Audience check — the `aud` claim MUST equal APPLE_CLIENT_ID (or
     fall back to the first APPLE_ALLOWED_AUDIENCES entry). NEVER
     trust the token if no audience is configured server-side.
  5. Expiry check — JOSE validates `exp` automatically; we still
     surface a clean ValueError so the router maps to 401.
  6. Email is taken from the claims AFTER signature verification, never
     before. The caller must never read user-controlled email from an
     unverified token.

JWKS caching: 24h TTL, in-process. Force-refresh on signature failure
(Apple rotates keys occasionally). Stale-on-error fallback so a 30-second
network blip doesn't break logins for the whole platform.
"""
from __future__ import annotations

import json
import logging
import time
import urllib.request
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)


# ── Constants ────────────────────────────────────────────────────────

_APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys"
_APPLE_ISSUER = "https://appleid.apple.com"
_JWKS_TTL_SECONDS = 86400.0  # 24h


# Module-level JWKS cache. Resets on process restart. Tests can monkey-
# patch this dict directly to inject deterministic keys.
_JWKS_CACHE: dict[str, Any] = {"keys": None, "fetched_at": 0.0}


# ── Helpers ──────────────────────────────────────────────────────────


def _allowed_audiences() -> list[str]:
    """Pull accepted audience values from config.

    Priority order:
      1. APPLE_CLIENT_ID (new unified env var) — single value, takes
         priority because it's the documented production setting.
      2. APPLE_ALLOWED_AUDIENCES (legacy, comma-separated) — kept so
         existing deployments don't need an env-var migration to keep
         /auth/apple working.

    Returns an empty list when nothing is configured; the caller raises
    503 rather than silently accept any audience.
    """
    primary = (settings.APPLE_CLIENT_ID or "").strip()
    if primary:
        return [primary]
    legacy = settings.APPLE_ALLOWED_AUDIENCES or ""
    return [a.strip() for a in legacy.split(",") if a.strip()]


def _fetch_jwks(force: bool = False) -> list[dict]:
    """Fetch Apple's JWKS, cached 24h.

    If `force=True` we bypass the cache (used when a verify fails due to
    "no matching kid" — Apple may have rotated). On network error we
    return whatever stale keys are cached rather than failing the whole
    request flow.
    """
    now = time.time()
    if (
        not force
        and _JWKS_CACHE["keys"]
        and (now - _JWKS_CACHE["fetched_at"]) < _JWKS_TTL_SECONDS
    ):
        return _JWKS_CACHE["keys"]
    try:
        with urllib.request.urlopen(_APPLE_KEYS_URL, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        _JWKS_CACHE["keys"] = data.get("keys", [])
        _JWKS_CACHE["fetched_at"] = now
        return _JWKS_CACHE["keys"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("oauth_apple: JWKS fetch failed: %s — using stale keys", exc)
        return _JWKS_CACHE["keys"] or []


# ── Public API ───────────────────────────────────────────────────────


def verify_apple_token(id_token: str) -> dict:
    """Verify an Apple identity_token and return its decoded claims.

    Returns:
      {
        "sub": "001234.abcd…",       # stable Apple user ID
        "email": "user@example.com", # real or @privaterelay.appleid.com
        "email_verified": True,
      }

    Raises:
      ValueError — on ANY verification failure (bad alg, signature
                   mismatch, wrong iss, wrong aud, expired). The router
                   maps this to HTTP 401.
      RuntimeError — when no audience is configured (server config
                     bug). The router maps this to HTTP 503.

    Never reads the email from the token until after signature
    verification — see module docstring for why.
    """
    if not id_token or not isinstance(id_token, str):
        raise ValueError("Apple token missing")

    audiences = _allowed_audiences()
    if not audiences:
        raise RuntimeError("Apple Sign-In not configured (APPLE_CLIENT_ID empty)")

    # Local import — keeps the module import-cycle-free + makes tests
    # easier to monkeypatch.
    from jose import jwt
    from jose.utils import base64url_decode
    from jose import jwk as jose_jwk

    # Step 1 — header. Bail on anything weird before going further.
    try:
        header = jwt.get_unverified_header(id_token)
    except Exception as exc:
        raise ValueError(f"Apple token header malformed: {exc}") from exc
    alg = header.get("alg")
    kid = header.get("kid")
    if alg != "RS256":
        raise ValueError(f"Apple token alg must be RS256 (got {alg})")
    if not kid:
        raise ValueError("Apple token missing kid header")

    # Step 2 — find the matching JWK. Force-refresh once on miss.
    keys = _fetch_jwks()
    matching = next((k for k in keys if k.get("kid") == kid), None)
    if not matching:
        keys = _fetch_jwks(force=True)
        matching = next((k for k in keys if k.get("kid") == kid), None)
    if not matching:
        raise ValueError("No Apple public key matches token kid")

    # Step 3 — signature. python-jose handles this inside jwt.decode,
    # but we also do an explicit verify of the raw signature here for
    # belt-and-braces (any failure during construct/verify is a clean
    # ValueError instead of jose's varied error types).
    try:
        public_key = jose_jwk.construct(matching)
    except Exception as exc:
        raise ValueError(f"Cannot construct Apple public key: {exc}") from exc

    try:
        message, encoded_sig = id_token.rsplit(".", 1)
        decoded_sig = base64url_decode(encoded_sig.encode("utf-8"))
    except Exception as exc:
        raise ValueError(f"Apple token format invalid: {exc}") from exc
    if not public_key.verify(message.encode("utf-8"), decoded_sig):
        raise ValueError("Apple token signature invalid")

    # Step 4 — decode + validate iss/aud/exp via jose. jose enforces
    # exp automatically (raises ExpiredSignatureError → our ValueError).
    try:
        claims = jwt.decode(
            id_token,
            key=matching,
            algorithms=["RS256"],
            audience=audiences,
            issuer=_APPLE_ISSUER,
            options={"verify_aud": True, "verify_iss": True, "verify_exp": True},
        )
    except Exception as exc:
        # Includes ExpiredSignatureError, JWTClaimsError, JWTError —
        # all should result in a clean 401.
        raise ValueError(f"Apple token claims invalid: {exc}") from exc

    # Step 5 — sanity-strip and return only the fields the caller needs.
    # Apple's `email_verified` is sometimes a string "true"/"false"
    # rather than a real bool — normalize it.
    raw_verified = claims.get("email_verified")
    if isinstance(raw_verified, str):
        email_verified = raw_verified.lower() == "true"
    else:
        email_verified = bool(raw_verified)

    return {
        "sub": claims.get("sub"),
        "email": claims.get("email"),
        "email_verified": email_verified,
    }
