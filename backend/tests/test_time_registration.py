"""Tidsregistrering compliance-core tests.

Exercises the pure computations (no DB) — these encode the legal rules, so
they're the part that MUST be right: 11h rest (incl. overnight shifts) and the
48h/4-month weekly average.
"""
from datetime import date
from types import SimpleNamespace

from app.services import time_registration as tr


def _row(d, start, end, hours, method="clock", break_min=0):
    """A duck-typed HoursLogged — the pure functions only read these attrs."""
    return SimpleNamespace(
        date=d, start_time=start, end_time=end, total_hours=hours,
        entry_method=method, break_minutes=break_min,
    )


def test_overnight_shift_bounds_cross_midnight():
    # 18:00 -> 02:00 must resolve the end onto the next day
    b = tr._shift_bounds(date(2026, 6, 10), "18:00", "02:00")
    assert b is not None
    start_dt, end_dt = b
    assert end_dt.day == 11
    assert (end_dt - start_dt).total_seconds() / 3600 == 8.0


def test_rest_violation_after_late_close():
    # Closes 02:00 (overnight from the 10th), opens 10:00 on the 11th → 8h rest
    rows = [
        _row(date(2026, 6, 10), "18:00", "02:00", 8.0),
        _row(date(2026, 6, 11), "10:00", "16:00", 6.0),
    ]
    v = tr.rest_violations(rows)
    assert len(v) == 1
    assert v[0].rest_hours == 8.0
    assert v[0].shortfall_hours == 3.0  # 11 - 8


def test_no_violation_when_rest_is_enough():
    # Closes 22:00, opens 09:30 next day → 11.5h rest, compliant
    rows = [
        _row(date(2026, 6, 10), "14:00", "22:00", 8.0),
        _row(date(2026, 6, 11), "09:30", "17:00", 7.5),
    ]
    assert tr.rest_violations(rows) == []


def test_rows_without_times_are_skipped_for_rest():
    # Quick-entry rows (hours only, no start/end) can't be rest-checked
    rows = [
        _row(date(2026, 6, 10), None, None, 8.0, method="quick"),
        _row(date(2026, 6, 11), None, None, 8.0, method="quick"),
    ]
    assert tr.rest_violations(rows) == []


def test_weekly_average_over_reference_window():
    # 480 hours across the 120-day window → 480 / (120/7) = 28.0 h/week
    rows = [_row(date(2026, 3, 1), "09:00", "17:00", 480.0)]
    avg = tr.weekly_average(rows, ref_end=date(2026, 6, 10))
    assert avg == 28.0


def test_weekly_average_flags_over_cap():
    # ~50h/week sustained over the window should exceed the 48h cap
    rows = [_row(date(2026, 6, 1), "00:00", "01:00", 50.0 * (120 / 7))]
    avg = tr.weekly_average(rows, ref_end=date(2026, 6, 10))
    assert avg > tr.MAX_WEEKLY_HOURS


def test_daily_register_is_sorted():
    rows = [
        _row(date(2026, 6, 11), "10:00", "16:00", 6.0),
        _row(date(2026, 6, 10), "18:00", "02:00", 8.0),
    ]
    reg = tr.daily_register(rows)
    assert [e.date for e in reg] == ["2026-06-10", "2026-06-11"]
    assert reg[0].source == "clock"
