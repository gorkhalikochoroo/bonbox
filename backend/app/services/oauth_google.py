"""
Google Sign-In identity token verifier (Task #65).

Verifies a Google-issued ID token (JWT) the frontend obtains from
@react-oauth/google's `GoogleLogin` component. The frontend hands us
`credential` (Google's name for the ID token); we verify the
signature against Google's published JWKs, validate the iss/aud/exp
claims, and return the trustworthy subset of claims.

Used by:
  • app.routers.auth_oauth POST /auth/oauth/google — the new, unified
    OAuth endpoint that handles BOTH Apple + Google with the same
    find-or-create / link semantics.
  • (Legacy) app.routers.auth POST /auth/google kept independently
    via the google-auth library for back-compat.

Multi-layer defense:
  1. Algorithm whitelist — Google signs with RS256. Any other alg is
     refused before signature check.
  2. JWKS lookup — Google's keys at
     https://www.googleapis.com/oauth2/v3/certs. Cached + force-
     refresh once on miss.
  3. Issuer check — `iss` MUST be either "accounts.google.com" or
     "https://accounts.google.com" (Google uses both interchangeably).
  4. Audience check — `aud` MUST equal GOOGLE_CLIENT_ID. The frontend
     gets a different audience for each OAuth client, so this is the
     critical anti-replay defense.
  5. Expiry — jose verifies `exp` automatically.
  6. Email comes from the verified claims AFTER signature check —
     never trust a token's email before that.

JWKS caching is in-process, 24h TTL, force-refresh on miss. Stale-on-
error to survive transient network blips.
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

# v3 endpoint returns JWKs in the JWKS shape jose expects. Other Google
# endpoints (`/oauth2/v1/certs`) return raw certs which would need
# extra parsing — stick with v3.
_GOOGLE_KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs"
# Google's published issuers — both forms are valid per their docs.
_GOOGLE_ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})
_JWKS_TTL_SECONDS = 86400.0


# Module-level JWKS cache. Tests can replace this dict to inject keys
# without touching the network.
_JWKS_CACHE: dict[str, Any] = {"keys": None, "fetched_at": 0.0}


# ── Helpers ──────────────────────────────────────────────────────────


def _fetch_jwks(force: bool = False) -> list[dict]:
    """Fetch Google's JWKS, cached 24h. Stale-on-error fallback."""
    now = time.time()
    if (
        not force
        and _JWKS_CACHE["keys"]
        and (now - _JWKS_CACHE["fetched_at"]) < _JWKS_TTL_SECONDS
    ):
        return _JWKS_CACHE["keys"]
    try:
        with urllib.request.urlopen(_GOOGLE_KEYS_URL, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        _JWKS_CACHE["keys"] = data.get("keys", [])
        _JWKS_CACHE["fetched_at"] = now
        return _JWKS_CACHE["keys"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("oauth_google: JWKS fetch failed: %s — using stale keys", exc)
        return _JWKS_CACHE["keys"] or []


# ── Public API ───────────────────────────────────────────────────────


def verify_google_token(id_token: str) -> dict:
    """Verify a Google ID token and return its decoded claims.

    Returns:
      {
        "sub": "1024…",                # stable Google user ID
        "email": "user@gmail.com",
        "email_verified": True,
        "name": "Jane Smith",          # optional
        "picture": "https://…",        # optional
      }

    Raises:
      ValueError — on ANY verification failure (bad alg, signature
                   mismatch, wrong iss, wrong aud, expired). Router
                   maps to HTTP 401.
      RuntimeError — when GOOGLE_CLIENT_ID is empty (server config
                     bug). Router maps to HTTP 503.
    """
    if not id_token or not isinstance(id_token, str):
        raise ValueError("Google token missing")

    audience = (settings.GOOGLE_CLIENT_ID or "").strip()
    if not audience:
        raise RuntimeError("Google Sign-In not configured (GOOGLE_CLIENT_ID empty)")

    from jose import jwt
    from jose.utils import base64url_decode
    from jose import jwk as jose_jwk

    # Step 1 — header. Refuse anything that isn't RS256.
    try:
        header = jwt.get_unverified_header(id_token)
    except Exception as exc:
        raise ValueError(f"Google token header malformed: {exc}") from exc

    # Pre-flight audience peek (logs only — the real cryptographic
    # verification happens at jwt.decode below).  The audience-mismatch
    # case has been the #1 prod misconfig because env vars on Render
    # (backend) and Vercel (frontend) live in two different places;
    # surfacing the actual aud here makes the log line trivially
    # diagnosable instead of "Google token claims invalid" with no detail.
    try:
        unverified = jwt.get_unverified_claims(id_token)
        token_aud = unverified.get("aud")
        if token_aud and token_aud != audience:
            logger.error(
                "oauth_google: AUDIENCE MISMATCH — token aud=%r but "
                "settings.GOOGLE_CLIENT_ID=%r. The frontend's "
                "VITE_GOOGLE_CLIENT_ID must match the backend's "
                "GOOGLE_CLIENT_ID exactly. See docs/DEPLOYMENT.md §1.",
                token_aud, audience,
            )
    except Exception:  # noqa: BLE001
        # Don't let diagnostic logging short-circuit real validation.
        pass
    alg = header.get("alg")
    kid = header.get("kid")
    if alg != "RS256":
        raise ValueError(f"Google token alg must be RS256 (got {alg})")
    if not kid:
        raise ValueError("Google token missing kid header")

    # Step 2 — JWK lookup, force-refresh on miss.
    keys = _fetch_jwks()
    matching = next((k for k in keys if k.get("kid") == kid), None)
    if not matching:
        keys = _fetch_jwks(force=True)
        matching = next((k for k in keys if k.get("kid") == kid), None)
    if not matching:
        raise ValueError("No Google public key matches token kid")

    # Step 3 — explicit signature verify (belt-and-braces). jose's
    # jwt.decode also checks this, but failing early with a clean
    # ValueError simplifies the router's error handling.
    try:
        public_key = jose_jwk.construct(matching)
    except Exception as exc:
        raise ValueError(f"Cannot construct Google public key: {exc}") from exc

    try:
        message, encoded_sig = id_token.rsplit(".", 1)
        decoded_sig = base64url_decode(encoded_sig.encode("utf-8"))
    except Exception as exc:
        raise ValueError(f"Google token format invalid: {exc}") from exc
    if not public_key.verify(message.encode("utf-8"), decoded_sig):
        raise ValueError("Google token signature invalid")

    # Step 4 — full decode with claim validation. We pass `issuer` as a
    # set of accepted strings via jose's `options` — jose's built-in
    # `issuer` arg is a single string, not a list, so we validate iss
    # manually below.
    try:
        claims = jwt.decode(
            id_token,
            key=matching,
            algorithms=["RS256"],
            audience=audience,
            options={"verify_aud": True, "verify_iss": False, "verify_exp": True},
        )
    except Exception as exc:
        raise ValueError(f"Google token claims invalid: {exc}") from exc

    iss = claims.get("iss")
    if iss not in _GOOGLE_ISSUERS:
        raise ValueError(f"Google token iss invalid: {iss}")

    # Step 5 — extract trustworthy fields. `email_verified` is usually
    # a real bool from Google but normalize defensively.
    raw_verified = claims.get("email_verified")
    if isinstance(raw_verified, str):
        email_verified = raw_verified.lower() == "true"
    else:
        email_verified = bool(raw_verified)

    return {
        "sub": claims.get("sub"),
        "email": claims.get("email"),
        "email_verified": email_verified,
        "name": claims.get("name") or "",
        "picture": claims.get("picture") or "",
        # Audit P1 (Task #75) — replay protection.  Google always
        # includes jti+exp on id_tokens.
        "jti": claims.get("jti"),
        "exp": claims.get("exp"),
    }
