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
  • pacing (cap on how many GUESTS may START per window, so the kitchen /
    the stylist isn't slammed — R9: guests, as the owner's label says),
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
    """An existing reservation occupying a resource.

    `reservation_id` and `party_size` (R9) let the pacing cap count GUESTS,
    as its label says ("Maks. gæster pr. tid"): each booking once, however
    many tables it joins, times its party. The defaults keep every older
    caller exactly as it was — an interval with no booking id counts as one
    booking of one guest."""
    resource_id: str
    start: datetime
    end: datetime
    reservation_id: str | None = None
    party_size: int = 1


@dataclass(frozen=True)
class TimeWindow:
    """An open interval the business accepts bookings within.

    `last_start` (R8, "sidste booking"): the latest START the owner takes in
    this window. None = the classic rule — the whole sitting ends by `end`,
    so the last start is closing minus the table time. When set, the START
    decides (start <= last_start) and a sitting may run past `end`: "we
    close at 22, last booking 21:00". Always within [start, end]."""
    start: datetime
    end: datetime
    last_start: datetime | None = None


def window_admits(w: TimeWindow, start: datetime, end: datetime) -> bool:
    """Does window `w` take a booking held from `start` to `end`? With a last
    booking time the start alone decides; without one the whole hold must
    end by closing. The ONE rule the grid and the booking-time re-check
    share, so the page and the create path can never disagree."""
    if w.last_start is not None:
        return w.start <= start <= w.last_start
    return w.start <= start and end <= w.end


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
    # Cap on GUESTS whose booking may START within one pacing window (R9 — it
    # counted bookings × tables). None = no cap.
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
    wins. A party bigger than every tier sits at least as long as the largest
    tier — it fell back to the 90-minute default, so a 12-top was held for
    less time than an 8-top and its table resold at 20:30. With no tiers at
    all, the default."""
    best: int | None = None
    best_up_to: int | None = None
    largest: tuple[int, int] | None = None  # (up_to, minutes) of the top tier
    for tier in sorted(config.turn_time_tiers, key=lambda t: t.get("up_to", 0)):
        up_to = tier.get("up_to")
        minutes = tier.get("minutes")
        if up_to is None or minutes is None:
            continue
        if largest is None or up_to >= largest[0]:
            largest = (up_to, minutes)
        if party_size <= up_to:
            if best_up_to is None or up_to < best_up_to:
                best, best_up_to = minutes, up_to
    if best is not None:
        return int(best)
    if largest is not None:
        return max(int(largest[1]), int(config.default_duration_min))
    return int(config.default_duration_min)


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


def guests_starting(start: datetime, busy, window_min: int) -> int:
    """Guests whose booking STARTS in [start, start + window_min). Each
    booking counts once with its party size — a party of 6 on two joined
    tables is 6 guests, not 2 tables. An interval without a booking id (an
    older caller) counts as one booking of one guest."""
    win = timedelta(minutes=window_min)
    seen: set = set()
    guests = 0
    for b in busy:
        if not (start <= b.start < start + win):
            continue
        rid = getattr(b, "reservation_id", None)
        if rid is not None:
            if rid in seen:
                continue
            seen.add(rid)
        guests += max(1, int(getattr(b, "party_size", 1) or 1))
    return guests


def _pacing_blocked(start: datetime, busy, config: AvailabilityConfig,
                    party_size: int = 1) -> bool:
    """True if this party would take the guests starting within this slot's
    pacing window past the owner's cap (protects the kitchen / provider
    throughput).

    R9: the cap counts GUESTS ("Maks. gæster pr. tid" / "Max covers per
    slot" — what the field always said, and what owners and booking tools
    pace a kitchen by). It counted bookings × tables: an owner who typed 20
    meaning 20 covers allowed 20 bookings. The new party counts too, so a
    party bigger than the cap on its own is never paced in online. With a
    party of one this is the old rule exactly (n started >= cap)."""
    if not config.pacing_max_per_slot:
        return False
    party = max(1, int(party_size or 1))
    guests = guests_starting(start, busy, config.pacing_window_min)
    return guests + party > config.pacing_max_per_slot


def time_grid(*, windows, duration_min: int, config: AvailabilityConfig,
              now: datetime | None = None):
    """The venue's bookable START TIMES, before any table is considered: every
    `slot_granularity_min` step from each window's opening, where the whole
    turn fits inside the window and the start is past `now + lead_time_min`.

    compute_slots walks exactly this grid and keeps the starts a table can
    take; a group request (no table held until the owner approves) offers the
    grid itself as preferred times. One walk, so the two can never disagree
    about opening hours, interval or lead time.

    R8: a day may have two windows (lunch and dinner); each grid starts at
    its own opening. A window with a last booking time (`last_start`) offers
    every step up to and including it, whatever the sitting's length. A
    start two windows share (one ending as the next opens) is given once."""
    dur = timedelta(minutes=duration_min)
    step = timedelta(minutes=max(1, config.slot_granularity_min))
    earliest = (now + timedelta(minutes=config.lead_time_min)) if now else None
    seen: set = set()
    for w in windows:
        start = w.start
        while (start <= w.last_start) if w.last_start is not None else (start + dur <= w.end):
            if start not in seen and (earliest is None or start >= earliest):
                seen.add(start)
                yield start
            start += step


def with_buffer(busy, buffer_min: int):
    """The busy list with each interval's end moved `buffer_min` later — the
    salon's "pause mellem kunder" (R6) behind every appointment already on a
    chair. 0 (or less) returns the list unchanged, so a venue without a pause
    runs exactly the arithmetic it always ran."""
    if not buffer_min or buffer_min <= 0:
        return busy
    pad = timedelta(minutes=int(buffer_min))
    return [BusyInterval(resource_id=b.resource_id, start=b.start, end=b.end + pad)
            for b in busy]


def compute_slots(*, windows, resources, busy, party_size: int,
                  config: AvailabilityConfig, now: datetime | None = None,
                  duration_min: int | None = None,
                  buffer_min: int = 0) -> list[Slot]:
    """Bookable slots for a party on a day. Returns only AVAILABLE slots,
    each with the resource that would be assigned.

    `buffer_min` (R6, salon chairs only): a pause after every appointment.
    The candidate holds its chair for duration + pause, and each booking
    already on a chair is read as ending `buffer_min` later — so exactly one
    pause sits between two customers, whichever was booked first. The
    service itself only has to END by closing (no pause is needed after the
    day's last customer), and pacing still counts starts. 0 = unchanged."""
    # Online ceiling — bigger parties can't self-serve.
    if config.max_party_size is not None and party_size > config.max_party_size:
        return []

    duration = duration_min if duration_min is not None else turn_time_minutes(party_size, config)
    dur = timedelta(minutes=duration)
    hold = timedelta(minutes=duration + max(0, int(buffer_min or 0)))
    held = with_buffer(busy, buffer_min)

    out: list[Slot] = []
    for start in time_grid(windows=windows, duration_min=duration, config=config, now=now):
        if not _pacing_blocked(start, busy, config, party_size):
            ids = assign_seats(party_size, start, start + hold, resources, held, config)
            if ids:
                out.append(Slot(
                    start=start, end=start + dur, resource_id=ids[0],
                    resource_ids=tuple(ids), available=True,
                    remaining=count_free_singles(
                        party_size, start, start + hold, resources, held,
                    ),
                ))
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

    # Must sit inside an open window (or start by its last booking time).
    if not any(window_admits(w, requested_start, end) for w in windows):
        return None
    if now and requested_start < now + timedelta(minutes=config.lead_time_min):
        return None
    if _pacing_blocked(requested_start, busy, config, party_size):
        return None
    return assign_resource(party_size, requested_start, end, resources, busy)


def find_slot_resources(*, requested_start: datetime, party_size: int, windows,
                        resources, busy, config: AvailabilityConfig,
                        now: datetime | None = None,
                        duration_min: int | None = None,
                        buffer_min: int = 0) -> list[str] | None:
    """Combo-aware sibling of `find_slot_resource` used by the booking-time
    race re-check. Same window / lead-time / pacing guards, but returns the
    full table set to assign — one id for a single table, or two+ when the
    party can only be seated by combining tables. None if no longer bookable.

    The DB exclusion constraint is the real backstop: every id returned here
    gets its own occupancy row, and any that lost a concurrent race makes the
    whole insert roll back (the caller re-runs this to pick a fresh set).

    `buffer_min`: the salon's pause between customers, read exactly as
    compute_slots reads it, so the guest page and the create path agree."""
    if config.max_party_size is not None and party_size > config.max_party_size:
        return None
    duration = duration_min if duration_min is not None else turn_time_minutes(party_size, config)
    end = requested_start + timedelta(minutes=duration)

    if not any(window_admits(w, requested_start, end) for w in windows):
        return None
    if now and requested_start < now + timedelta(minutes=config.lead_time_min):
        return None
    if _pacing_blocked(requested_start, busy, config, party_size):
        return None
    hold_end = end + timedelta(minutes=max(0, int(buffer_min or 0)))
    return assign_seats(party_size, requested_start, hold_end, resources,
                        with_buffer(busy, buffer_min), config)
