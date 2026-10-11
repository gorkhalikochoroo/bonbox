"""Server-side "last seen" for an account: users.last_seen_at (11 Oct 2026).

Why this exists. The super-admin user list said "Last seen 2h ago" for an
account Manoj had just signed in to. Its only source was the newest
event_logs row, and event_logs is usage analytics the BROWSER writes — from
R-h on, only after the owner turns Analytics on in the cookie banner. An
owner who never consents would read "never seen" for ever. Signing in is not
analytics: the server knows it from the session it is already checking, so
it records it itself, here.

Two writers:
  • get_current_user (services/auth.py) — on an authenticated request, AT MOST
    once per LAST_SEEN_MIN_INTERVAL per account. The comparison runs against
    the row get_current_user has already loaded, so a fresh stamp costs
    nothing; a stale one is ONE conditional UPDATE + commit. Every request
    shares one worker and a 15-connection pool (see the stand-link _touch
    note), so this must never become a write per request.
  • sign-in endpoints — force=True, so the moment of signing in is exact.

What it records about whom. The account that signed in: the token's own
user row — an accountant or team member signing in stamps THEIR row, never
the owner whose data they view. Staff-portal (/s/:token) and host-stand
links authenticate with their own link tokens, not get_current_user, so they
never stamp an owner as seen.

Telemetry must never decide whether a request is served: any failure is
rolled back and swallowed.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy import or_, update
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.models.user import User
from app.utils.time import utc_now

LAST_SEEN_MIN_INTERVAL = timedelta(minutes=5)


def _fresh(prev, now) -> bool:
    """True when `prev` is a stamp less than the interval old (and not in the
    future — a future value is a clock error, so it is rewritten)."""
    if prev is None:
        return False
    try:
        age = (now - prev).total_seconds()
    except TypeError:  # naive/aware mismatch from a future column change
        return False
    return 0 <= age < LAST_SEEN_MIN_INTERVAL.total_seconds()


def touch_last_seen(db: Session, user: User, *, force: bool = False) -> bool:
    """Stamp `user.last_seen_at` with now (naive UTC). Returns True when a row
    was written.

    Without `force`, a stamp younger than LAST_SEEN_MIN_INTERVAL on the loaded
    row means no query at all; otherwise the UPDATE is conditional on the
    stored value still being stale, so two concurrent requests from one
    account write once. `force` (sign-in) always writes.

    Commits on the caller's session. Call it only where that session holds
    no pending work of its own (get_current_user runs before the route body;
    the sign-in endpoints call it after their own commits).
    """
    if user is None or getattr(user, "id", None) is None:
        return False
    now = utc_now()
    if not force and _fresh(user.__dict__.get("last_seen_at"), now):
        return False
    try:
        stmt = update(User).where(User.id == user.id)
        if not force:
            cutoff = now - LAST_SEEN_MIN_INTERVAL
            stmt = stmt.where(
                or_(
                    User.last_seen_at.is_(None),
                    User.last_seen_at <= cutoff,
                    User.last_seen_at > now,
                )
            )
        result = db.execute(
            stmt.values(last_seen_at=now).execution_options(synchronize_session=False)
        )
        db.commit()
    except Exception:  # noqa: BLE001 — telemetry never fails the request
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return False
    try:
        # Keep the loaded row in step so later reads in this request see the
        # stamp without a refresh query.
        set_committed_value(user, "last_seen_at", now)
    except Exception:  # noqa: BLE001
        pass
    return bool(getattr(result, "rowcount", 0))
