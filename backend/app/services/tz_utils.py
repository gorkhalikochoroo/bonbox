"""
Timezone helpers — compute "today", "this week", "yesterday" boundaries in
the VENUE's timezone so anomaly detection doesn't false-positive at UTC
midnight while it's still business hours locally.

The zone follows the venue, not the browser: users.timezone is re-synced
from the owner's browser at every login (useAuth.syncTimezoneIfChanged), so
a Danish owner who logged in from Kathmandu or Los Angeles carried that zone
into "today", the 06:00 business day, daily close and reservations. Since
12 Nov the zone is `venue_tz_name` — the same rule as the staff calendar
feed (ics_timezone.feed_zone): a DKK owner or a DK / unset country is always
Europe/Copenhagen; Portugal is Lisbon (or Madeira / the Azores when stored);
any other country keeps its stored zone.

Uses Python's stdlib `zoneinfo` (>=3.9).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from app.services.ics_timezone import feed_zone, is_dkk_owner
from app.utils.time import utc_now


# Danish restaurant convention — late-night service (e.g. closing at 02:30)
# is the SAME shift as the evening before. So a sale clocked at 02:00 local
# time belongs to YESTERDAY's business day. Used as the default cutoff when
# the user's BusinessProfile is missing or has no explicit cutoff configured.
_DEFAULT_CUTOFF_HOUR = 6


DEFAULT_TZ = "Europe/Copenhagen"

# The venue's business country, carried on the owner object: set by callers
# that already hold the BusinessProfile (a job loop, gavekort_moms._tz_user),
# or cached here after the first lookup — one query per owner object, and
# none at all for a DKK owner.
COUNTRY_ATTR = "business_country"
_UNSET = object()
_UNKNOWN = object()  # couldn't check (no session / the lookup failed)


def _zone_ok(name: str) -> bool:
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError, TypeError):
        return False


def venue_tz_name(country: str | None, currency: str | None,
                  stored_tz: str | None) -> str:
    """The IANA zone a venue's business day runs in.

    ONE rule with the staff calendar feed (ics_timezone.feed_zone):
      - a DKK (or unset-currency) owner, or a DK / empty / missing country
        -> Europe/Copenhagen, whatever users.timezone says;
      - Portugal -> Europe/Lisbon, unless the stored zone is Europe/Lisbon,
        Atlantic/Madeira or Atlantic/Azores;
      - any other country -> the stored zone.
    An invalid zone name falls back to Europe/Copenhagen.
    """
    name = feed_zone(country, currency, stored_tz) or DEFAULT_TZ
    return name if _zone_ok(name) else DEFAULT_TZ


def _business_country(user):
    """The owner's BusinessProfile.country ("" = no profile row), or _UNKNOWN.

    Read from the object when a caller put it there, else looked up once
    through the row's own session and cached on the object, so a loop calling
    now_local(user) a hundred times costs one query."""
    carried = getattr(user, COUNTRY_ATTR, _UNSET)
    if carried is not _UNSET:
        return carried or ""
    profile = getattr(user, "business_profile", None)
    if profile is not None and hasattr(profile, "country"):
        return profile.country or ""
    try:
        from sqlalchemy.orm import object_session
        sess = object_session(user)
    except Exception:  # noqa: BLE001 — not a mapped row
        sess = None
    uid = getattr(user, "id", None)
    if sess is None or uid is None:
        return _UNKNOWN
    try:
        from app.models.business_profile import BusinessProfile
        with sess.no_autoflush:
            row = (
                sess.query(BusinessProfile.country)
                .filter(BusinessProfile.user_id == uid)
                .first()
            )
    except Exception:  # noqa: BLE001 — never take a page down over a zone
        return _UNKNOWN
    country = (row[0] if row is not None else None) or ""
    try:
        setattr(user, COUNTRY_ATTR, country)
    except Exception:  # noqa: BLE001 — a read-only object just isn't cached
        pass
    return country


def owner_tz_name(user) -> str:
    """venue_tz_name for an owner row (or a light object that carries
    `currency` and, optionally, `business_country`).

    An object with no `currency` at all is not an owner row but a bare zone
    holder — its `timezone` is read as given (invalid -> UTC), as before.
    """
    if user is None:
        return DEFAULT_TZ
    stored = getattr(user, "timezone", None)
    if not hasattr(user, "currency"):
        name = (stored or DEFAULT_TZ).strip()
        return name if _zone_ok(name) else "UTC"
    currency = getattr(user, "currency", None)
    if is_dkk_owner(currency):
        return DEFAULT_TZ          # no country lookup for a Danish owner
    country = _business_country(user)
    if country is _UNKNOWN:
        # Couldn't read the country (a detached object, a failed query):
        # the stored zone, as before this rule existed — never a guess.
        name = (stored or DEFAULT_TZ).strip()
        return name if _zone_ok(name) else DEFAULT_TZ
    return venue_tz_name(country, currency, stored)


def venue_zone(user) -> ZoneInfo:
    """The venue's ZoneInfo for an owner — see owner_tz_name."""
    return ZoneInfo(owner_tz_name(user))


def _user_zone(user) -> ZoneInfo:
    # Kept under its old name: ~15 modules import it. It is the VENUE's zone.
    return venue_zone(user)


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

    Combines the venue's timezone (`venue_zone`: Europe/Copenhagen for a
    Danish venue, whatever the owner's browser said) with their cutoff hour (`BusinessProfile.day_cutoff_hour`, default 6).
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
    "venue_tz_name",
    "owner_tz_name",
    "venue_zone",
    "now_local",
    "today_local",
    "week_start_local",
    "utc_window_for_local_day",
    "business_day_window",
    "business_today_local",
    "utc_now",
]
