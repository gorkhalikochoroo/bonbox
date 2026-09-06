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
    # 2026: ~52,800 kr/year ÷ 12 ≈ 4,400 kr/month.
    assert PERSONFRADRAG_MONTHLY == 4400.0


def test_atp_full_time_monthly():
    # ATP is hours-tiered (see _atp_total_for_hours). The back-compat
    # ATP_MONTHLY_FULL_TIME alias is the EMPLOYEE 1/3 share of the full
    # monthly contribution: 284 × ⅓ = 94.67 (derived from the 284 kr base;
    # the published employee sats is ~94,65, the 2-øre gap is rounding).
    assert ATP_MONTHLY_FULL_TIME == 94.67


def test_feriepenge_rate_is_125_percent():
    assert FERIEPENGE_RATE == 0.125


# ─────────────────────────────────────────────────────────────────
# calc_employee_period — full pipeline at realistic numbers
# ─────────────────────────────────────────────────────────────────
def test_calc_employee_30k_full_time():
    """A 30,000 kr/month café manager — typical Copenhagen SMB wage.
    Defaults to hovedkort (36% A-skat, with personfradrag). Full-time
    hours (160 ≥ 117) → full ATP tier."""
    result = calc_employee_period(gross=30000, hours=160, contract_type="full")

    # AM-bidrag: 8% of 30,000 = 2,400
    assert result["am_bidrag"] == 2400.0

    # Taxable base: 30,000 - 2,400 - 4,400 = 23,200
    # A-skat: 36% of 23,200 = 8,352
    assert result["a_skat"] == 8352.0

    # ATP — hours-tiered. 160h ≥ 117h → full 284 kr contribution, split
    # 1/3 employee (94.67, withheld from pay) + 2/3 employer (189.33, on
    # top). result["atp"] is the EMPLOYER share.
    assert result["atp_total"] == 284.0
    assert result["atp_employee"] == 94.67
    assert result["atp_employer"] == 189.33
    assert result["atp"] == 189.33

    # Feriepenge: 12.5% of 30,000 = 3,750
    assert result["feriepenge"] == 3750.0

    # Net to employee: 30,000 - 2,400 (AM) - 8,352 (A-skat) - 94.67 (own ATP) = 19,153.33
    assert result["net_pay"] == 19153.33

    # Employer total cost: 30,000 + 189.33 (employer ATP) + 3,750 (feriepenge) = 33,939.33
    assert result["employer_total_cost"] == 33939.33


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


def test_atp_is_hours_tiered():
    """ATP accrues by ATP-pligtige HOURS worked in the month, NOT by
    contract_type. A full-hours employee (≥117h) gets the full 284 kr
    contribution; a very-low-hours employee (<39h) accrues nothing."""
    full = calc_employee_period(gross=20000, hours=160)   # ≥117h → full tier
    low = calc_employee_period(gross=20000, hours=20)     # <39h → below ATP floor
    assert full["atp_total"] == 284.0
    assert full["atp_employee"] == 94.67
    assert full["atp"] == 189.33          # employer share
    assert low["atp_total"] == 0.0
    assert low["atp"] == 0.0


# ─────────────────────────────────────────────────────────────────
# Trækkort — per-employee A-skat resolution (multi-barrier)
# ─────────────────────────────────────────────────────────────────
def test_hovedkort_default_36_pct_with_personfradrag():
    """No explicit trækkort = hovedkort default = 36% with personfradrag."""
    result = calc_employee_period(gross=30000, contract_type="full",
                                  tax_card_type="hovedkort")
    # Same as the default test above — 8,352 A-skat
    assert result["a_skat"] == 8352.0
    assert result["a_skat_rate"] == 0.36
    assert result["include_personfradrag"] is True


def test_bikort_42_pct_no_personfradrag():
    """Bikort = 42% applied to the FULL post-AM amount (no personfradrag).
    For 30k gross: AM=2,400, then 42% of 27,600 = 11,592 A-skat."""
    result = calc_employee_period(gross=30000, contract_type="full",
                                  tax_card_type="bikort")
    assert result["a_skat_rate"] == 0.42
    assert result["include_personfradrag"] is False
    # 30,000 - 2,400 = 27,600. 42% of that = 11,592.
    assert result["a_skat"] == 11592.0
    # Bikort produces HIGHER A-skat than hovedkort at same gross
    hovedkort = calc_employee_period(gross=30000, tax_card_type="hovedkort")
    assert result["a_skat"] > hovedkort["a_skat"]


def test_frikort_zero_a_skat():
    """Frikort = student under annual limit = 0% A-skat."""
    result = calc_employee_period(gross=30000, contract_type="full",
                                  tax_card_type="frikort")
    assert result["a_skat"] == 0.0
    assert result["a_skat_rate"] == 0.0


def test_explicit_rate_override_clamped():
    """Owner pastes a rate from eSkattekort. Sane values used; bad ones rejected."""
    # Valid: 0.385 (38.5%, between hovedkort and bikort)
    a = calc_employee_period(gross=30000, tax_card_rate=0.385,
                             tax_card_type="hovedkort")
    assert a["a_skat_rate"] == 0.385
    # Negative rejected → falls through to default
    b = calc_employee_period(gross=30000, tax_card_rate=-0.5)
    assert b["a_skat_rate"] == 0.36
    # >60% rejected (no Danish A-skat exceeds ~52%) → default
    c = calc_employee_period(gross=30000, tax_card_rate=0.99)
    assert c["a_skat_rate"] == 0.36
    # Garbage string rejected → default
    d = calc_employee_period(gross=30000, tax_card_rate="garbage")
    assert d["a_skat_rate"] == 0.36


def test_unknown_tax_card_type_falls_back_to_default():
    """Multi-barrier: drive-by injection of a bad enum doesn't break the calc."""
    result = calc_employee_period(gross=30000, tax_card_type="totally-fake")
    assert result["a_skat_rate"] == 0.36  # default-hovedkort fallback


def test_tax_card_source_label_returned():
    """UI uses tax_card_source to show 'Estimat (hovedkort)' badge."""
    a = calc_employee_period(gross=30000, tax_card_type="bikort")
    assert a["tax_card_source"] == "bikort"
    b = calc_employee_period(gross=30000)  # no card set
    assert b["tax_card_source"] == "default-hovedkort"
    c = calc_employee_period(gross=30000, tax_card_rate=0.4,
                             tax_card_type="hovedkort")
    assert c["tax_card_source"] == "override"


# ─────────────────────────────────────────────────────────────────
# Sanity: net + AM-bidrag + A-skat == gross (the conservation law)
# ─────────────────────────────────────────────────────────────────
def test_net_plus_deductions_equals_gross():
    for gross in (5000, 15000, 30000, 60000, 100000):
        r = calc_employee_period(gross=gross, contract_type="full")
        # Conservation: gross == net + am_bidrag + a_skat (rounding tolerance .01)
        total = r["net_pay"] + r["am_bidrag"] + r["a_skat"]
        assert abs(total - r["gross"]) < 0.01, f"conservation failed at {gross}"


# ── The export must FAIL CLOSED ────────────────────────────────────────
#
# GET /payroll/csv used to swallow ANY exception from estimate_period_payroll
# into {"per_staff": []} and return 200 with a header-only file. The comment
# defending it said "so the user's import job doesn't crash" — which is the
# wrong trade on money. A crashed import is loud and recoverable; a
# well-formed, empty payroll CSV at the 10th-of-month deadline means somebody
# does not get paid and nothing said so.
#
# This test drives the route through its error path and asserts the owner
# gets an error rather than an empty file. It fails on the old code.

def test_payroll_csv_fails_closed_instead_of_exporting_an_empty_file(monkeypatch):
    import app.routers.staff as staff_router
    from fastapi import HTTPException

    def _boom(*a, **k):
        raise RuntimeError("payroll service down")

    # The route imports the service INSIDE the function, so patch at source.
    import app.services.payroll_service as payroll_service
    monkeypatch.setattr(payroll_service, "estimate_period_payroll", _boom)

    from datetime import date
    try:
        staff_router.export_payroll_csv(
            period_start=date(2026, 8, 1),
            period_end=date(2026, 8, 31),
            db=None,
            user=type("U", (), {"id": "u1"})(),
        )
    except HTTPException as e:
        assert e.status_code == 503, f"expected 503, got {e.status_code}"
        # The message must tell the owner the export was NOT made, so an
        # empty download is never mistaken for an empty payroll.
        assert "IKKE tom" in e.detail
        return
    except RuntimeError:
        raise AssertionError(
            "route let the service error escape raw — it should be a named 503"
        )
    raise AssertionError(
        "route returned a CSV on a failed payroll calculation — this is the "
        "fail-open bug: a header-only file reads as 'nobody worked'"
    )
