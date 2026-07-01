"""
Autopilot respects staff availability ("kan ikke"): the greedy assigner must
skip a staffer on a day/time they marked unavailable — so "respects your
availability" is TRUE, not a claim. Soft signal: only the autopilot defers.

Run:
  cd backend && python3 -m pytest tests/test_autopilot_availability.py -x -q
"""

from datetime import date

from app.services.schedule_autopilot import _staff_unavailable

MON = date(2026, 7, 6)   # weekday() == 0
TUE = date(2026, 7, 7)   # weekday() == 1


def _allday_weekday(wd):
    return {"weekday": wd, "specific_date": None, "s_min": None, "e_min": None}


def _allday_date(d):
    return {"weekday": None, "specific_date": d, "s_min": None, "e_min": None}


def _timed_weekday(wd, s_min, e_min):
    return {"weekday": wd, "specific_date": None, "s_min": s_min, "e_min": e_min}


def test_no_blocks_is_available():
    assert _staff_unavailable([], MON, "16:00", "23:00") is False


def test_allday_weekday_blocks_that_day_only():
    blk = [_allday_weekday(0)]  # never Mondays
    assert _staff_unavailable(blk, MON, "16:00", "23:00") is True
    assert _staff_unavailable(blk, TUE, "16:00", "23:00") is False


def test_one_off_date_blocks_only_that_date():
    blk = [_allday_date(TUE)]
    assert _staff_unavailable(blk, TUE, "10:00", "14:00") is True
    assert _staff_unavailable(blk, MON, "10:00", "14:00") is False


def test_timed_window_overlap():
    blk = [_timed_weekday(0, 8 * 60, 12 * 60)]  # Mon 08:00–12:00
    # Evening shift doesn't overlap the morning block → still available.
    assert _staff_unavailable(blk, MON, "16:00", "23:00") is False
    # Midday shift overlaps → unavailable.
    assert _staff_unavailable(blk, MON, "09:00", "15:00") is True
    # Touching edge (block ends 12:00, shift starts 12:00) → no overlap.
    assert _staff_unavailable(blk, MON, "12:00", "18:00") is False


def test_overnight_shift_matches_start_day_block():
    blk = [_allday_weekday(0)]  # all-day Monday
    # A 22:00→06:00 shift starting Monday is blocked by the Monday all-day mark.
    assert _staff_unavailable(blk, MON, "22:00", "06:00") is True
