"""Reservation orchestration — adapts the DB world into the pure engine.

Keeps the routers thin: parses settings, builds the day's open windows
(restaurant = operating hours; appointment = the provider's published
shift), maps ORM rows into engine views, and returns bookable slots.

The pure maths live in availability_engine.py; this layer is the glue.
"""
from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta

from sqlalchemy.orm import Session

from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.staff import Schedule
from app.services.availability_engine import (
    AvailabilityConfig, BusyInterval, ResourceView, TimeWindow,
    compute_slots, find_slot_resource, turn_time_minutes,
)

# Statuses that still occupy a resource (a cancelled/no-show row frees it).
ACTIVE_STATUSES = ("requested", "confirmed", "seated")

_WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# Sensible defaults so a fresh restaurant can take bookings before it has
# touched the settings page. All overridable via reservation_settings_json.
DEFAULT_SETTINGS: dict = {
    "slot_granularity_min": 15,
    "turn_time_tiers": [
        {"up_to": 2, "minutes": 90},
        {"up_to": 4, "minutes": 105},
        {"up_to": 8, "minutes": 120},
    ],
    "default_duration_min": 90,
    "pacing_max_per_slot": None,     # None = no pacing cap
    "pacing_window_min": 15,
    "lead_time_min": 60,             # earliest bookable = now + 1h
    "max_advance_days": 60,          # how far ahead guests can book
    "max_party_size": 10,            # online ceiling — bigger → "call us"
    "group_request_threshold": 8,    # at/above → request (owner approves)
    "retention_days": 90,            # GDPR purge window after service date
    # Appointment vertical default service length when none specified.
    "default_service_duration_min": 60,
    # Fallback open window when operating_hours_json is unset.
    "fallback_open": "11:00",
    "fallback_close": "22:00",
}


def load_settings(profile: BusinessProfile | None) -> dict:
    """Merge stored JSON over the defaults (stored wins per-key)."""
    merged = dict(DEFAULT_SETTINGS)
    raw = getattr(profile, "reservation_settings_json", None) if profile else None
    if raw:
        try:
            stored = json.loads(raw)
            if isinstance(stored, dict):
                merged.update({k: v for k, v in stored.items() if v is not None})
        except (ValueError, TypeError):
            pass
    return merged


def build_config(settings: dict) -> AvailabilityConfig:
    return AvailabilityConfig(
        slot_granularity_min=int(settings.get("slot_granularity_min", 15)),
        pacing_max_per_slot=settings.get("pacing_max_per_slot") or None,
        pacing_window_min=int(settings.get("pacing_window_min", 15)),
        turn_time_tiers=settings.get("turn_time_tiers") or [],
        default_duration_min=int(settings.get("default_duration_min", 90)),
        lead_time_min=int(settings.get("lead_time_min", 0)),
        max_party_size=settings.get("max_party_size"),
    )


def _parse_hhmm(s: str) -> time | None:
    try:
        hh, mm = s.strip().split(":")
        return time(int(hh), int(mm))
    except (ValueError, AttributeError):
        return None


def restaurant_windows(profile: BusinessProfile | None, day: date,
                       settings: dict) -> list[TimeWindow]:
    """One open window for the day from operating_hours_json. Closes past
    midnight roll to the next day (e.g. '18:00-02:00')."""
    key = _WEEKDAY_KEYS[day.weekday()]
    spec = None
    raw = getattr(profile, "operating_hours_json", None) if profile else None
    if raw:
        try:
            hours = json.loads(raw)
            spec = hours.get(key) if isinstance(hours, dict) else None
        except (ValueError, TypeError):
            spec = None

    if spec == "closed":
        return []
    open_s, close_s = settings["fallback_open"], settings["fallback_close"]
    if spec and "-" in spec:
        parts = spec.split("-")
        open_s, close_s = parts[0], parts[1]

    o, c = _parse_hhmm(open_s), _parse_hhmm(close_s)
    if not o or not c:
        return []
    start = datetime.combine(day, o)
    end = datetime.combine(day, c)
    if end <= start:                       # crosses midnight
        end += timedelta(days=1)
    return [TimeWindow(start=start, end=end)]


def provider_windows(db: Session, user_id, staff_id, day: date) -> list[TimeWindow]:
    """Appointment vertical: a provider's open windows = their published
    Schedule shifts for the day."""
    if not staff_id:
        return []
    shifts = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user_id,
            Schedule.staff_id == staff_id,
            Schedule.date == day,
            Schedule.status == "published",
        )
        .all()
    )
    out: list[TimeWindow] = []
    for s in shifts:
        o, c = _parse_hhmm(s.start_time or ""), _parse_hhmm(s.end_time or "")
        if o and c:
            start = datetime.combine(day, o)
            end = datetime.combine(day, c)
            if end <= start:
                end += timedelta(days=1)
            out.append(TimeWindow(start=start, end=end))
    return out


def active_resources(db: Session, user_id) -> list[BookableResource]:
    return (
        db.query(BookableResource)
        .filter(
            BookableResource.user_id == user_id,
            BookableResource.is_active.is_(True),
            BookableResource.is_deleted.is_(False),
        )
        .order_by(BookableResource.sort_order, BookableResource.label)
        .all()
    )


def busy_for_day(db: Session, user_id, day: date) -> list[BusyInterval]:
    """Active reservations overlapping the day (+/- a margin for turns that
    straddle midnight). Cancelled / no-show rows free their resource."""
    lo = datetime.combine(day, time(0, 0)) - timedelta(hours=6)
    hi = datetime.combine(day, time(0, 0)) + timedelta(days=1, hours=6)
    rows = (
        db.query(Reservation)
        .filter(
            Reservation.user_id == user_id,
            Reservation.is_deleted.is_(False),
            Reservation.status.in_(ACTIVE_STATUSES),
            Reservation.resource_id.isnot(None),
            Reservation.starts_at < hi,
            Reservation.ends_at > lo,
        )
        .all()
    )
    return [
        BusyInterval(resource_id=str(r.resource_id), start=r.starts_at, end=r.ends_at)
        for r in rows
    ]


def _views(resources: list[BookableResource]) -> list[ResourceView]:
    return [ResourceView(id=str(r.id), capacity_seats=r.capacity_seats) for r in resources]


def available_slots(db: Session, *, profile: BusinessProfile, user_id, day: date,
                    party_size: int, now: datetime | None = None,
                    duration_min: int | None = None) -> list[datetime]:
    """Bookable start times for a party on a day. Restaurant uses the shared
    operating-hours window across all tables; appointment verticals union
    each provider's shift window."""
    settings = load_settings(profile)
    config = build_config(settings)
    resources = active_resources(db, user_id)
    busy = busy_for_day(db, user_id, day)

    providers = [r for r in resources if r.kind == "provider"]
    tables = [r for r in resources if r.kind != "provider"]

    starts: set[datetime] = set()

    # Restaurant / room tables share one operating-hours window.
    if tables:
        windows = restaurant_windows(profile, day, settings)
        if windows:
            for s in compute_slots(
                windows=windows, resources=_views(tables), busy=busy,
                party_size=party_size, config=config, now=now,
                duration_min=duration_min,
            ):
                starts.add(s.start)

    # Appointment providers each have their own shift window.
    for p in providers:
        windows = provider_windows(db, user_id, p.staff_id, day)
        if not windows:
            continue
        dur = duration_min or settings.get("default_service_duration_min", 60)
        for s in compute_slots(
            windows=windows, resources=_views([p]), busy=busy,
            party_size=party_size, config=config, now=now, duration_min=dur,
        ):
            starts.add(s.start)

    return sorted(starts)


def recheck_and_assign(db: Session, *, profile: BusinessProfile, user_id,
                       start: datetime, party_size: int,
                       now: datetime | None = None,
                       duration_min: int | None = None) -> str | None:
    """Server-side race re-check at booking time. Returns the resource id to
    assign, or None if the slot is no longer bookable."""
    settings = load_settings(profile)
    config = build_config(settings)
    resources = active_resources(db, user_id)
    busy = busy_for_day(db, user_id, start.date())

    tables = [r for r in resources if r.kind != "provider"]
    if tables:
        windows = restaurant_windows(profile, start.date(), settings)
        rid = find_slot_resource(
            requested_start=start, party_size=party_size, windows=windows,
            resources=_views(tables), busy=busy, config=config, now=now,
            duration_min=duration_min,
        )
        if rid:
            return rid

    for p in resources:
        if p.kind != "provider":
            continue
        windows = provider_windows(db, user_id, p.staff_id, start.date())
        dur = duration_min or settings.get("default_service_duration_min", 60)
        rid = find_slot_resource(
            requested_start=start, party_size=party_size, windows=windows,
            resources=_views([p]), busy=busy, config=config, now=now,
            duration_min=dur,
        )
        if rid:
            return rid
    return None


def resolve_duration(profile: BusinessProfile, party_size: int,
                     service_duration_min: int | None = None) -> int:
    settings = load_settings(profile)
    if service_duration_min:
        return int(service_duration_min)
    return turn_time_minutes(party_size, build_config(settings))
