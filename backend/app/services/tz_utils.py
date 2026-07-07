"""
Timezone helpers — compute "today", "this week", "yesterday" boundaries in
each user's local timezone so anomaly detection doesn't false-positive at
UTC midnight while it's still business hours locally.

Uses Python's stdlib `zoneinfo` (>=3.9). Falls back to UTC if the user's
timezone string is invalid (which would only happen if someone manually
corrupted the value in the DB).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from app.utils.time import utc_now


# Danish restaurant convention — late-night service (e.g. closing at 02:30)
# is the SAME shift as the evening before. So a sale clocked at 02:00 local
# time belongs to YESTERDAY's business day. Used as the default cutoff when
# the user's BusinessProfile is missing or has no explicit cutoff configured.
_DEFAULT_CUTOFF_HOUR = 6


def _user_zone(user) -> ZoneInfo:
    tz = (getattr(user, "timezone", None) or "Europe/Copenhagen").strip()
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _user_cutoff_hour(user) -> int:
    """Resolve the business-day cutoff hour for the user, clamped to [0,23].

    Lookup order:
      1. `user.business_profile.day_cutoff_hour` (when the relationship is
         eagerly loaded — current schema does NOT have this relationship,
         but defensive in case it's added later).
      2. `user.day_cutoff_hour` (some legacy paths stash it on the user).
      3. The Danish restaurant default (06:00).

    Why this lives on the user object and not via a DB session: the helper
    is called from ~12 places, half of which are deep inside aggregation
    loops where adding a `db.query(BusinessProfile)…` would explode latency.
    Callers that have a session should populate `user.day_cutoff_hour`
    once at the top of the request (see dashboard.py / property_report.py
    for the pattern), then pass `user` down without further lookups.
    """
    raw = None
    profile = getattr(user, "business_profile", None)
    if profile is not None:
        raw = getattr(profile, "day_cutoff_hour", None)
    if raw is None:
        raw = getattr(user, "day_cutoff_hour", None)
    if raw is None:
        return _DEFAULT_CUTOFF_HOUR
    try:
        hour = int(raw)
    except (TypeError, ValueError):
        return _DEFAULT_CUTOFF_HOUR
    # Clamp — protects against DB rows that smuggled in a junk value
    # before the BusinessProfile validator existed.
    if hour < 0:
        return 0
    if hour > 23:
        return 23
    return hour


def now_local(user) -> datetime:
    """Current datetime in the user's local timezone."""
    return datetime.now(_user_zone(user))


def today_local(user) -> date:
    """Today's calendar date as the user sees it."""
    return now_local(user).date()


def week_start_local(user) -> date:
    """Monday of the current week, in the user's TZ."""
    today = today_local(user)
    return today - timedelta(days=today.weekday())


def utc_window_for_local_day(user, d: date) -> tuple[datetime, datetime]:
    """
    Return the UTC [start, end) datetimes that contain the given local
    calendar day. Useful when filtering UTC-stored timestamps by a local
    date range.
    """
    tz = _user_zone(user)
    start_local = datetime.combine(d, datetime.min.time(), tzinfo=tz)
    end_local = start_local + timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def business_day_window(user, target_date: date | None = None) -> tuple[datetime, datetime]:
    """UTC [start, end) for the user's local business day.

    Combines the user's timezone (`User.timezone`, default Europe/Copenhagen)
    with their cutoff hour (`BusinessProfile.day_cutoff_hour`, default 6).
    A 02:00 CEST event belongs to YESTERDAY's business day — that's the
    drift we're squashing across dashboard / property report / live KPIs.

    If `target_date` is omitted, returns the window for the CURRENT
    business day (i.e. the business date the wall-clock right-now falls in).
    Pre-cutoff times resolve to yesterday's window; post-cutoff to today's.

    Returns timezone-aware UTC datetimes. Half-open interval: the END time
    of one business day equals the START of the next. Callers wanting a
    date-based filter (`Sale.date == d`) should use `business_today_local`
    instead and pass the resulting date to their query.
    """
    tz = _user_zone(user)
    cutoff = _user_cutoff_hour(user)

    if target_date is None:
        target_date = business_today_local(user)

    # Anchor the business day at `target_date` cutoff:00 local AND the
    # next day's cutoff:00 local, then convert each to UTC independently.
    # CRITICAL: do NOT use `start_local + timedelta(days=1)` here — that
    # adds 24h of UTC time, not 24h of WALL-CLOCK local time. On the
    # Sunday Europe/Copenhagen falls back (CEST→CET) the business day is
    # genuinely 25 hours long; on the spring-forward Sunday it's 23. The
    # helper has to faithfully reflect that or the property report
    # silently loses (or double-counts) 1h of late-night sales twice a
    # year — which is exactly the class of drift this whole audit (#148)
    # is squashing.
    start_local = datetime.combine(
        target_date, datetime.min.time(), tzinfo=tz,
    ).replace(hour=cutoff)
    next_date = target_date + timedelta(days=1)
    end_local = datetime.combine(
        next_date, datetime.min.time(), tzinfo=tz,
    ).replace(hour=cutoff)

    return (
        start_local.astimezone(timezone.utc),
        end_local.astimezone(timezone.utc),
    )


def business_today_local(user) -> date:
    """The date the current business day belongs to.

    Pre-cutoff time returns yesterday's date — so a 03:00 CEST query for
    "today's revenue" returns the date of the shift that's still in
    progress (which started before midnight). Matches the restaurant
    operator's mental model.
    """
    tz = _user_zone(user)
    cutoff = _user_cutoff_hour(user)
    now = datetime.now(tz)
    if now.hour < cutoff:
        return (now - timedelta(days=1)).date()
    return now.date()


def business_day_window_local(user, target_date: date | None = None) -> tuple[datetime, datetime]:
    """NAIVE-local [start, end) for the user's business day.

    Same cutoff semantics as `business_day_window`, but returns NAIVE local
    datetimes instead of UTC — for filtering columns stored as naive
    business-local wall-clock (e.g. `Reservation.starts_at`). A 23:30 booking
    belongs to that evening's service; a 02:00 booking belongs to the PREVIOUS
    day's service (before the cutoff). Half-open: the END of one business day
    equals the START of the next.

    Because both the bounds and the compared column are naive local wall-clock,
    the comparison is pure wall-clock and DST-safe (no UTC round-trip needed).
    """
    cutoff = _user_cutoff_hour(user)
    if target_date is None:
        target_date = business_today_local(user)
    cutoff_time = datetime.min.time().replace(hour=cutoff)
    lo = datetime.combine(target_date, cutoff_time)
    hi = datetime.combine(target_date + timedelta(days=1), cutoff_time)
    return (lo, hi)


# Note: `utc_now` is intentionally re-exported from `app.utils.time` via the
# top-of-file import. Do NOT define a wrapper here — a previous wrapper
# shadowed the import and recursed into itself (RecursionError landmine).
# Callers using `from app.services.tz_utils import utc_now` keep working;
# this module is a one-stop shop for time/TZ helpers.
__all__ = [
    "now_local",
    "today_local",
    "week_start_local",
    "utc_window_for_local_day",
    "business_day_window",
    "business_today_local",
    "utc_now",
]
