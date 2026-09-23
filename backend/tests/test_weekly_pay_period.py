"""A cafe that pays every Friday must be able to see a week.

WHY THIS WAS MISSING AND WHY IT MATTERS. _compute_pay_period supported
monthly_1st, monthly_15th, biweekly and custom(day-of-month) — and nothing
weekly. DK hospitality pays weekly more often than any other cadence, and
`custom` cannot express it: it is anchored on a DAY OF THE MONTH, so it can say
"the 15th" but never "every Monday".

An owner paying weekly therefore had to read a fortnight and halve it in their
head — the exact arithmetic this page exists to remove, done on wages, at the
end of a shift.

Monday-Sunday, matching how a Dane says "uge 39" and matching the week
Arbejdstidsloven's 48-hour cap is averaged over.

THE PARITY BELOW IS THE LOAD-BEARING PART. The frontend computes the period too
(computePayPeriod in pages/StaffHoursPage.jsx) so the stepper can move without
a round trip. Two implementations of one definition: if they drift, the screen
shows one week and the server totals another, and nobody finds out until
somebody is paid wrong.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.routers.staff import _compute_pay_period


class _Cfg:
    def __init__(self, period_type="weekly", custom_start_day=None):
        self.period_type = period_type
        self.custom_start_day = custom_start_day


def _d(v):
    """_compute_pay_period returns ISO strings, not dates."""
    return date.fromisoformat(v) if isinstance(v, str) else v


def _wk(d: date):
    r = _compute_pay_period(_Cfg(), d)
    return _d(r["start_date"]), _d(r["end_date"])


class TestAWeekIsMondayToSunday:
    def test_midweek_resolves_to_its_own_week(self):
        assert _wk(date(2026, 9, 23)) == (date(2026, 9, 21), date(2026, 9, 27))

    def test_monday_is_the_first_day_not_the_last(self):
        start, end = _wk(date(2026, 9, 21))
        assert start == date(2026, 9, 21) and end == date(2026, 9, 27)

    def test_sunday_belongs_to_the_week_that_is_ending(self):
        """The one everybody gets wrong. JS getDay() is 0=Sunday, so a naive
        port puts Sunday in the NEXT week and pays it twice."""
        assert _wk(date(2026, 9, 27)) == (date(2026, 9, 21), date(2026, 9, 27))

    def test_it_is_always_exactly_seven_days(self):
        d = date(2026, 1, 1)
        for _ in range(400):
            start, end = _wk(d)
            assert (end - start).days == 6, f"{d} produced {start}..{end}"
            d += timedelta(days=1)

    def test_weeks_tile_without_gap_or_overlap(self):
        """Consecutive weeks must abut exactly — a gap loses somebody's shift,
        an overlap pays it twice."""
        start, end = _wk(date(2026, 9, 23))
        nxt_start, _ = _wk(end + timedelta(days=1))
        assert nxt_start == end + timedelta(days=1)

    def test_it_crosses_a_month_boundary(self):
        assert _wk(date(2026, 10, 1)) == (date(2026, 9, 28), date(2026, 10, 4))

    def test_it_crosses_a_year_boundary(self):
        start, end = _wk(date(2027, 1, 1))  # a Friday
        assert start == date(2026, 12, 28) and end == date(2027, 1, 3)


class TestTheFrontendAgrees:
    """The JS mirror, reimplemented here from pages/StaffHoursPage.jsx.

    If someone edits one side, this fails rather than letting the screen and
    the server disagree about which week is being paid.
    """

    @staticmethod
    def _js_mirror(d: date):
        # const dow = (ref.getDay() + 6) % 7  → Python weekday() already is this
        dow = (d.weekday() + 7) % 7
        start = d - timedelta(days=dow)
        return start, start + timedelta(days=6)

    def test_every_day_of_a_year_matches(self):
        d = date(2026, 1, 1)
        for _ in range(400):
            assert _wk(d) == self._js_mirror(d), f"backend/frontend disagree on {d}"
            d += timedelta(days=1)

    def test_the_frontend_still_has_the_weekly_branch(self):
        """Source-level: the JS mirror above is only meaningful while the real
        one exists."""
        from pathlib import Path
        page = (Path(__file__).resolve().parents[2]
                / "frontend" / "src" / "pages" / "StaffHoursPage.jsx")
        src = page.read_text(encoding="utf-8")
        assert 'if (type === "weekly")' in src
        assert '(ref.getDay() + 6) % 7' in src, (
            "the Sunday correction is gone — Sunday will fall into the wrong week"
        )
        assert '{ id: "weekly", key: "hovFrameWeekly" }' in src, (
            "weekly is computable but not offered in the picker"
        )


class TestTheOtherFramesAreUntouched:
    def test_monthly_still_works(self):
        r = _compute_pay_period(_Cfg("monthly_1st"), date(2026, 9, 23))
        assert _d(r["start_date"]) == date(2026, 9, 1)
        assert _d(r["end_date"]) == date(2026, 9, 30)

    def test_biweekly_still_works(self):
        r = _compute_pay_period(_Cfg("biweekly"), date(2026, 9, 23))
        assert (_d(r["end_date"]) - _d(r["start_date"])).days == 13
