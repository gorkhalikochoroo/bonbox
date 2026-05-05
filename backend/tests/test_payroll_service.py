"""
Tests for Danish payroll calculator.

These pin down the rates so a future "let me bump A-skat to 40%" doesn't
silently break employer cash-flow forecasts.

Run: cd backend && pytest tests/test_payroll_service.py -v
"""

from app.services.payroll_service import (
    calc_employee_period,
    AM_BIDRAG_RATE,
    ESTIMATED_A_SKAT_RATE,
    PERSONFRADRAG_MONTHLY,
    ATP_MONTHLY_FULL_TIME,
    FERIEPENGE_RATE,
)


# ─────────────────────────────────────────────────────────────────
# Rate constants — pinned. Updates require deliberate test edits.
# ─────────────────────────────────────────────────────────────────
def test_am_bidrag_rate_is_8_percent():
    assert AM_BIDRAG_RATE == 0.08


def test_a_skat_estimate_is_36_percent():
    # Bottom bracket: 12.06% bundskat + ~24% avg kommuneskat = ~36%.
    assert ESTIMATED_A_SKAT_RATE == 0.36


def test_personfradrag_is_monthly_2026():
    assert PERSONFRADRAG_MONTHLY == 4300.0


def test_atp_full_time_monthly():
    assert ATP_MONTHLY_FULL_TIME == 90.0


def test_feriepenge_rate_is_125_percent():
    assert FERIEPENGE_RATE == 0.125


# ─────────────────────────────────────────────────────────────────
# calc_employee_period — full pipeline at realistic numbers
# ─────────────────────────────────────────────────────────────────
def test_calc_employee_30k_full_time():
    """A 30,000 kr/month café manager — typical Copenhagen SMB wage."""
    result = calc_employee_period(gross=30000, contract_type="full")

    # AM-bidrag: 8% of 30,000 = 2,400
    assert result["am_bidrag"] == 2400.0

    # Taxable base: 30,000 - 2,400 - 4,300 = 23,300
    # A-skat: 36% of 23,300 = 8,388
    assert result["a_skat"] == 8388.0

    # ATP: 90 (full time)
    assert result["atp"] == 90.0

    # Feriepenge: 12.5% of 30,000 = 3,750
    assert result["feriepenge"] == 3750.0

    # Net to employee: 30,000 - 2,400 - 8,388 = 19,212
    assert result["net_pay"] == 19212.0

    # Employer total cost: 30,000 + 90 (ATP) + 3,750 (feriepenge) = 33,840
    assert result["employer_total_cost"] == 33840.0


def test_calc_employee_below_personfradrag():
    """Part-time student, 4,000 kr/month — below allowance, no A-skat owed."""
    result = calc_employee_period(gross=4000, contract_type="part")

    # AM-bidrag still applies (no allowance)
    assert result["am_bidrag"] == 320.0

    # After AM-bidrag = 3,680. After personfradrag = 0 (clamped).
    # A-skat = 0 (correctly).
    assert result["a_skat"] == 0.0

    # ATP zero for part-time (simplified)
    assert result["atp"] == 0.0


def test_calc_employee_zero_gross_no_crash():
    """Empty period — zero hours, must not crash."""
    result = calc_employee_period(gross=0, contract_type="full")
    assert result["gross"] == 0.0
    assert result["am_bidrag"] == 0.0
    assert result["a_skat"] == 0.0
    assert result["net_pay"] == 0.0


def test_calc_employee_handles_none_gross():
    """Defensive — None gross treated as 0, doesn't crash."""
    result = calc_employee_period(gross=None, contract_type="full")
    assert result["gross"] == 0.0


def test_calc_employee_negative_gross_clamped_to_zero():
    """Cannot owe negative wages — clamped at floor."""
    result = calc_employee_period(gross=-500, contract_type="full")
    assert result["gross"] == 0.0
    assert result["am_bidrag"] == 0.0


def test_personfradrag_can_be_disabled_for_bikort_emulation():
    """If user opts out of allowance (bikort or supplementary income), A-skat
    applies to the full post-AM amount."""
    no_allow = calc_employee_period(gross=30000, contract_type="full",
                                    include_personfradrag=False)
    with_allow = calc_employee_period(gross=30000, contract_type="full",
                                      include_personfradrag=True)
    # Bikort-style (no personfradrag) yields HIGHER A-skat
    assert no_allow["a_skat"] > with_allow["a_skat"]


def test_part_time_no_atp():
    """Part-time contracts don't accrue ATP in our simplified model."""
    full = calc_employee_period(gross=20000, contract_type="full")
    part = calc_employee_period(gross=20000, contract_type="part")
    assert full["atp"] == 90.0
    assert part["atp"] == 0.0


# ─────────────────────────────────────────────────────────────────
# Sanity: net + AM-bidrag + A-skat == gross (the conservation law)
# ─────────────────────────────────────────────────────────────────
def test_net_plus_deductions_equals_gross():
    for gross in (5000, 15000, 30000, 60000, 100000):
        r = calc_employee_period(gross=gross, contract_type="full")
        # Conservation: gross == net + am_bidrag + a_skat (rounding tolerance .01)
        total = r["net_pay"] + r["am_bidrag"] + r["a_skat"]
        assert abs(total - r["gross"]) < 0.01, f"conservation failed at {gross}"
