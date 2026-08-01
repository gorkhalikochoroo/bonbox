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

from app.models.behandling import Behandling
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
    # Guest self-select their table on the public widget. OFF by default — the
    # owner keeps seating control (auto-assign picks the best free table), which
    # matches OpenTable/Resy norm; owners who want the transparency turn it on.
    "guest_can_pick_table": False,
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


def provider_windows(db: Session, user_id, resource, day: date,
                     settings: dict) -> list[TimeWindow]:
    """A provider chair's open windows for the day — two HONEST sources, never
    a venue-hours fallback:

      • owner "self-chair" (`follows_opening_hours=True`) → the owner's CONFIRMED
        weekly opening hours (`booking_hours`). Lets a solo salon take bookings
        without a StaffMember; no declared hours ⇒ [].
      • employed stylist (`staff_id` set) → that stylist's PUBLISHED Schedule
        shifts; no published shift ⇒ [].

    A provider row that is neither (a legacy NULL-staff row with
    follows_opening_hours False) ⇒ [] — it never silently lights up."""
    if getattr(resource, "follows_opening_hours", False):
        return _opening_hours_windows(settings, day)
    staff_id = getattr(resource, "staff_id", None)
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

    # Appointment providers each have their own window (self-chair opening
    # hours, or an employed stylist's published shift).
    for p in providers:
        windows = provider_windows(db, user_id, p, day, settings)
        if not windows:
            continue
        dur = duration_min or settings.get("default_service_duration_min", 60)
        for s in compute_slots(
            windows=windows, resources=_views([p]), busy=busy,
            party_size=party_size, config=config, now=now, duration_min=dur,
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


def summarize_days(db: Session, *, profile: BusinessProfile, user_id,
                   start_date: date, days: int, party_size: int,
                   now: datetime) -> dict:
    """Per-day open/closed overview for the public date strip + the public-surface
    monitor. Calls the SAME available_slots() a diner actually sees, so the strip
    can never disagree with reality. Days in the past or beyond the advance window
    are 'out_of_window' (not offerable). Returns:
        {'next_open_day': iso|None, 'days': [{'date', 'has_slots', 'reason'}]}
    ONE source of truth for 'is this booking page dead' — shared so the customer
    UX and the auto-diagnosis can't diverge."""
    settings = load_settings(profile)
    today = now.date()
    max_advance = int(settings.get("max_advance_days", 60))
    out: list[dict] = []
    first_open = None
    for i in range(days):
        d = start_date + timedelta(days=i)
        if d < today or d > today + timedelta(days=max_advance):
            out.append({"date": d.isoformat(), "has_slots": False, "reason": "out_of_window"})
            continue
        slots = available_slots(
            db, profile=profile, user_id=user_id, day=d,
            party_size=party_size, now=now,
        )
        has = len(slots) > 0
        out.append({"date": d.isoformat(), "has_slots": has,
                    "reason": None if has else "closed_or_full"})
        if has and first_open is None:
            first_open = d.isoformat()
    return {"next_open_day": first_open, "days": out}


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
        windows = provider_windows(db, user_id, p, start.date(), settings)
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
                          now: datetime | None = None) -> str | None:
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
        duration_min=dur,
    )
    return ids[0] if ids else None
