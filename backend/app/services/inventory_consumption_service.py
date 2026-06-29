"""Smart Inventory consumption — auto-decrement stock when sales
happen + predict depletion timing.

Why this exists (May 2026):
  Before this, InventoryItem.quantity changed only when the owner
  manually adjusted it (or via the Bar Pour module's pour-tracking
  for liquids only). Solid items (coffee beans, flour, shampoo,
  cleaning chemicals) had no link between their stock and the actual
  usage — owners had to do periodic stocktakes and guess.

  This module closes that loop: when an InventoryItem is configured
  with consumption_pattern + serving_size + usage_keywords, the
  service:
    1. Auto-decrements stock when matching sales fire
    2. Predicts how long stock will last at current sales velocity
    3. Surfaces "reorder by [date]" hints

Multi-layer defense:

  L1 — TENANT BOUNDARY
       Every query filters by user_id. Both InventoryItem and Sale
       queries; cross-owner stock manipulation impossible.

  L2 — VALIDATION
       consumption_pattern: enum-checked against allowlist
       consumption_unit:    free-text but bounded (length + char-set)
       serving_size:        positive (>0); ≤ 1e9 (sanity bound)
       usage_keywords:      ≤500 chars; bounded keyword count;
                            scrubbed of control chars

  L3 — UNIT CONVERSION
       Storage unit (kg, L) ≠ consumption unit (g, ml). The service
       converts deterministically using a built-in unit table. Unknown
       units fall back to "no auto-decrement" rather than guessing
       (fail-closed — silent miscount of stock would be worse than
       opt-in).

  L4 — KEYWORD MATCHING (case-insensitive substring)
       Match Sale.item_name against the comma-separated usage_keywords.
       Substring rather than exact match because owners write "Espresso
       (small)" / "Espresso doppio" / "Iced espresso" but want all of
       those to consume coffee beans. Per-keyword length bound (≤30
       chars each) so 'a' as a keyword can't match every sale.

  L5 — IDEMPOTENT REPLAY
       record_sale_consumption is keyed by sale_id; running it twice
       for the same sale doesn't double-decrement. Required because
       Sale create-from-receipt path could fire twice on retry.

Future (Phase 3+):
  • Confidence scoring per match — flag low-confidence matches for
    owner review
  • Cross-item competition (one sale → multiple items consumed,
    e.g. cappuccino = 18g coffee + 100ml milk)
  • Waste detection: actual depletion (stock_takes) vs predicted
    depletion (sales × serving_size) → variance flag
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import date as date_cls, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem, InventoryLog
from app.models.sale import Sale
from app.utils.time import utc_now

log = logging.getLogger(__name__)


class InventoryConsumptionError(ValueError):
    """Service-layer rejection. Routers map these to 422."""


# ─── Allowlists / constants ──────────────────────────────────────────


# Consumption-pattern discriminator. Each value tells the AI / forecast
# what KIND of usage this is — helps the demand model pick the right
# multiplier (per_dish scales with food sales, per_pour scales with
# drink sales, etc.).
CONSUMPTION_PATTERNS = frozenset({
    "per_unit",      # legacy / catch-all (1 sale = 1 unit consumed)
    "per_serving",   # cafe (e.g. 20g coffee per espresso)
    "per_pour",      # bar (already-tracked liquids; new fields override)
    "per_dish",      # restaurant ingredient (g flour per pizza)
    "per_service",   # salon / workshop (mL shampoo per haircut)
    "per_use",       # consumables (1 cleaning cloth = 1 use)
})

# Built-in unit conversion table. Source unit → target unit → factor
# (multiply source by factor to get target). Limited to the scales
# small-business inventory actually uses; unknown conversions fall
# back to no-decrement rather than guessing.
_UNIT_FACTORS: dict[str, dict[str, float]] = {
    # Mass
    "kg": {"g": 1000.0, "kg": 1.0},
    "g":  {"g": 1.0, "kg": 0.001},
    # Volume (metric)
    "l":  {"ml": 1000.0, "l": 1.0, "cl": 100.0, "dl": 10.0},
    "ml": {"ml": 1.0, "l": 0.001, "cl": 0.1, "dl": 0.01},
    "cl": {"ml": 10.0, "cl": 1.0, "l": 0.01, "dl": 0.1},
    "dl": {"ml": 100.0, "cl": 10.0, "dl": 1.0, "l": 0.1},
    # Discrete — when storage and consumption units match it's a no-op
    "pieces": {"pieces": 1.0, "piece": 1.0},
    "piece":  {"piece": 1.0, "pieces": 1.0},
    "pcs":    {"pcs": 1.0, "pieces": 1.0, "piece": 1.0},
    # Items (cleaning cloths, plates, napkins etc.)
    "items":  {"items": 1.0, "item": 1.0},
    "item":   {"item": 1.0, "items": 1.0},
}


_USAGE_KEYWORDS_MAX_TOTAL = 500   # total chars
_USAGE_KEYWORDS_MAX_COUNT = 30
_USAGE_KEYWORDS_MAX_PER = 30      # per-keyword length cap
_USAGE_KEYWORDS_MIN_PER = 2       # avoid 'a' / 'b' matching everything


# ─── Validators ──────────────────────────────────────────────────────


def _validate_consumption_pattern(value: Optional[str]) -> Optional[str]:
    if value in (None, "", "null"):
        return None
    if not isinstance(value, str):
        raise InventoryConsumptionError("consumption_pattern must be a string")
    v = value.strip().lower()
    if v not in CONSUMPTION_PATTERNS:
        raise InventoryConsumptionError(
            f"Unknown consumption_pattern '{value}'. "
            f"Use one of: {sorted(CONSUMPTION_PATTERNS)}"
        )
    return v


def _validate_consumption_unit(value: Optional[str]) -> Optional[str]:
    if value in (None, "", "null"):
        return None
    if not isinstance(value, str):
        raise InventoryConsumptionError("consumption_unit must be a string")
    v = value.strip().lower()
    if not (1 <= len(v) <= 20):
        raise InventoryConsumptionError("consumption_unit length out of bounds")
    if not re.match(r"^[a-z]+$", v):
        raise InventoryConsumptionError(
            "consumption_unit must be lowercase letters only"
        )
    return v


def _validate_serving_size(value: Any) -> Optional[float]:
    if value in (None, "", "null"):
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise InventoryConsumptionError("serving_size must be a number")
    if v <= 0:
        raise InventoryConsumptionError("serving_size must be > 0")
    if v > 1e9:
        raise InventoryConsumptionError("serving_size too large")
    return v


def _validate_usage_keywords(value: Optional[str]) -> Optional[str]:
    """Comma-separated keywords. Strips control chars + whitespace,
    de-dupes, applies length bounds. Returns the normalised string
    (alphabetised, trimmed) or None.
    """
    if value in (None, "", "null"):
        return None
    if not isinstance(value, str):
        raise InventoryConsumptionError("usage_keywords must be a string")
    if len(value) > _USAGE_KEYWORDS_MAX_TOTAL:
        raise InventoryConsumptionError(
            f"usage_keywords too long (max {_USAGE_KEYWORDS_MAX_TOTAL} chars)"
        )
    parts = [p.strip().lower() for p in value.split(",")]
    parts = [p for p in parts if p]
    # Scrub control chars from each keyword
    parts = [
        re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", p)
        for p in parts
    ]
    parts = [p for p in parts if p]
    # Apply length bounds per keyword
    cleaned: list[str] = []
    for p in parts:
        if len(p) < _USAGE_KEYWORDS_MIN_PER:
            raise InventoryConsumptionError(
                f"keyword '{p}' is too short (min {_USAGE_KEYWORDS_MIN_PER} chars) — "
                "single letters would match too broadly"
            )
        if len(p) > _USAGE_KEYWORDS_MAX_PER:
            raise InventoryConsumptionError(
                f"keyword too long (max {_USAGE_KEYWORDS_MAX_PER} chars)"
            )
        cleaned.append(p)
    # De-dupe (preserve first occurrence)
    seen: set[str] = set()
    deduped: list[str] = []
    for p in cleaned:
        if p not in seen:
            deduped.append(p)
            seen.add(p)
    if len(deduped) > _USAGE_KEYWORDS_MAX_COUNT:
        raise InventoryConsumptionError(
            f"too many keywords (max {_USAGE_KEYWORDS_MAX_COUNT})"
        )
    return ",".join(deduped) if deduped else None


# ─── Public service API ──────────────────────────────────────────────


def update_consumption_metadata(
    db: Session,
    *,
    owner_id: uuid.UUID,
    item_id: uuid.UUID,
    consumption_pattern: Optional[str] = None,
    consumption_unit: Optional[str] = None,
    serving_size: Any = None,
    usage_keywords: Optional[str] = None,
) -> InventoryItem:
    """Owner sets / updates consumption metadata on an inventory item.

    All four fields are independently optional — passing None for a
    field leaves it unchanged. Pass empty string to clear a field.
    """
    item = db.query(InventoryItem).filter(
        InventoryItem.id == item_id,
        InventoryItem.user_id == owner_id,  # tenant gate
    ).first()
    if not item:
        raise InventoryConsumptionError("Inventory item not found.")

    # Each validator returns None for empty/clear, valid value otherwise.
    # We update only when the caller explicitly passed something
    # (None → don't touch; "" → clear).
    if consumption_pattern is not None:
        item.consumption_pattern = _validate_consumption_pattern(consumption_pattern)
    if consumption_unit is not None:
        item.consumption_unit = _validate_consumption_unit(consumption_unit)
    if serving_size is not None:
        item.serving_size = _validate_serving_size(serving_size)
    if usage_keywords is not None:
        item.usage_keywords = _validate_usage_keywords(usage_keywords)

    item.updated_at = utc_now()
    db.commit()
    db.refresh(item)
    return item


def convert_units(amount: float, *, from_unit: str, to_unit: str) -> Optional[float]:
    """Convert `amount` from `from_unit` to `to_unit` using the built-
    in factor table. Returns None on unknown units (fail-closed —
    silently miscalculating stock would be worse than not auto-
    decrementing).
    """
    if amount is None:
        return None
    fu = (from_unit or "").lower()
    tu = (to_unit or "").lower()
    if not fu or not tu:
        return None
    factors = _UNIT_FACTORS.get(fu)
    if not factors:
        return None
    factor = factors.get(tu)
    if factor is None:
        return None
    return float(amount) * factor


def keyword_matches(item: InventoryItem, sale_item_name: Optional[str]) -> bool:
    """True if any keyword in item.usage_keywords appears (case-
    insensitive substring) in sale.item_name."""
    if not item.usage_keywords or not sale_item_name:
        return False
    haystack = sale_item_name.lower()
    for kw in item.usage_keywords.split(","):
        kw = kw.strip().lower()
        if kw and kw in haystack:
            return True
    return False


def predict_days_until_depletion(
    db: Session,
    *,
    item: InventoryItem,
    lookback_days: int = 14,
) -> Optional[float]:
    """Estimate how many days of stock remain at current sales velocity.

    Algorithm:
      1. Find sales over the last `lookback_days` whose item_name
         matches one of the item's usage_keywords.
      2. For each match, multiply by serving_size (in consumption_unit).
      3. Convert total consumption from consumption_unit → storage unit.
      4. Daily depletion rate = total / lookback_days.
      5. Days remaining = current quantity / daily_rate.

    Returns None when:
      • Item has no consumption_pattern / serving_size / keywords set
      • No matching sales in window (no signal)
      • Unit conversion fails (unknown units)
      • Quantity is 0 or negative

    Fail-closed: ambiguous → return None rather than fabricate.
    """
    if not item.consumption_pattern or not item.serving_size or not item.usage_keywords:
        return None
    if not item.unit or not item.consumption_unit:
        return None
    qty = float(item.quantity or 0)
    if qty <= 0:
        return None

    since = date_cls.today() - timedelta(days=lookback_days)
    sales = (
        db.query(Sale)
        .filter(
            Sale.user_id == item.user_id,
            Sale.is_deleted.isnot(True),
            Sale.date >= since,
            Sale.item_name.isnot(None),
        )
        .all()
    )
    matched = [s for s in sales if keyword_matches(item, s.item_name)]
    if not matched:
        return None

    # Total consumption in consumption_unit (e.g. grams of coffee).
    total_consumption_in_consumption_unit = (
        len(matched) * float(item.serving_size)
    )
    # Convert to storage unit (e.g. kg) so we can compare with item.quantity.
    consumed_in_storage_unit = convert_units(
        total_consumption_in_consumption_unit,
        from_unit=item.consumption_unit,
        to_unit=item.unit,
    )
    if consumed_in_storage_unit is None or consumed_in_storage_unit <= 0:
        return None

    daily_rate = consumed_in_storage_unit / max(1, lookback_days)
    if daily_rate <= 0:
        return None
    return round(qty / daily_rate, 1)


def find_matching_items_for_sale(
    db: Session,
    *,
    owner_id: uuid.UUID,
    sale_item_name: Optional[str],
) -> list[InventoryItem]:
    """Return inventory items whose usage_keywords match this sale's
    item_name. Tenant-scoped via owner_id.

    Used by the auto-decrement hook (Phase 3 wires this into the sale-
    create path); for now it's read-only suggestions surfaced in the
    inventory edit modal so the owner can preview which sales their
    keywords catch.
    """
    if not sale_item_name:
        return []
    items = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == owner_id,
            InventoryItem.usage_keywords.isnot(None),
            InventoryItem.consumption_pattern.isnot(None),
        )
        .all()
    )
    return [i for i in items if keyword_matches(i, sale_item_name)]


def record_sale_consumption(db: Session, *, sale: Sale) -> list[dict]:
    """Recipe-based auto-deduct (the keystone that keeps "on hand" live).

    When a generic menu-item sale is recorded — e.g. "Cappuccino" — decrement
    every inventory item whose usage_keywords match, each by
    `serving_size × servings`, converted from consumption_unit → storage unit.
    This is the path the explicit `inventory_item_id` 1:1 deduction in the
    sales router does NOT cover.

    Design (every guardrail from the inventory-redesign honesty doctrine):
      • OPT-IN BY CONSTRUCTION — only items with a COMPLETE recipe
        (consumption_pattern + serving_size + consumption_unit + unit +
        usage_keywords) are touched. No recipe → skipped. Default OFF: an
        item the owner hasn't given a recipe never moves.
      • FAIL-CLOSED — unknown unit conversion or no keyword match = NO
        decrement (convert_units already returns None rather than guessing).
        Silently miscounting stock is worse than not auto-decrementing.
      • SKIP THE 1:1 PATH — if the sale already carries an explicit
        inventory_item_id, the router deducted that item directly; we don't
        double-count.
      • IDEMPOTENT — keyed on InventoryLog.batch_id = "sale:<id>"; replaying
        the same sale never double-decrements (retry-safe).
      • INSPECTABLE — every decrement writes a visible InventoryLog row
        (reason="forbrug", batch_id linking the sale) the owner can open and
        the count ritual reconciles against.
      • COMPUTED, NOT COUNTED — stock is floored at 0; the result is the
        "beregnet" on-hand, never presented as a physical count. Drift is
        resolved by the optælling ritual.

    Pure + caller-committed: this mutates the session but does NOT commit;
    the caller commits and wraps in try/except so a consumption hiccup can
    never break the sale write.

    Returns the list of applied decrements ([] when nothing matched).
    """
    if sale is None or getattr(sale, "is_deleted", False):
        return []
    # The explicit item-linked path already deducted 1:1 — don't double-count.
    if getattr(sale, "inventory_item_id", None):
        return []
    sale_name = getattr(sale, "item_name", None)
    if not sale_name:
        return []

    items = find_matching_items_for_sale(
        db, owner_id=sale.user_id, sale_item_name=sale_name
    )
    if not items:
        return []

    batch = f"sale:{sale.id}"
    # Scale by the quantity actually sold on this sale row (Quick Sale rows
    # are usually 1; an explicit quantity_sold scales the recipe).
    try:
        servings = float(getattr(sale, "quantity_sold", None) or 1) or 1.0
    except (TypeError, ValueError):
        servings = 1.0
    if servings <= 0:
        servings = 1.0

    applied: list[dict] = []
    for item in items:
        # Require a COMPLETE recipe — fail-closed on anything missing.
        if not (
            item.consumption_pattern
            and item.serving_size
            and item.consumption_unit
            and item.unit
            and item.usage_keywords
        ):
            continue

        # Idempotency: this sale already decremented this item → skip.
        already = (
            db.query(InventoryLog.id)
            .filter(
                InventoryLog.item_id == item.id,
                InventoryLog.batch_id == batch,
            )
            .first()
        )
        if already:
            continue

        consumed_cu = float(item.serving_size) * servings  # in consumption_unit
        # Identity shortcut — convert_units only knows cross-unit factors, so a
        # same-unit recipe (e.g. stocked + consumed in "stk") would otherwise
        # fail-closed and never decrement.
        if (item.consumption_unit or "").lower() == (item.unit or "").lower():
            consumed_su = consumed_cu
        else:
            consumed_su = convert_units(
                consumed_cu, from_unit=item.consumption_unit, to_unit=item.unit
            )
        if consumed_su is None or consumed_su <= 0:
            continue  # unknown conversion → fail-closed, no decrement

        # The quantity column is Numeric(10,2); quantize the decrement to 2 dp
        # so the applied amount, the new on-hand, and the log row all agree and
        # don't desync row-to-row. Round-to-nearest keeps the computed on-hand
        # honest; the optælling ritual reconciles drift. LIMITATION: a recipe
        # that consumes <0.005 of a storage unit per serving (e.g. 2 g stocked
        # in kg) rounds to 0 and won't visibly move stock — stock such items in
        # a finer unit, or bump the column to Numeric(10,4) later.
        consumed_su = round(consumed_su, 2)
        if consumed_su <= 0:
            continue

        current = float(item.quantity or 0)
        new_qty = current - consumed_su
        if new_qty < 0:
            new_qty = 0.0
        applied_delta = round(current - new_qty, 2)  # what we actually removed
        if applied_delta <= 0:
            continue  # already empty — nothing to remove

        item.quantity = new_qty
        db.add(
            InventoryLog(
                item_id=item.id,
                change_qty=-round(applied_delta, 2),
                reason="forbrug",  # DK: consumption auto-deducted from a sale
                date=getattr(sale, "date", None) or date_cls.today(),
                batch_id=batch,
            )
        )
        applied.append(
            {
                "item_id": str(item.id),
                "qty": round(applied_delta, 4),
                "unit": item.unit,
            }
        )

    return applied
