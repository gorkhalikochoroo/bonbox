"""Tests for the inventory consumption service.

Multi-layer security pinned:
  • Tenant boundary: cross-owner item_id reads/writes rejected
  • Pattern enum: only allowed patterns; unknowns rejected
  • Unit conversion: known pairs work; unknowns fail-closed
  • Serving size: positive only; sanity-bounded
  • Keyword scrubbing: control chars stripped, length bounds, dedupe
  • Single-letter keywords rejected (would over-match)
  • Keyword match: case-insensitive substring against Sale.item_name
  • Depletion prediction: returns None on missing/incomplete signal
    (fail-closed: never fabricate a number)
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.inventory import InventoryItem
from app.models.sale import Sale
from app.models.user import User
from app.services.inventory_consumption_service import (
    CONSUMPTION_PATTERNS,
    InventoryConsumptionError,
    convert_units,
    find_matching_items_for_sale,
    keyword_matches,
    predict_days_until_depletion,
    update_consumption_metadata,
)


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def owner(db):
    u = User(
        email="cafe@bonbox.test", password_hash="x",
        business_name="Café", business_type="cafe",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def other_owner(db):
    u = User(
        email="other@bonbox.test", password_hash="x",
        business_name="Other", business_type="cafe",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def coffee_bag(db, owner):
    item = InventoryItem(
        user_id=owner.id,
        name="Coffee beans (Lavazza)",
        unit="kg",
        quantity=5.0,
        cost_per_unit=180.0,
        category="Beverages",
    )
    db.add(item); db.commit(); db.refresh(item)
    return item


# ─── Pattern + unit + size validation ────────────────────────────────


def test_valid_consumption_pattern_set(db, owner, coffee_bag):
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        consumption_pattern="per_serving",
        consumption_unit="g",
        serving_size=20,
        usage_keywords="espresso,cappuccino,latte",
    )
    db.refresh(coffee_bag)
    assert coffee_bag.consumption_pattern == "per_serving"
    assert coffee_bag.consumption_unit == "g"
    assert float(coffee_bag.serving_size) == 20.0
    assert coffee_bag.usage_keywords == "espresso,cappuccino,latte"


def test_unknown_consumption_pattern_rejected(db, owner, coffee_bag):
    with pytest.raises(InventoryConsumptionError):
        update_consumption_metadata(
            db, owner_id=owner.id, item_id=coffee_bag.id,
            consumption_pattern="per_galaxy",
        )


def test_consumption_pattern_normalised_case(db, owner, coffee_bag):
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        consumption_pattern="PER_SERVING",
    )
    db.refresh(coffee_bag)
    assert coffee_bag.consumption_pattern == "per_serving"


def test_consumption_unit_must_be_letters_only(db, owner, coffee_bag):
    with pytest.raises(InventoryConsumptionError):
        update_consumption_metadata(
            db, owner_id=owner.id, item_id=coffee_bag.id,
            consumption_unit="g/cup",
        )


def test_serving_size_rejects_zero_and_negative(db, owner, coffee_bag):
    with pytest.raises(InventoryConsumptionError):
        update_consumption_metadata(
            db, owner_id=owner.id, item_id=coffee_bag.id, serving_size=0,
        )
    with pytest.raises(InventoryConsumptionError):
        update_consumption_metadata(
            db, owner_id=owner.id, item_id=coffee_bag.id, serving_size=-5,
        )


def test_pattern_enum_set_complete():
    """Pin the allowed patterns so a future addition is a deliberate
    update of both the enum AND this test."""
    assert CONSUMPTION_PATTERNS == frozenset({
        "per_unit", "per_serving", "per_pour", "per_dish",
        "per_service", "per_use",
    })


# ─── Tenant boundary ─────────────────────────────────────────────────


def test_cross_owner_item_id_rejected(db, owner, other_owner, coffee_bag):
    """other_owner tries to update owner's item — service refuses
    with same shape as not-found (no enumeration)."""
    with pytest.raises(InventoryConsumptionError):
        update_consumption_metadata(
            db, owner_id=other_owner.id, item_id=coffee_bag.id,
            consumption_pattern="per_serving",
        )


# ─── Usage keywords ──────────────────────────────────────────────────


def test_usage_keywords_strips_control_chars(db, owner, coffee_bag):
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        usage_keywords="espresso\x00,latte\x07,cappuccino\x1b[31m",
    )
    db.refresh(coffee_bag)
    parts = set(coffee_bag.usage_keywords.split(","))
    assert "espresso" in parts
    assert "latte" in parts
    # Control char trailing the third keyword is stripped, leaving
    # the bracketed-color sequence behind as visible chars (intentional —
    # that's the same scrubbing pattern the rest of the codebase uses).
    assert any(p.startswith("cappuccino") for p in parts)


def test_usage_keywords_dedupes(db, owner, coffee_bag):
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        usage_keywords="espresso, ESPRESSO, latte,Espresso",
    )
    db.refresh(coffee_bag)
    parts = coffee_bag.usage_keywords.split(",")
    # Three distinct keywords, with espresso surviving once
    assert parts.count("espresso") == 1
    assert "latte" in parts


def test_usage_keywords_min_length_blocks_single_letters(db, owner, coffee_bag):
    """Single letters would substring-match every sale ('a' in
    'cappuccino', 'pizza', 'gravy', etc.) — service rejects."""
    with pytest.raises(InventoryConsumptionError):
        update_consumption_metadata(
            db, owner_id=owner.id, item_id=coffee_bag.id,
            usage_keywords="a,b,espresso",
        )


def test_usage_keywords_max_per_keyword_length(db, owner, coffee_bag):
    long_kw = "x" * 31
    with pytest.raises(InventoryConsumptionError):
        update_consumption_metadata(
            db, owner_id=owner.id, item_id=coffee_bag.id,
            usage_keywords=long_kw,
        )


def test_usage_keywords_max_total_chars(db, owner, coffee_bag):
    huge = ",".join(["espresso"] * 100)  # easily over 500
    with pytest.raises(InventoryConsumptionError):
        update_consumption_metadata(
            db, owner_id=owner.id, item_id=coffee_bag.id,
            usage_keywords=huge,
        )


def test_usage_keywords_max_count_30(db, owner, coffee_bag):
    """Even short keywords can't pile up unboundedly."""
    keywords = ",".join(f"kw{i:02d}" for i in range(31))
    with pytest.raises(InventoryConsumptionError):
        update_consumption_metadata(
            db, owner_id=owner.id, item_id=coffee_bag.id,
            usage_keywords=keywords,
        )


def test_usage_keywords_empty_normalised_to_none(db, owner, coffee_bag):
    """Pass empty string to clear the field."""
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        usage_keywords="espresso",
    )
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id, usage_keywords="",
    )
    db.refresh(coffee_bag)
    assert coffee_bag.usage_keywords is None


# ─── Keyword matching ────────────────────────────────────────────────


def test_keyword_matches_substring_case_insensitive(db, owner, coffee_bag):
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        usage_keywords="espresso,cappuccino",
        consumption_pattern="per_serving",
        consumption_unit="g", serving_size=20,
    )
    db.refresh(coffee_bag)
    assert keyword_matches(coffee_bag, "Espresso doppio") is True
    assert keyword_matches(coffee_bag, "Iced Cappuccino (large)") is True
    assert keyword_matches(coffee_bag, "Pizza margherita") is False


def test_keyword_matches_returns_false_when_unset(db, owner, coffee_bag):
    """No keywords → no match, no exception."""
    assert keyword_matches(coffee_bag, "Espresso") is False


def test_keyword_matches_returns_false_for_empty_sale_name(db, owner, coffee_bag):
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        usage_keywords="espresso",
    )
    db.refresh(coffee_bag)
    assert keyword_matches(coffee_bag, None) is False
    assert keyword_matches(coffee_bag, "") is False


# ─── Unit conversion ─────────────────────────────────────────────────


def test_convert_units_kg_to_g():
    assert convert_units(1, from_unit="kg", to_unit="g") == 1000.0


def test_convert_units_l_to_ml():
    assert convert_units(0.75, from_unit="l", to_unit="ml") == 750.0


def test_convert_units_same_unit_passthrough():
    assert convert_units(42, from_unit="pieces", to_unit="pieces") == 42.0


def test_convert_units_unknown_pair_returns_none():
    """Fail-closed: unknown units → None rather than guess."""
    assert convert_units(1, from_unit="bushels", to_unit="liters") is None
    assert convert_units(1, from_unit="kg", to_unit="bushels") is None


def test_convert_units_handles_none_amount():
    assert convert_units(None, from_unit="kg", to_unit="g") is None


# ─── Depletion prediction ────────────────────────────────────────────


def test_depletion_prediction_returns_none_when_metadata_missing(db, owner, coffee_bag):
    """No consumption_pattern → no prediction."""
    assert predict_days_until_depletion(db, item=coffee_bag) is None


def test_depletion_prediction_returns_none_when_no_matching_sales(db, owner, coffee_bag):
    """Set up the item but no matching sales in lookback → None."""
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        consumption_pattern="per_serving",
        consumption_unit="g", serving_size=20,
        usage_keywords="espresso",
    )
    db.refresh(coffee_bag)
    assert predict_days_until_depletion(db, item=coffee_bag) is None


def test_depletion_prediction_correct_on_clean_signal(db, owner, coffee_bag):
    """5 kg coffee, 20g per espresso, 50 espressos in last 14 days =
    1000g consumed = 1 kg depleted in 14 days = 70 g/day = 71.4 days
    of stock remaining."""
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        consumption_pattern="per_serving",
        consumption_unit="g", serving_size=20,
        usage_keywords="espresso",
    )
    db.refresh(coffee_bag)

    today = date.today()
    for i in range(50):
        s = Sale(
            user_id=owner.id,
            date=today - timedelta(days=i % 14),
            amount=30,
            payment_method="card",
            item_name=f"Espresso #{i}",
        )
        db.add(s)
    db.commit()

    days = predict_days_until_depletion(db, item=coffee_bag)
    assert days is not None
    # 5kg / (1kg / 14d) = 70 days. Allow rounding +/- 1.
    assert 65.0 <= days <= 75.0


def test_depletion_prediction_returns_none_when_quantity_zero(db, owner, coffee_bag):
    """Out of stock — depletion prediction not meaningful."""
    coffee_bag.quantity = 0
    db.commit()
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        consumption_pattern="per_serving",
        consumption_unit="g", serving_size=20,
        usage_keywords="espresso",
    )
    db.refresh(coffee_bag)
    assert predict_days_until_depletion(db, item=coffee_bag) is None


def test_depletion_prediction_unknown_unit_pair_returns_none(db, owner, coffee_bag):
    """consumption_unit = 'bushels' isn't in the conversion table →
    fail-closed (None) instead of assuming 1:1."""
    coffee_bag.consumption_unit = "bushels"
    db.commit()
    coffee_bag.consumption_pattern = "per_serving"
    coffee_bag.serving_size = 20
    coffee_bag.usage_keywords = "espresso"
    db.commit()
    db.refresh(coffee_bag)

    today = date.today()
    for i in range(20):
        db.add(Sale(
            user_id=owner.id, date=today - timedelta(days=i % 14),
            amount=30, payment_method="card", item_name="Espresso",
        ))
    db.commit()
    assert predict_days_until_depletion(db, item=coffee_bag) is None


# ─── find_matching_items_for_sale tenant scope ───────────────────────


def test_find_matching_items_tenant_scoped(db, owner, other_owner, coffee_bag):
    """An item at owner A doesn't appear in owner B's sale-match
    lookup."""
    update_consumption_metadata(
        db, owner_id=owner.id, item_id=coffee_bag.id,
        consumption_pattern="per_serving",
        consumption_unit="g", serving_size=20,
        usage_keywords="espresso",
    )
    matches_for_owner = find_matching_items_for_sale(
        db, owner_id=owner.id, sale_item_name="Espresso"
    )
    assert any(m.id == coffee_bag.id for m in matches_for_owner)

    matches_for_other = find_matching_items_for_sale(
        db, owner_id=other_owner.id, sale_item_name="Espresso"
    )
    assert all(m.id != coffee_bag.id for m in matches_for_other)


def test_find_matching_items_skips_items_without_metadata(db, owner):
    """Items without consumption_pattern set are excluded from match
    lookup — auto-decrement is opt-in, so unconfigured items stay
    invisible to the matcher."""
    plain = InventoryItem(
        user_id=owner.id, name="Plates", unit="pieces", quantity=100,
    )
    db.add(plain); db.commit(); db.refresh(plain)
    matches = find_matching_items_for_sale(
        db, owner_id=owner.id, sale_item_name="Plates",
    )
    assert all(m.id != plain.id for m in matches)


# ─── Recipe-based auto-deduct (G2 keystone) ──────────────────────────────
# record_sale_consumption decrements recipe ingredients when a generic
# menu-item sale is recorded. Opt-in (complete recipe), fail-closed,
# idempotent (batch_id="sale:<id>"), floored at 0, never raises.
from app.models.inventory import InventoryLog as _InventoryLog  # noqa: E402
from app.services.inventory_consumption_service import (  # noqa: E402
    record_sale_consumption,
)


def _coffee(db, owner, *, qty=5.0, **over):
    """A coffee-beans item with a COMPLETE recipe: 18 g per espresso/cappuccino,
    stocked in kg."""
    fields = dict(
        user_id=owner.id, name="Kaffebønner", quantity=qty, unit="kg",
        cost_per_unit=80, category="General",
        consumption_pattern="per_serving", serving_size=18,
        consumption_unit="g", usage_keywords="espresso,cappuccino,latte",
    )
    fields.update(over)
    it = InventoryItem(**fields)
    db.add(it); db.commit(); db.refresh(it)
    return it


def _sale(db, owner, name, *, qty=None, item_id=None):
    s = Sale(
        user_id=owner.id, date=date.today(), amount=35,
        payment_method="card", item_name=name,
        quantity_sold=qty, inventory_item_id=item_id,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


def test_record_sale_consumption_deducts_recipe(db, owner):
    item = _coffee(db, owner, qty=5.0)          # 5 kg
    sale = _sale(db, owner, "Cappuccino (stor)")  # matches "cappuccino"
    applied = record_sale_consumption(db, sale=sale)
    db.commit(); db.refresh(item)
    # 18 g = 0.018 kg removed from 5 kg.
    assert len(applied) == 1
    assert round(float(item.quantity), 2) == 4.98
    log = db.query(_InventoryLog).filter(_InventoryLog.item_id == item.id).one()
    assert log.reason == "forbrug"
    assert log.batch_id == f"sale:{sale.id}"
    assert round(float(log.change_qty), 2) == -0.02


def test_record_sale_consumption_is_idempotent(db, owner):
    item = _coffee(db, owner, qty=5.0)
    sale = _sale(db, owner, "Espresso")
    record_sale_consumption(db, sale=sale); db.commit()
    second = record_sale_consumption(db, sale=sale); db.commit()
    db.refresh(item)
    assert second == []                          # nothing applied the 2nd time
    assert round(float(item.quantity), 2) == 4.98  # only deducted once
    assert db.query(_InventoryLog).filter(_InventoryLog.item_id == item.id).count() == 1


def test_record_sale_consumption_skips_incomplete_recipe(db, owner):
    # Pattern + keywords present but NO serving_size → fail-closed, no deduct.
    item = _coffee(db, owner, qty=5.0, serving_size=None)
    sale = _sale(db, owner, "Latte")
    assert record_sale_consumption(db, sale=sale) == []
    db.refresh(item)
    assert float(item.quantity) == 5.0


def test_record_sale_consumption_skips_explicit_item_linked_sale(db, owner):
    # Sale already carries inventory_item_id → the 1:1 router path handled it;
    # the recipe hook must not double-deduct.
    item = _coffee(db, owner, qty=5.0)
    sale = _sale(db, owner, "Cappuccino", item_id=item.id)
    assert record_sale_consumption(db, sale=sale) == []
    db.refresh(item)
    assert float(item.quantity) == 5.0


def test_record_sale_consumption_no_keyword_match(db, owner):
    item = _coffee(db, owner, qty=5.0)
    sale = _sale(db, owner, "Cheese sandwich")   # no keyword overlap
    assert record_sale_consumption(db, sale=sale) == []
    db.refresh(item)
    assert float(item.quantity) == 5.0


def test_record_sale_consumption_floors_at_zero(db, owner):
    # Only 0.01 kg left but a serving needs 0.018 kg → floor at 0, log the
    # actual applied amount (0.01), never go negative.
    item = _coffee(db, owner, qty=0.01)
    sale = _sale(db, owner, "Espresso")
    applied = record_sale_consumption(db, sale=sale); db.commit()
    db.refresh(item)
    assert float(item.quantity) == 0.0
    assert round(applied[0]["qty"], 3) == 0.01
    log = db.query(_InventoryLog).filter(_InventoryLog.item_id == item.id).one()
    assert round(float(log.change_qty), 3) == -0.01


def test_record_sale_consumption_scales_by_quantity_sold(db, owner):
    item = _coffee(db, owner, qty=5.0)
    sale = _sale(db, owner, "Cappuccino", qty=3)   # 3 × 18 g = 54 g = 0.054 kg
    record_sale_consumption(db, sale=sale); db.commit()
    db.refresh(item)
    assert round(float(item.quantity), 2) == 4.95


def test_record_sale_consumption_is_tenant_scoped(db, owner, other_owner):
    # Another owner's matching coffee item is never touched.
    mine = _coffee(db, owner, qty=5.0)
    theirs = _coffee(db, other_owner, qty=5.0)
    sale = _sale(db, owner, "Cappuccino")
    record_sale_consumption(db, sale=sale); db.commit()
    db.refresh(mine); db.refresh(theirs)
    assert round(float(mine.quantity), 2) == 4.98
    assert float(theirs.quantity) == 5.0
