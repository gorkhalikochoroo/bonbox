"""Read-only "Needs du nu" diagnosis — named detectors over data we already
have.

This is the SAFE half of the auto-diagnosis idea (the catastrophic "auto-repair"
half is red-lined). Every detector here strictly OBSERVES and ROUTES: it returns
a typed finding with a deep-link to the exact spot, and NEVER mutates a value,
auto-resolves a discrepancy, or picks a side on a money question. Detectors
fail-SOFT — a broken or slow detector drops its own finding and never breaks the
queue. No new model, no inference: cheap rule-checks on existing rows.

Output contract (kept structured, NOT human strings): the frontend renders the
localized title/detail/action keyed on `code` + `meta`, so DK terminology and
i18n stay on the client.

    {
      "code": "unconfirmed_reservations",   # stable detector id
      "severity": "info" | "warn" | "urgent",
      "meta": { ... small values the UI interpolates ... },
      "deep_link": "/reservations",          # reuses the #1 deep-link grammar
    }
"""
import logging
from datetime import timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.reservation import Reservation
from app.models.payment_connection import PaymentConnection
from app.models.daily_close import DailyClose
from app.services.tz_utils import today_local
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

_STALE_FEED_DAYS = 3
_CLOSES_REGULARLY_MIN = 3   # confirmed closes in the last 14 days
_REGULAR_WINDOW_DAYS = 14


def _finding(code, severity, deep_link, meta=None):
    return {"code": code, "severity": severity, "deep_link": deep_link, "meta": meta or {}}


def _detect_unconfirmed_reservations(db: Session, user, now):
    """Upcoming bookings still 'requested' (awaiting the owner's approval)."""
    cnt = (
        db.query(func.count(Reservation.id))
        .filter(
            Reservation.user_id == user.id,
            Reservation.status == "requested",
            Reservation.starts_at >= now,
            Reservation.deleted_at.is_(None),
        )
        .scalar()
    ) or 0
    if cnt <= 0:
        return None
    return _finding(
        "unconfirmed_reservations",
        "warn" if cnt >= 3 else "info",
        "/reservations",
        {"count": int(cnt)},
    )


def _detect_stale_bank_feed(db: Session, user, now):
    """An active auto-sync connection that hasn't pulled in a while → the
    revenue/MOMS picture may be behind. Read-only: we point at Connections,
    never silently 'fix' it."""
    cutoff = now - timedelta(days=_STALE_FEED_DAYS)
    conn = (
        db.query(PaymentConnection)
        .filter(
            PaymentConnection.user_id == user.id,
            PaymentConnection.is_active.is_(True),
            PaymentConnection.auto_sync.is_(True),
        )
        .order_by(PaymentConnection.last_synced_at.is_(None).desc(),
                  PaymentConnection.last_synced_at.asc())
        .first()
    )
    if not conn:
        return None
    last = conn.last_synced_at
    if last is not None and last >= cutoff:
        return None  # fresh enough
    days = None
    if last is not None:
        days = max(0, (now - last).days)
    return _finding(
        "stale_bank_feed",
        "warn",
        "/connections",
        {"provider": conn.provider, "days": days},
    )


def _detect_close_missing(db: Session, user, now):
    """If the owner closes regularly but yesterday has no confirmed close,
    gently nudge. Gated on 'closes regularly' so it never nags a business that
    doesn't run a daily close."""
    today = today_local(user)
    yesterday = today - timedelta(days=1)
    window_start = today - timedelta(days=_REGULAR_WINDOW_DAYS)

    regular = (
        db.query(func.count(DailyClose.id))
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.status == "confirmed",
            DailyClose.date >= window_start,
            DailyClose.deleted_at.is_(None),
        )
        .scalar()
    ) or 0
    if regular < _CLOSES_REGULARLY_MIN:
        return None

    has_yday = (
        db.query(DailyClose.id)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date == yesterday,
            DailyClose.status == "confirmed",
            DailyClose.deleted_at.is_(None),
        )
        .first()
    )
    if has_yday:
        return None
    return _finding(
        "close_missing",
        "info",
        "/daily-close",
        {"date": yesterday.isoformat()},
    )


# Registry — add a detector here and it joins the queue. Each runs guarded.
_DETECTORS = [
    _detect_unconfirmed_reservations,
    _detect_stale_bank_feed,
    _detect_close_missing,
]

# Severity ordering for a stable, owner-friendly sort (urgent first).
_SEVERITY_RANK = {"urgent": 0, "warn": 1, "info": 2}


def run_diagnostics(db: Session, user, *, now=None) -> list[dict]:
    """Run all detectors, fail-soft per detector, return findings sorted by
    severity (urgent first). Read-only — mutates nothing."""
    now = now or utc_now()
    findings: list[dict] = []
    for detect in _DETECTORS:
        try:
            f = detect(db, user, now)
            if f:
                findings.append(f)
        except Exception:  # noqa: BLE001 — one bad detector must not break the queue
            logger.exception("diagnostics detector failed: %s", getattr(detect, "__name__", "?"))
    findings.sort(key=lambda f: _SEVERITY_RANK.get(f.get("severity"), 9))
    return findings
