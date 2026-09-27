"""Month by month — how many bookings and guests each month.

The book already keeps every booking: the GDPR purge only blanks the guest's
name, email and phone after the retention window; the booking row itself —
date, party size, status, source — stays. What was missing was a way to READ
that as a record: "how did September go, next to August?". This computes it.

Counts are facts, not estimates, so — unlike reservation_insights_service —
there is no confidence gate: a month with three bookings says three.

ONE set of definitions, used by the calendar's month line AND the Indsigt
table, so the two can never disagree:
  bookings   every booking except cancelled ones
  guests     party sizes of confirmed / seated / completed bookings — the same
             BOOKED_COVER_STATUSES basis the insights and the calendar use
  no_shows   bookings marked no-show
  cancelled  cancelled bookings
  online     non-cancelled bookings made on the public booking page

Months are BUSINESS months, exactly like the calendar: a booking at 01:30 on
the 1st belongs to the previous day's service, so to the previous month.
`Reservation.starts_at` is naive business-local wall-clock, so shifting it by
the cutoff and taking the date IS the business day (see tz_utils).
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from app.models.reservation import Reservation
from app.services.reservation_insights_service import BOOKED_COVER_STATUSES
from app.services.tz_utils import (
    _user_cutoff_hour,
    business_day_window_local,
    business_today_local,
)

DEFAULT_MONTHS = 12
MAX_MONTHS = 24
ONLINE_SOURCES = ("public",)


def empty_counts() -> dict:
    return {"bookings": 0, "guests": 0, "no_shows": 0, "cancelled": 0, "online": 0}


def add_booking(counts: dict, status: str | None, party_size: int | None, source: str | None) -> None:
    """Fold one booking into a month's counts (the definitions above)."""
    if status == "cancelled":
        counts["cancelled"] += 1
        return
    counts["bookings"] += 1
    if status == "no_show":
        counts["no_shows"] += 1
    if status in BOOKED_COVER_STATUSES:
        counts["guests"] += int(party_size or 0)
    if source in ONLINE_SOURCES:
        counts["online"] += 1


def business_day_of(starts_at: datetime, cutoff_hour: int) -> date:
    return (starts_at - timedelta(hours=cutoff_hour)).date()


def clamp_months(months) -> int:
    try:
        n = int(months)
    except (TypeError, ValueError):
        return DEFAULT_MONTHS
    return max(1, min(MAX_MONTHS, n))


def _shift_month(year: int, month: int, delta: int) -> tuple[int, int]:
    idx = year * 12 + (month - 1) + delta
    return idx // 12, idx % 12 + 1


def month_totals(rows, cutoff_hour: int, first_day: date, last_day: date) -> dict:
    """One month's counts from Reservation rows the caller already fetched
    (the calendar's month-load has them in hand — no second query)."""
    counts = empty_counts()
    for r in rows:
        if r.starts_at is None:
            continue
        if first_day <= business_day_of(r.starts_at, cutoff_hour) <= last_day:
            add_booking(counts, r.status, r.party_size, getattr(r, "source", None))
    return counts


def monthly_summary(db: Session, user, months=DEFAULT_MONTHS) -> dict:
    """The last `months` business months, this one included, newest first.

    Every month in the window is returned, zeros included — the client
    decides how many empty leading months are worth showing."""
    months = clamp_months(months)
    today = business_today_local(user)
    cutoff = _user_cutoff_hour(user)

    fy, fm = _shift_month(today.year, today.month, -(months - 1))
    first_day = date(fy, fm, 1)
    ny, nm = _shift_month(today.year, today.month, 1)
    last_day = date(ny, nm, 1) - timedelta(days=1)
    lo, _ = business_day_window_local(user, first_day)
    _, hi = business_day_window_local(user, last_day)

    rows = (
        db.query(Reservation.starts_at, Reservation.status, Reservation.party_size, Reservation.source)
        .filter(
            Reservation.user_id == user.id,
            Reservation.is_deleted.is_(False),
            Reservation.starts_at >= lo,
            Reservation.starts_at < hi,
        )
        .all()
    )

    buckets: dict[str, dict] = {}
    for i in range(months):
        y, m = _shift_month(fy, fm, i)
        buckets[f"{y:04d}-{m:02d}"] = empty_counts()
    for starts_at, status, party_size, source in rows:
        if starts_at is None:
            continue
        bday = business_day_of(starts_at, cutoff)
        key = f"{bday.year:04d}-{bday.month:02d}"
        if key in buckets:
            add_booking(buckets[key], status, party_size, source)

    current = f"{today.year:04d}-{today.month:02d}"
    out = [{"month": k, "current": k == current, **v} for k, v in buckets.items()]
    out.reverse()
    return {"months": out, "current_month": current}
