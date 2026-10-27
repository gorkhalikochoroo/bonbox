"""Reservation orchestration — adapts the DB world into the pure engine.

Keeps the routers thin: parses settings, builds the day's open windows
(restaurant = operating hours; appointment = the provider's published
shift), maps ORM rows into engine views, and returns bookable slots.

The pure maths live in availability_engine.py; this layer is the glue.
"""
from __future__ import annotations

import dataclasses
import json
import logging
import re
import secrets
import uuid
from datetime import date, datetime, time, timedelta

from sqlalchemy import func
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models.absence import StaffAbsence
from app.models.behandling import Behandling
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.staff import Schedule
from app.services.availability_engine import (
    AvailabilityConfig, BusyInterval, ResourceView, TimeWindow,
    assign_seats, combinable_zone_overflow, compute_slots, find_slot_resource,
    find_slot_resources, time_grid, turn_time_minutes,
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
    # Guest self-select their table on the public widget. OFF by default — the
    # owner keeps seating control (auto-assign picks the best free table), which
    # matches OpenTable/Resy norm; owners who want the transparency turn it on.
    "guest_can_pick_table": False,
    "retention_days": 90,            # GDPR purge window after service date
    # Appointment vertical default service length when none specified.
    "default_service_duration_min": 60,
    # A salon's pause between customers (R6): minutes added after every
    # appointment on a chair, 0/5/10/15. Online bookings only; the owner can
    # still write a customer in closer. Read through service_buffer().
    "service_buffer_min": 0,
    # SMS reminders (Pro): owner opt-in, off by default. sms_sender is the
    # alphanumeric sender ID shown on the text (max 11 chars).
    "sms_reminders": False,
    "sms_sender": "BonBox",
    # Fallback open window when operating_hours_json is unset.
    "fallback_open": "11:00",
    "fallback_close": "22:00",
    # Dates the owner closed for ONLINE booking (holidays, a private party
    # night, "pause until …"). The owner's own bookings are never stopped by
    # them. Each entry {id, from, to, note, kind: "closed"|"pause"}; always
    # written through clean_closures().
    "closed_dates": [],
    # E-mail the owner about new online bookings and guest cancellations
    # (owner_booking_alerts caps them; push is opted into per device).
    "owner_booking_emails": True,
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


def online_party_ceiling(settings: dict) -> int | None:
    """max_party_size as every path applies it: a whole number of 1 or more,
    or None — no online ceiling. A stored 0 (or blank, negative or junk) is
    "no limit": the create path (`if max_party and ...`) and the public page
    (`Number(max) || 10`) always read it so, while the engine alone read 0 as
    "nobody fits" and a shop's page offered no day and no time — with the
    field hidden from its settings, so the owner could not change it either
    (Push 8 review). The ONE reading — availability, the day strip, the group
    grid and the create path all ask this."""
    raw = settings.get("max_party_size")
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if n >= 1 else None


# Start times ("Starttider", R6). The steps an owner can pick; the reader
# below still honours any sane stored value (5–120) so a venue that stored
# something else by hand keeps its grid, and anything junk reads as 15 — a
# string used to fail every public page with a 500, and a stored 1 built a
# one-minute grid.
SLOT_STEPS = (15, 30, 60)
DEFAULT_SLOT_STEP = 15
# A NEW salon starts on 30-minute start times (rubric S3): a 09:15 start
# left a 15-minute hole no 30-minute service could fill. Restaurants, and
# salons that already take bookings, keep 15 until the owner chooses.
NEW_SALON_SLOT_STEP = 30
# "Pause mellem kunder" (R6): the choices the owner has.
SERVICE_BUFFERS = (0, 5, 10, 15)


def slot_step(settings: dict) -> int:
    """The start-time step the engine walks: a stored whole number 5–120,
    else 15."""
    raw = settings.get("slot_granularity_min", DEFAULT_SLOT_STEP)
    if isinstance(raw, bool):
        return DEFAULT_SLOT_STEP
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_SLOT_STEP
    return n if 5 <= n <= 120 else DEFAULT_SLOT_STEP


def clean_slot_step(raw) -> int | None:
    """An owner's Starttider choice as the settings PUT stores it: one of
    SLOT_STEPS, or None (dropped — the stored value stays)."""
    if isinstance(raw, bool):
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if n in SLOT_STEPS else None


def service_buffer(settings: dict) -> int:
    """The salon's pause after each appointment, in minutes: a stored whole
    number 0–60, else 0 (no pause)."""
    raw = settings.get("service_buffer_min", 0)
    if isinstance(raw, bool) or raw is None:
        return 0
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return 0
    return n if 0 <= n <= 60 else 0


def clean_service_buffer(raw) -> int | None:
    """An owner's pause choice as the settings PUT stores it: one of
    SERVICE_BUFFERS, or None (dropped)."""
    if isinstance(raw, bool):
        return None
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return None
    return n if n in SERVICE_BUFFERS else None


def _online_buffer(settings: dict, buffer_min: int | None) -> int:
    """The pause a chair check uses: the caller's explicit value (the owner's
    own paths pass 0), else the venue's setting (online)."""
    if buffer_min is None:
        return service_buffer(settings)
    return max(0, int(buffer_min))


def start_new_salon_on_30(db: Session, user_id, profile: BusinessProfile | None) -> bool:
    """Called just before a venue's chair is created (salon quick-setup, a
    stylist station). A NEW salon — no chair ever (deleted ones count), no
    table, and an owner who never picked Starttider — starts on 30-minute
    start times. Returns True when it set them. Never raises: the chair the
    owner asked for is the contract."""
    if profile is None:
        return False
    try:
        raw = json.loads(profile.reservation_settings_json or "{}")
        if not isinstance(raw, dict):
            raw = {}
    except (ValueError, TypeError):
        raw = {}
    if raw.get("slot_step_chosen"):
        return False
    try:
        had_chair = (
            db.query(BookableResource.id)
            .filter(BookableResource.user_id == user_id,
                    BookableResource.kind == "provider")
            .first()
        ) is not None
        has_table = (
            db.query(BookableResource.id)
            .filter(BookableResource.user_id == user_id,
                    BookableResource.kind != "provider",
                    BookableResource.is_deleted.is_(False))
            .first()
        ) is not None
    except SQLAlchemyError:
        logger.warning("new-salon start step: lookup failed", exc_info=True)
        return False
    if had_chair or has_table:
        return False
    merged = load_settings(profile)
    merged["slot_granularity_min"] = NEW_SALON_SLOT_STEP
    profile.reservation_settings_json = json.dumps(merged)
    return True


def build_config(settings: dict) -> AvailabilityConfig:
    return AvailabilityConfig(
        slot_granularity_min=slot_step(settings),
        pacing_max_per_slot=settings.get("pacing_max_per_slot") or None,
        pacing_window_min=int(settings.get("pacing_window_min", 15)),
        turn_time_tiers=settings.get("turn_time_tiers") or [],
        default_duration_min=int(settings.get("default_duration_min", 90)),
        lead_time_min=int(settings.get("lead_time_min", 0)),
        max_party_size=online_party_ceiling(settings),
        combine_enabled=bool(settings.get("combine_enabled", True)),
        max_combo_size=int(settings.get("max_combo_size", 3) or 3),
    )


def _parse_hhmm(s: str) -> time | None:
    try:
        hh, mm = s.strip().split(":")
        return time(int(hh), int(mm))
    except (ValueError, AttributeError):
        return None


def hours_declared(profile: BusinessProfile | None, settings: dict) -> bool:
    """Has the venue told us when it is open — booking hours, or the
    business's opening hours — for at least one day?"""
    bh = settings.get("booking_hours")
    if isinstance(bh, dict) and any(isinstance(v, str) and "-" in v for v in bh.values()):
        return True
    raw = getattr(profile, "operating_hours_json", None) if profile else None
    if raw:
        try:
            hours = json.loads(raw)
        except (ValueError, TypeError):
            return False
        if isinstance(hours, dict):
            return any(isinstance(v, str) and "-" in v for v in hours.values())
    return False


def _day_spec(profile: BusinessProfile | None, settings: dict,
              key: str) -> tuple[object | None, str | None]:
    """The raw hours spec that decides weekday `key` ("mon".."sun"), and the
    source it came from: `(spec, "booking" | "opening")`, or `(None, None)`
    when neither source names the day (or the Profile hours are unreadable).

    The ONE precedence rule — restaurant_windows() builds its window from it,
    and the day-reason classifier asks it whether "lukket" is a claim the
    venue made (build plan C1):
      1. `booking_hours` in reservation settings, when it holds a truthy value
         for the day (the owner's "we take bookings Mon 17-23, Tue closed");
      2. else the business's `operating_hours_json` (the Profile hours).
    The spec is returned raw ("closed", "17:00-23:00", or anything an older
    client stored); parsing stays in restaurant_windows."""
    bh = settings.get("booking_hours")
    if isinstance(bh, dict) and bh.get(key):
        return bh.get(key), "booking"
    spec = _opening_hours_spec(profile, key)
    if spec is not None:
        return spec, "opening"
    return None, None


def _opening_hours_spec(profile: BusinessProfile | None, key: str) -> object | None:
    """The Profile hours' (operating_hours_json) raw spec for weekday `key`,
    or None: no hours, the day not named, or JSON nobody can read."""
    raw = getattr(profile, "operating_hours_json", None) if profile else None
    if not raw:
        return None
    try:
        hours = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return hours.get(key) if isinstance(hours, dict) else None


def restaurant_windows(profile: BusinessProfile | None, day: date,
                       settings: dict) -> list[TimeWindow]:
    """The day's open window for bookings. Source precedence:
      1. `booking_hours` in reservation settings — owner-set "we take bookings
         Mon 17:00–23:00, Tue closed, …" (a dict keyed by mon..sun, values
         "HH:MM-HH:MM" or "closed"). This is the explicit control.
      2. the business's `operating_hours_json` (same format).
    Nothing declared for the day ⇒ no window (fail-closed), exactly like the
    salon path. It used to fall back to `fallback_open`/`fallback_close`
    (11:00–22:00 every day), and a venue's page went live on those invented
    hours the moment it added its first table: a café closing at 17:00 and
    shut on Mondays took bookings for Monday at 21:00.
    Closes past midnight roll to the next day (e.g. '18:00-02:00')."""
    spec, _source = _day_spec(profile, settings, _WEEKDAY_KEYS[day.weekday()])
    if spec is None or spec == "closed" or "-" not in str(spec):
        return []
    open_s, close_s = str(spec).split("-")[:2]

    o, c = _parse_hhmm(open_s), _parse_hhmm(close_s)
    if not o or not c:
        return []
    start = datetime.combine(day, o)
    end = datetime.combine(day, c)
    if end <= start:                       # crosses midnight
        end += timedelta(days=1)
    return [TimeWindow(start=start, end=end)]


# A fixed Monday. restaurant_windows() and _opening_hours_windows() read only
# the weekday of the day they are given, so the week they build from it is
# every week (no clock, no time zone).
_REFERENCE_MONDAY = date(2026, 1, 5)


def _hhmm_pairs(windows: list[TimeWindow]) -> list[list[str]]:
    return [[w.start.strftime("%H:%M"), w.end.strftime("%H:%M")] for w in windows]


def week_windows(profile: BusinessProfile | None, settings: dict) -> dict:
    """{"mon": [["17:00", "22:00"]], "tue": [], ..., "sun": [...]}: the table
    engine's bookable window for each weekday, Monday first, straight from
    restaurant_windows(). An empty list is a day with no window (closed,
    undeclared or unreadable — the engine books nothing). A close earlier
    than the open runs past midnight (["18:00", "02:00"]).

    The ONE week the owner's hours card, the booking pickers, the host stand
    (reservations._open_hours_by_weekday) and the guest page's hours list
    (public_week) read, so they can never disagree."""
    return {
        key: _hhmm_pairs(restaurant_windows(profile, _REFERENCE_MONDAY + timedelta(days=i), settings))
        for i, key in enumerate(_WEEKDAY_KEYS)
    }


def public_week(profile: BusinessProfile | None, settings: dict,
                resources: list) -> dict | None:
    """The venue's week as the booking engine reads it, for the guest page
    (booking push p3). None when no single weekly claim is true, or nothing
    is declared. Never invented, never "closed" for a day nobody declared.

        {"days": {"mon": {"windows": [["17:00", "22:00"]], "by": "booking" | "opening"} | None,
                  ..., "sun": ...}}

    Chosen per resource kind, exactly as available_slots() picks windows:
      * tables only: each weekday from restaurant_windows() (the booking
        hours when set for that day, else the Profile hours);
      * providers only, every one a self-chair (follows_opening_hours): the
        booking hours only (_opening_hours_windows) — never the Profile hours;
      * a provider on stylist shifts (or a legacy row), tables and providers
        together, or no active resource: None. Shifts add or remove any day,
        and one weekly claim cannot hold for two engines.

    A day with a window: `by` is the source that opened it. A windowless day
    is listed only where the venue made a claim, and `by` then reads the
    SAME closed-day rule as the date strip (_closed_by_declaration /
    CLOSED_DAY_SOURCES, build plan C1), so the list and the strip never
    disagree:
      * "opening" — the strip says "lukket" (default: the Profile hours say
        closed that weekday) → the page writes "Lukket";
      * "booking" — closed for bookings only (the booking hours say closed,
        the strip is neutral) → "Ingen bordbestilling" / "Ingen tidsbestilling".
    An undeclared weekday or an unreadable value is None (no row): "not
    declared" is never merged into "closed"."""
    if not resources:
        return None
    tables = [r for r in resources if getattr(r, "kind", None) != "provider"]
    providers = [r for r in resources if getattr(r, "kind", None) == "provider"]
    if tables and providers:
        return None
    if providers and not all(getattr(p, "follows_opening_hours", False) for p in providers):
        return None

    bh = settings.get("booking_hours")
    week = week_windows(profile, settings) if tables else None
    days: dict = {}
    for i, key in enumerate(_WEEKDAY_KEYS):
        ref = _REFERENCE_MONDAY + timedelta(days=i)
        if tables:
            spec, by = _day_spec(profile, settings, key)
            windows = week[key]
        else:
            spec = bh.get(key) if isinstance(bh, dict) else None
            by = "booking" if spec else None
            windows = _hhmm_pairs(_opening_hours_windows(settings, ref)) if spec else []
        if windows:
            days[key] = {"windows": windows, "by": by}
        elif _closed_by_declaration(profile, settings, ref):
            days[key] = {"windows": [], "by": "opening"}
        elif spec == "closed":
            days[key] = {"windows": [], "by": "booking"}
        else:
            days[key] = None
    if not any(d and d["windows"] for d in days.values()):
        return None
    return {"days": days}


def _opening_hours_windows(settings: dict, day: date) -> list[TimeWindow]:
    """Owner "self-chair" availability = the CONFIRMED weekly opening hours
    (the `booking_hours` settings key), fail-closed.

    Reads ONLY `booking_hours` the owner explicitly persisted — it NEVER
    consults operating_hours_json / fallback_open (that would invent working
    hours a salon owner never declared, breaking the honesty gate). No entry /
    "closed" / unparseable spec ⇒ [] (no slots that day). A close ≤ open rolls
    to the next day so a late salon (e.g. "12:00-01:00") still works."""
    bh = settings.get("booking_hours")
    if not isinstance(bh, dict):
        return []
    spec = bh.get(_WEEKDAY_KEYS[day.weekday()])
    if not spec or spec == "closed" or "-" not in spec:
        return []
    parts = spec.split("-")
    o, c = _parse_hhmm(parts[0]), _parse_hhmm(parts[1])
    if not o or not c:
        return []
    start = datetime.combine(day, o)
    end = datetime.combine(day, c)
    if end <= start:                       # crosses midnight (late salon)
        end += timedelta(days=1)
    return [TimeWindow(start=start, end=end)]


# Absence rows that take a stylist off the book: an absence that is waiting
# for the owner, seen, or covered by someone else. Every kind counts (Ferie,
# Syg, Barns sygedag, Andet). A cancelled row (withdrawn, or declined by the
# owner) does not block.
ABSENCE_BLOCKING_STATUSES = ("pending", "acknowledged", "covered")


def _absent(db: Session, user_id, staff_ids, start: date, end: date) -> set:
    """{(str(staff_id), date)} for every blocking absence of these staff in
    [start, end] — ONE query, tenant-scoped. An empty staff list asks
    nothing."""
    ids = [s for s in staff_ids if s]
    if not ids:
        return set()
    rows = (
        db.query(StaffAbsence.staff_id, StaffAbsence.date)
        .filter(
            StaffAbsence.user_id == user_id,
            StaffAbsence.staff_id.in_(ids),
            StaffAbsence.date >= start,
            StaffAbsence.date <= end,
            StaffAbsence.status.in_(ABSENCE_BLOCKING_STATUSES),
        )
        .all()
    )
    return {(str(sid), d) for sid, d in rows}


def provider_windows(db: Session, user_id, resource, day: date,
                     settings: dict) -> list[TimeWindow]:
    """A provider chair's open windows for the day — two HONEST sources, never
    a venue-hours fallback:

      • owner "self-chair" (`follows_opening_hours=True`) → the owner's CONFIRMED
        weekly opening hours (`booking_hours`). Lets a solo salon take bookings
        without a StaffMember; no declared hours ⇒ [].
      • employed stylist (`staff_id` set) → that stylist's PUBLISHED Schedule
        shifts; no published shift ⇒ []. A day the stylist is away (Ferie,
        Syg, Barns sygedag, Andet — any absence not cancelled) ⇒ [], even
        while her shift is still published.

    A provider row that is neither (a legacy NULL-staff row with
    follows_opening_hours False) ⇒ [] — it never silently lights up."""
    if getattr(resource, "follows_opening_hours", False):
        return _opening_hours_windows(settings, day)
    staff_id = getattr(resource, "staff_id", None)
    if not staff_id:
        return []
    if (str(staff_id), day) in _absent(db, user_id, [staff_id], day, day):
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
    return _shift_windows(day, shifts)


def _shift_windows(day: date, shifts) -> list[TimeWindow]:
    """Published Schedule rows → the day's windows (a close ≤ open rolls to
    the next day). Shared by provider_windows and the day-reason batch below,
    so the two can never parse a shift differently."""
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


def _batched_provider_windows(db: Session, user_id, resources, start: date,
                              end: date, settings: dict):
    """provider_windows for every day in [start, end], from ONE Schedule
    query instead of one per provider per day. Returns `fn(resource, day)`
    with provider_windows' exact rules (self-chair → booking hours; employed
    stylist → published shifts; neither → []). Used only to NAME an empty
    day's reason — the open/closed answer still comes from available_slots."""
    staff_ids = [r.staff_id for r in resources
                 if r.kind == "provider" and r.staff_id
                 and not getattr(r, "follows_opening_hours", False)]
    by_day: dict = {}
    if staff_ids:
        rows = (
            db.query(Schedule)
            .filter(
                Schedule.user_id == user_id,
                Schedule.staff_id.in_(staff_ids),
                Schedule.date >= start,
                Schedule.date <= end,
                Schedule.status == "published",
            )
            .all()
        )
        for row in rows:
            by_day.setdefault((row.staff_id, row.date), []).append(row)
    # The days each stylist is away, in one query for the whole range.
    away = _absent(db, user_id, staff_ids, start, end)

    def windows_for(resource, day: date) -> list[TimeWindow]:
        if getattr(resource, "follows_opening_hours", False):
            return _opening_hours_windows(settings, day)
        staff_id = getattr(resource, "staff_id", None)
        if not staff_id:
            return []
        if (str(staff_id), day) in away:
            return []
        return _shift_windows(day, by_day.get((staff_id, day), []))

    return windows_for


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
                    duration_min: int | None = None,
                    service_duration_min: int | None = None) -> list[datetime]:
    """Bookable start times for a party on a day. Restaurant uses the shared
    operating-hours window across all tables; appointment verticals union
    each provider's shift window.

    `service_duration_min` (R6) is the length a chair is checked for — the
    service the guest chose, or the salon's shortest — and reaches ONLY the
    chairs; tables keep `duration_min` / their turn time. Chairs also hold
    the salon's pause between customers (service_buffer)."""
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

    # Appointment providers each have their own window (self-chair opening
    # hours, or an employed stylist's published shift).
    buf = service_buffer(settings) if providers else 0
    for p in providers:
        windows = provider_windows(db, user_id, p, day, settings)
        if not windows:
            continue
        dur = service_duration_min or duration_min or settings.get("default_service_duration_min", 60)
        for s in compute_slots(
            windows=windows, resources=_views([p]), busy=busy,
            party_size=party_size, config=config, now=now, duration_min=dur,
            buffer_min=buf,
        ):
            starts.add(s.start)

    return sorted(starts)


def available_slot_details(db: Session, *, profile: BusinessProfile, user_id, day: date,
                           party_size: int, now: datetime | None = None,
                           duration_min: int | None = None) -> dict:
    """{ "HH:MM": remaining_single_tables } for a party on a day.

    A SEPARATE function rather than a change to available_slots(), whose
    list[datetime] contract has several callers (the day-strip summary, the
    frontend monitor) that want exactly that and nothing more.

    Feeds the guest-facing scarcity hint. The numbers come from the same
    engine pass that decides bookability, so a slot can never advertise a
    count the booking path would refuse — and count_free_singles understates
    (it ignores combinable tables) so the cue never overstates scarcity.

    Providers are excluded on purpose: an appointment chair is not a table,
    "2 left" would be meaningless for it, and a salon's slot list should not
    inherit a restaurant's scarcity language.
    """
    settings = load_settings(profile)
    config = build_config(settings)
    resources = active_resources(db, user_id)
    busy = busy_for_day(db, user_id, day)
    tables = [r for r in resources if r.kind != "provider"]
    if not tables:
        return {}

    windows = restaurant_windows(profile, day, settings)
    if not windows:
        return {}

    out: dict[str, int] = {}
    for s in compute_slots(
        windows=windows, resources=_views(tables), busy=busy,
        party_size=party_size, config=config, now=now, duration_min=duration_min,
    ):
        key = s.start.strftime("%H:%M")
        # A start time can surface from more than one window; keep the highest
        # count so the hint never under-reports what is genuinely bookable.
        out[key] = max(out.get(key, 0), int(s.remaining or 0))
    return out


def is_group_request(settings: dict, party_size: int) -> bool:
    """A party at/above group_request_threshold books as a REQUEST: no table
    is held, the owner decides. The ONE definition — the availability
    endpoints, the day strip and the create path all ask this."""
    threshold = settings.get("group_request_threshold")
    try:
        return bool(threshold) and int(party_size) >= int(threshold)
    except (TypeError, ValueError):
        return False


def group_request_slots(db: Session, *, profile: BusinessProfile, user_id, day: date,
                        party_size: int, now: datetime | None = None) -> list[datetime]:
    """PREFERRED times a group request may ask for: the venue's normal bookable
    time grid for the day — same opening hours, interval and lead time as
    available_slots() — IGNORING table capacity (and pacing), because a request
    holds no table: the owner decides whether and where the party fits.

    Without this, a group's availability was "no slots" whenever no single
    table (or combo) seated the whole party — which is exactly when it is a
    request — so the page invented a time and the date strip showed every day
    closed. Empty when the venue is closed that day, above the online party
    ceiling (the create path refuses those too), or has no tables at all (an
    appointment venue has no group requests)."""
    settings = load_settings(profile)
    config = build_config(settings)
    if config.max_party_size is not None and party_size > config.max_party_size:
        return []
    if not any(r.kind != "provider" for r in active_resources(db, user_id)):
        return []
    windows = restaurant_windows(profile, day, settings)
    duration = turn_time_minutes(party_size, config)
    return sorted(set(time_grid(windows=windows, duration_min=duration,
                                config=config, now=now)))


# ── Why a day offers no online time ─────────────────────────────────────
# A closed set: the guest page maps each reason to its own words. Never a
# plan, tier or cap word — "not_accepting" (the monthly cap, set by the
# router) is deliberately generic.
DAY_REASONS = ("past", "not_yet_bookable", "not_accepting", "closed",
               "no_times", "no_fit", "too_late", "full", "closed_date")
# "Reason unknown": emitted only when classification fails or is skipped (the
# surface monitor asks for no reasons). The page reads it as neutral.
LEGACY_REASON = "closed_or_full"
# Which hours source may make a day with no window read "closed" ("lukket")
# on the guest page. Default (build plan C1, owner question Q4): the Profile
# opening hours say "closed" that weekday. A day closed only by the
# Reservations booking hours reads the neutral "no_times". Owner's
# alternative ("Lukket" for both): CLOSED_DAY_SOURCES = ("opening", "booking").
CLOSED_DAY_SOURCES = ("opening",)
# What a day reads when bookings hold none of its starts and only the owner's
# own pacing cap ("max covers per slot") does. Default (owner question Q1):
# "full" — full by the owner's own rule, and the rule is not explained.
# Owner's alternative ("kun tlf."): PACED_DAY_REASON = "no_fit". Only when it
# differs from "full" does the classifier spend the extra pass that tells
# pacing from bookings (_held_by_pacing), so the default costs nothing.
PACED_DAY_REASON = "full"


def window_reason(day: date, today: date, max_advance: int) -> str | None:
    """`past` / `not_yet_bookable` for a day outside the booking window, else
    None. The same window every public endpoint applies (max_advance read as
    int(settings.get("max_advance_days", 60)), so a stored 0 = today only)."""
    if day < today:
        return "past"
    if day > today + timedelta(days=max_advance):
        return "not_yet_bookable"
    return None


# ── Closed dates and pauses (online booking only) ───────────────────────
# The owner closes a date ("Lukket juleaften") or pauses online booking
# ("resten af i dag", "til og med fredag"). Both stop ONLINE booking only —
# the public endpoints read them; restaurant_windows / provider_windows never
# do, so the owner can still write a private party into the book.
CLOSURE_KINDS = ("closed", "pause")
CLOSURE_MAX_ENTRIES = 60
CLOSURE_MAX_SPAN_DAYS = 366
CLOSURE_NOTE_MAX = 80
_CLOSURE_ID_RE = re.compile(r"^[0-9a-f]{8}$")


def _iso_day(value) -> date | None:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def clean_closure_note(note) -> str | None:
    """A guest-facing closure note: links replaced, line breaks and runs of
    spaces collapsed, at most CLOSURE_NOTE_MAX characters, "" → None."""
    if not isinstance(note, str):
        return None
    from app.utils.text import strip_links
    text = " ".join((strip_links(note) or "").split())
    text = text[:CLOSURE_NOTE_MAX].strip()
    return text or None


def check_closure(entry, today: date) -> tuple[dict | None, str | None]:
    """One closure entry → (clean entry, None) or (None, error code).

    Error codes: bad_date, end_before_start, range_too_long, in_the_past.
    The id is kept when it is a well-formed one, else a new one is minted."""
    if not isinstance(entry, dict):
        return None, "bad_date"
    start = _iso_day(entry.get("from"))
    raw_to = entry.get("to")
    end = start if raw_to in (None, "") else _iso_day(raw_to)
    if start is None or end is None:
        return None, "bad_date"
    if end < start:
        return None, "end_before_start"
    if (end - start).days + 1 > CLOSURE_MAX_SPAN_DAYS:
        return None, "range_too_long"
    if end < today:
        return None, "in_the_past"
    kind = entry.get("kind") if entry.get("kind") in CLOSURE_KINDS else "closed"
    cid = entry.get("id")
    if not (isinstance(cid, str) and _CLOSURE_ID_RE.match(cid)):
        cid = secrets.token_hex(4)
    return {"id": cid, "from": start.isoformat(), "to": end.isoformat(),
            "note": clean_closure_note(entry.get("note")), "kind": kind}, None


def clean_closures(raw, today: date) -> list[dict]:
    """Every write of `closed_dates` goes through here: valid entries only,
    anything that ended before yesterday pruned, sorted by start, at most
    CLOSURE_MAX_ENTRIES, ids unique. Junk is dropped, never stored."""
    out: list[dict] = []
    seen: set = set()
    for entry in raw if isinstance(raw, list) else []:
        # Yesterday stays one more day, so a guest's receipt from last night
        # still reads the note; older entries go.
        clean, _err = check_closure(entry, today - timedelta(days=1))
        if clean is None:
            continue
        while clean["id"] in seen:
            clean["id"] = secrets.token_hex(4)
        seen.add(clean["id"])
        out.append(clean)
    out.sort(key=lambda e: (e["from"], e["to"], e["id"]))
    return out[:CLOSURE_MAX_ENTRIES]


def _closure_entries(settings: dict) -> list[dict]:
    """The stored entries, read defensively (a junk value reads as none)."""
    raw = settings.get("closed_dates") if isinstance(settings, dict) else None
    out = []
    for e in raw if isinstance(raw, list) else []:
        if not isinstance(e, dict):
            continue
        start, end = _iso_day(e.get("from")), _iso_day(e.get("to") or e.get("from"))
        if start is None or end is None or end < start:
            continue
        out.append({**e, "_from": start, "_to": end,
                    "kind": e.get("kind") if e.get("kind") in CLOSURE_KINDS else "closed"})
    return out


def _public(e: dict) -> dict:
    return {"id": e.get("id"), "from": e["_from"].isoformat(), "to": e["_to"].isoformat(),
            "note": e.get("note") if isinstance(e.get("note"), str) and e.get("note") else None,
            "kind": e["kind"]}


def closure_on(settings: dict, day: date) -> dict | None:
    """The closure covering `day` ({id, from, to, note, kind}), or None. A
    "closed" entry wins over a "pause" on the same day."""
    hits = [e for e in _closure_entries(settings) if e["_from"] <= day <= e["_to"]]
    if not hits:
        return None
    hits.sort(key=lambda e: (e["kind"] != "closed", e["_from"]))
    return _public(hits[0])


def pause_covering(settings: dict, today: date) -> dict | None:
    """The pause entry whose range includes today, or None."""
    hits = [e for e in _closure_entries(settings)
            if e["kind"] == "pause" and e["_from"] <= today <= e["_to"]]
    if not hits:
        return None
    hits.sort(key=lambda e: e["_to"], reverse=True)
    return _public(hits[0])


def closures_between(settings: dict, start: date, end: date) -> list[dict]:
    """Entries overlapping [start, end], sorted by start."""
    hits = [e for e in _closure_entries(settings) if e["_from"] <= end and e["_to"] >= start]
    hits.sort(key=lambda e: (e["_from"], e["_to"]))
    return [_public(e) for e in hits]


def _closed_by_declaration(profile: BusinessProfile | None, settings: dict,
                           day: date) -> bool:
    """True only when a source listed in CLOSED_DAY_SOURCES literally says
    this weekday is "closed". The caller asks only for a day with no window
    (restaurant_windows() is empty), so "lukket" never sits on a day the
    booking hours open.

    Each source is read for itself, never through _day_spec's precedence.
    The owner's "Åbningstider (booking)" card and the salon quick-setup save
    all seven weekdays (serializeBookingHours), closed days as "closed", so
    once saved the booking hours DECIDE every weekday. Asking only the
    deciding source made "lukket" unreachable for every salon and for every
    venue that had saved that card, even where the Profile hours say closed
    too. No hours, an undeclared weekday or an unreadable value is not a
    claim, so it can never read "lukket". The hours list (booking push p3)
    asks this same function, so the list and the strip agree."""
    key = _WEEKDAY_KEYS[day.weekday()]
    if "opening" in CLOSED_DAY_SOURCES and _opening_hours_spec(profile, key) == "closed":
        return True
    if "booking" in CLOSED_DAY_SOURCES:
        bh = settings.get("booking_hours")
        if isinstance(bh, dict) and bh.get(key) == "closed":
            return True
    return False


def _held_by_pacing(db: Session, *, user_id, day: date, party_size: int,
                    now: datetime, config: AvailabilityConfig, tables: list,
                    t_win: list, p_win: list, p_dur: int) -> bool:
    """Would a start after the lead time be free with the pacing cap off?
    Then pacing, not bookings, holds the day (owner question Q1). The same
    engine pass available_slots() runs, on the same windows and busy list,
    with only pacing_max_per_slot cleared."""
    if not config.pacing_max_per_slot:
        return False
    free = dataclasses.replace(config, pacing_max_per_slot=None)
    busy = busy_for_day(db, user_id, day)
    if t_win and tables and compute_slots(
            windows=t_win, resources=_views(tables), busy=busy,
            party_size=party_size, config=free, now=now):
        return True
    return any(ws and compute_slots(
        windows=ws, resources=_views([p]), busy=busy, party_size=party_size,
        config=free, now=now, duration_min=p_dur) for p, ws in p_win)


def classify_empty_day(db: Session, *, profile: BusinessProfile, user_id, day: date,
                       party_size: int, now: datetime, settings: dict | None = None,
                       resources: list | None = None,
                       windows_for=None,
                       service_duration_min: int | None = None) -> str:
    """Why (day, party) has no online time — one of DAY_REASONS.

    PRECONDITION: the call the guest sees (available_slots /
    group_request_slots) returned [] for this day and party. This never
    decides whether a day is open; it only names why it isn't. The first true
    reason wins, in a fixed order — the party-wide, clock-free reasons
    (ceiling, nothing seats the party) come BEFORE too_late, so a party of 6
    at a venue of 4-tops reads "by phone" tonight too, never "too late"
    (which would promise that tomorrow works).

    `windows_for(resource, day)` (optional) replaces provider_windows with a
    batched lookup (summarize_days loads every shift in its range once)."""
    settings = settings if settings is not None else load_settings(profile)
    config = build_config(settings)
    resources = resources if resources is not None else active_resources(db, user_id)
    if windows_for is None:
        def windows_for(p, d):
            return provider_windows(db, user_id, p, d, settings)
    tables = [r for r in resources if r.kind != "provider"]
    providers = [r for r in resources if r.kind == "provider"]
    group = is_group_request(settings, party_size)
    declared = restaurant_windows(profile, day, settings)   # the venue's own hours

    def shut() -> str:
        return "closed" if _closed_by_declaration(profile, settings, day) else "no_times"

    # 1. Nothing online could seat anyone (no resources, or a group request
    #    at a venue without tables): a call when the venue is open that day.
    if not tables and (group or not providers):
        return "no_fit" if declared else shut()
    # 2. No bookable window this day (a salon's chair hours / published shift,
    #    or the venue's hours).
    t_win = declared if tables else []
    p_win = [] if group else [(p, windows_for(p, day)) for p in providers]
    if not t_win and not any(ws for _, ws in p_win):
        return "no_times" if declared else shut()
    # 3. Above the online ceiling (party-wide, clock-free).
    if config.max_party_size is not None and party_size > config.max_party_size:
        return "no_fit"
    # 4. Nothing seats the party even on an empty floor (party-wide, clock-free).
    #    A group request holds no table, so any table venue "fits" it.
    t_dur = turn_time_minutes(party_size, config)
    # A salon setting: read only when there are chairs (as available_slots),
    # so a junk value stored on a table venue can't fail its every day.
    # The same chair length the strip asked available_slots about (R6).
    p_dur = (int(service_duration_min or settings.get("default_service_duration_min", 60))
             if providers else 0)
    t0 = datetime.combine(day, time(12, 0))
    viable: list[tuple[list, int]] = []
    if t_win and (group or assign_seats(party_size, t0, t0 + timedelta(minutes=t_dur),
                                        _views(tables), [], config) is not None):
        viable.append((t_win, t_dur))
    for p, ws in p_win:
        if ws and assign_seats(party_size, t0, t0 + timedelta(minutes=p_dur),
                               _views([p]), [], config) is not None:
            viable.append((ws, p_dur))
    if not viable:
        return "no_fit"

    # 5. The sitting is longer than every window that day.
    def any_start(at: datetime | None) -> bool:
        return any(next(time_grid(windows=ws, duration_min=d, config=config, now=at), None)
                   is not None for ws, d in viable)

    if not any_start(None):
        return "no_fit"
    # 6. Starts exist, but every one is inside the lead time.
    if not any_start(now):
        return "too_late"
    # 7. A group grid with starts would have produced slots: unreachable.
    if group:
        logger.warning("day reason: unreachable group branch for owner %s on %s",
                       user_id, day)
        return LEGACY_REASON
    # Bookings, or the owner's own pacing cap, hold every remaining start.
    # Both read "full" unless the owner chose otherwise for pacing (Q1).
    if PACED_DAY_REASON != "full" and _held_by_pacing(
            db, user_id=user_id, day=day, party_size=party_size, now=now,
            config=config, tables=tables, t_win=t_win, p_win=p_win, p_dur=p_dur):
        return PACED_DAY_REASON
    return "full"


def _release_failed_read(db: Session, exc: BaseException) -> None:
    """After a DB error inside a day reason, roll the session back so the
    caller's next query runs. On Postgres a failed SELECT aborts the whole
    transaction ("current transaction is aborted"), so the next day's
    available_slots() in the same summary would fail the request with a 500.
    Every caller is a public GET (/availability, /provider-availability,
    /availability-summary) that has written nothing, so the rollback loses
    nothing; loaded rows reload on their next read. A Python error leaves
    the transaction alone."""
    if not isinstance(exc, SQLAlchemyError):
        return
    try:
        db.rollback()
    except Exception:  # noqa: BLE001 — the caller's next query reports it
        logger.warning("day reason: rollback after a failed read failed", exc_info=True)


def _classify_safely(db: Session, kw: dict) -> tuple[str, BaseException | None]:
    try:
        return classify_empty_day(db, **kw), None
    except Exception as exc:  # noqa: BLE001 — a reason is a label, never a gate
        _release_failed_read(db, exc)
        return LEGACY_REASON, exc


def empty_day_reason(db: Session, **kw) -> str:
    """classify_empty_day that can never break its caller: naming a reason
    must never close a day or fail a request. Any error → logged +
    LEGACY_REASON (the page reads it as neutral); a DB error also rolls the
    read back (_release_failed_read)."""
    reason, exc = _classify_safely(db, kw)
    if exc is not None:
        logger.warning("day reason failed for owner %s on %s",
                       kw.get("user_id"), kw.get("day"), exc_info=exc)
    return reason


def summarize_days(db: Session, *, profile: BusinessProfile, user_id,
                   start_date: date, days: int, party_size: int,
                   now: datetime, with_reasons: bool = True,
                   service_duration_min: int | None = None) -> dict:
    """Per-day open/closed overview for the public date strip + the public-surface
    monitor. Calls the SAME available_slots() a diner actually sees (or, for a
    group request, the same group_request_slots() /availability offers), so the
    strip can never disagree with reality. Returns:
        {'next_open_day': iso|None, 'group_request': bool,
         'days': [{'date', 'has_slots', 'reason'}]}
    `reason` is None on a day with times, else one of DAY_REASONS: `past` /
    `not_yet_bookable` outside the advance window; for an empty in-window day
    `closed` (declared closed in the Profile hours), `no_times`, `no_fit`,
    `too_late` or `full` (see classify_empty_day); `closed_date` for a date
    the owner closed for online booking (that day also carries `note` and
    `kind`, with or without reasons). `has_slots` and
    `next_open_day` are computed first, exactly as before — a reason never
    changes them. With `with_reasons=False` (the monitor, which reads only
    has_slots / next_open_day) an empty in-window day reads LEGACY_REASON and
    nothing extra runs; a classification error also reads LEGACY_REASON.
    ONE source of truth for 'is this booking page dead' — shared so the customer
    UX and the auto-diagnosis can't diverge."""
    settings = load_settings(profile)
    today = now.date()
    max_advance = int(settings.get("max_advance_days", 60))
    # A group request is open whenever the venue is open — table capacity is
    # the owner's call, not the strip's. Counting tables here marked every day
    # "closed" for exactly the parties that were only ever asking.
    group = is_group_request(settings, party_size)
    # A salon's chairs are checked for a REAL service length (R6, rubric
    # S10): the one the guest chose, else the shortest the salon offers —
    # a day is open when at least that fits. The hidden 60-minute default
    # said a day was open while a 90-minute service had no time, or closed
    # while a 30-minute gap was free. No service at all: the old default.
    p_len = service_duration_min or shortest_service_min(db, user_id)
    # Loaded once for the classifier, and only when reasons are asked for:
    # the resources, and (lazily, at the first empty day) every published
    # shift in the range in one query — a salon pays no query per stylist per
    # empty day.
    resources = None
    windows_for = None
    if with_reasons:
        try:
            resources = active_resources(db, user_id)
        except Exception as exc:  # noqa: BLE001 — the classifier reloads and fails safe
            _release_failed_read(db, exc)
            resources = None
    shifts_loaded = False
    # One traceback per request, then a count: this is a public endpoint
    # (60/min), and one broken setting would otherwise log up to 30 a call.
    failed: list = []
    out: list[dict] = []
    first_open = None
    for i in range(days):
        d = start_date + timedelta(days=i)
        outside = window_reason(d, today, max_advance)
        if outside:
            out.append({"date": d.isoformat(), "has_slots": False, "reason": outside})
            continue
        # A date the owner closed for online booking: closed, with the
        # owner's note, whatever the hours say — and named even when no
        # reasons are asked for (the monitor tells "closed by the owner"
        # from a dead page).
        closure = closure_on(settings, d)
        if closure is not None:
            out.append({"date": d.isoformat(), "has_slots": False,
                        "reason": "closed_date", "note": closure["note"],
                        "kind": closure["kind"]})
            continue
        if group:
            slots = group_request_slots(
                db, profile=profile, user_id=user_id, day=d,
                party_size=party_size, now=now,
            )
        else:
            slots = available_slots(
                db, profile=profile, user_id=user_id, day=d,
                party_size=party_size, now=now, service_duration_min=p_len,
            )
        has = len(slots) > 0
        if has:
            reason = None
        elif with_reasons:
            if not shifts_loaded and resources is not None:
                shifts_loaded = True
                if any(r.kind == "provider" for r in resources):
                    try:
                        windows_for = _batched_provider_windows(
                            db, user_id, resources, d,
                            start_date + timedelta(days=days - 1), settings,
                        )
                    except Exception as exc:  # noqa: BLE001 — per-day queries instead
                        _release_failed_read(db, exc)
                        windows_for = None
            reason, exc = _classify_safely(db, dict(
                profile=profile, user_id=user_id, day=d,
                party_size=party_size, now=now, settings=settings,
                resources=resources, windows_for=windows_for,
                service_duration_min=p_len,
            ))
            if exc is not None:
                if not failed:
                    logger.warning("day reason failed for owner %s on %s",
                                   user_id, d, exc_info=exc)
                failed.append(d)
        else:
            reason = LEGACY_REASON
        out.append({"date": d.isoformat(), "has_slots": has, "reason": reason})
        if has and first_open is None:
            first_open = d.isoformat()
    if len(failed) > 1:
        logger.warning("day reasons failed on %d more days for owner %s (first %s)",
                       len(failed) - 1, user_id, failed[0])
    return {"next_open_day": first_open, "group_request": group, "days": out}


def recheck_and_assign_combo(db: Session, *, profile: BusinessProfile, user_id,
                             start: datetime, party_size: int,
                             now: datetime | None = None,
                             duration_min: int | None = None,
                             owner_booking: bool = False,
                             buffer_min: int | None = None) -> list[str] | None:
    """Server-side race re-check at booking time, combo-aware. Returns the full
    table set to assign — one id for a single table, or two+ when the party can
    only be seated by combining tables — or None if no longer bookable.

    Restaurant tables are checked first (and may combine); appointment
    providers each carry capacity 1 and never combine, so they return at most a
    single id. The caller writes one occupancy row per id, atomically.

    `buffer_min` (R6): the pause a chair must keep around this appointment.
    None = the salon's setting (an online booking); the owner's own paths
    pass 0 — the owner may write a customer in closer than the guest page
    offers. Tables never read it."""
    settings = load_settings(profile)
    config = build_config(settings)
    resources = active_resources(db, user_id)
    busy = busy_for_day(db, user_id, start.date())

    tables = [r for r in resources if r.kind != "provider"]
    if tables:
        windows = restaurant_windows(profile, start.date(), settings)
        if not windows and owner_booking and not hours_declared(profile, settings):
            # The OWNER booking a caller in by hand is the authority on when the
            # venue is open. Undeclared hours keep the public page shut (no
            # invented hours for guests), but they must not stop the owner
            # writing a booking into their own book: the whole day is theirs.
            day0 = datetime.combine(start.date(), time(0, 0))
            windows = [TimeWindow(start=day0, end=day0 + timedelta(days=1))]
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

    # The owner's own bookings (owner_booking) keep no pause unless asked.
    buf = _online_buffer(settings, 0 if (buffer_min is None and owner_booking) else buffer_min)
    for p in resources:
        if p.kind != "provider":
            continue
        windows = provider_windows(db, user_id, p, start.date(), settings)
        dur = duration_min or settings.get("default_service_duration_min", 60)
        ids = find_slot_resources(
            requested_start=start, party_size=party_size, windows=windows,
            resources=_views([p]), busy=busy, config=config, now=now,
            duration_min=dur, buffer_min=buf,
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
            # Orientation only — 0° for null so the CSS transform never breaks.
            # Drawn SIZE is deliberately NOT emitted (width/height stay owner-only);
            # the guest map re-derives footprint from capacity_seats, so a guest
            # can never infer capacity from an owner-drawn size.
            "rotation_deg": float(r.rotation_deg) if r.rotation_deg is not None else 0.0,
            "status": status,
        })
    return out


# ─── Salon / appointment (provider) helpers — S3a ────────────────────
# These are ADDITIVE. They never touch the restaurant table path
# (available_slots / recheck_and_assign_combo / public_floor above) — a salon
# is served entirely through this new pair of functions, so the live
# table-booking behaviour is unchanged.
#
# Honesty gates (S3a, extended by the salon self-chair unlock):
#   • Provider availability comes from ONE of two OWNER-DECLARED sources, never
#     an invented venue-hours fallback: an employed stylist's PUBLISHED shift,
#     OR (owner "self-chair") the owner's CONFIRMED weekly opening hours. Either
#     way provider_windows() returns [] when nothing is declared — no shift and
#     no confirmed hours = no slot (restaurant_windows / fallback_open are never
#     consulted for a provider).
#   • The SERVER resolves the booking duration from the behandlinger catalog
#     (resolve_behandling_duration) — a client-supplied duration is never
#     trusted for a salon booking.

def resolve_behandling_duration(db: Session, user_id, behandling_id) -> int:
    """The tenant-scoped behandling's `duration_min`, or the settings default
    when the id is missing / unknown / not owned by this tenant.

    The duration a salon booking actually holds the chair for comes from the
    OWNER'S catalog, never from the client — this is the single place that
    re-derives it server-side. Tenant-scoped: the lookup filters on user_id so
    one salon can never resolve another salon's behandling. A falsy / unknown
    id falls back to the venue's `default_service_duration_min` (60) — the same
    default the appointment branch of available_slots() already uses — so the
    booking still gets a sane length instead of failing.
    """
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user_id)
        .first()
    )
    default = int(load_settings(profile).get("default_service_duration_min", 60))
    if not behandling_id:
        return default
    b = (
        db.query(Behandling)
        .filter(Behandling.id == behandling_id, Behandling.user_id == user_id)
        .first()
    )
    if b is None or not b.duration_min:
        return default
    return int(b.duration_min)


def shortest_service_min(db: Session, user_id) -> int | None:
    """The shortest ACTIVE behandling's length, or None (no service, or a read
    error — the caller then falls back to the venue default). The day strip
    asks this when the guest has not chosen a service yet (R6)."""
    try:
        n = (
            db.query(func.min(Behandling.duration_min))
            .filter(Behandling.user_id == user_id, Behandling.active.is_(True))
            .scalar()
        )
    except SQLAlchemyError as exc:
        logger.warning("shortest service: read failed", exc_info=True)
        _release_failed_read(db, exc)
        return None
    return int(n) if n else None


def service_length(db: Session, user_id, behandling_id) -> int | None:
    """The tenant's ACTIVE behandling's length, or None: no id, an id that is
    not a UUID, another salon's, or an inactive one. Never the 60-minute
    default — the strip then asks shortest_service_min instead."""
    if not behandling_id:
        return None
    try:
        bid = uuid.UUID(str(behandling_id))
    except (ValueError, TypeError, AttributeError):
        return None
    try:
        n = (
            db.query(Behandling.duration_min)
            .filter(Behandling.id == bid, Behandling.user_id == user_id,
                    Behandling.active.is_(True))
            .scalar()
        )
    except SQLAlchemyError as exc:
        logger.warning("service length: read failed", exc_info=True)
        _release_failed_read(db, exc)
        return None
    return int(n) if n else None


def available_provider_slots(db: Session, *, profile: BusinessProfile | None,
                             user_id, day: date, duration_min: int,
                             stylist_resource_id=None,
                             now: datetime | None = None) -> list[dict]:
    """Bookable appointment slots on a salon's PROVIDERS for a day.

    Returns a LIST of dicts, one per (provider, start) the engine would honour::

        {"start": <iso>, "resource_id": <provider id>,
         "staff_id": <staff id or None>, "duration_min": <int>}

    Provider availability is owner-declared: provider_windows() reads either a
    self-chair's CONFIRMED opening hours or an employed stylist's PUBLISHED
    Schedule rows, so a provider with neither contributes nothing that day
    (no invented venue-hours fallback — the honesty gate).

    `duration_min` is passed through verbatim (the caller resolves it from the
    behandlinger catalog via resolve_behandling_duration); each slot is checked
    for that exact length using the SAME occupancy / no-double-book machinery
    the table engine uses (busy_for_day → compute_slots, which never returns a
    start whose [start, start+duration) overlaps an active occupancy row).

    Scope:
      • stylist_resource_id given  → only that one active provider.
      • stylist_resource_id None   → every active provider (kind="provider").

    This is a NEW function — available_slots() (the table path) is untouched.
    """
    settings = load_settings(profile)
    config = build_config(settings)
    busy = busy_for_day(db, user_id, day)
    dur = int(duration_min) if duration_min else int(
        settings.get("default_service_duration_min", 60))

    buf = service_buffer(settings)
    providers = [
        r for r in active_resources(db, user_id) if r.kind == "provider"
    ]
    if stylist_resource_id is not None:
        want = str(stylist_resource_id)
        providers = [p for p in providers if str(p.id) == want]

    out: list[dict] = []
    for p in providers:
        windows = provider_windows(db, user_id, p, day, settings)
        if not windows:
            continue
        for s in compute_slots(
            windows=windows, resources=_views([p]), busy=busy,
            party_size=1, config=config, now=now, duration_min=dur,
            buffer_min=buf,
        ):
            out.append({
                "start": s.start.isoformat(),
                "resource_id": str(p.id),
                "staff_id": str(p.staff_id) if p.staff_id else None,
                "duration_min": dur,
            })
    out.sort(key=lambda d: (d["start"], d["resource_id"]))
    return out


def recheck_provider_slot(db: Session, *, profile: BusinessProfile | None,
                          user_id, resource_id, start: datetime,
                          duration_min: int,
                          now: datetime | None = None,
                          buffer_min: int | None = None) -> str | None:
    """Booking-time race re-check for ONE specifically-requested stylist.

    Returns the provider id (as str) if THAT provider is still free for
    [start, start+duration) inside one of their published shifts, else None.

    This is the FAIL-CLOSED primitive behind the named-stylist rule: it never
    falls through to a different provider. The caller maps a None to a 409 and
    must NOT silently reassign the client to someone else — only an explicit
    "valgfri behandler" request (which routes through recheck_and_assign_combo)
    may auto-assign among free providers.

    A non-provider / inactive / foreign / unknown resource_id → None (treated
    as "not bookable" rather than leaking which it was).

    `buffer_min` (R6): None = the salon's pause (online); the owner's own
    paths pass 0.
    """
    settings = load_settings(profile)
    config = build_config(settings)
    busy = busy_for_day(db, user_id, start.date())
    dur = int(duration_min) if duration_min else int(
        settings.get("default_service_duration_min", 60))

    want = str(resource_id)
    provider = next(
        (r for r in active_resources(db, user_id)
         if r.kind == "provider" and str(r.id) == want),
        None,
    )
    if provider is None:
        return None
    windows = provider_windows(db, user_id, provider, start.date(), settings)
    if not windows:
        return None
    ids = find_slot_resources(
        requested_start=start, party_size=1, windows=windows,
        resources=_views([provider]), busy=busy, config=config, now=now,
        duration_min=dur, buffer_min=_online_buffer(settings, buffer_min),
    )
    return ids[0] if ids else None
