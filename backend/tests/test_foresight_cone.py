"""
Tests for the MOMS range / cone / weekly-rate solver (task #349).

All pure — composes the #348 engine at the three MOMS scenarios. The honesty
contract is the headline of these tests: the cone must never read ON_TRACK
when the high end of the MOMS range would leave the owner SHORT (#360).
"""
from datetime import date
from decimal import Decimal

from app.services import foresight_service as fs
from app.services.foresight_service import (
    CashEvent,
    ForesightInputs,
    STATE_AT_RISK,
    STATE_INSUFFICIENT_DATA,
    STATE_ON_TRACK,
    STATE_SHORT,
    STATE_TIGHT,
)

AS_OF = date(2026, 6, 14)
DEADLINE = date(2026, 9, 1)   # 79 days → 12 weeks


def _inputs(**over):
    base = dict(
        as_of=AS_OF,
        deadline=DEADLINE,
        current_balance=Decimal("145000"),
        moms_estimate=Decimal("0"),   # overridden by the cone
        safety_buffer=Decimal("0"),
    )
    base.update(over)
    return ForesightInputs(**base)


# ── build_moms_range ───────────────────────────────────────────────────

def test_range_mid_period_flexes_only_the_projected_tail():
    r = fs.build_moms_range(realized_moms=Decimal("10000"),
                            projected_remaining_moms=Decimal("10000"),
                            band_pct=Decimal("0.25"))
    assert r.expected == Decimal("20000")
    assert r.low == Decimal("17500")    # 10000 + 10000·0.75
    assert r.high == Decimal("22500")   # 10000 + 10000·1.25
    assert r.confidence == "medium"     # half the period booked


def test_range_collapses_to_point_when_period_over():
    r = fs.build_moms_range(realized_moms=Decimal("20000"),
                            projected_remaining_moms=Decimal("0"))
    assert r.low == r.expected == r.high == Decimal("20000")
    assert r.confidence == "high"


def test_range_low_confidence_at_period_start():
    r = fs.build_moms_range(realized_moms=Decimal("0"),
                            projected_remaining_moms=Decimal("20000"))
    assert r.confidence == "low"
    assert r.expected == Decimal("20000")


def test_range_no_sales_basis_stays_humble():
    r = fs.build_moms_range(realized_moms=Decimal("0"),
                            projected_remaining_moms=Decimal("0"))
    assert r.expected == Decimal("0")
    assert r.confidence == "low"


def test_range_clamps_negative_inputs():
    r = fs.build_moms_range(realized_moms=Decimal("-5"),
                            projected_remaining_moms=Decimal("-5"))
    assert r.realized == Decimal("0")
    assert r.projected == Decimal("0")


# ── solve_weekly_rate ──────────────────────────────────────────────────

def test_weekly_rate_exact_division():
    p = fs.solve_weekly_rate(shortfall=Decimal("18000"), weeks=12)
    assert p.weekly_rate == Decimal("1500")
    assert p.already_covered is False


def test_weekly_rate_rounds_up_to_clean_number():
    # 12500 / 12 = 1041.67 → ceil to nearest 100 → 1100
    p = fs.solve_weekly_rate(shortfall=Decimal("12500"), weeks=12)
    assert p.weekly_rate == Decimal("1100")


def test_weekly_rate_zero_when_already_covered():
    p = fs.solve_weekly_rate(shortfall=Decimal("0"), weeks=12)
    assert p.already_covered is True
    assert p.weekly_rate == Decimal("0")


def test_weekly_rate_handles_none_shortfall():
    p = fs.solve_weekly_rate(shortfall=None, weeks=12)
    assert p.already_covered is True
    assert p.weekly_rate == Decimal("0")


def test_weekly_rate_floors_weeks_at_one():
    p = fs.solve_weekly_rate(shortfall=Decimal("450"), weeks=0)
    assert p.weeks == 1
    assert p.weekly_rate == Decimal("500")   # ceil(450) to 100


# ── build_cone: ordering + honesty ─────────────────────────────────────

def test_cone_balance_edges_are_ordered():
    # higher MOMS → lower end balance: worst ≤ mid ≤ best
    r = fs.build_moms_range(realized_moms=Decimal("100000"),
                            projected_remaining_moms=Decimal("40000"))
    cone = fs.build_cone(_inputs(current_balance=Decimal("300000")), r)
    assert cone.worst.balance_after_moms <= cone.mid.balance_after_moms
    assert cone.mid.balance_after_moms <= cone.best.balance_after_moms


def test_cone_at_risk_when_worst_case_short_from_on_track():
    # balance clears the EXPECTED bill but not the HIGH bill → honesty escalation.
    # realized 100k, projected 40k, band .25 → expected 140k, high 150k.
    # balance 145k: mid covers (+5k), worst short (−5k).
    r = fs.build_moms_range(realized_moms=Decimal("100000"),
                            projected_remaining_moms=Decimal("40000"),
                            band_pct=Decimal("0.25"))
    cone = fs.build_cone(_inputs(current_balance=Decimal("145000")), r)
    assert cone.mid.state == STATE_ON_TRACK       # expected bill: covered
    assert cone.worst.covers_moms is False        # high bill: not covered
    assert cone.worst_case_short is True
    assert cone.headline_state == STATE_AT_RISK    # never a "covers MOMS" state
    # the play-it-safe plan closes the 5k worst-case gap over 12 weeks, and it
    # is the action the headline leads with — NOT an "already covered" CTA.
    assert cone.weekly_plan_safe.weekly_rate == Decimal("500")
    assert cone.headline_plan is cone.weekly_plan_safe
    assert cone.headline_plan.already_covered is False
    assert cone.weekly_plan.already_covered is True  # the expected bill needs nothing


def test_cone_at_risk_when_mid_tight_and_worst_short():
    # The HIGH-severity bug the adversarial pass caught: mid is TIGHT (covers
    # MOMS but dips below buffer), worst is SHORT. The old guard only escalated
    # ON_TRACK, so the headline stayed TIGHT — a "covers MOMS" assertion over an
    # uncovered worst case. It must now read AT_RISK with a non-covered action.
    r = fs.build_moms_range(realized_moms=Decimal("100000"),
                            projected_remaining_moms=Decimal("40000"),
                            band_pct=Decimal("0.25"))   # exp 140k, high 150k (+7.1%)
    supplier = CashEvent(on=date(2026, 7, 1), amount=Decimal("-150000"),
                         label="Supplier prepay", kind="recurring")
    receivable = CashEvent(on=date(2026, 8, 1), amount=Decimal("150000"),
                           label="Seasonal receivable", kind="inflow")
    cone = fs.build_cone(_inputs(current_balance=Decimal("155000"),
                                 safety_buffer=Decimal("12000"),
                                 recurring_outflows=[supplier],
                                 projected_inflows=[receivable]), r)
    assert cone.mid.state == STATE_TIGHT
    assert cone.mid.covers_moms is True
    assert cone.worst.covers_moms is False
    assert cone.worst_case_short is True
    assert cone.headline_state == STATE_AT_RISK     # NOT TIGHT — no false "covered"
    assert cone.headline_plan is cone.weekly_plan_safe
    assert cone.headline_plan.already_covered is False


def test_cone_short_surfaces_a_weekly_plan():
    r = fs.build_moms_range(realized_moms=Decimal("120000"),
                            projected_remaining_moms=Decimal("20000"),
                            band_pct=Decimal("0"))   # expected = high = 140k
    cone = fs.build_cone(_inputs(current_balance=Decimal("100000")), r)
    assert cone.headline_state == STATE_SHORT
    # 40k gap / 12 weeks = 3333.33 → ceil to 100 → 3400
    assert cone.weekly_plan.weekly_rate == Decimal("3400")
    assert cone.worst_case_short is False          # mid already short, not a downgrade case


def test_cone_on_track_when_even_high_bill_is_covered():
    r = fs.build_moms_range(realized_moms=Decimal("100000"),
                            projected_remaining_moms=Decimal("40000"))
    cone = fs.build_cone(_inputs(current_balance=Decimal("300000")), r)
    assert cone.headline_state == STATE_ON_TRACK
    assert cone.worst_case_short is False
    assert cone.weekly_plan.already_covered is True


def test_cone_insufficient_data_propagates():
    r = fs.build_moms_range(realized_moms=Decimal("100000"),
                            projected_remaining_moms=Decimal("0"))
    cone = fs.build_cone(_inputs(current_balance=None), r)
    assert cone.headline_state == STATE_INSUFFICIENT_DATA
    assert cone.weekly_plan is None
    assert cone.weekly_plan_safe is None


# ── evaluate(): one-call convenience ───────────────────────────────────

def test_evaluate_matches_manual_composition():
    inputs = _inputs(current_balance=Decimal("145000"))
    via_evaluate = fs.evaluate(inputs,
                               realized_moms=Decimal("100000"),
                               projected_remaining_moms=Decimal("40000"))
    manual_range = fs.build_moms_range(realized_moms=Decimal("100000"),
                                       projected_remaining_moms=Decimal("40000"))
    via_manual = fs.build_cone(inputs, manual_range)
    assert via_evaluate.headline_state == via_manual.headline_state
    assert via_evaluate.moms_range.expected == via_manual.moms_range.expected
