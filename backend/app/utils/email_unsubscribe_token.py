"""
HMAC-signed unsubscribe tokens — Task #108.

Generates and verifies one-click unsubscribe tokens for transactional
emails (Daily Brief today; future: kasserapport delivery, anomaly
alerts, founder updates).

Why HMAC + a custom scheme instead of JWT:
  * Tokens go in email footers + List-Unsubscribe headers → must
    fit comfortably in a single URL line.  JWT's header+payload+sig
    triple comes in heavier than we need.
  * The payload is tiny: user_id, topic, expiry.  Three fields, one
    HMAC-SHA256.  Token is ~120 chars — paste-friendly.
  * No external dep — hmac/hashlib/base64 are stdlib.

Why this is safe:
  * SECRET_KEY signs the body.  Anyone with the key can forge tokens
    — same trust model as the JWT auth.  An attacker with the key
    can already impersonate users, so the unsubscribe surface is no
    weaker than session auth.
  * Tokens have a hard expiry (default 30 days) so a leaked email
    archive can't be replayed forever.
  * GET on the unsubscribe URL does NOT take action — only POST.
    This protects against Gmail / corporate proxy link prefetchers
    that fire GETs on every URL they see to scan for malware.
    Combined with RFC 8058's "List-Unsubscribe-Post" header, real
    one-click unsubscribes hit POST and work; prefetch GETs land on
    a confirm page.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time

logger = logging.getLogger(__name__)


def _secret() -> bytes:
    """Resolve the HMAC signing key.  Falls back to APP_SECRET_KEY then
    SECRET_KEY so we honor either env var name (matches the rest of
    the codebase's pattern)."""
    import os
    return (
        os.environ.get("APP_SECRET_KEY")
        or os.environ.get("SECRET_KEY")
        or "dev-fallback-secret-do-not-use-in-prod"
    ).encode("utf-8")


def make_unsubscribe_token(user_id: str, topic: str, ttl_days: int = 30) -> str:
    """Mint a signed unsubscribe token.

    `topic` is the per-email-type opt-out key — today only
    'daily_brief' is wired, but the scheme supports future topics
    (e.g. 'kasserapport_delivery', 'anomaly_alerts') without a model
    or URL change.
    """
    payload = {
        "u": str(user_id),
        "t": topic,
        "e": int(time.time()) + (ttl_days * 86400),
    }
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    body = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    sig = hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
    return f"{body}.{sig_b64}"


def parse_unsubscribe_token(token: str) -> dict | None:
    """Verify + decode a token.  Returns the payload dict on success
    or None on any failure (bad shape, bad signature, expired).

    Never raises — callers always get None on invalid input so we
    don't leak whether a token was malformed, forged, or merely
    expired.
    """
    if not token or not isinstance(token, str):
        return None
    parts = token.split(".", 1)
    if len(parts) != 2:
        return None
    body, sig = parts
    expected = hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest()
    expected_b64 = base64.urlsafe_b64encode(expected).rstrip(b"=").decode("ascii")
    # hmac.compare_digest avoids the short-circuit timing attack that
    # vanilla `==` would expose.
    if not hmac.compare_digest(sig, expected_b64):
        return None
    pad = "=" * (-len(body) % 4)
    try:
        raw = base64.urlsafe_b64decode(body + pad)
        payload = json.loads(raw)
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("e")
    if not isinstance(exp, int) or exp < int(time.time()):
        return None
    return payload
