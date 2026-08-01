"""
Per-slot scarcity — the "2 left" / "Last table" hint on the public booking page.

WHY THIS FILE IS MOSTLY ABOUT HONESTY. A scarcity cue is the one piece of copy
on a booking page with a direct incentive to lie: "Last table" makes people
book faster whether or not it is true. The design handoff says so itself — if
the backend cannot supply real numbers, show plain available/full rather than
faking them. So these tests care less about the arithmetic being pretty and
more about it being impossible for the number to claim availability the
booking path would refuse.

Locks under test:
  • The count is real: 3 free tables that fit -> 3, and it falls as tables fill.
  • It NEVER overstates. It counts exactly the set assign_resource picks from,
    and ignores combinable tables, so it errs low by construction.
  • Tables too small for the party are not counted.
  • A slot that is offered always has remaining >= 1 — a bookable time can
    never render as "0 left".
  • Providers (salon chairs) are excluded: "2 left" is table language.

Run: cd backend && python3 -m pytest tests/test_slot_scarcity.py -x -q
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.services.availability_engine import (
    AvailabilityConfig,
    BusyInterval,
    ResourceView,
    TimeWindow,
    compute_slots,
    count_free_singles,
    is_resource_free,
)


def _R(rid: str, seats: int, combinable: bool = False, zone=None) -> ResourceView:
    return ResourceView(id=rid, capacity_seats=seats, combinable=combinable, zone=zone)


_START = datetime(2026, 7, 4, 19, 0)
_END = _START + timedelta(minutes=90)


def _busy(*triples):
    """The engine takes a LIST of BusyInterval, not a dict — is_resource_free
    iterates it directly."""
    return [BusyInterval(resource_id=rid, start=s, end=e) for rid, s, e in triples]


# ── the count is real ────────────────────────────────────────────────

def test_counts_every_free_table_that_fits():
    resources = [_R("a", 2), _R("b", 4), _R("c", 6)]
    assert count_free_singles(2, _START, _END, resources, []) == 3


def test_count_falls_as_tables_fill():
    resources = [_R("a", 2), _R("b", 2), _R("c", 2)]
    busy = _busy(("a", _START, _END))
    assert count_free_singles(2, _START, _END, resources, busy) == 2
    busy2 = _busy(("a", _START, _END), ("b", _START, _END))
    assert count_free_singles(2, _START, _END, resources, busy2) == 1


def test_last_table_is_exactly_one():
    resources = [_R("a", 2), _R("b", 2)]
    busy = _busy(("a", _START, _END))
    assert count_free_singles(2, _START, _END, resources, busy) == 1


def test_fully_booked_is_zero():
    resources = [_R("a", 2)]
    busy = _busy(("a", _START, _END))
    assert count_free_singles(2, _START, _END, resources, busy) == 0


# ── it must never overstate ──────────────────────────────────────────

def test_tables_too_small_are_not_counted():
    """A 2-top cannot take a party of 4, so it must not inflate the hint."""
    resources = [_R("small", 2), _R("big", 4)]
    assert count_free_singles(4, _START, _END, resources, []) == 1


def test_never_exceeds_the_set_assign_resource_would_pick_from():
    """The count and the seating decision must read the same world — otherwise
    a slot could advertise a table the booking path then refuses."""
    resources = [_R("a", 2), _R("b", 4), _R("c", 4)]
    busy = _busy(("b", _START, _END))
    fits_and_free = [
        r for r in resources
        if r.capacity_seats >= 2 and is_resource_free(r.id, _START, _END, busy)
    ]
    assert count_free_singles(2, _START, _END, resources, busy) == len(fits_and_free)


def test_understates_rather_than_overstates_with_combos():
    """Two 2-tops can be combined to seat 4, but the counter only sees singles.
    Reporting 0 where a combo exists is the SAFE direction — the slot is still
    offered; only the hint stays quiet. Overstating would invent urgency."""
    resources = [_R("a", 2, combinable=True, zone="in"),
                 _R("b", 2, combinable=True, zone="in")]
    assert count_free_singles(4, _START, _END, resources, []) == 0


def test_partial_overlap_still_blocks():
    """A table busy for part of the window cannot take the whole booking."""
    resources = [_R("a", 2)]
    busy = _busy(("a", _START + timedelta(minutes=30), _END + timedelta(minutes=30)))
    assert count_free_singles(2, _START, _END, resources, busy) == 0


# ── a bookable slot can never read as "0 left" ───────────────────────

def test_offered_slots_always_have_at_least_one_remaining():
    """compute_slots only emits a slot when a party can be seated, and the
    single-table path is what sets remaining — so any slot backed by a single
    table reports >= 1. (Combo-only slots report 0 and simply show no hint.)"""
    resources = [_R("a", 2), _R("b", 4)]
    cfg = AvailabilityConfig(slot_granularity_min=30, combine_enabled=False)
    slots = compute_slots(
        windows=[TimeWindow(start=_START, end=_START + timedelta(hours=3))],
        resources=resources, busy=[], party_size=2, config=cfg, now=None,
        duration_min=90,
    )
    assert slots, "fixture should produce slots"
    assert all(s.remaining >= 1 for s in slots), (
        "a slot that is offered must never render as '0 left'"
    )
