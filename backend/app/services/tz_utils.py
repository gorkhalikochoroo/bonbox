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


def _user_zone(user) -> ZoneInfo:
    tz = (getattr(user, "timezone", None) or "Europe/Copenhagen").strip()
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


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


def utc_now() -> datetime:
    """UTC now — naive (compatible with default datetime.utcnow() callsites
    that this codebase already uses)."""
    return datetime.utcnow()
