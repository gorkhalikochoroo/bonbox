"""
Tests for the forward foresight engine (task #348).

The engine is PURE — no DB, no PSD2 — so these run against a mock feed today,
before any aggregator is live. Two halves:

  1. `project()` math + the fail-closed honesty contract (#352).
  2. `resolve_next_deadline()` — the acceptance criterion: reaches the REAL
     next MOMS afregningsfrist for BOTH a half-yearly and a quarterly filer
     (never hardcodes half-yearly — #357 DK-mechanics correction).
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from app.services import foresight_service as fs
from app.services.foresight_service import (
    CashEvent,
    ForesightInputs,
    STATE_INSUFFICIENT_DATA,
    STATE_ON_TRACK,
    STATE_SHORT,
    STATE_TIGHT,
)

# A fixed horizon used across the math tests: Jun 14 → Sep 1, 2026 (a real DK
# half-yearly afregningsfrist), 79 days out.
AS_OF = date(2026, 6, 14)
DEADLINE = date(2026, 9, 1)


def _inputs(**over):
    base = dict(
        as_of=AS_OF,
        deadline=DEADLINE,
        current_balance=Decimal("100000"),
        moms_estimate=Decimal("20000"),
        safety_buffer=Decimal("0"),
    )
    base.update(over)
    return ForesightInputs(**base)


# ── project(): the verdict math ────────────────────────────────────────

def test_on_track_when_balance_clears_moms_and_buffer():
    p = fs.project(_inputs(current_balance=Decimal("100000"),
                           moms_estimate=Decimal("20000"),
                           safety_buffer=Decimal("10000")))
    assert p.state == STATE_ON_TRACK
    assert p.covers_moms is True
    assert p.balance_before_moms == Decimal("100000")
    assert p.balance_after_moms == Decimal("80000")
    assert p.shortfall == Decimal("0")        # already covered → no gap
    assert p.horizon_days == 79


def test_short_when_balance_below_moms():
    p = fs.project(_inputs(current_balance=Decimal("15000"),
                           moms_estimate=Decimal("20000"),
                           safety_buffer=Decimal("0")))
    assert p.state == STATE_SHORT
    assert p.covers_moms is False
    assert p.balance_after_moms == Decimal("-5000")
    # gap to close by the deadline = moms + buffer − projected balance
    assert p.shortfall == Decimal("5000")


def test_recurring_outflows_reduce_balance_before_moms():
    rent = CashEvent(on=date(2026, 7, 1), amount=Decimal("-12000"),
                     label="Husleje", kind="recurring")
    p = fs.project(_inputs(current_balance=Decimal("100000"),
                           recurring_outflows=[rent]))
    assert p.balance_before_moms == Decimal("88000")     # 100k − 12k rent
    assert p.balance_after_moms == Decimal("68000")      # − 20k MOMS


def test_projected_inflows_increase_balance():
    receivable = CashEvent(on=date(2026, 7, 1), amount=Decimal("50000"),
                           label="Catering invoice", kind="inflow")
    p = fs.project(_inputs(current_balance=Decimal("10000"),
                           projected_inflows=[receivable]))
    assert p.balance_before_moms == Decimal("60000")
    assert p.covers_moms is True


def test_tight_when_midperiod_dip_below_buffer_but_still_covers():
    # Big bill mid-period drops below the buffer, a later inflow recovers it,
    # and MOMS is still covered at the deadline → TIGHT (not ON_TRACK, not SHORT).
    big_bill = CashEvent(on=date(2026, 7, 1), amount=Decimal("-45000"),
                         label="Annual insurance", kind="recurring")
    recovery = CashEvent(on=date(2026, 8, 1), amount=Decimal("40000"),
                         label="Big receivable", kind="inflow")
    p = fs.project(_inputs(current_balance=Decimal("50000"),
                           moms_estimate=Decimal("20000"),
                           safety_buffer=Decimal("10000"),
                           recurring_outflows=[big_bill],
                           projected_inflows=[recovery]))
    assert p.state == STATE_TIGHT
    assert p.covers_moms is True
    assert p.lowest_point["balance"] == Decimal("5000")   # the mid-period trough
    assert p.lowest_point["on"] == "2026-07-01"


def test_moms_bill_can_be_the_lowest_point():
    p = fs.project(_inputs(current_balance=Decimal("100000"),
                           moms_estimate=Decimal("20000"),
                           safety_buffer=Decimal("0")))
    # No events before the deadline, so the MOMS debit itself is the trough.
    assert p.lowest_point["balance"] == Decimal("80000")
    assert p.lowest_point["on"] == DEADLINE.isoformat()


# ── project(): fail-closed honesty (#352) ──────────────────────────────

def test_insufficient_data_when_balance_unknown():
    p = fs.project(_inputs(current_balance=None))
    assert p.state == STATE_INSUFFICIENT_DATA
    # NO numeric verdict is emitted on unknown data.
    assert p.covers_moms is None
    assert p.balance_before_moms is None
    assert p.balance_after_moms is None
    assert p.shortfall is None
    assert p.timeline == []


def test_insufficient_data_when_deadline_unknown():
    p = fs.project(_inputs(deadline=None))
    assert p.state == STATE_INSUFFICIENT_DATA
    assert p.covers_moms is None


def test_insufficient_data_when_deadline_in_past():
    p = fs.project(_inputs(deadline=date(2026, 1, 1)))
    assert p.state == STATE_INSUFFICIENT_DATA
    assert p.covers_moms is None


# ── project(): timeline shape ──────────────────────────────────────────

def test_timeline_spans_today_to_deadline():
    p = fs.project(_inputs())
    assert p.timeline[0]["on"] == AS_OF.isoformat()
    assert p.timeline[-1]["on"] == DEADLINE.isoformat()
    # Every sampled balance is a Decimal (no float money artifacts).
    assert all(isinstance(pt["balance"], Decimal) for pt in p.timeline)


def test_timeline_surfaces_a_subweek_trough():
    # A dip-and-recover that completes inside one weekly sampling gap (payroll
    # Wed → receivable Fri) must still be visible in the chart — otherwise the
    # line reads flat/reassuring while the badge says TIGHT.
    out = CashEvent(on=date(2026, 7, 15), amount=Decimal("-90000"),
                    label="Payroll run", kind="recurring")
    back = CashEvent(on=date(2026, 7, 17), amount=Decimal("90000"),
                     label="Receivable", kind="inflow")
    p = fs.project(_inputs(current_balance=Decimal("50000"),
                           safety_buffer=Decimal("10000"),
                           recurring_outflows=[out], projected_inflows=[back]))
    assert p.state == STATE_TIGHT
    assert p.lowest_point["balance"] == Decimal("-40000")
    # the trough day is now a sample, and the charted minimum equals the true one
    assert p.lowest_point["on"] in [pt["on"] for pt in p.timeline]
    assert min(pt["balance"] for pt in p.timeline) == Decimal("-40000")
    # timeline stays chronologically ordered after the injection
    assert [pt["on"] for pt in p.timeline] == sorted(pt["on"] for pt in p.timeline)


# ── resolve_next_deadline(): the acceptance criterion ──────────────────

def test_resolve_deadline_half_yearly_filer():
    user = SimpleNamespace(currency="DKK", tax_filing_frequency="half_yearly")
    # Explicit as_of. Calling with no as_of and asserting "> date.today()" was
    # TAUTOLOGICAL: the resolver filters on `deadline <= today: continue`, so
    # that assertion could never fail and the test stayed green on a frist day
    # while production returned a date six months out.
    out = fs.resolve_next_deadline(user, as_of=date(2026, 6, 14))
    assert out is not None
    assert out["frequency"] == "half_yearly"
    # DK half-yearly afregningsfrist months are March and September.
    assert out["deadline"].month in (3, 9)
    assert out["deadline"] == date(2026, 9, 1)


def test_resolve_deadline_quarterly_filer():
    user = SimpleNamespace(currency="DKK", tax_filing_frequency="quarterly")
    out = fs.resolve_next_deadline(user, as_of=date(2026, 6, 14))
    assert out is not None
    assert out["frequency"] == "quarterly"
    # DK quarterly afregningsfrist months are Mar / Jun / Sep / Dec.
    assert out["deadline"].month in (3, 6, 9, 12)
    assert out["deadline"] > date(2026, 6, 14)


def test_resolve_deadline_defaults_to_half_yearly_for_dk():
    # No explicit frequency → DK default is half_yearly (SMB band <5M kr).
    user = SimpleNamespace(currency="DKK")
    out = fs.resolve_next_deadline(user)
    assert out is not None
    assert out["frequency"] == "half_yearly"


def test_resolve_deadline_unknown_currency_returns_none():
    user = SimpleNamespace(currency="ZZZ")
    assert fs.resolve_next_deadline(user) is None
