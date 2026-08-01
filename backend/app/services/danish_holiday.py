"""
Feriedage under the Danish Ferielov (samtidighedsferie, 2020 reform).

THE RULE. An employee earns 2,08 feriedage per full month of employment — 25
days a year. The ferieår runs 1 September – 31 August, and days earned in it may
be taken from 1 September through 31 December of the following year (a 16-month
afholdelsesperiode), which is what "samtidighedsferie" means: you earn and spend
in step rather than a year behind.

WHAT WE CAN HONESTLY SAY, AND WHAT WE CANNOT.

This module computes days EARNED WHILE THE STAFFER HAS EXISTED IN BONBOX, minus
ferie absences RECORDED IN BONBOX. That is arithmetic on data we hold, and it is
the only holiday number this product is entitled to state.

It is NOT the employee's legal balance, and the UI must never call it that. We
do not know:
  • their real employment start date — `created_at` is when the owner added them
    here, which is usually later, sometimes by years;
  • days carried over or transferred from a previous employer;
  • holiday taken before BonBox, or booked outside it;
  • whether they are funktionær, part-time, or on a collective agreement with
    a 6th-week arrangement.

So the caller gets `earned`, `taken`, `remaining` AND `since` — and is expected
to render the date, because "9,4 dage optjent siden marts" is true while
"9,4 dage tilbage" is a claim about someone's legal entitlement that we cannot
make. The lønsystem owns that number.

MONEY IS OUT OF SCOPE. This counts DAYS. Feriepenge, feriegodtgørelse and the
12,5% holiday supplement are payroll and stay with the lønsystem — see
decision_staff_scope_not_payroll. Nothing here computes kroner.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

# 25 days across 12 months. The statutory figure is quoted as 2,08.
DAYS_PER_MONTH = 25 / 12
DAYS_PER_YEAR = 25

# The ferieår opens on 1 September.
FERIEAAR_START_MONTH = 9
FERIEAAR_START_DAY = 1


@dataclass(frozen=True)
class HolidayBalance:
    earned: float          # days accrued in this ferieår, while known to BonBox
    taken: float           # ferie days recorded in BonBox for this ferieår
    remaining: float       # earned - taken, floored at 0
    since: date            # the date accrual was counted from — RENDER THIS
    ferieaar_start: date
    ferieaar_end: date
    partial: bool          # True when `since` is later than the ferieår start,
                           # i.e. we are missing the beginning of their year


def ferieaar_bounds(on: date) -> tuple[date, date]:
    """The ferieår containing `on`: 1 Sep → 31 Aug."""
    if (on.month, on.day) >= (FERIEAAR_START_MONTH, FERIEAAR_START_DAY):
        start = date(on.year, FERIEAAR_START_MONTH, FERIEAAR_START_DAY)
    else:
        start = date(on.year - 1, FERIEAAR_START_MONTH, FERIEAAR_START_DAY)
    end = date(start.year + 1, 8, 31)
    return start, end


def _full_months_between(start: date, end: date) -> int:
    """Whole months from start to end.

    Accrual is per FULL month of employment, so a staffer who started on the
    20th has not earned that month's 2,08 until the 20th comes round again.
    Counting part-months would over-state the balance, and over-stating someone's
    holiday is the failure mode that ends in a refused request.
    """
    if end <= start:
        return 0
    months = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day < start.day:
        months -= 1
    return max(0, months)


def accrued_days(since: date, on: date) -> float:
    """Days earned between `since` and `on`, capped at the statutory year."""
    months = _full_months_between(since, on)
    return min(months * DAYS_PER_MONTH, DAYS_PER_YEAR)


def compute(
    *,
    known_since: date,
    taken_days: float,
    on: date,
) -> HolidayBalance:
    """Holiday position for one staff member.

    Args:
      known_since: the earliest date BonBox can vouch for — normally the staff
        row's created_at. NOT their employment start date.
      taken_days: ferie days recorded in BonBox inside this ferieår.
      on: the date to evaluate at (today).
    """
    start, end = ferieaar_bounds(on)

    # Accrue from the ferieår start, or from when we first knew them if that is
    # later. Never from before the ferieår — days do not roll into this one.
    since = max(start, known_since)
    earned = accrued_days(since, on)

    taken = max(0.0, float(taken_days or 0))
    remaining = max(0.0, earned - taken)

    return HolidayBalance(
        earned=round(earned, 1),
        taken=round(taken, 1),
        remaining=round(remaining, 1),
        since=since,
        ferieaar_start=start,
        ferieaar_end=end,
        # Partial means "we joined their year late" — the UI shows `since` so
        # the staffer can see the number is BonBox's view, not their whole year.
        partial=since > start,
    )
