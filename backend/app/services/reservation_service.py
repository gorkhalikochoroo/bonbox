"""Reservation orchestration — adapts the DB world into the pure engine.

Keeps the routers thin: parses settings, builds the day's open windows
(restaurant = operating hours; appointment = the provider's published
shift), maps ORM rows into engine views, and returns bookable slots.

The pure maths live in availability_engine.py; this layer is the glue.
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, time, timedelta

from sqlalchemy.orm import Session

from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.staff import Schedule
from app.services.availability_engine import (
    AvailabilityConfig, BusyInterval, ResourceView, TimeWindow,
    combinable_zone_overflow, compute_slots, find_slot_resource,
    find_slot_resources, turn_time_minutes,
)

logger = logging.getLogger(__name__)

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
    # Table combining: push 2+ combinable same-zone tables together for a
    # party no single table fits (a 6 across a 4-top + 2-top). On by default,
    # but inert until the owner flags tables `combinable` — so a fresh floor
    # behaves exactly as before. max_combo_size caps tables per seating.
    "combine_enabled": True,
    "max_combo_size": 3,
    "retention_days": 90,            # GDPR purge window after service date
    # Appointment vertical default service length when none specified.
    "default_service_duration_min": 60,
    # SMS reminders (Pro): owner opt-in, off by default. sms_sender is the
    # alphanumeric sender ID shown on the text (max 11 chars).
    "sms_reminders": False,
    "sms_sender": "BonBox",
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
        combine_enabled=bool(settings.get("combine_enabled", True)),
        max_combo_size=int(settings.get("max_combo_size", 3) or 3),
    )


def _parse_hhmm(s: str) -> time | None:
    try:
        hh, mm = s.strip().split(":")
        return time(int(hh), int(mm))
    except (ValueError, AttributeError):
        return None


def restaurant_windows(profile: BusinessProfile | None, day: date,
                       settings: dict) -> list[TimeWindow]:
    """The day's open window for bookings. Source precedence:
      1. `booking_hours` in reservation settings — owner-set "we take bookings
         Mon 17:00–23:00, Tue closed, …" (a dict keyed by mon..sun, values
         "HH:MM-HH:MM" or "closed"). This is the explicit control.
      2. the business's `operating_hours_json` (same format),
      3. the `fallback_open`/`fallback_close` defaults.
    Closes past midnight roll to the next day (e.g. '18:00-02:00')."""
    key = _WEEKDAY_KEYS[day.weekday()]
    spec = None

    # 1. Reservation-specific booking hours win (owner sets them in Settings).
    bh = settings.get("booking_hours")
    if isinstance(bh, dict) and bh.get(key):
        spec = bh.get(key)

    # 2. Else fall back to the business's operating hours.
    if spec is None:
        raw = getattr(profile, "operating_hours_json", None) if profile else None
        if raw:
            try:
                hours = json.loads(raw)
                spec = hours.get(key) if isinstance(hours, dict) else None
            except (ValueError, TypeError):
                spec = None

    if spec == "closed":
        return []
    # 3. Else the fallback open/close.
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
    """What's occupied on the day (+/- a margin for turns that straddle
    midnight). Read from `reservation_occupancy` — the SAME source of truth the
    DB exclusion constraint enforces — so a combined seating contributes one
    busy interval PER table (a 6-top booking across a 4-top + 2-top blocks
    BOTH), and a cancelled/no-show/completed reservation (its rows flipped
    active=FALSE) frees its tables automatically. A `requested` group hold owns
    no occupancy row, so it correctly blocks nothing until approved."""
    lo = datetime.combine(day, time(0, 0)) - timedelta(hours=6)
    hi = datetime.combine(day, time(0, 0)) + timedelta(days=1, hours=6)
    rows = (
        db.query(ReservationOccupancy)
        .filter(
            ReservationOccupancy.user_id == user_id,
            ReservationOccupancy.active.is_(True),
            ReservationOccupancy.starts_at < hi,
            ReservationOccupancy.ends_at > lo,
        )
        .all()
    )
    return [
        BusyInterval(resource_id=str(o.resource_id), start=o.starts_at, end=o.ends_at)
        for o in rows
    ]


def _views(resources: list[BookableResource]) -> list[ResourceView]:
    return [
        ResourceView(
            id=str(r.id), capacity_seats=r.capacity_seats,
            combinable=bool(getattr(r, "combinable", False)), zone=r.zone,
        )
        for r in resources
    ]


def _log_combo_overflow(views: list[ResourceView]) -> None:
    """Honest-claims: if any zone has more combinable tables than the engine's
    per-zone search cap, the search only considers the smallest ones — say so
    in the log rather than silently capping coverage. No-op for normal floors."""
    for zone, count in combinable_zone_overflow(views):
        logger.warning(
            "reservation combine: zone %r has %d combinable tables — only the "
            "smallest are considered for combinations (per-zone search cap).",
            zone, count,
        )


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
            table_views = _views(tables)
            if config.combine_enabled:
                _log_combo_overflow(table_views)
            for s in compute_slots(
                windows=windows, resources=table_views, busy=busy,
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


def recheck_and_assign_combo(db: Session, *, profile: BusinessProfile, user_id,
                             start: datetime, party_size: int,
                             now: datetime | None = None,
                             duration_min: int | None = None) -> list[str] | None:
    """Server-side race re-check at booking time, combo-aware. Returns the full
    table set to assign — one id for a single table, or two+ when the party can
    only be seated by combining tables — or None if no longer bookable.

    Restaurant tables are checked first (and may combine); appointment
    providers each carry capacity 1 and never combine, so they return at most a
    single id. The caller writes one occupancy row per id, atomically."""
    settings = load_settings(profile)
    config = build_config(settings)
    resources = active_resources(db, user_id)
    busy = busy_for_day(db, user_id, start.date())

    tables = [r for r in resources if r.kind != "provider"]
    if tables:
        windows = restaurant_windows(profile, start.date(), settings)
        table_views = _views(tables)
        if config.combine_enabled:
            _log_combo_overflow(table_views)
        ids = find_slot_resources(
            requested_start=start, party_size=party_size, windows=windows,
            resources=table_views, busy=busy, config=config, now=now,
            duration_min=duration_min,
        )
        if ids:
            return ids

    for p in resources:
        if p.kind != "provider":
            continue
        windows = provider_windows(db, user_id, p.staff_id, start.date())
        dur = duration_min or settings.get("default_service_duration_min", 60)
        ids = find_slot_resources(
            requested_start=start, party_size=party_size, windows=windows,
            resources=_views([p]), busy=busy, config=config, now=now,
            duration_min=dur,
        )
        if ids:
            return ids
    return None


def recheck_and_assign(db: Session, *, profile: BusinessProfile, user_id,
                       start: datetime, party_size: int,
                       now: datetime | None = None,
                       duration_min: int | None = None) -> str | None:
    """Single-id back-compat wrapper over `recheck_and_assign_combo` — returns
    the PRIMARY table to assign (or None). Kept for callers that don't yet
    handle combined seatings; new code should use the combo variant."""
    ids = recheck_and_assign_combo(
        db, profile=profile, user_id=user_id, start=start,
        party_size=party_size, now=now, duration_min=duration_min,
    )
    return ids[0] if ids else None


def resolve_duration(profile: BusinessProfile, party_size: int,
                     service_duration_min: int | None = None) -> int:
    settings = load_settings(profile)
    if service_duration_min:
        return int(service_duration_min)
    return turn_time_minutes(party_size, build_config(settings))


def public_floor(db: Session, *, profile: BusinessProfile, user_id,
                 start: datetime, party_size: int,
                 duration_min: int | None = None,
                 now: datetime | None = None) -> list[dict]:
    """Per-table availability for the PUBLIC floor map at a specific start time.

    For each ACTIVE dining table, classify it for `party_size` at `start`:
      • "free"        — not occupied for [start, start+duration) AND seats ≥ party
      • "small"       — free but seats < party (can't seat the party alone; the
                        engine may still combine it — just not individually pickable)
      • "unavailable" — occupied by another booking at that interval

    Returns LAYOUT-ONLY data (label, capacity, zone, shape, pos_x/pos_y, status)
    — never guest names, booking ids, or any PII. Providers (appointment kind)
    are excluded; the public floor is a dining room, not a staff calendar."""
    resources = [r for r in active_resources(db, user_id) if r.kind != "provider"]
    dur = duration_min or resolve_duration(profile, party_size)
    end = start + timedelta(minutes=dur)
    busy = busy_for_day(db, user_id, start.date())
    busy_ids = {b.resource_id for b in busy if b.start < end and start < b.end}

    out: list[dict] = []
    for r in resources:
        rid = str(r.id)
        seats = int(r.capacity_seats or 0)
        if rid in busy_ids:
            status = "unavailable"
        elif seats >= int(party_size):
            status = "free"
        else:
            status = "small"
        out.append({
            "id": rid,
            "label": r.label,
            "capacity_seats": seats,
            "zone": r.zone,
            # Archetype passthrough — mirror routers/reservations._SHAPES so the
            # public map draws the same Langbord/Bås/Barplads/Højbord the owner
            # arranged. Unknown → None (the frontend falls back to round).
            "shape": r.shape if r.shape in (
                "round", "square", "rect", "booth", "bar", "hightop") else None,
            "pos_x": float(r.pos_x) if r.pos_x is not None else None,
            "pos_y": float(r.pos_y) if r.pos_y is not None else None,
            "status": status,
        })
    return out
