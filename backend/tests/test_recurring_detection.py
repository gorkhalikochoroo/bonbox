"""
Tests for recurring-outflow detection (task #351).

Pure detector + projector — no DB. Covers cadence classification, the
confidence blend (regularity × count × amount-stability), the explicit-flag
floor, same-day aggregation, and month-aware horizon projection.
"""
from datetime import date, timedelta
from decimal import Decimal

from app.services.cashflow_service import _add_one_month
from app.services.recurring_detection import (
    RecurringSeries,
    detect_recurring_outflows,
    detect_recurring_series,
    detect_series,
    project_series,
)


# ── Minimal fakes for the DB-seam tests (no conftest / DB in this repo) ──
class _FakeExpense:
    def __init__(self, d, amount, description, is_recurring=False):
        self.date = d
        self.amount = amount
        self.description = description
        self.is_recurring = is_recurring
        self.is_deleted = False
        self.is_personal = False
        self.user_id = "u1"


class _FakeUser:
    id = "u1"


class _FakeQuery:
    def __init__(self, rows, cutoff, as_of):
        self._rows, self._cutoff, self._as_of = rows, cutoff, as_of

    def filter(self, *a, **k):
        return self

    def all(self):
        return [r for r in self._rows if self._cutoff <= r.date <= self._as_of]


class _FakeDB:
    """Mirrors the adapter's date-window filter so lookback is actually tested."""
    def __init__(self, rows, as_of, lookback_days=760):
        self._rows = rows
        self._cutoff = as_of - timedelta(days=lookback_days)
        self._as_of = as_of

    def query(self, model):
        return _FakeQuery(self._rows, self._cutoff, self._as_of)


def _monthly_dates(start: date, n: int) -> list[date]:
    out = [start]
    d = start
    for _ in range(n - 1):
        d = _add_one_month(d)
        out.append(d)
    return out


def _step_dates(start: date, step_days: int, n: int) -> list[date]:
    return [start + timedelta(days=step_days * i) for i in range(n)]


# ── detect_series: cadence classification ──────────────────────────────

def test_detects_monthly_cadence_high_confidence():
    dates = _monthly_dates(date(2025, 12, 1), 6)
    s = detect_series("Husleje", dates, [Decimal("8000")] * 6)
    assert s.cadence == "monthly"
    assert s.occurrences == 6
    assert s.typical_amount == Decimal("8000")
    assert s.last_seen == dates[-1]
    assert s.confidence > 0.8        # long, regular, stable → trusted


def test_detects_weekly_cadence():
    s = detect_series("Cleaning", _step_dates(date(2026, 1, 5), 7, 8), [Decimal("600")] * 8)
    assert s.cadence == "weekly"


def test_detects_biweekly_cadence():
    s = detect_series("Wages", _step_dates(date(2026, 1, 5), 14, 6), [Decimal("12000")] * 6)
    assert s.cadence == "biweekly"


def test_detects_quarterly_cadence():
    dates = [date(2025, 6, 1), date(2025, 9, 1), date(2025, 12, 1)]
    s = detect_series("Forsikring", dates, [Decimal("4500")] * 3)
    assert s.cadence == "quarterly"


def test_detects_yearly_cadence():
    s = detect_series("Domæne", [date(2024, 3, 1), date(2025, 3, 1)], [Decimal("900")] * 2)
    assert s.cadence == "yearly"


def test_irregular_gaps_classified_irregular_with_low_confidence():
    dates = [date(2026, 1, 1), date(2026, 1, 11), date(2026, 3, 7),
             date(2026, 3, 14), date(2026, 4, 23)]
    s = detect_series("Ad-hoc supplies", dates, [Decimal("500")] * 5)
    assert s.cadence == "irregular"
    assert s.confidence <= 0.35      # couldn't place a cadence → low trust


# ── detect_series: thin / explicit handling ────────────────────────────

def test_single_occurrence_not_recurring_returns_none():
    assert detect_series("One-off", [date(2026, 5, 1)], [Decimal("3000")]) is None


def test_single_explicit_occurrence_assumed_monthly_low_confidence():
    s = detect_series("Husleje", [date(2026, 5, 1)], [Decimal("8000")], explicit=True)
    assert s is not None
    assert s.cadence == "monthly"
    assert s.occurrences == 1
    assert s.confidence == 0.4


def test_no_occurrences_returns_none():
    assert detect_series("Nothing", [], []) is None


# ── detect_series: confidence behaviour ────────────────────────────────

def test_more_history_raises_confidence():
    long_s = detect_series("Rent", _monthly_dates(date(2025, 12, 1), 6), [Decimal("8000")] * 6)
    short_s = detect_series("Rent", _monthly_dates(date(2026, 4, 1), 2), [Decimal("8000")] * 2)
    assert long_s.confidence > short_s.confidence


def test_stable_amount_beats_noisy_amount():
    dates = _monthly_dates(date(2025, 12, 1), 6)
    stable = detect_series("Rent", dates, [Decimal("8000")] * 6)
    noisy = detect_series("Rent", dates,
                          [Decimal(x) for x in ("8000", "2000", "15000", "5000", "12000", "1000")])
    assert stable.confidence > noisy.confidence


def test_explicit_flag_floors_confidence():
    dates = _monthly_dates(date(2026, 4, 1), 2)
    amounts = [Decimal("1000"), Decimal("9000")]   # noisy → base confidence < 0.5
    implicit = detect_series("Rent", dates, amounts)
    explicit = detect_series("Rent", dates, amounts, explicit=True)
    assert implicit.confidence < 0.5
    assert explicit.confidence >= 0.5


def test_typical_amount_is_the_median():
    dates = _monthly_dates(date(2026, 1, 1), 3)
    s = detect_series("Rent", dates, [Decimal("1000"), Decimal("1000"), Decimal("1200")])
    assert s.typical_amount == Decimal("1000")


def test_same_day_occurrences_aggregate_into_one():
    # Two entries on the same day = one occurrence whose amount is their sum.
    d0 = date(2026, 1, 1)
    d1 = _add_one_month(d0)
    s = detect_series("Rent", [d0, d0, d1],
                      [Decimal("500"), Decimal("500"), Decimal("1000")])
    assert s.occurrences == 2
    assert s.typical_amount == Decimal("1000")
    assert s.cadence == "monthly"


# ── project_series: horizon projection ─────────────────────────────────

def _series(cadence, last_seen, amount="8000", median_gap=30):
    return RecurringSeries(
        label="Rent", cadence=cadence, typical_amount=Decimal(amount),
        confidence=0.9, occurrences=6, last_seen=last_seen,
        median_gap_days=median_gap, explicit=False,
    )


def test_project_monthly_within_horizon():
    s = _series("monthly", date(2026, 5, 1))
    ev = project_series(s, as_of=date(2026, 6, 14), horizon_end=date(2026, 9, 1))
    # Jun 1 is ≤ as_of (skipped); Sep 1 is the inclusive bound.
    assert [e.on for e in ev] == [date(2026, 7, 1), date(2026, 8, 1), date(2026, 9, 1)]
    assert all(e.amount == Decimal("-8000") for e in ev)
    assert all(e.kind == "recurring" for e in ev)


def test_project_weekly_steps_by_seven_days():
    s = _series("weekly", date(2026, 6, 10), amount="600", median_gap=7)
    ev = project_series(s, as_of=date(2026, 6, 14), horizon_end=date(2026, 7, 15))
    assert [e.on for e in ev] == [date(2026, 6, 17), date(2026, 6, 24),
                                  date(2026, 7, 1), date(2026, 7, 8), date(2026, 7, 15)]


def test_project_quarterly_steps_by_three_months():
    s = _series("quarterly", date(2026, 3, 1), median_gap=91)
    ev = project_series(s, as_of=date(2026, 6, 14), horizon_end=date(2026, 12, 31))
    assert [e.on for e in ev] == [date(2026, 9, 1), date(2026, 12, 1)]


def test_project_skips_all_past_dues_for_stale_last_seen():
    s = _series("monthly", date(2025, 1, 1))
    ev = project_series(s, as_of=date(2026, 6, 14), horizon_end=date(2026, 8, 1))
    assert ev[0].on == date(2026, 7, 1)
    assert all(e.on > date(2026, 6, 14) for e in ev)
    assert all(e.on <= date(2026, 8, 1) for e in ev)


def test_project_irregular_uses_median_gap():
    s = _series("irregular", date(2026, 6, 1), median_gap=20)
    ev = project_series(s, as_of=date(2026, 6, 14), horizon_end=date(2026, 8, 1))
    assert [e.on for e in ev] == [date(2026, 6, 21), date(2026, 7, 11), date(2026, 7, 31)]


def test_project_monthly_reanchors_end_of_month():
    # A Jan-31 bill must re-anchor to the 31st each month (snapping short months),
    # NOT drift to the 28th forever: Feb 28 → Mar 31 → Apr 30 (the #351 fix).
    s = _series("monthly", date(2026, 1, 31))
    ev = project_series(s, as_of=date(2026, 2, 1), horizon_end=date(2026, 4, 30))
    assert [e.on for e in ev] == [date(2026, 2, 28), date(2026, 3, 31), date(2026, 4, 30)]


def test_four_weekly_bill_day_steps_not_month_steps():
    # gap 28 classifies as "monthly" but is really 4-weekly (e.g. payroll) — it
    # must day-step, else a full payment per year is lost (false 'covered').
    s = _series("monthly", date(2026, 1, 1), median_gap=28)
    ev = project_series(s, as_of=date(2026, 1, 1), horizon_end=date(2026, 3, 15))
    assert [e.on for e in ev] == [date(2026, 1, 29), date(2026, 2, 26)]  # 28-day steps


def test_stepped_up_amount_is_not_under_projected():
    dates = _monthly_dates(date(2025, 12, 1), 6)
    amounts = [Decimal("8000")] * 5 + [Decimal("12000")]   # rent stepped up
    s = detect_series("Husleje", dates, amounts)
    assert s.typical_amount == Decimal("8000")        # display = median
    assert s.projection_amount == Decimal("12000")    # project the higher recent amount
    ev = project_series(s, as_of=date(2026, 6, 14), horizon_end=date(2026, 8, 1))
    assert ev and all(e.amount == Decimal("-12000") for e in ev)


# ── DB seam: lookback, grouping, staleness (the #351 cash-safety fixes) ─

def test_adapter_detects_yearly_bill_via_widened_lookback():
    # The HIGH finding: a yearly bill was dropped (n==1) under the old 180d
    # lookback, inflating the balance. The 760d window now sees both occurrences.
    as_of = date(2026, 6, 14)
    rows = [_FakeExpense(d, 12000.0, "Husleje") for d in _monthly_dates(date(2025, 12, 1), 6)]
    rows += [_FakeExpense(date(2024, 8, 20), 60000.0, "Erhvervsforsikring"),
             _FakeExpense(date(2025, 8, 20), 60000.0, "Erhvervsforsikring")]
    ev = detect_recurring_outflows(_FakeUser(), _FakeDB(rows, as_of),
                                   as_of=as_of, horizon_end=date(2026, 9, 1))
    insurance = [e for e in ev if e.label == "Erhvervsforsikring"]
    assert insurance, "yearly bill must not be silently dropped"
    assert insurance[0].on == date(2026, 8, 20)   # projected on its real annual due date


def test_adapter_merges_month_suffixed_descriptions():
    # The HIGH finding: per-month descriptions split one bill into n==1 singletons.
    as_of = date(2026, 6, 14)
    rows = [
        _FakeExpense(date(2026, 2, 1), 8000.0, "Husleje februar 2026"),
        _FakeExpense(date(2026, 3, 1), 8000.0, "Husleje marts 2026"),
        _FakeExpense(date(2026, 4, 1), 8000.0, "Husleje april 2026"),
        _FakeExpense(date(2026, 5, 1), 8000.0, "Husleje maj 2026"),
    ]
    series = detect_recurring_series(_FakeUser(), _FakeDB(rows, as_of), as_of=as_of)
    assert len(series) == 1                # one bill, not four singletons
    assert series[0].cadence == "monthly"
    assert series[0].occurrences == 4


def test_adapter_skips_discontinued_bill():
    # The wide lookback must not resurrect a cancelled bill — last seen 5 months
    # ago for a monthly cadence ⇒ stale ⇒ not projected.
    as_of = date(2026, 6, 14)
    rows = [_FakeExpense(d, 500.0, "Gammelt abonnement") for d in
            (date(2025, 10, 1), date(2025, 11, 1), date(2025, 12, 1), date(2026, 1, 1))]
    ev = detect_recurring_outflows(_FakeUser(), _FakeDB(rows, as_of),
                                   as_of=as_of, horizon_end=date(2026, 9, 1))
    assert all(e.label != "Gammelt abonnement" for e in ev)
