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
    free for big parties; no auto-combine in v1).

Everything is naive local (Europe/Copenhagen wall-clock) datetimes — the
router converts once at the edge so the maths here stays simple.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta


@dataclass(frozen=True)
class ResourceView:
    """A bookable resource reduced to what the engine needs."""
    id: str
    capacity_seats: int


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
    """A bookable start time + the resource that would be assigned."""
    start: datetime
    end: datetime
    resource_id: str | None
    available: bool


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
                    rid = assign_resource(party_size, start, start + dur, resources, busy)
                    if rid is not None:
                        out.append(Slot(start=start, end=start + dur, resource_id=rid, available=True))
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
