"""Unit tests for the kasserapport cross-field reconciliation scorer.

Anchored on the real failure that motivated it — Restaurant Abigail's
kasserapport, where the recurring "1012 - …" varegruppe code was read as the
day total (1.012) under a correctly-read MOMS of 5.376,80 — plus the
false-positive guards that must NOT trip on a correct read.
"""
from app.services.kasserapport_reconciliation import reconcile_z_report


def _codes(res):
    return set(res["failure_codes"])


def test_moms_exceeds_revenue_is_hard_and_blanks_totals():
    # Abigail: MOMS 5376.80 under a misread revenue of 1012 (the "1012" code).
    res = reconcile_z_report({
        "revenue_total": 1012.0, "moms_total": 5376.80,
        "payment_breakdown": {"softpay": 14249.0, "dankort": 9066.10},
    })
    assert "moms_exceeds_revenue" in _codes(res)
    assert set(res["fields_to_blank"]) == {"revenue_total", "moms_total"}
    assert res["manual_review_needed"] is True
    assert res["consistency_score"] < 0.6
    assert "MOMS" in res["note"]


def test_correct_read_no_flags():
    # Real totals: revenue 14854 (gross), MOMS 5376.80. The softpay +
    # betalingskort split must NOT trip the payment check (max single line
    # 14249 < 1.5 x 14854) — this is the regression that proves we don't
    # cry wolf on a legitimate multi-method report.
    res = reconcile_z_report({
        "revenue_total": 14854.0, "moms_total": 5376.80,
        "payment_breakdown": {"softpay": 14249.0, "card": 605.0},
        "revenue_breakdown": {"food": 8000.0, "drinks": 344.0},
    })
    assert res["failure_codes"] == []
    assert res["fields_to_blank"] == []
    assert res["manual_review_needed"] is False
    assert res["consistency_score"] == 1.0
    assert res["note"] == ""


def test_moms_equals_25pct_of_net_boundary_ok():
    # Net revenue with exactly 25% MOMS — must NOT trip (moms = 0.25*rev < rev).
    res = reconcile_z_report({"revenue_total": 8477.20, "moms_total": 2119.30})
    assert "moms_exceeds_revenue" not in _codes(res)
    assert res["fields_to_blank"] == []


def test_breakdown_exceeding_total_is_soft_flag_only():
    res = reconcile_z_report({
        "revenue_total": 1000.0, "moms_total": 200.0,
        "revenue_breakdown": {"food": 3000.0, "drinks": 2000.0},
    })
    assert "breakdown_exceeds_revenue" in _codes(res)
    # Soft: never blanks a field, but does ask for review.
    assert res["fields_to_blank"] == []
    assert res["manual_review_needed"] is True


def test_single_payment_line_dwarfs_revenue_is_soft():
    # No MOMS line, but a payment line ~15x the total → catches the
    # "1012-class" misread independently of the MOMS check.
    res = reconcile_z_report({
        "revenue_total": 900.0, "moms_total": 180.0,
        "payment_breakdown": {"softpay": 14000.0},
    })
    assert "payment_exceeds_revenue" in _codes(res)
    assert res["fields_to_blank"] == []  # flag only — which side is wrong is ambiguous


def test_payment_within_tip_headroom_ok():
    # A card line slightly above revenue (tips folded in) within the 1.5x
    # headroom must NOT flag.
    res = reconcile_z_report({
        "revenue_total": 5000.0, "moms_total": 1000.0,
        "payment_breakdown": {"card": 5200.0, "cash": 300.0},
    })
    assert res["failure_codes"] == []


def test_empty_extraction_does_not_crash():
    res = reconcile_z_report({})
    assert res["failure_codes"] == []
    assert res["fields_to_blank"] == []
    assert res["manual_review_needed"] is False


def test_bools_not_treated_as_numbers():
    # bool is an int subclass — must be excluded from numeric checks.
    res = reconcile_z_report({"revenue_total": True, "moms_total": True})
    assert "moms_exceeds_revenue" not in _codes(res)
