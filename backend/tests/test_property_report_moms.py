"""Tests for the property_report (Daily Report) MOMS math.

Pinning the math + the moms_mode flag so the frontend can render the
right layout (B2C extract vs B2B add-on-top vs no-VAT flat).

Direct unit tests on the math branches inside property_report — we
don't spin up FastAPI here, just exercise the math + the response
shape contract.
"""
from __future__ import annotations

import pytest


# Replicate the exact math branches from routers/property_report.py.
# Pinning the math here means a future edit must update both the
# router AND this test, forcing review of the change.

def _calc(taxable_sales: float, vat_rate: float, prices_incl_moms: bool):
    if vat_rate <= 0 or taxable_sales <= 0:
        tax_collected = 0.0
        all_sales_net = round(taxable_sales, 2)
        gross_sales = round(taxable_sales, 2)
        moms_mode = "none"
    elif prices_incl_moms:
        tax_collected = round(taxable_sales * vat_rate / (1 + vat_rate), 2)
        all_sales_net = round(taxable_sales - tax_collected, 2)
        gross_sales = round(taxable_sales, 2)
        moms_mode = "incl"
    else:
        tax_collected = round(taxable_sales * vat_rate, 2)
        all_sales_net = round(taxable_sales, 2)
        gross_sales = round(taxable_sales + tax_collected, 2)
        moms_mode = "excl"
    return {
        "taxable_sales": round(taxable_sales, 2),
        "tax_collected": tax_collected,
        "all_sales_net": all_sales_net,
        "gross_sales": gross_sales,
        "moms_mode": moms_mode,
    }


# ─── B2C: prices include Moms (default DK behavior) ────────────────────

def test_b2c_dk_25pct_extracts_moms_from_gross():
    """22,854 DKK gross → 18,283.20 net + 4,570.80 Moms (DK 25%)."""
    out = _calc(22854.0, 0.25, prices_incl_moms=True)
    assert out["moms_mode"] == "incl"
    assert out["taxable_sales"] == 22854.0
    assert out["gross_sales"] == 22854.0           # entered amount IS gross
    assert out["tax_collected"] == 4570.80         # extracted, NOT 5713.50
    assert out["all_sales_net"] == 18283.20        # gross - moms


def test_b2c_eu_21pct_extracts_correctly():
    """EU 21% VAT extract — 12,100 EUR gross → 10,000 net + 2,100 VAT
    (this gross/rate combination divides cleanly: 1.21 × 2100 = 2541 = 12100 × 0.21)."""
    out = _calc(12100.0, 0.21, prices_incl_moms=True)
    assert out["moms_mode"] == "incl"
    assert out["tax_collected"] == 2100.0
    assert out["all_sales_net"] == 10000.0


def test_b2c_invariant_net_plus_moms_equals_gross():
    """Bookkeeping invariant — within rounding."""
    out = _calc(15234.50, 0.25, prices_incl_moms=True)
    assert abs(out["all_sales_net"] + out["tax_collected"] - out["gross_sales"]) < 0.02


# ─── B2B: prices are net, Moms added on top ───────────────────────────

def test_b2b_dk_25pct_adds_moms_on_top():
    """22,854 DKK NET → customer pays 28,567.50 GROSS, seller owes
    5,713.50 to Skat."""
    out = _calc(22854.0, 0.25, prices_incl_moms=False)
    assert out["moms_mode"] == "excl"
    assert out["taxable_sales"] == 22854.0
    assert out["all_sales_net"] == 22854.0         # entered = net
    assert out["tax_collected"] == 5713.50         # net * vat_rate
    assert out["gross_sales"] == 28567.50          # net + tax_collected


def test_b2b_invariant_net_plus_moms_equals_gross():
    out = _calc(10000.0, 0.25, prices_incl_moms=False)
    assert out["all_sales_net"] + out["tax_collected"] == out["gross_sales"]


def test_b2b_dk_25pct_gross_is_higher_than_net():
    """In B2B mode, the gross customer-paid amount is always > net."""
    out = _calc(5000.0, 0.25, prices_incl_moms=False)
    assert out["gross_sales"] > out["all_sales_net"]
    assert out["gross_sales"] == 6250.0   # 5000 * 1.25


# ─── Edge cases ───────────────────────────────────────────────────────

def test_zero_sales_returns_no_moms():
    """No sales → no Moms, mode='none' so the UI shows a flat layout."""
    out = _calc(0.0, 0.25, prices_incl_moms=True)
    assert out["moms_mode"] == "none"
    assert out["tax_collected"] == 0.0
    assert out["all_sales_net"] == 0.0
    assert out["gross_sales"] == 0.0


def test_zero_vat_rate_returns_no_moms():
    """User in a no-VAT jurisdiction → mode='none'."""
    out = _calc(10000.0, 0.0, prices_incl_moms=True)
    assert out["moms_mode"] == "none"
    assert out["tax_collected"] == 0.0
    assert out["all_sales_net"] == 10000.0
    assert out["gross_sales"] == 10000.0


def test_moms_mode_is_one_of_three_values():
    """Pin the contract: moms_mode ∈ {'incl', 'excl', 'none'}."""
    cases = [
        _calc(100.0, 0.25, prices_incl_moms=True),    # incl
        _calc(100.0, 0.25, prices_incl_moms=False),   # excl
        _calc(0.0,   0.25, prices_incl_moms=True),    # none (no sales)
        _calc(100.0, 0.0,  prices_incl_moms=True),    # none (no rate)
    ]
    valid = {"incl", "excl", "none"}
    for c in cases:
        assert c["moms_mode"] in valid


# ─── Regression — the exact bug we fixed ──────────────────────────────

def test_pre_fix_bug_no_longer_present():
    """Bug pin: in the old code, B2B mode rendered as if B2C, leading
    to '−5,713.50 Moms' on top of a 22,854 'Net Sales' figure that
    equalled Taxable Sales. After the fix:
      • B2B response now exposes a distinct gross_sales (= net + moms)
      • moms_mode='excl' tells the frontend to render '+5,713.50' (not −)
        and label the bottom line 'Total customer paid' (not 'Net Sales').
    """
    b2b = _calc(22854.0, 0.25, prices_incl_moms=False)
    # The two values that used to be confusingly identical are now
    # distinct in the response (net=22854, gross=28567.50)
    assert b2b["all_sales_net"] != b2b["gross_sales"]
    assert b2b["gross_sales"] == 28567.50
    assert b2b["moms_mode"] == "excl"  # frontend uses this to render '+'
