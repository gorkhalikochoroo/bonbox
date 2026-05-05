"""
Tests for wine accuracy — margin calculation must be Moms-aware.

Real bug we hit: gross margin was being computed by comparing menu
sell_price (incl Moms) with cost_price (ex Moms), which overstated
margin by ~5–10 percentage points. Restaurants relying on this number
would price wines too cheaply.

Run: cd backend && pytest tests/test_wine.py -v
"""

from app.routers.wine import _calc_margin, _net_sell, GLASSES_PER_BOTTLE


# ─────────────────────────────────────────────────────────────────
# Margin: Moms-aware (the actual bug)
# ─────────────────────────────────────────────────────────────────
def test_margin_b2c_default_extracts_moms_from_sell():
    # Cost 100 kr ex-moms, sell 250 kr incl-moms.
    # Net sell = 250 / 1.25 = 200. Real margin = (200 - 100) / 200 = 50%.
    # The buggy formula returned 60% (cost/sell directly).
    assert _calc_margin(100, 250, prices_include_moms=True) == 50.0


def test_margin_b2b_no_moms_extraction():
    # Cost 100, sell 250 BOTH ex-moms (B2B). Margin = 60%.
    assert _calc_margin(100, 250, prices_include_moms=False) == 60.0


def test_margin_zero_sell_returns_zero_not_crash():
    assert _calc_margin(50, 0) == 0.0
    assert _calc_margin(50, 0, prices_include_moms=True) == 0.0


def test_margin_zero_cost_returns_full_net_margin():
    # Free wine sample priced at 100 incl-moms → 100% margin on net 80
    assert _calc_margin(0, 100, prices_include_moms=True) == 100.0


def test_margin_negative_when_underwater():
    # Cost 200 ex-moms, sell 100 incl-moms (net 80) — losing money
    assert _calc_margin(200, 100, prices_include_moms=True) < 0


def test_net_sell_helper():
    # 250 incl-moms = 200 net (with 25% rate)
    assert _net_sell(250, prices_include_moms=True) == 200.0
    # B2B mode — no extraction
    assert _net_sell(250, prices_include_moms=False) == 250.0
    # Zero/negative degrades safely
    assert _net_sell(0) == 0.0


# ─────────────────────────────────────────────────────────────────
# Glasses per bottle constant — used in stock deduction logic
# ─────────────────────────────────────────────────────────────────
def test_glasses_per_bottle_is_5():
    # 750ml bottle / 150ml standard pour = 5 glasses
    assert GLASSES_PER_BOTTLE == 5


# ─────────────────────────────────────────────────────────────────
# Multi-layer defense — _calc_margin must never crash on bad input
# ─────────────────────────────────────────────────────────────────
def test_margin_handles_none_via_caller_default():
    # The caller does `float(x or 0)`; this just makes sure passing 0
    # works as the caller's safety net would deliver.
    assert _calc_margin(0, 0) == 0.0
