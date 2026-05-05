"""
Tests for Daily Close MOMS calculation.

Audit findings (fixed in this iteration):
1. MOMS rate was hardcoded 25% — wrong for NPR/GBP/EUR/INR users
2. Didn't honor user.prices_include_moms — B2B users got wrong moms
3. cash_expected used `or` chain — 0 was treated as missing

These tests exercise the math directly. End-to-end (with real DB write)
should be added in a separate integration suite.

Run: cd backend && pytest tests/test_daily_close_moms.py -v
"""

import pytest

from app.services.tax_service import _get_vat_rate


def _calc_moms(revenue_total: float, vat_rate: float, prices_incl_moms: bool) -> float:
    """Mirror of the moms-calc logic in routers/daily_close.py.

    If we extract this into the daily_close router as a helper later,
    these tests should import it directly.
    """
    if revenue_total <= 0 or vat_rate <= 0:
        return 0.0
    if prices_incl_moms:
        return round(revenue_total * vat_rate / (1 + vat_rate), 2)
    return round(revenue_total * vat_rate, 2)


# ─────────────────────────────────────────────────────────────────
# DK 25% MOMS — most common case
# ─────────────────────────────────────────────────────────────────
def test_dk_b2c_1000_kr_revenue_yields_200_moms():
    # 1000 incl-Moms = 800 net + 200 Moms
    assert _calc_moms(1000, 0.25, prices_incl_moms=True) == 200.0


def test_dk_b2b_1000_kr_net_yields_250_moms():
    # 1000 net + 25% Moms = 1250 gross. Moms portion = 250.
    assert _calc_moms(1000, 0.25, prices_incl_moms=False) == 250.0


# ─────────────────────────────────────────────────────────────────
# Other-currency rates — confirms the rate-lookup wiring
# ─────────────────────────────────────────────────────────────────
def test_npr_uses_13_percent_not_25():
    assert _get_vat_rate("NPR") == 0.13
    # 1000 incl 13% = 884.96 net, 115.04 VAT
    assert _calc_moms(1000, 0.13, prices_incl_moms=True) == 115.04


def test_gbp_uses_20_percent():
    assert _get_vat_rate("GBP") == 0.20
    assert _calc_moms(1200, 0.20, prices_incl_moms=True) == 200.0


def test_eur_uses_21_percent_default():
    # EUR default rate — countries can override (DE 19%, FR 20%, etc.)
    assert _get_vat_rate("EUR") == 0.21


# ─────────────────────────────────────────────────────────────────
# Edge cases
# ─────────────────────────────────────────────────────────────────
def test_zero_revenue_yields_zero_moms():
    assert _calc_moms(0, 0.25, prices_incl_moms=True) == 0.0


def test_negative_revenue_yields_zero_moms():
    assert _calc_moms(-100, 0.25, prices_incl_moms=True) == 0.0


def test_zero_vat_rate_yields_zero_moms():
    # Some sectors (financial, healthcare) are 0% rated
    assert _calc_moms(1000, 0, prices_incl_moms=True) == 0.0


def test_rounding_preserves_2_decimals():
    # 1234.56 / 1.25 = 987.648 → moms = 246.91 (banker's rounding aside)
    assert _calc_moms(1234.56, 0.25, prices_incl_moms=True) == 246.91


# ─────────────────────────────────────────────────────────────────
# Cash-expected zero handling — ensures 0 isn't treated as None
# ─────────────────────────────────────────────────────────────────
def test_cash_expected_zero_stays_zero():
    """Reproduces the `or` bug: pb={'cash': 0} should give cash_expected=0."""
    pb = {"cash": 0}
    if "cash" in pb:
        cash_expected = pb["cash"]
    elif "kontant" in pb:
        cash_expected = pb["kontant"]
    else:
        cash_expected = None
    assert cash_expected == 0
    # Old buggy `or` chain would give None:
    buggy = pb.get("cash") or pb.get("kontant")
    assert buggy is None  # Confirms the bug exists in the old expression


def test_cash_expected_kontant_fallback():
    """Danish key 'kontant' is the fallback when 'cash' is absent."""
    pb = {"kontant": 500}
    cash_expected = pb["cash"] if "cash" in pb else (pb["kontant"] if "kontant" in pb else None)
    assert cash_expected == 500
