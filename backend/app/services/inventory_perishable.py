"""Perishable inventory intelligence — shelf-life defaults + auto-expiry.

The problem this solves: smart-import (and manual create) hands us
items like "Fresh salmon 2kg" and "Whole milk 4L" without an
expiry_date. The owner doesn't know to type one in, the AI doesn't
guess (would be wrong). Fish goes bad in 2 days, milk lasts a week,
hard cheese lasts a month. Without a default, the existing
/api/inventory/expired and /expiring endpoints have nothing to alert
on — perishables silently rot in stock.

Solution:
  • SHELF_LIFE_DAYS — per-category typical shelf-life (conservative).
  • PERISHABLE_CATEGORIES — set of categories where auto-expiry kicks in.
  • compute_default_expiry(category, received_at) → date | None
  • mark_perishable_if_needed(item) → fills is_perishable + expiry_date
    in-place when the category warrants it and the user didn't already
    provide values.

Conservative bias: when in doubt, set a SHORTER shelf-life rather than
longer. Owner can extend manually; over-shooting risks selling spoiled
food and a customer-trust disaster.

References for shelf-life defaults:
  • Fødevarestyrelsen (Danish Food Authority) general guidelines for
    refrigerated foods.
  • USDA refrigerated storage charts.
  • FoodSafety.gov.
Numbers err on the side of caution (typical RESTAURANT walk-in fridge
storage at 0-4°C, opened-package shelf life shorter than retail
sealed-package shelf life).
"""
from __future__ import annotations

from datetime import date, timedelta


# ─── Shelf-life defaults per category (days) ──────────────────────────
#
# Keys MUST match (or substring-match against) categories used in
# inventory_categorizer.py TAXONOMY. Conservative defaults — owner can
# extend per-item if their supplier guarantees a longer shelf life.
#
# Why these numbers (briefly):
#   Seafood   2d  — fish/shellfish in walk-in fridge, opened-package
#                   safe window; 2-3d cooked.
#   Meat      4d  — fresh raw red meat / poultry refrigerated.
#   Dairy     7d  — opened cream/milk; longer for unopened, shorter for
#                   opened soft cheese.
#   Produce   5d  — leafy greens; root veg lasts longer (owner extends).
#   Bakery    3d  — fresh bread / pastry; longer if frozen, owner adjusts.
#   Frozen   90d  — most frozen items; not a hard cap, just an outer
#                   bound for "we should still alert if it's been
#                   sitting in the freezer for 3 months untouched".
#   Beer/Wine/Spirits — None (not perishable in food-safety sense; they
#                       have best-by but it's not a stock-rotation alert).
#
# The default for a perishable category not listed below is 7 days
# (DEFAULT_PERISHABLE_DAYS) — a safe fallback that triggers the alert
# without being so short it cries wolf on long-life items.

DEFAULT_PERISHABLE_DAYS = 7

SHELF_LIFE_DAYS: dict[str, int] = {
    # Restaurant / cafe / grocery — food safety
    "Seafood": 2,
    "Meat": 4,
    "Produce": 5,
    "Dairy": 7,
    "Bakery": 3,
    "Frozen": 90,
    # Cafe-specific
    "Pastry": 3,
    "Sandwich": 1,        # made-to-order; spoils fastest
    "Milk": 7,
    # Grocery-specific
    "Pantry": 365,        # technically perishable but yearly is fine
    # Bar (mostly non-perishable; mixers are the exception)
    "Mixers": 30,         # opened juice / syrups
    "Garnish": 5,         # cut citrus, olives in brine
}


# Categories where auto-expiry should fire on item creation. Anything
# not in this set is treated as non-perishable for auto-fill purposes
# even if SHELF_LIFE_DAYS happens to have an entry (e.g. "Frozen" we
# log a date but don't aggressively flag).
PERISHABLE_CATEGORIES: set[str] = {
    "Seafood", "Meat", "Produce", "Dairy", "Bakery",
    "Pastry", "Sandwich", "Milk", "Mixers", "Garnish",
}


def get_shelf_life_days(category: str | None) -> int | None:
    """Return the typical shelf-life in days for a category, or None
    if the category is non-perishable / unknown.

    Case-insensitive lookup. Substring fallback so 'Bakery & Pastry'
    matches 'Bakery'."""
    if not category:
        return None
    cat = category.strip()
    if cat in SHELF_LIFE_DAYS:
        return SHELF_LIFE_DAYS[cat]

    # Case-insensitive direct match.
    for key, days in SHELF_LIFE_DAYS.items():
        if key.lower() == cat.lower():
            return days

    # Substring fallback — "Fresh Meat" → 'Meat', "Cut Produce" → 'Produce'.
    cat_lc = cat.lower()
    for key, days in SHELF_LIFE_DAYS.items():
        if key.lower() in cat_lc:
            return days

    return None


def is_perishable_category(category: str | None) -> bool:
    """True iff this category should trigger auto-expiry on create."""
    if not category:
        return False
    cat = category.strip()
    if cat in PERISHABLE_CATEGORIES:
        return True
    # Substring match for variations like "Fresh Meat", "Sliced Meat".
    cat_lc = cat.lower()
    return any(p.lower() in cat_lc for p in PERISHABLE_CATEGORIES)


def compute_default_expiry(
    category: str | None, received_at: date | None = None
) -> date | None:
    """Compute the date this item should be used by, given its category
    and the date it was received.

    Returns None for non-perishable categories — caller does NOT auto-fill
    in that case, leaving the field NULL (no spurious alerts).

    Conservative: returns received_at + SHELF_LIFE_DAYS[category]. If the
    category is in PERISHABLE_CATEGORIES but missing from SHELF_LIFE_DAYS,
    falls back to DEFAULT_PERISHABLE_DAYS so we never have a perishable
    item without a date.
    """
    if not is_perishable_category(category):
        return None
    base = received_at or date.today()
    days = get_shelf_life_days(category)
    if days is None:
        days = DEFAULT_PERISHABLE_DAYS
    return base + timedelta(days=days)


def mark_perishable_if_needed(
    *,
    category: str | None,
    is_perishable: bool | None,
    expiry_date: date | None,
    received_at: date | None = None,
) -> tuple[bool, date | None]:
    """Decide the final (is_perishable, expiry_date) for an item being
    created.

    Behavior:
      • If the user/AI already provided is_perishable=True AND expiry_date,
        respect both (no override — owner's value wins).
      • If category is in PERISHABLE_CATEGORIES and expiry_date is None,
        set is_perishable=True and compute expiry_date.
      • If neither matches, return the inputs unchanged.

    This is the SINGLE SOURCE OF TRUTH for the auto-fill — both the smart-
    import /commit and the manual /api/inventory POST should call it so
    the behaviour stays consistent. If we add ML-based shelf-life
    prediction later, only this function changes.
    """
    final_perishable = bool(is_perishable) if is_perishable is not None else False
    final_expiry = expiry_date

    if is_perishable_category(category):
        # Auto-flag perishable IF the caller didn't already know.
        if not final_perishable:
            final_perishable = True
        # Auto-fill expiry IF empty.
        if final_expiry is None:
            final_expiry = compute_default_expiry(category, received_at)

    return final_perishable, final_expiry
