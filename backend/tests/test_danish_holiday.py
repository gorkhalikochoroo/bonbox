"""
Feriedage under the Danish Ferielov.

The number this produces is shown to an employee about their own holiday, so the
tests that matter are the ones proving it does not OVER-state. An inflated
balance ends with someone requesting days they do not have and being refused —
which is worse than showing nothing.

Two rules carry that weight:
  • accrual is per FULL month, so a part-month earns nothing;
  • accrual starts at the later of the ferieår opening and the date BonBox first
    knew the staffer, never earlier.
"""

from datetime import date

import pytest

from app.services import danish_holiday as dh


class TestFerieaarBounds:
    @pytest.mark.parametrize(
        "on,start,end",
        [
            (date(2026, 9, 1),  date(2026, 9, 1), date(2027, 8, 31)),   # opening day
            (date(2026, 12, 24), date(2026, 9, 1), date(2027, 8, 31)),
            (date(2027, 8, 31), date(2026, 9, 1), date(2027, 8, 31)),   # closing day
            (date(2027, 1, 2),  date(2026, 9, 1), date(2027, 8, 31)),
            (date(2026, 8, 31), date(2025, 9, 1), date(2026, 8, 31)),   # day before opening
        ],
    )
    def test_ferieaar_runs_september_to_august(self, on, start, end):
        assert dh.ferieaar_bounds(on) == (start, end)


class TestAccrual:
    def test_a_full_year_is_twentyfive_days(self):
        assert dh.accrued_days(date(2026, 9, 1), date(2027, 9, 1)) == pytest.approx(25.0)

    def test_one_month_is_two_point_zero_eight(self):
        assert dh.accrued_days(date(2026, 9, 1), date(2026, 10, 1)) == pytest.approx(25 / 12)

    def test_a_part_month_earns_nothing(self):
        # Started the 20th, it is the 19th of the next month — the full month
        # has not elapsed. Rounding this up would hand out a day nobody earned.
        assert dh.accrued_days(date(2026, 9, 20), date(2026, 10, 19)) == 0.0
        assert dh.accrued_days(date(2026, 9, 20), date(2026, 10, 20)) == pytest.approx(25 / 12)

    def test_never_exceeds_the_statutory_year(self):
        # Two years of employment still earns one year's worth within a ferieår.
        assert dh.accrued_days(date(2024, 1, 1), date(2027, 1, 1)) == 25.0

    def test_future_or_equal_dates_earn_nothing(self):
        assert dh.accrued_days(date(2026, 9, 1), date(2026, 9, 1)) == 0.0
        assert dh.accrued_days(date(2027, 1, 1), date(2026, 9, 1)) == 0.0


class TestCompute:
    def test_counts_from_the_ferieaar_start_for_an_established_staffer(self):
        # Known since 2020; the ferieår opened 1 Sep 2026. Accrual starts at the
        # ferieår, not 2020 — days do not roll in from previous years.
        b = dh.compute(known_since=date(2020, 1, 1), taken_days=0, on=date(2026, 12, 1))
        assert b.since == date(2026, 9, 1)
        assert b.earned == pytest.approx(3 * 25 / 12, abs=0.05)
        assert b.partial is False

    def test_counts_from_the_join_date_for_a_new_staffer(self):
        # Added in October — we cannot vouch for September.
        b = dh.compute(known_since=date(2026, 10, 1), taken_days=0, on=date(2026, 12, 1))
        assert b.since == date(2026, 10, 1)
        assert b.earned == pytest.approx(2 * 25 / 12, abs=0.05)
        assert b.partial is True          # the UI must show `since`

    def test_subtracts_recorded_ferie(self):
        b = dh.compute(known_since=date(2020, 1, 1), taken_days=2, on=date(2026, 12, 1))
        assert b.taken == 2.0
        assert b.remaining == pytest.approx(b.earned - 2, abs=0.05)

    def test_remaining_never_goes_negative(self):
        # More taken than accrued (carry-over from a previous year we cannot
        # see). "-3 days" is nonsense to show anyone; floor at zero.
        b = dh.compute(known_since=date(2026, 9, 1), taken_days=99, on=date(2026, 10, 1))
        assert b.remaining == 0.0

    def test_ignores_a_negative_taken_count(self):
        b = dh.compute(known_since=date(2020, 1, 1), taken_days=-5, on=date(2026, 12, 1))
        assert b.taken == 0.0
        assert b.remaining == pytest.approx(b.earned, abs=0.05)

    def test_a_staffer_added_today_has_earned_nothing(self):
        # The most important non-lie in the module: joining does not grant days.
        b = dh.compute(known_since=date(2026, 12, 1), taken_days=0, on=date(2026, 12, 1))
        assert b.earned == 0.0
        assert b.remaining == 0.0

    def test_always_reports_the_date_it_counted_from(self):
        # The UI renders this; without it the number reads as a legal balance
        # rather than "what BonBox has seen".
        b = dh.compute(known_since=date(2026, 11, 3), taken_days=0, on=date(2027, 2, 1))
        assert b.since == date(2026, 11, 3)
        assert b.ferieaar_start == date(2026, 9, 1)
        assert b.ferieaar_end == date(2027, 8, 31)

    def test_computes_no_money(self):
        # Feriepenge is payroll and stays with the lønsystem. If a kroner field
        # ever appears here, that decision was reversed by accident.
        b = dh.compute(known_since=date(2020, 1, 1), taken_days=0, on=date(2026, 12, 1))
        assert not any("kr" in f or "pay" in f or "amount" in f for f in b.__dataclass_fields__)
