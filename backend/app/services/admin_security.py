"""
Multi-layer guard for super-admin endpoints.

Defense-in-depth — each layer is independent. If any one is bypassed, the next
still catches. All denials return the same generic 404 so an attacker cannot
distinguish between "not an admin" and "admin endpoint exists." Every access
attempt is audited via SecurityEvent.

To grant a user super_admin access, BOTH must be true:
  1. Their email must be in the SUPER_ADMIN_EMAILS env var (comma-separated)
  2. Their `users.role` column must be set to `super_admin` (via DB, never API)

There is intentionally NO endpoint to elevate role to super_admin — it must
be set manually in the database. This prevents privilege escalation through
any API path, however unlikely.
"""

import hmac
import logging
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.services.auth import get_current_user

logger = logging.getLogger(__name__)


# Generic denial — same response for every failure mode.
# 404 (not 403) chosen so the existence of /admin/* endpoints is not even
# leaked to non-admin authenticated users.
_DENIED = HTTPException(
    status_code=status.HTTP_404_NOT_FOUND,
    detail="Not found",
)


def _allowed_emails() -> list[str]:
    """Parse the SUPER_ADMIN_EMAILS env var (comma-separated)."""
    raw = getattr(settings, "SUPER_ADMIN_EMAILS", "") or ""
    return [e.strip().lower() for e in raw.split(",") if e.strip()]


def _safe_email_match(user_email: str, allowed: list[str]) -> bool:
    """
    Constant-time match against allowlist to prevent email-based timing
    attacks. We can't avoid the loop, but each comparison itself is timing-
    safe via hmac.compare_digest.
    """
    if not user_email or not allowed:
        return False
    needle = user_email.strip().lower().encode("utf-8")
    matched = False
    for entry in allowed:
        candidate = entry.encode("utf-8")
        # OR-equal so we don't short-circuit out of the loop on first match —
        # total runtime is independent of where (or whether) the match is.
        if hmac.compare_digest(needle, candidate):
            matched = True
    return matched


def _audit(
    db: Session,
    user_id,
    event_type: str,
    request: Request,
    detail: str | None = None,
) -> None:
    """Best-effort audit log — never fails the request."""
    try:
        ip = request.client.host if request and request.client else None
        ua = request.headers.get("user-agent", "")[:500] if request else None
        evt = SecurityEvent(
            user_id=user_id,
            event_type=event_type,
            ip_address=ip,
            user_agent=ua,
            detail=detail,
        )
        db.add(evt)
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("Failed to write security event: %s", e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def require_super_admin(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> User:
    """
    6-layer admin guard. Returns the authenticated super-admin user, or raises
    a generic 404 (audited) on any failure.

      L1: Valid JWT (handled by get_current_user — already raised if invalid)
      L2: Allowlist must be configured (no allowlist = no admin access ever)
      L3: user.role == 'super_admin'
      L4: user.email matches SUPER_ADMIN_EMAILS allowlist (constant-time)
      L5: user.email_verified == True
      L6: Account age >= 24h (defense against fresh-signup escalation)

    Every call writes a SecurityEvent for forensic visibility.
    """
    allowed = _allowed_emails()

    # L2 — no allowlist configured: refuse universally
    if not allowed:
        _audit(db, user.id, "admin_denied_no_allowlist", request)
        raise _DENIED

    # L3 — role check
    if user.role != "super_admin":
        _audit(
            db,
            user.id,
            "admin_denied_wrong_role",
            request,
            detail=f"role={user.role}",
        )
        raise _DENIED

    # L4 — email allowlist (constant-time)
    if not _safe_email_match(user.email, allowed):
        _audit(db, user.id, "admin_denied_email_mismatch", request)
        raise _DENIED

    # L5 — email must be verified
    if not user.email_verified:
        _audit(db, user.id, "admin_denied_email_unverified", request)
        raise _DENIED

    # L6 — account must be at least 24 hours old
    age = datetime.utcnow() - user.created_at
    if age < timedelta(hours=24):
        _audit(
            db,
            user.id,
            "admin_denied_account_too_new",
            request,
            detail=f"age_hours={age.total_seconds() / 3600:.1f}",
        )
        raise _DENIED

    # L7 — brute-force lockout: if this user has too many recent denials,
    # refuse for a cooldown window even if all other layers pass. Prevents
    # an attacker who finds one valid layer (e.g. compromises an account)
    # from probing the others rapidly.
    threshold = int(getattr(settings, "ADMIN_LOCKOUT_THRESHOLD", 5))
    window_min = int(getattr(settings, "ADMIN_LOCKOUT_WINDOW_MIN", 10))
    cooldown_min = int(getattr(settings, "ADMIN_LOCKOUT_COOLDOWN_MIN", 15))
    window_start = datetime.utcnow() - timedelta(minutes=window_min)
    recent_denials = (
        db.query(SecurityEvent)
        .filter(
            SecurityEvent.user_id == user.id,
            SecurityEvent.event_type.like("admin_denied_%"),
            SecurityEvent.created_at >= window_start,
        )
        .count()
    )
    if recent_denials >= threshold:
        # Check if we're still in cooldown by looking at the most-recent denial
        last_denial = (
            db.query(SecurityEvent.created_at)
            .filter(
                SecurityEvent.user_id == user.id,
                SecurityEvent.event_type.like("admin_denied_%"),
            )
            .order_by(SecurityEvent.created_at.desc())
            .first()
        )
        if last_denial:
            since_last = datetime.utcnow() - last_denial[0]
            if since_last < timedelta(minutes=cooldown_min):
                _audit(
                    db,
                    user.id,
                    "admin_denied_lockout",
                    request,
                    detail=f"recent_denials={recent_denials} cooldown_min={cooldown_min}",
                )
                raise _DENIED

    # All layers passed — record success
    _audit(db, user.id, "admin_access_granted", request)
    return user
