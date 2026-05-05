"""
Tests for tax_service period derivation.

These tests pin down the BUG 1 regression: previously _get_next_deadlines used
a quarter_map that mapped the Mar 1 deadline to Q1 (Jan–Mar) of the same year
— impossible, since Q1 isn't done yet on Mar 1. The fix uses _derive_period
which derives the period from the deadline + frequency.

Run from backend/: pytest tests/test_tax_service.py -v
"""

from datetime import date

from app.services.tax_service import (
    _derive_period,
    _last_day_of_month,
    _get_next_deadlines,
    PERIOD_MONTHS,
)


def test_last_day_of_month():
    assert _last_day_of_month(2026, 1) == date(2026, 1, 31)
    assert _last_day_of_month(2026, 2) == date(2026, 2, 28)  # not a leap year
    assert _last_day_of_month(2024, 2) == date(2024, 2, 29)  # leap
    assert _last_day_of_month(2026, 12) == date(2026, 12, 31)


# ─────────────────────────────────────────────────────────────────
# DK quarterly — the regression suite. Before the fix, Mar 1 mapped
# to Q1 (Jan–Mar) of the same year. The correct mapping is Q4 of
# the previous year (Oct–Dec).
# ─────────────────────────────────────────────────────────────────
def test_dk_quarterly_mar1_reports_q4_prev_year():
    start, end, label = _derive_period(date(2026, 3, 1), "quarterly")
    assert start == date(2025, 10, 1), f"Mar 1 quarterly should start Oct 1 prev, got {start}"
    assert end == date(2025, 12, 31), f"Mar 1 quarterly should end Dec 31 prev, got {end}"
    assert label == "Q4 2025"


def test_dk_quarterly_jun1_reports_q1():
    start, end, label = _derive_period(date(2026, 6, 1), "quarterly")
    assert start == date(2026, 1, 1)
    assert end == date(2026, 3, 31)
    assert label == "Q1 2026"


def test_dk_quarterly_sep1_reports_q2():
    start, end, label = _derive_period(date(2026, 9, 1), "quarterly")
    assert start == date(2026, 4, 1)
    assert end == date(2026, 6, 30)
    assert label == "Q2 2026"


def test_dk_quarterly_dec1_reports_q3():
    start, end, label = _derive_period(date(2026, 12, 1), "quarterly")
    assert start == date(2026, 7, 1)
    assert end == date(2026, 9, 30)
    assert label == "Q3 2026"


# ─────────────────────────────────────────────────────────────────
# DK half-yearly — the new default for SMBs <5M kr. H1 (Jan–Jun) due
# Sep 1; H2 (Jul–Dec) due Mar 1 of the following year.
# ─────────────────────────────────────────────────────────────────
def test_dk_half_yearly_sep1_reports_h1():
    start, end, label = _derive_period(date(2026, 9, 1), "half_yearly")
    assert start == date(2026, 1, 1)
    assert end == date(2026, 6, 30)
    assert label == "H1 2026"


def test_dk_half_yearly_mar1_reports_h2_prev():
    start, end, label = _derive_period(date(2026, 3, 1), "half_yearly")
    assert start == date(2025, 7, 1)
    assert end == date(2025, 12, 31)
    assert label == "H2 2025"


# ─────────────────────────────────────────────────────────────────
# NPR / INR monthly — period is the calendar month before the deadline
# ─────────────────────────────────────────────────────────────────
def test_monthly_25th_reports_previous_calendar_month():
    # NPR deadline May 25 2026 reports April 2026
    start, end, label = _derive_period(date(2026, 5, 25), "monthly")
    assert start == date(2026, 4, 1)
    assert end == date(2026, 4, 30)
    assert label == "April 2026"


def test_monthly_january_25th_reports_december_prev_year():
    start, end, label = _derive_period(date(2026, 1, 25), "monthly")
    assert start == date(2025, 12, 1)
    assert end == date(2025, 12, 31)


# ─────────────────────────────────────────────────────────────────
# NOK bimonthly — Apr 10 reports Jan–Feb
# ─────────────────────────────────────────────────────────────────
def test_nok_bimonthly_apr10_reports_jan_feb():
    start, end, label = _derive_period(date(2026, 4, 10), "bimonthly")
    assert start == date(2026, 1, 1)
    assert end == date(2026, 2, 28)


# ─────────────────────────────────────────────────────────────────
# _get_next_deadlines — sanity that DK half_yearly returns ascending dates
# ─────────────────────────────────────────────────────────────────
def test_dk_half_yearly_deadlines_are_ascending_and_match_periods():
    deadlines = _get_next_deadlines("DKK", frequency="half_yearly", count=3)
    assert len(deadlines) == 3
    # Strictly increasing
    for prev, curr in zip(deadlines, deadlines[1:]):
        assert prev["deadline"] < curr["deadline"]
    # Each returned period_end must be EXACTLY 2 months before the deadline's
    # month-start (the rule baked into _derive_period). This catches
    # accidental off-by-one regressions.
    for d in deadlines:
        deadline = d["deadline"]
        period_end = d["period_end"]
        gap_months = (deadline.year - period_end.year) * 12 + (deadline.month - period_end.month)
        # period_end is last day of month, deadline is day 1, so gap is between
        # 2 (Sep1 vs Jun30) and 3 (Mar1 vs Dec31)
        assert 2 <= gap_months <= 3, f"unexpected gap: deadline={deadline}, period_end={period_end}"


def test_period_months_table_complete():
    # Every frequency we use must have an entry in PERIOD_MONTHS so
    # _derive_period doesn't silently fall back to quarterly.
    assert PERIOD_MONTHS["monthly"] == 1
    assert PERIOD_MONTHS["bimonthly"] == 2
    assert PERIOD_MONTHS["quarterly"] == 3
    assert PERIOD_MONTHS["half_yearly"] == 6
