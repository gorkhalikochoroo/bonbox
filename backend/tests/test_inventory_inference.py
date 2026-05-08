"""Tests for inventory_inference — propose consumption metadata
per item from a curated dictionary, cross-checked against actual sales.

Multi-layer pinned:
  • Tenant boundary: cross-owner item rejected
  • Dictionary lookup: vertical-specific overrides cross-vertical
  • Substring match (case-insensitive)
  • Match order: longer/more specific keys win
  • Fail-closed on unknown items: 'low' confidence + per_unit default
  • Cross-check: confidence drops when keywords don't match any sale
  • Output shape always complete
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.inventory import InventoryItem
from app.models.sale import Sale
from app.models.user import User
from app.services.inventory_inference import (
    INVENTORY_PROPOSAL_DICT,
    SALES_LOOKBACK_DAYS,
    infer_inventory_consumption,
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
def cafe_owner(db):
    u = User(
        email="cafe@bonbox.test", password_hash="x",
        business_name="Café", business_type="cafe",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def restaurant_owner(db):
    u = User(
        email="rest@bonbox.test", password_hash="x",
        business_name="Restaurant", business_type="restaurant",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def bar_owner(db):
    u = User(
        email="bar@bonbox.test", password_hash="x",
        business_name="Bar", business_type="bar",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _add_item(db, owner, name, unit="kg", quantity=5):
    item = InventoryItem(
        user_id=owner.id, name=name, unit=unit, quantity=quantity,
    )
    db.add(item); db.commit(); db.refresh(item)
    return item


def _add_sale(db, owner, item_name, on_date=None):
    s = Sale(
        user_id=owner.id,
        date=on_date or date.today(),
        amount=30, payment_method="card",
        item_name=item_name,
    )
    db.add(s); db.commit()
    return s


# ─── Dictionary shape invariants ──────────────────────────────────────


def test_dictionary_has_expected_verticals():
    """Major verticals all have at least one entry. Adding/removing a
    vertical needs to update this test on purpose."""
    expected = {"cafe", "restaurant", "bar", "salon", "retail", "workshop", "grocery", "*"}
    assert set(INVENTORY_PROPOSAL_DICT.keys()) == expected


def test_dictionary_entries_have_required_fields():
    for vertical, entries in INVENTORY_PROPOSAL_DICT.items():
        for substring, payload in entries.items():
            for key in ("consumption_pattern", "consumption_unit",
                        "serving_size", "usage_keywords", "reasoning"):
                assert key in payload, f"{vertical}/{substring} missing {key}"
            assert payload["serving_size"] > 0


# ─── Café — common items ─────────────────────────────────────────────


def test_cafe_coffee_beans_match(db, cafe_owner):
    item = _add_item(db, cafe_owner, "Coffee beans (Lavazza)", unit="kg")
    proposal = infer_inventory_consumption(db, user=cafe_owner, item=item)
    assert proposal["consumption_pattern"] == "per_serving"
    assert proposal["consumption_unit"] == "g"
    assert proposal["serving_size"] == 20.0
    assert "espresso" in proposal["usage_keywords"]
    # No matching sales yet → confidence medium not high
    assert proposal["confidence"] in ("medium", "low")


def test_cafe_coffee_with_real_sales_high_confidence(db, cafe_owner):
    item = _add_item(db, cafe_owner, "Coffee beans", unit="kg")
    _add_sale(db, cafe_owner, "Espresso doppio")
    _add_sale(db, cafe_owner, "Cappuccino")
    proposal = infer_inventory_consumption(db, user=cafe_owner, item=item)
    assert proposal["confidence"] == "high"
    assert "Espresso doppio" in proposal["matching_sales_preview"]
    assert "Cappuccino" in proposal["matching_sales_preview"]


def test_cafe_oat_milk_more_specific_than_milk(db, cafe_owner):
    """'Oat milk' substring is checked before 'milk' so an oat-milk
    item gets the plant-milk proposal, not the dairy one."""
    item = _add_item(db, cafe_owner, "Oat Milk Barista", unit="l")
    proposal = infer_inventory_consumption(db, user=cafe_owner, item=item)
    assert "oat" in proposal["usage_keywords"]


def test_cafe_milk_matches(db, cafe_owner):
    item = _add_item(db, cafe_owner, "Whole milk", unit="l")
    proposal = infer_inventory_consumption(db, user=cafe_owner, item=item)
    assert proposal["consumption_pattern"] == "per_serving"
    assert proposal["consumption_unit"] == "ml"
    assert proposal["serving_size"] == 100.0


# ─── Restaurant ──────────────────────────────────────────────────────


def test_restaurant_flour_matches(db, restaurant_owner):
    item = _add_item(db, restaurant_owner, "Tipo 00 flour", unit="kg")
    proposal = infer_inventory_consumption(db, user=restaurant_owner, item=item)
    assert proposal["consumption_pattern"] == "per_dish"
    assert "pizza" in proposal["usage_keywords"]


def test_restaurant_oil_means_cooking_oil_not_engine_oil(db, restaurant_owner):
    """At a restaurant, 'oil' should resolve to cooking oil (frying),
    not the workshop-engine-oil entry."""
    item = _add_item(db, restaurant_owner, "Frying oil", unit="l")
    proposal = infer_inventory_consumption(db, user=restaurant_owner, item=item)
    assert proposal["consumption_unit"] == "ml"
    assert proposal["serving_size"] == 10.0
    assert "fries" in proposal["usage_keywords"] or "fry" in proposal["usage_keywords"]


# ─── Bar ─────────────────────────────────────────────────────────────


def test_bar_vodka_per_pour(db, bar_owner):
    item = _add_item(db, bar_owner, "Absolut Vodka 70cl", unit="bottles")
    proposal = infer_inventory_consumption(db, user=bar_owner, item=item)
    assert proposal["consumption_pattern"] == "per_pour"
    assert proposal["consumption_unit"] == "ml"
    assert proposal["serving_size"] == 30.0


def test_bar_wine_per_pour_150ml(db, bar_owner):
    item = _add_item(db, bar_owner, "Red wine house", unit="bottles")
    proposal = infer_inventory_consumption(db, user=bar_owner, item=item)
    assert proposal["serving_size"] == 150.0


# ─── Workshop — vertical override prevents wrong reading ─────────────


def test_workshop_oil_means_engine_oil(db, db_workshop_owner=None):
    """The same word 'oil' resolves to engine-oil at a workshop. Pinned
    so a future global override never accidentally re-uses cooking oil
    semantics here."""
    workshop = User(
        email="ws@bonbox.test", password_hash="x",
        business_name="WS", business_type="workshop",
        currency="DKK", plan="free",
    )
    db.add(workshop); db.commit(); db.refresh(workshop)
    item = InventoryItem(
        user_id=workshop.id, name="Engine oil 5W30", unit="l", quantity=20,
    )
    db.add(item); db.commit(); db.refresh(item)
    proposal = infer_inventory_consumption(db, user=workshop, item=item)
    assert proposal["consumption_pattern"] == "per_service"
    assert proposal["serving_size"] == 5000.0  # ~5 L per oil change


# ─── Unknown item — fail-closed ──────────────────────────────────────


def test_unknown_item_returns_low_confidence_default(db, cafe_owner):
    item = _add_item(db, cafe_owner, "Mystery widget XYZ", unit="pieces")
    proposal = infer_inventory_consumption(db, user=cafe_owner, item=item)
    assert proposal["confidence"] == "low"
    assert proposal["consumption_pattern"] == "per_unit"
    assert proposal["serving_size"] == 1.0
    assert proposal["usage_keywords"] == ""
    assert "configure manually" in proposal["reasoning"]


# ─── Cross-vertical fallback ─────────────────────────────────────────


def test_cross_vertical_dictionary_used_when_specific_misses(db, cafe_owner):
    """A café owner with 'cleaning cloth' falls through to the * (cross-
    vertical) dictionary."""
    item = _add_item(db, cafe_owner, "Cleaning cloth pack", unit="pieces")
    proposal = infer_inventory_consumption(db, user=cafe_owner, item=item)
    assert proposal["consumption_pattern"] == "per_use"


# ─── Tenant boundary ─────────────────────────────────────────────────


def test_tenant_boundary_other_owners_sales_dont_match(db, cafe_owner):
    """Sales belonging to OTHER cafés don't appear in this owner's
    matching_sales_preview, even if the item names overlap."""
    other = User(
        email="other-cafe@bonbox.test", password_hash="x",
        business_name="Other Café", business_type="cafe",
        currency="DKK", plan="free",
    )
    db.add(other); db.commit(); db.refresh(other)
    item = _add_item(db, cafe_owner, "Coffee beans", unit="kg")
    # Both owners log Espresso sales
    _add_sale(db, cafe_owner, "Espresso (mine)")
    _add_sale(db, other, "Espresso (theirs)")
    proposal = infer_inventory_consumption(db, user=cafe_owner, item=item)
    preview = proposal["matching_sales_preview"]
    assert "Espresso (mine)" in preview
    assert "Espresso (theirs)" not in preview


def test_tenant_boundary_other_owners_item_rejected(db, cafe_owner, restaurant_owner):
    """If we somehow get an item that belongs to another owner, the
    service refuses with a low-confidence default rather than reading
    cross-tenant data."""
    item = _add_item(db, restaurant_owner, "Coffee beans", unit="kg")
    proposal = infer_inventory_consumption(db, user=cafe_owner, item=item)
    assert proposal["confidence"] == "low"


# ─── Output shape ────────────────────────────────────────────────────


def test_proposal_always_has_complete_shape(db, cafe_owner):
    item = _add_item(db, cafe_owner, "anything", unit="pieces")
    proposal = infer_inventory_consumption(db, user=cafe_owner, item=item)
    for key in ("consumption_pattern", "consumption_unit", "serving_size",
                "usage_keywords", "matching_sales_preview", "confidence",
                "reasoning"):
        assert key in proposal, f"missing {key}"
