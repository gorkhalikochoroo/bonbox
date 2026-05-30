"""Unit tests for the reservation availability engine.

The engine is pure (no DB), so these are fast, deterministic, and cover
the failure modes that make or break a reservation product: double-booking,
over-blocking, pacing, turn-times, window edges, and the server-side
race-recheck.
"""
from datetime import datetime, timedelta

from app.services.availability_engine import (
    ResourceView, BusyInterval, TimeWindow, AvailabilityConfig,
    turn_time_minutes, is_resource_free, assign_resource,
    compute_slots, find_slot_resource, find_slot_resources,
    find_combo, assign_seats,
)


def _d(h, m=0):
    """A datetime on a fixed test day (2026-06-12) at h:m."""
    return datetime(2026, 6, 12, h, m)


def _dinner_window():
    # Dinner service 17:00–22:00.
    return [TimeWindow(start=_d(17), end=_d(22))]


def _cfg(**kw):
    base = dict(
        slot_granularity_min=30,
        default_duration_min=90,
        turn_time_tiers=[
            {"up_to": 2, "minutes": 90},
            {"up_to": 4, "minutes": 105},
            {"up_to": 6, "minutes": 120},
        ],
    )
    base.update(kw)
    return AvailabilityConfig(**base)


# ── turn-time tiers ────────────────────────────────────────────────────
def test_turn_time_scales_with_party_size():
    c = _cfg()
    assert turn_time_minutes(1, c) == 90
    assert turn_time_minutes(2, c) == 90
    assert turn_time_minutes(3, c) == 105
    assert turn_time_minutes(4, c) == 105
    assert turn_time_minutes(6, c) == 120
    # Bigger than the largest tier → default.
    assert turn_time_minutes(10, c) == 90


# ── empty day ──────────────────────────────────────────────────────────
def test_empty_day_offers_slots_across_window():
    resources = [ResourceView("t2", 2)]
    slots = compute_slots(
        windows=_dinner_window(), resources=resources, busy=[],
        party_size=2, config=_cfg(),
    )
    starts = [s.start for s in slots]
    # 90-min turns, 30-min steps, last start that still ends by 22:00 = 20:30.
    assert _d(17) in starts
    assert _d(20, 30) in starts
    assert _d(21) not in starts  # 21:00 + 90 = 22:30 > close
    assert all(s.available and s.resource_id == "t2" for s in slots)


# ── window edge: never offer a slot that runs past close ───────────────
def test_slot_never_runs_past_window_close():
    resources = [ResourceView("t6", 6)]  # a 6-top for the party of 6
    slots = compute_slots(
        windows=_dinner_window(), resources=resources, busy=[],
        party_size=6, config=_cfg(),  # 120-min turn
    )
    # Last bookable start for a 120-min turn is 20:00.
    assert max(s.start for s in slots) == _d(20)


# ── a booked table blocks only overlapping slots on THAT table ─────────
def test_booking_blocks_overlap_but_other_table_free():
    resources = [ResourceView("t2a", 2), ResourceView("t2b", 2)]
    # t2a booked 19:00–20:30.
    busy = [BusyInterval("t2a", _d(19), _d(20, 30))]
    slots = compute_slots(
        windows=_dinner_window(), resources=resources, busy=busy,
        party_size=2, config=_cfg(),
    )
    # 19:00 must still be offered — on t2b, not t2a.
    s1900 = [s for s in slots if s.start == _d(19)]
    assert len(s1900) == 1
    assert s1900[0].resource_id == "t2b"


def test_fully_booked_slot_is_not_offered():
    resources = [ResourceView("t2a", 2)]  # only one table
    busy = [BusyInterval("t2a", _d(19), _d(20, 30))]
    slots = compute_slots(
        windows=_dinner_window(), resources=resources, busy=busy,
        party_size=2, config=_cfg(),
    )
    starts = [s.start for s in slots]
    assert _d(19) not in starts        # overlaps the booking
    assert _d(19, 30) not in starts    # 19:30+90=21:00 overlaps until 20:30
    assert _d(20, 30) in starts        # touching end is free (half-open)


# ── smallest-fit: don't burn a big table on a small party ──────────────
def test_smallest_fit_assignment():
    resources = [ResourceView("t6", 6), ResourceView("t2", 2), ResourceView("t4", 4)]
    rid = assign_resource(2, _d(18), _d(19, 30), resources, busy=[])
    assert rid == "t2"
    rid4 = assign_resource(4, _d(18), _d(19, 30), resources, busy=[])
    assert rid4 == "t4"


# ── party too big for any single table → nothing online ────────────────
def test_party_bigger_than_any_table_no_slots():
    resources = [ResourceView("t2", 2), ResourceView("t4", 4)]
    slots = compute_slots(
        windows=_dinner_window(), resources=resources, busy=[],
        party_size=8, config=_cfg(),
    )
    assert slots == []


def test_online_party_ceiling_blocks_everything():
    resources = [ResourceView("big", 20)]
    slots = compute_slots(
        windows=_dinner_window(), resources=resources, busy=[],
        party_size=12, config=_cfg(max_party_size=8),
    )
    assert slots == []  # over the online ceiling → must call


# ── pacing: cap how many bookings start per window ─────────────────────
def test_pacing_blocks_when_window_full():
    # Plenty of tables, but pacing allows only 1 new booking per 30-min window.
    resources = [ResourceView(f"t{i}", 2) for i in range(5)]
    busy = [BusyInterval("t0", _d(19), _d(20, 30))]  # one party already at 19:00
    cfg = _cfg(pacing_max_per_slot=1, pacing_window_min=30)
    slots = compute_slots(
        windows=_dinner_window(), resources=resources, busy=busy,
        party_size=2, config=cfg,
    )
    starts = [s.start for s in slots]
    assert _d(19) not in starts        # window already has 1 start → blocked
    assert _d(19, 30) in starts        # next window is open


# ── lead time ──────────────────────────────────────────────────────────
def test_lead_time_filters_near_term_slots():
    resources = [ResourceView("t2", 2)]
    now = _d(18, 5)  # it's 18:05; require 60 min lead
    slots = compute_slots(
        windows=_dinner_window(), resources=resources, busy=[],
        party_size=2, config=_cfg(lead_time_min=60), now=now,
    )
    starts = [s.start for s in slots]
    assert _d(18, 30) not in starts    # < 19:05 lead cutoff
    assert _d(19, 30) in starts


# ── is_resource_free / overlap semantics ───────────────────────────────
def test_overlap_is_half_open():
    busy = [BusyInterval("t", _d(19), _d(20, 30))]
    assert not is_resource_free("t", _d(19, 30), _d(21), busy)  # overlaps
    assert is_resource_free("t", _d(20, 30), _d(22), busy)      # touches end → free
    assert is_resource_free("t", _d(17), _d(18, 30), busy)      # before


# ── server-side race re-check ──────────────────────────────────────────
def test_find_slot_resource_confirms_free_slot():
    resources = [ResourceView("t2", 2)]
    rid = find_slot_resource(
        requested_start=_d(19), party_size=2, windows=_dinner_window(),
        resources=resources, busy=[], config=_cfg(),
    )
    assert rid == "t2"


def test_find_slot_resource_rejects_taken_slot():
    resources = [ResourceView("t2", 2)]
    busy = [BusyInterval("t2", _d(19), _d(20, 30))]
    rid = find_slot_resource(
        requested_start=_d(19, 30), party_size=2, windows=_dinner_window(),
        resources=resources, busy=busy, config=_cfg(),
    )
    assert rid is None  # the only table is taken → no double-book


def test_find_slot_resource_rejects_outside_window():
    resources = [ResourceView("t2", 2)]
    rid = find_slot_resource(
        requested_start=_d(16), party_size=2, windows=_dinner_window(),
        resources=resources, busy=[], config=_cfg(),
    )
    assert rid is None  # before open


def test_find_slot_resource_rejects_over_ceiling():
    resources = [ResourceView("big", 20)]
    rid = find_slot_resource(
        requested_start=_d(19), party_size=12, windows=_dinner_window(),
        resources=resources, busy=[], config=_cfg(max_party_size=8),
    )
    assert rid is None


# ── appointment vertical: capacity-1 provider, explicit duration ───────
def test_appointment_uses_explicit_duration_and_provider():
    # One stylist, working 09:00–12:00; a 45-min cut already at 10:00.
    providers = [ResourceView("maria", 1)]
    window = [TimeWindow(start=_d(9), end=_d(12))]
    busy = [BusyInterval("maria", _d(10), _d(10, 45))]
    slots = compute_slots(
        windows=window, resources=providers, busy=busy, party_size=1,
        config=_cfg(slot_granularity_min=15), duration_min=45,
    )
    starts = [s.start for s in slots]
    assert _d(9) in starts
    assert _d(10) not in starts        # stylist busy
    assert _d(10, 30) not in starts    # 10:30+45 overlaps until 10:45
    assert _d(10, 45) in starts        # free again
    assert all(s.resource_id == "maria" for s in slots)


# ══ table combining ══════════════════════════════════════════════════════
def _combo_resources():
    """A 4-top + a 2-top, both combinable, same zone — the classic
    'seat a 6 across two tables' floor."""
    return [
        ResourceView("t4", 4, combinable=True, zone="inde"),
        ResourceView("t2", 2, combinable=True, zone="inde"),
    ]


def test_combine_disabled_by_default_yields_no_combo():
    # combine_enabled defaults False → a party of 6 over a combinable 4+2
    # still gets nothing (matches the legacy 'no auto-combine' behaviour).
    slots = compute_slots(
        windows=_dinner_window(), resources=_combo_resources(), busy=[],
        party_size=6, config=_cfg(),  # combine_enabled defaults False
    )
    assert slots == []


def test_combine_two_tables_for_oversized_party():
    # Party of 6, biggest single table is 4 → must combine. With combining on,
    # the slot is backed by BOTH tables.
    slots = compute_slots(
        windows=_dinner_window(), resources=_combo_resources(), busy=[],
        party_size=6, config=_cfg(combine_enabled=True, max_combo_size=3),
    )
    assert slots, "expected combined slots for the party of 6"
    s = slots[0]
    assert set(s.resource_ids) == {"t4", "t2"}
    assert s.resource_id == s.resource_ids[0]  # primary = first of the set


def test_single_table_preferred_over_combo():
    # A free 4-top exists alongside two combinable 2-tops; a party of 4 takes
    # the single 4-top — never tie up two tables when one fits.
    resources = [
        ResourceView("single4", 4, combinable=True, zone="inde"),
        ResourceView("t2a", 2, combinable=True, zone="inde"),
        ResourceView("t2b", 2, combinable=True, zone="inde"),
    ]
    slots = compute_slots(
        windows=_dinner_window(), resources=resources, busy=[],
        party_size=4, config=_cfg(combine_enabled=True),
    )
    assert slots
    assert all(s.resource_ids == ("single4",) for s in slots)


def test_combo_prefers_least_waste():
    # Party of 5, no single fits. Tables 4,4,2 combinable: 4+2=6 (waste 1)
    # must beat 4+4=8 (waste 3).
    resources = [
        ResourceView("a4", 4, combinable=True, zone="z"),
        ResourceView("b4", 4, combinable=True, zone="z"),
        ResourceView("c2", 2, combinable=True, zone="z"),
    ]
    combo = find_combo(5, _d(18), _d(20), resources, busy=[], max_combo_size=3)
    assert combo is not None
    assert "c2" in combo and len(combo) == 2 and ("a4" in combo or "b4" in combo)


def test_combo_prefers_fewer_tables():
    # Party of 8, tables 4,4,2,2,2 combinable. 4+4=8 (2 tables, 0 waste) must
    # beat any 3-table combination.
    resources = [
        ResourceView("a4", 4, combinable=True, zone="z"),
        ResourceView("b4", 4, combinable=True, zone="z"),
        ResourceView("c2", 2, combinable=True, zone="z"),
        ResourceView("d2", 2, combinable=True, zone="z"),
        ResourceView("e2", 2, combinable=True, zone="z"),
    ]
    combo = find_combo(8, _d(18), _d(20), resources, busy=[], max_combo_size=3)
    assert combo is not None
    assert set(combo) == {"a4", "b4"}


def test_combo_respects_zone():
    # Two combinable 2-tops but in DIFFERENT zones — can't push together.
    resources = [
        ResourceView("inside2", 2, combinable=True, zone="inde"),
        ResourceView("terrace2", 2, combinable=True, zone="terrasse"),
    ]
    assert find_combo(4, _d(18), _d(20), resources, busy=[], max_combo_size=3) is None


def test_combo_respects_max_combo_size():
    # Party 10 needs all three 4-tops (=12); max_combo_size=2 caps at 2 tables
    # (max 8 < 10) → no combo. Raising the cap to 3 seats them.
    resources = [ResourceView(f"t{i}", 4, combinable=True, zone="z") for i in range(3)]
    assert find_combo(10, _d(18), _d(20), resources, busy=[], max_combo_size=2) is None
    combo = find_combo(10, _d(18), _d(20), resources, busy=[], max_combo_size=3)
    assert combo is not None and len(combo) == 3


def test_combo_ignores_non_combinable_tables():
    # A 4-top + 2-top NOT flagged combinable → no combo for a party of 6.
    resources = [
        ResourceView("t4", 4, combinable=False, zone="z"),
        ResourceView("t2", 2, combinable=False, zone="z"),
    ]
    assert find_combo(6, _d(18), _d(20), resources, busy=[], max_combo_size=3) is None


def test_combo_skips_busy_table():
    # The 2-top is busy 19:00–20:30, leaving the 4-top no combinable partner →
    # no combo for a party of 6 at 19:00.
    resources = _combo_resources()
    busy = [BusyInterval("t2", _d(19), _d(20, 30))]
    assert find_combo(6, _d(19), _d(21), resources, busy=busy, max_combo_size=3) is None


def test_assign_seats_single_then_combo():
    # assign_seats returns a 1-list for a single fit and a 2-list for a combo.
    cfg = _cfg(combine_enabled=True)
    one = assign_seats(2, _d(18), _d(19, 30), _combo_resources(), busy=[], config=cfg)
    assert one == ["t2"]                       # smallest single fit
    two = assign_seats(6, _d(18), _d(20), _combo_resources(), busy=[], config=cfg)
    assert two is not None and set(two) == {"t4", "t2"}


def test_find_slot_resources_returns_combo():
    ids = find_slot_resources(
        requested_start=_d(19), party_size=6, windows=_dinner_window(),
        resources=_combo_resources(), busy=[], config=_cfg(combine_enabled=True),
    )
    assert ids is not None and set(ids) == {"t4", "t2"}


def test_find_slot_resources_combo_rejects_when_partner_taken():
    # The 2-top is taken for the overlapping range → the party of 6 can't be
    # seated even by combining (the 4-top alone is too small).
    busy = [BusyInterval("t2", _d(19), _d(20, 30))]
    ids = find_slot_resources(
        requested_start=_d(19), party_size=6, windows=_dinner_window(),
        resources=_combo_resources(), busy=busy, config=_cfg(combine_enabled=True),
    )
    assert ids is None
