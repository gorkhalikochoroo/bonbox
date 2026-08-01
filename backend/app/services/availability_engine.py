"""Availability engine — the brain of reservations.

Pure, dependency-free, deterministic. Given a day's open windows, the
resources, and the bookings already on them, it returns the slots a guest
can actually be given — never one we can't honour.

It is vertical-agnostic. The router adapts the world into three inputs:
  • windows   — open intervals for the day. Restaurant: derived from
                operating_hours_json. Appointment: the provider's published
                Schedule shift(s).
  • resources — tables (capacity = seats) or providers/chairs (capacity 1).
  • busy      — existing non-cancelled reservations as (resource_id, start,
                end) intervals.

Then it fits a party/appointment of a given duration, respecting:
  • turn-time that scales with party size (restaurants),
  • pacing (cap on how many bookings may START per window, so the kitchen /
    the stylist isn't slammed),
  • lead time (earliest bookable = now + lead),
  • resource fit (smallest table that seats the party — big tables stay
    free for big parties),
  • table combining (when no single table fits, push two+ combinable tables
    in the same zone together — a party of 6 across a 4-top + a 2-top —
    preferring the fewest tables, then the least wasted seats). Each table
    in the combo is still individually overlap-protected by the DB exclusion
    constraint, so combining never weakens the no-double-booking guarantee.

Everything is naive local (Europe/Copenhagen wall-clock) datetimes — the
router converts once at the edge so the maths here stays simple.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from itertools import combinations

# Max combinable tables we'll consider in ONE zone when searching for a
# combination. Bounds the combinatorial search (C(24,3)=2024 — trivial) far
# above any real floor plan; a zone with more combinable tables than this keeps
# only its smallest ones (the most combine-useful, least-waste). The service
# layer logs a one-time warning if a zone ever exceeds it — never silently.
_COMBO_POOL_CAP = 24


@dataclass(frozen=True)
class ResourceView:
    """A bookable resource reduced to what the engine needs."""
    id: str
    capacity_seats: int
    # Can this table be pushed together with other combinable tables in the
    # same zone to seat a party that fits no single table? Providers/chairs
    # are never combinable (capacity 1). Defaults False so existing callers
    # and tests are unaffected.
    combinable: bool = False
    # Physical grouping — only same-zone tables combine (you can't push an
    # indoor table against a terrace one). None forms its own group.
    zone: str | None = None


@dataclass(frozen=True)
class BusyInterval:
    """An existing reservation occupying a resource."""
    resource_id: str
    start: datetime
    end: datetime


@dataclass(frozen=True)
class TimeWindow:
    """An open interval the business accepts bookings within."""
    start: datetime
    end: datetime


@dataclass(frozen=True)
class Slot:
    """A bookable start time + the resource(s) that would be assigned."""
    start: datetime
    end: datetime
    resource_id: str | None
    available: bool
    # The full table set backing this slot: one id for a single table, or
    # two+ for a combined seating. `resource_id` mirrors the primary
    # (resource_ids[0]) for back-compat. Empty when none assigned.
    resource_ids: tuple[str, ...] = ()
    # How many single tables could still take this party at this time — the
    # honest number behind the guest-facing "2 left" / "Last table" hint.
    # See count_free_singles: it understates rather than overstates.
    remaining: int = 0


@dataclass
class AvailabilityConfig:
    slot_granularity_min: int = 15
    # Cap on reservations that may START within one pacing window. None = no cap.
    pacing_max_per_slot: int | None = None
    pacing_window_min: int = 15
    # Turn-time tiers by party size, largest-applicable wins. Each entry:
    # {"up_to": <max party>, "minutes": <turn>}. Falls through to
    # default_duration_min for parties bigger than the largest tier.
    turn_time_tiers: list[dict] = field(default_factory=list)
    default_duration_min: int = 90
    lead_time_min: int = 0
    # Online party-size ceiling. Parties bigger than this can't self-book
    # (router routes them to a "call us" / request path). None = no ceiling.
    max_party_size: int | None = None
    # Table combining: when no single table seats the party, push 2+
    # combinable same-zone tables together. Off by default (existing tests
    # see no combos); even when on, only tables flagged combinable take part.
    combine_enabled: bool = False
    # Most tables one combined seating may span (don't tie up the whole floor
    # for one party). 2–3 is typical; capped against the per-zone pool.
    max_combo_size: int = 3


def turn_time_minutes(party_size: int, config: AvailabilityConfig) -> int:
    """Turn-time for a party. Smallest tier whose `up_to` covers the party
    wins; otherwise the default."""
    best: int | None = None
    best_up_to: int | None = None
    for tier in sorted(config.turn_time_tiers, key=lambda t: t.get("up_to", 0)):
        up_to = tier.get("up_to")
        minutes = tier.get("minutes")
        if up_to is None or minutes is None:
            continue
        if party_size <= up_to:
            if best_up_to is None or up_to < best_up_to:
                best, best_up_to = minutes, up_to
    return int(best) if best is not None else int(config.default_duration_min)


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    """Half-open overlap: [a) intersects [b). Touching ends don't overlap,
    so a 18:00–19:30 booking leaves 19:30 free for the next party."""
    return a_start < b_end and b_start < a_end


def is_resource_free(resource_id: str, start: datetime, end: datetime, busy) -> bool:
    for b in busy:
        if b.resource_id == resource_id and _overlaps(start, end, b.start, b.end):
            return False
    return True


def assign_resource(party_size: int, start: datetime, end: datetime,
                    resources, busy) -> str | None:
    """Smallest-capacity resource that seats the party and is free for the
    whole range. Smallest-fit keeps big tables open for big parties."""
    candidates = sorted(
        (r for r in resources if r.capacity_seats >= party_size),
        key=lambda r: (r.capacity_seats, str(r.id)),
    )
    for r in candidates:
        if is_resource_free(r.id, start, end, busy):
            return r.id
    return None


def count_free_singles(party_size: int, start: datetime, end: datetime,
                       resources, busy) -> int:
    """How many SINGLE tables could seat this party for this whole range.

    Drives the guest-facing scarcity hint ("2 left", "Last table"). It counts
    exactly the set assign_resource picks from, so the number can never claim
    availability the booking path would then refuse.

    DELIBERATELY UNDERSTATES. A party that no single table fits may still be
    seatable by COMBINING tables, and that is not counted here. Erring low is
    the safe direction for a scarcity cue: showing "Last table" when a combo
    also exists costs the guest nothing, whereas overstating would be a lie
    told to create urgency. The slot itself is still offered either way —
    this only decides what the hint says.
    """
    return sum(
        1
        for r in resources
        if r.capacity_seats >= party_size and is_resource_free(r.id, start, end, busy)
    )


def find_combo(party_size: int, start: datetime, end: datetime,
               resources, busy, max_combo_size: int) -> list[str] | None:
    """Best combination of combinable, same-zone, free tables that seats the
    party. Preference order (lowest wins): fewest tables → least wasted seats
    → stable id order. Returns the table ids (len ≥ 2), or None when no
    combination reaches the party size.

    Only tables flagged `combinable` and free for the whole range take part,
    and a combination is drawn from a single zone (you can't push an indoor
    table against a terrace one). Bounded by `_COMBO_POOL_CAP` per zone."""
    if not max_combo_size or max_combo_size < 2:
        return None
    free = [
        r for r in resources
        if getattr(r, "combinable", False)
        and is_resource_free(r.id, start, end, busy)
    ]
    if len(free) < 2:
        return None

    # Group by zone — only physically grouped tables push together.
    zones: dict = {}
    for r in free:
        zones.setdefault(getattr(r, "zone", None), []).append(r)

    best_key: tuple | None = None
    best_ids: list[str] | None = None
    for pool in zones.values():
        # Smallest tables first: keeps the least-waste candidates if we have to
        # cap, and makes the search deterministic.
        pool = sorted(pool, key=lambda r: (r.capacity_seats, str(r.id)))
        if len(pool) > _COMBO_POOL_CAP:
            pool = pool[:_COMBO_POOL_CAP]
        upper = min(int(max_combo_size), len(pool))
        for size in range(2, upper + 1):
            found_at_size = False
            for combo in combinations(pool, size):
                total = sum(t.capacity_seats for t in combo)
                if total >= party_size:
                    found_at_size = True
                    waste = total - party_size
                    ids = tuple(str(t.id) for t in combo)
                    key = (size, waste, ids)
                    if best_key is None or key < best_key:
                        best_key, best_ids = key, list(ids)
            # A smaller table-count always beats a larger one (size is the
            # primary key), so once this zone yields an answer at `size` there's
            # no point trying bigger combos within it.
            if found_at_size:
                break
    return best_ids


def assign_seats(party_size: int, start: datetime, end: datetime,
                 resources, busy, config: AvailabilityConfig) -> list[str] | None:
    """The seating decision: a single table if one fits (preferred — never tie
    up two tables when one will do), else a combination when combining is
    enabled. Returns the table id(s), or None if the party can't be seated."""
    single = assign_resource(party_size, start, end, resources, busy)
    if single is not None:
        return [single]
    if getattr(config, "combine_enabled", False):
        return find_combo(party_size, start, end, resources, busy,
                          getattr(config, "max_combo_size", 3))
    return None


def combinable_zone_overflow(resources, cap: int = _COMBO_POOL_CAP) -> list[tuple]:
    """Zones whose combinable-table count exceeds `cap` (so find_combo will
    only consider the smallest `cap` of them). Returned as (zone, count) pairs
    so the service layer can log it — combos are never silently truncated."""
    counts: dict = {}
    for r in resources:
        if getattr(r, "combinable", False):
            z = getattr(r, "zone", None)
            counts[z] = counts.get(z, 0) + 1
    return [(z, n) for z, n in counts.items() if n > cap]


def _pacing_blocked(start: datetime, busy, config: AvailabilityConfig) -> bool:
    """True if too many reservations already start within this slot's pacing
    window (protects the kitchen / provider throughput)."""
    if not config.pacing_max_per_slot:
        return False
    win = timedelta(minutes=config.pacing_window_min)
    floor = start
    started = sum(1 for b in busy if floor <= b.start < floor + win)
    return started >= config.pacing_max_per_slot


def compute_slots(*, windows, resources, busy, party_size: int,
                  config: AvailabilityConfig, now: datetime | None = None,
                  duration_min: int | None = None) -> list[Slot]:
    """Bookable slots for a party on a day. Returns only AVAILABLE slots,
    each with the resource that would be assigned."""
    # Online ceiling — bigger parties can't self-serve.
    if config.max_party_size is not None and party_size > config.max_party_size:
        return []

    duration = duration_min if duration_min is not None else turn_time_minutes(party_size, config)
    dur = timedelta(minutes=duration)
    step = timedelta(minutes=max(1, config.slot_granularity_min))
    earliest = (now + timedelta(minutes=config.lead_time_min)) if now else None

    out: list[Slot] = []
    for w in windows:
        start = w.start
        while start + dur <= w.end:
            if earliest is None or start >= earliest:
                if not _pacing_blocked(start, busy, config):
                    ids = assign_seats(party_size, start, start + dur, resources, busy, config)
                    if ids:
                        out.append(Slot(
                            start=start, end=start + dur, resource_id=ids[0],
                            resource_ids=tuple(ids), available=True,
                            remaining=count_free_singles(
                                party_size, start, start + dur, resources, busy,
                            ),
                        ))
            start += step
    return out


def find_slot_resource(*, requested_start: datetime, party_size: int, windows,
                       resources, busy, config: AvailabilityConfig,
                       now: datetime | None = None,
                       duration_min: int | None = None) -> str | None:
    """Server-side re-check at booking time (prevents races): is the exact
    requested start still bookable? Returns the resource to assign, or None.

    Re-validates the slot independently rather than trusting the client's
    earlier availability read."""
    if config.max_party_size is not None and party_size > config.max_party_size:
        return None
    duration = duration_min if duration_min is not None else turn_time_minutes(party_size, config)
    end = requested_start + timedelta(minutes=duration)

    # Must sit inside an open window.
    if not any(w.start <= requested_start and end <= w.end for w in windows):
        return None
    if now and requested_start < now + timedelta(minutes=config.lead_time_min):
        return None
    if _pacing_blocked(requested_start, busy, config):
        return None
    return assign_resource(party_size, requested_start, end, resources, busy)


def find_slot_resources(*, requested_start: datetime, party_size: int, windows,
                        resources, busy, config: AvailabilityConfig,
                        now: datetime | None = None,
                        duration_min: int | None = None) -> list[str] | None:
    """Combo-aware sibling of `find_slot_resource` used by the booking-time
    race re-check. Same window / lead-time / pacing guards, but returns the
    full table set to assign — one id for a single table, or two+ when the
    party can only be seated by combining tables. None if no longer bookable.

    The DB exclusion constraint is the real backstop: every id returned here
    gets its own occupancy row, and any that lost a concurrent race makes the
    whole insert roll back (the caller re-runs this to pick a fresh set)."""
    if config.max_party_size is not None and party_size > config.max_party_size:
        return None
    duration = duration_min if duration_min is not None else turn_time_minutes(party_size, config)
    end = requested_start + timedelta(minutes=duration)

    if not any(w.start <= requested_start and end <= w.end for w in windows):
        return None
    if now and requested_start < now + timedelta(minutes=config.lead_time_min):
        return None
    if _pacing_blocked(requested_start, busy, config):
        return None
    return assign_seats(party_size, requested_start, end, resources, busy, config)
