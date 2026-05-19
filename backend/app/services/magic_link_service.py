"""
Magic-link sign-in service (Task #61).

Two operations:
  • create_token(email, ip) → (raw_token, MagicLinkToken)
      - generates secrets.token_urlsafe(32)
      - hashes with sha256 before storage (raw token never persisted)
      - rate-limits: max 3 unused tokens per email in last 10 minutes
  • verify_token(raw_token, ip) → User
      - hashes the incoming token, looks up by hash
      - validates not expired + not already used
      - finds or self-creates the User (same first-touch behaviour as
        Google sign-in: a magic-link request for a new email creates
        the owner row on first verify, with email_verified=True
        because they clicked a link sent to their inbox)
      - marks the token consumed (single-use) on success

Multi-layer defense:
  L1 input            — Pydantic schema bounds the raw token length
  L2 hashing          — sha256 of token → DB. Defence against DB read
  L3 rate limit       — service-level cap per email; router has IP cap
  L4 expiry           — 15 min TTL
  L5 single use       — used_at gates re-use
  L6 audit log        — caller writes audit rows for requested/verified/expired

Logging discipline:
  Never log the raw token. Log the email + token_hash prefix only. The
  sha256 prefix is enough to correlate "we issued X, then verify failed
  for X" without leaking the actual credential.
"""
import hashlib
import logging
import secrets
from datetime import timedelta
from typing import Tuple

from fastapi import HTTPException, status
from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.models.magic_link_token import MagicLinkToken
from app.models.user import User
from app.services.auth import hash_password
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


# ── Tunables — kept as module constants so tests can monkeypatch. ─────

# 15 minutes is a deliberate trade-off:
#   • short enough that an exfiltrated link is mostly already useless
#   • long enough for Apple Mail / corporate spam filters that delay
#     delivery by 30-60s, plus user reading their email a few minutes
#     later (real measured behaviour at Substack: ~85% of links clicked
#     within 5 minutes; the long tail is the 15-min-and-beyond cohort)
TOKEN_TTL_MINUTES = 15

# Rate limit at the email layer (router enforces an IP-layer cap on top).
# 3 unused tokens / 10 minutes per email is enough for the legitimate
# "I didn't get the email, send another" case (Resend usually delivers
# in 5-30s; users who hit re-request more than 3x in 10 min are either
# fighting their email provider or running a bot).
RATE_LIMIT_MAX_TOKENS = 3
RATE_LIMIT_WINDOW_MIN = 10


def _hash_token(raw: str) -> str:
    """SHA-256 hex digest. Tokens are 256-bit random already, so an
    unsalted hash is fine — we just need a way to look up the row
    without storing the raw credential."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _normalize_email(email: str) -> str:
    """Lowercase + trim. Single source of truth — rate limits, DB rows,
    user lookups all use this exact form."""
    return (email or "").strip().lower()


def create_token(
    db: Session,
    email: str,
    request_ip: str | None = None,
) -> Tuple[str, MagicLinkToken]:
    """Issue a fresh magic-link token for `email`.

    Returns (raw_token, row) — the raw token is what we email to the
    user; the row has the sha256 hash + bookkeeping fields.

    Raises HTTPException(429) if the email has exceeded its rate-limit
    window. Caller catches this and either propagates the 429 (router
    can decide to translate or hide) OR swallows it and still returns
    the generic 200 to avoid enumeration (current router does the
    latter — see auth_magic_link.py).
    """
    norm_email = _normalize_email(email)

    # Rate limit — count *unused* tokens issued for this email in the
    # last RATE_LIMIT_WINDOW_MIN. Used tokens don't count (they were
    # consumed successfully and shouldn't penalise a legit user
    # requesting again).
    cutoff = utc_now() - timedelta(minutes=RATE_LIMIT_WINDOW_MIN)
    recent_count = (
        db.query(MagicLinkToken)
        .filter(
            and_(
                MagicLinkToken.email == norm_email,
                MagicLinkToken.created_at >= cutoff,
                MagicLinkToken.used_at.is_(None),
            )
        )
        .count()
    )
    if recent_count >= RATE_LIMIT_MAX_TOKENS:
        # Multi-layer: this is a defensive 429 that the caller MAY
        # choose to mask as a 200 (current router does, to prevent
        # enumeration). The exception still exists for tests +
        # admin tooling.
        logger.info(
            "magic_link: rate-limit hit email=%s count=%d",
            norm_email,
            recent_count,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "magic_link_rate_limited",
                "message": "Too many sign-in links requested. Try again in a few minutes.",
            },
        )

    # Generate the raw token. 32 bytes → 43 base64url chars; collision
    # probability for sha256 of a 256-bit random input is negligible.
    raw = secrets.token_urlsafe(32)
    token_hash = _hash_token(raw)

    now = utc_now()
    row = MagicLinkToken(
        user_id=None,  # back-patched on verify if the user resolves
        email=norm_email,
        token_hash=token_hash,
        created_at=now,
        expires_at=now + timedelta(minutes=TOKEN_TTL_MINUTES),
        used_at=None,
        request_ip=request_ip,
    )
    db.add(row)
    db.flush()

    return raw, row


def verify_token(
    db: Session,
    raw_token: str,
    used_ip: str | None = None,
) -> User:
    """Exchange a raw magic-link token for a User.

    Raises:
      HTTPException(401) — token unknown
      HTTPException(410) — token expired
      HTTPException(409) — token already used

    On success:
      • Marks the token consumed (used_at, used_ip)
      • Finds or self-creates the User (mirror of Google sign-in
        first-touch behaviour: a brand-new email on verify becomes
        an owner with email_verified=True + a 14-day Pro trial)
      • Back-patches token.user_id so the audit trail links the
        token row to the user that consumed it

    Caller is responsible for committing the session — we add+flush so
    everything's atomic with whatever audit/post-login work the router
    does, but never commit() ourselves. Same convention as audit_service.
    """
    if not raw_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "magic_link_invalid", "message": "This link is invalid."},
        )

    token_hash = _hash_token(raw_token)

    row = (
        db.query(MagicLinkToken)
        .filter(MagicLinkToken.token_hash == token_hash)
        .first()
    )
    if row is None:
        logger.info(
            "magic_link.verify: unknown token_hash=%s",
            token_hash[:12],
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "magic_link_invalid", "message": "This link is invalid."},
        )

    now = utc_now()

    # Single-use — check BEFORE expiry so an attacker who replays an
    # already-consumed token sees the same 409 a slow re-click would
    # see (avoid timing leak between expired-vs-used).
    if row.used_at is not None:
        logger.info(
            "magic_link.verify: already-used token email=%s used_at=%s",
            row.email,
            row.used_at,
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "magic_link_used", "message": "This link has already been used."},
        )

    if row.expires_at and row.expires_at < now:
        logger.info(
            "magic_link.verify: expired email=%s expired_at=%s",
            row.email,
            row.expires_at,
        )
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"code": "magic_link_expired", "message": "This link has expired. Request a new one."},
        )

    # Find or create the user. Same self-signup behaviour as Google:
    # a verified magic-link click is proof the email is real, so we
    # land the user as an owner with email_verified=True.
    user = db.query(User).filter(User.email == row.email).first()
    if user is None:
        user = User(
            email=row.email,
            # Random unguessable password — never used; the user signs
            # in via magic-link or sets a real one later through
            # /auth/reset-password.
            password_hash=hash_password(secrets.token_urlsafe(32)),
            business_name="",  # filled in via the onboarding wizard
            business_type="",
            currency="DKK",
            role="owner",
            email_verified=True,
        )
        # Start the 14-day Pro trial — parity with Google + password
        # self-signup. Magic-link users shouldn't be a second-class
        # entitlement bucket.
        try:
            from app.services.billing import start_trial

            start_trial(user)
        except Exception as e:  # noqa: BLE001
            # Non-fatal — the user can still sign in; their trial may
            # just be missing. Log loudly.
            logger.warning("magic_link.verify: start_trial failed: %s", e)
        db.add(user)
        db.flush()
    elif getattr(user, "is_locked", False):
        # Locked accounts can't bypass via magic-link either.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "account_locked", "message": "Account is locked. Contact support."},
        )

    # Burn the token. Re-issue rejected via used_at check above.
    row.used_at = now
    row.used_ip = used_ip
    row.user_id = user.id

    return user
