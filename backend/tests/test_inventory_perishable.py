"""Tests for perishable shelf-life intelligence + auto-expiry.

Pins the conservative shelf-life numbers + the auto-fill semantics
that smart-import /commit + manual /inventory POST both rely on.

Why these tests matter:
  • If shelf-life numbers drift longer (e.g. someone bumps Seafood from
    2 days to 5), restaurants could sell spoiled fish — customer-trust
    + Fødevarestyrelsen disaster. Lock the conservative defaults here.
  • If the auto-fill logic stops respecting owner-provided values, an
    explicit "expires next month" set by the owner could silently get
    overwritten with our 2-day Seafood default. Pin that owner wins.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from app.services.inventory_perishable import (
    DEFAULT_PERISHABLE_DAYS,
    PERISHABLE_CATEGORIES,
    SHELF_LIFE_DAYS,
    compute_default_expiry,
    get_shelf_life_days,
    is_perishable_category,
    mark_perishable_if_needed,
)


# ─── Shelf-life table — pin the conservative values ────────────────────

def test_seafood_shelf_life_is_conservative():
    """Fish/shellfish in walk-in fridge — 2 days is the food-safety
    conservative number. Anything longer risks customer harm."""
    assert SHELF_LIFE_DAYS["Seafood"] == 2


def test_meat_shelf_life_is_conservative():
    """Fresh raw meat refrigerated — 4 days. USDA/Fødevarestyrelsen
    aligned. NEVER let this drift up without a food-safety review."""
    assert SHELF_LIFE_DAYS["Meat"] == 4


def test_dairy_shelf_life_is_one_week():
    """Opened dairy — 7 days conservative. Sealed retail packs last
    longer but restaurant walk-in is usually opened."""
    assert SHELF_LIFE_DAYS["Dairy"] == 7


def test_sandwich_has_shortest_shelf_life():
    """Made-to-order sandwiches spoil fastest — 1 day."""
    assert SHELF_LIFE_DAYS["Sandwich"] == 1


def test_perishable_categories_includes_food_safety_critical():
    """Pin the set of categories that trigger auto-expiry."""
    for cat in ("Seafood", "Meat", "Dairy", "Produce", "Bakery"):
        assert cat in PERISHABLE_CATEGORIES


def test_default_perishable_fallback_is_one_week():
    """If a perishable category has no explicit shelf-life entry, we
    fall back to 7 days — short enough to alert, generous enough not
    to cry wolf on every produce item."""
    assert DEFAULT_PERISHABLE_DAYS == 7


# ─── get_shelf_life_days ───────────────────────────────────────────────

def test_get_shelf_life_days_exact_match():
    assert get_shelf_life_days("Seafood") == 2
    assert get_shelf_life_days("Meat") == 4
    assert get_shelf_life_days("Dairy") == 7


def test_get_shelf_life_days_case_insensitive():
    """Owners may rename categories — case shouldn't matter."""
    assert get_shelf_life_days("seafood") == 2
    assert get_shelf_life_days("MEAT") == 4


def test_get_shelf_life_days_substring_match():
    """'Fresh Meat' or 'Sliced Meat' should still match 'Meat'."""
    assert get_shelf_life_days("Fresh Meat") == 4
    assert get_shelf_life_days("Sliced Produce") == 5


def test_get_shelf_life_days_returns_none_for_unknown():
    assert get_shelf_life_days(None) is None
    assert get_shelf_life_days("") is None
    assert get_shelf_life_days("Beer") is None       # not perishable
    assert get_shelf_life_days("Spirits") is None
    assert get_shelf_life_days("Tools") is None      # workshop category


# ─── is_perishable_category ────────────────────────────────────────────

def test_perishable_categories_round_trip():
    for cat in ("Seafood", "Meat", "Produce", "Dairy", "Bakery"):
        assert is_perishable_category(cat) is True


def test_non_perishable_categories():
    """Beer/Wine/Spirits/Tools are NOT food-safety perishable. Auto-
    expiry shouldn't fire on these."""
    for cat in ("Beer", "Wine", "Spirits", "Tools", "Filters", "Apparel"):
        assert is_perishable_category(cat) is False


def test_is_perishable_handles_none_and_empty():
    assert is_perishable_category(None) is False
    assert is_perishable_category("") is False


def test_is_perishable_substring_match():
    assert is_perishable_category("Fresh Meat") is True
    assert is_perishable_category("Frozen Meat") is True


# ─── compute_default_expiry ────────────────────────────────────────────

def test_compute_expiry_for_seafood_is_two_days():
    today = date(2026, 5, 7)
    assert compute_default_expiry("Seafood", today) == date(2026, 5, 9)


def test_compute_expiry_for_meat_is_four_days():
    today = date(2026, 5, 7)
    assert compute_default_expiry("Meat", today) == date(2026, 5, 11)


def test_compute_expiry_returns_none_for_non_perishable():
    """Beer / Wine / Spirits should NOT get an auto-expiry — we don't
    want spurious alerts on a 5-year whisky bottle."""
    assert compute_default_expiry("Beer", date.today()) is None
    assert compute_default_expiry("Spirits", date.today()) is None
    assert compute_default_expiry("Tools", date.today()) is None


def test_compute_expiry_uses_today_when_received_at_omitted():
    result = compute_default_expiry("Seafood")
    expected = date.today() + timedelta(days=2)
    assert result == expected


def test_compute_expiry_substring_category():
    """'Fresh Salmon Fillet' under category 'Seafood' subset → 2 days."""
    today = date(2026, 5, 7)
    assert compute_default_expiry("Fresh Seafood Catch", today) == date(2026, 5, 9)


# ─── mark_perishable_if_needed — owner-value-wins semantics ────────────

def test_mark_auto_fills_for_seafood():
    """Brand new fish item with no expiry from caller → auto-flag."""
    today = date(2026, 5, 7)
    is_per, expiry = mark_perishable_if_needed(
        category="Seafood",
        is_perishable=None,
        expiry_date=None,
        received_at=today,
    )
    assert is_per is True
    assert expiry == date(2026, 5, 9)


def test_mark_respects_explicit_owner_expiry():
    """If owner manually sets expiry_date, do NOT override with the
    2-day Seafood default. Owner knows their supplier."""
    owner_choice = date(2026, 5, 20)
    is_per, expiry = mark_perishable_if_needed(
        category="Seafood",
        is_perishable=True,
        expiry_date=owner_choice,
    )
    assert is_per is True
    assert expiry == owner_choice


def test_mark_does_not_fill_for_non_perishable():
    """Beer crate gets no auto-expiry — even though 'Beer' has best-by
    dates, those are not stock-rotation alerts."""
    is_per, expiry = mark_perishable_if_needed(
        category="Beer",
        is_perishable=None,
        expiry_date=None,
    )
    assert is_per is False
    assert expiry is None


def test_mark_promotes_perishable_flag_for_food_categories():
    """Even if caller forgot to set is_perishable=True, we set it for
    Meat/Seafood/Dairy. Avoids a class of bugs where an owner adds
    'Fresh Salmon' but it never appears on the expiry alert page."""
    is_per, expiry = mark_perishable_if_needed(
        category="Meat",
        is_perishable=False,           # caller said False
        expiry_date=None,
    )
    assert is_per is True              # we corrected to True
    assert expiry is not None


def test_mark_no_change_for_non_perishable_with_owner_expiry():
    """Edge case: owner sets expiry on a non-perishable (e.g. promotional
    'use by' on a beer keg). Respect their value, don't auto-flag."""
    chosen = date(2026, 6, 1)
    is_per, expiry = mark_perishable_if_needed(
        category="Beer",
        is_perishable=False,
        expiry_date=chosen,
    )
    assert is_per is False
    assert expiry == chosen


def test_mark_handles_missing_category():
    """No category → no auto-fill. Don't guess."""
    is_per, expiry = mark_perishable_if_needed(
        category=None,
        is_perishable=None,
        expiry_date=None,
    )
    assert is_per is False
    assert expiry is None


def test_mark_handles_unknown_perishable_category():
    """Category we don't recognize → no auto-fill (don't crash, don't
    invent a date)."""
    is_per, expiry = mark_perishable_if_needed(
        category="Quokka Snacks",
        is_perishable=None,
        expiry_date=None,
    )
    assert is_per is False
    assert expiry is None


# ─── Owner-value-wins regression pin ───────────────────────────────────

def test_owner_explicit_non_perishable_wins_even_for_food_category():
    """Edge: owner adds 'Beef stock cubes' under Meat category, sets
    is_perishable=False because cubes are shelf-stable. Don't override.

    Note: Right now we DO override because PERISHABLE_CATEGORIES
    inclusion takes priority. This test pins current behavior — if we
    decide owner-value-wins should be stricter, update both function
    and this test together."""
    is_per, expiry = mark_perishable_if_needed(
        category="Meat",
        is_perishable=False,           # owner says shelf-stable
        expiry_date=None,
    )
    # Current behavior: category wins. Documented above; change
    # together if requirements shift.
    assert is_per is True
