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
from datetime import date, timedelta  # noqa: F401 — `date` used in type hint string

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.reservation import Reservation
from app.models.payment_connection import PaymentConnection
from app.models.daily_close import DailyClose
from app.services.tz_utils import today_local, business_today_local
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

_STALE_FEED_DAYS = 3
_CLOSES_REGULARLY_MIN = 3   # confirmed closes in the last 14 days
_REGULAR_WINDOW_DAYS = 14

# A draft close older than this (business days) is "stale" — the day is done
# but the report was never locked, so nothing has tied out yet.
_STALE_DRAFT_DAYS = 2
# Confirmed-but-unreconciled closes are intentionally NOT time-windowed:
# a locked, revisor-bound close that doesn't tie out matters MORE the
# longer it sits unfixed, not less. We surface only the single worst, so
# there is no recency blind spot (an old confirmed mismatch used to
# vanish silently after ~31 days — exactly the worst item to drop).
# A CONFIRMED close only counts as a CLEAR mismatch when the gap is BOTH
# absolutely large (>100 kr) AND relatively large (>5%). Conservative on
# purpose: tips / rounding / gift cards legitimately move a tied-out close a
# little, and a false "doesn't tie out" on a locked report destroys trust.
_UNRECONCILED_ABS_KR = 100.0
_UNRECONCILED_PCT = 0.05
# A draft "ties out" when payments and revenue agree within rounding noise.
_TIE_OUT_ABS_KR = 1.0
_TIE_OUT_PCT = 0.005


def _close_date(close) -> "date | None":  # noqa: F821 — date is a runtime type
    """The close's business date, falling back to created_at's date."""
    d = getattr(close, "date", None)
    if d is not None:
        return d
    created = getattr(close, "created_at", None)
    return created.date() if created is not None else None


def _ties_out(payment_total, revenue_total) -> bool:
    """True when payments ≈ revenue within rounding noise (<=1 kr or 0.5%)."""
    rev = float(revenue_total or 0)
    pay = float(payment_total or 0)
    return abs(pay - rev) <= max(_TIE_OUT_ABS_KR, _TIE_OUT_PCT * rev)


def _finding(code, severity, deep_link, meta=None):
    return {"code": code, "severity": severity, "deep_link": deep_link, "meta": meta or {}}


def _detect_unconfirmed_reservations(db: Session, user, now, skip=frozenset()):
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


def _detect_stale_bank_feed(db: Session, user, now, skip=frozenset()):
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


def _detect_close_missing(db: Session, user, now, skip=frozenset()):
    """If the owner closes regularly but yesterday has no confirmed close,
    gently nudge. Gated on 'closes regularly' so it never nags a business that
    doesn't run a daily close."""
    today = today_local(user)
    yesterday = today - timedelta(days=1)
    if ("close_missing", yesterday.isoformat()) in skip:
        return None
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


def _detect_stale_draft_close(db: Session, user, now, skip=frozenset()):
    """A daily close left in DRAFT for >2 business days — the day is over but
    the report was never locked, so its numbers haven't tied out and it can't
    reach the revisor. We surface the OLDEST offender (the one most at risk),
    and flag whether its payments even agree with its revenue so the message
    can say "…der ikke stemmer". Read-only: we point at the close, never lock
    or alter it."""
    cutoff_day = business_today_local(user) - timedelta(days=_STALE_DRAFT_DAYS)

    drafts = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.status == "draft",
            DailyClose.is_deleted.isnot(True),
        )
        .all()
    )
    stale = []
    for c in drafts:
        d = _close_date(c)
        if d is None or d >= cutoff_day:
            continue
        if ("stale_draft_close", d.isoformat()) in skip:
            continue
        stale.append((d, c))
    if not stale:
        return None

    stale.sort(key=lambda pair: pair[0])  # oldest first
    oldest_date, oldest = stale[0]
    revenue_total = float(oldest.revenue_total or 0)
    payment_total = float(oldest.payment_total or 0)
    return _finding(
        "stale_draft_close",
        "warn",
        f"/daily-close?date={oldest_date.isoformat()}",
        {
            "date": oldest_date.isoformat(),
            "count": len(stale),
            "revenue_total": revenue_total,
            "payment_total": payment_total,
            "ties_out": _ties_out(payment_total, revenue_total),
        },
    )


def _detect_close_unreconciled(db: Session, user, now, skip=frozenset()):
    """A CONFIRMED (locked) close whose payments clearly don't match its
    revenue — the kind of mismatch that must NOT silently flow to the revisor.
    Conservative by design (>5% AND >100 kr): tips, rounding and gift cards
    legitimately move a tied-out close a little, and a false alarm on a locked
    report would destroy owner trust. We surface the single WORST (largest
    gap) across ALL the owner's confirmed closes — intentionally NOT
    time-windowed: a locked, revisor-bound close that doesn't tie out
    matters more the longer it sits unfixed, and worst-only keeps it to
    one calm item. Read-only: we route the owner to the close, never
    'reconcile' it ourselves."""
    closes = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.status == "confirmed",
            DailyClose.is_deleted.isnot(True),
        )
        .all()
    )
    worst = None
    worst_diff = 0.0
    for c in closes:
        revenue_total = float(c.revenue_total or 0)
        if revenue_total <= 0:
            continue
        c_date = _close_date(c)
        if c_date is not None and ("close_unreconciled", c_date.isoformat()) in skip:
            continue
        payment_total = float(c.payment_total or 0)
        diff = abs(payment_total - revenue_total)
        if diff > max(_UNRECONCILED_ABS_KR, _UNRECONCILED_PCT * revenue_total):
            if diff > worst_diff:
                worst_diff = diff
                worst = c
    if worst is None:
        return None

    worst_date = _close_date(worst)
    revenue_total = float(worst.revenue_total or 0)
    payment_total = float(worst.payment_total or 0)
    return _finding(
        "close_unreconciled",
        "urgent",
        f"/daily-close?date={worst_date.isoformat()}" if worst_date else "/daily-close",
        {
            "date": worst_date.isoformat() if worst_date else None,
            "revenue_total": revenue_total,
            "payment_total": payment_total,
            "diff": round(payment_total - revenue_total, 2),
        },
    )


# Registry — add a detector here and it joins the queue. Each runs guarded.
_DETECTORS = [
    _detect_unconfirmed_reservations,
    _detect_stale_bank_feed,
    _detect_close_missing,
    _detect_stale_draft_close,
    _detect_close_unreconciled,
]

# Severity ordering for a stable, owner-friendly sort (urgent first).
_SEVERITY_RANK = {"urgent": 0, "warn": 1, "info": 2}


def run_diagnostics(db: Session, user, *, now=None, skip=None) -> list[dict]:
    """Run all detectors, fail-soft per detector, return findings sorted by
    severity (urgent first). Read-only — mutates nothing.

    `skip` is a set of (code, iso_date) the owner dismissed client-side.
    It is threaded INTO the worst-only/oldest-only detectors (not just
    post-filtered) so dismissing the worst finding surfaces the next-worst
    instead of silently masking every other broken close behind it."""
    now = now or utc_now()
    skip = frozenset(skip or ())
    findings: list[dict] = []
    for detect in _DETECTORS:
        try:
            f = detect(db, user, now, skip)
            if f:
                findings.append(f)
        except Exception:  # noqa: BLE001 — one bad detector must not break the queue
            logger.exception("diagnostics detector failed: %s", getattr(detect, "__name__", "?"))
    findings.sort(key=lambda f: _SEVERITY_RANK.get(f.get("severity"), 9))
    return findings
