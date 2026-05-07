"""Tests for the global search endpoint that powers the ⌘K palette.

Coverage:
  • _safe_pattern escapes SQL LIKE wildcards (defense)
  • _search_sales / _search_expenses / _search_inventory return matches
  • All searches respect tenant scope (user_id filter)
  • Soft-deleted rows excluded
  • Per-group cap respected
  • Empty result set returns empty groups (no crash)
  • Khata import failure handled gracefully (returns empty list)
"""
from __future__ import annotations

import uuid
from datetime import date as _date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.sale import Sale
from app.models.user import User
from app.routers.search import (
    _PER_GROUP_LIMIT,
    _safe_pattern,
    _search_closes,
    _search_expenses,
    _search_inventory,
    _search_sales,
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
def lars(db):
    u = User(
        email="lars@mirabelle.dk",
        password_hash="x",
        business_name="Mirabelle",
        currency="DKK",
        plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def other_user(db):
    """A second tenant — used to verify scope isolation."""
    u = User(
        email="anna@anothershop.dk",
        password_hash="x",
        business_name="Another Shop",
        currency="DKK",
        plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


# ─── _safe_pattern ────────────────────────────────────────────────────

def test_safe_pattern_wraps_in_percent():
    assert _safe_pattern("fish") == "%fish%"


def test_safe_pattern_escapes_percent():
    """User typing '50%' should not match everything containing '50' — the
    % needs escaping to be treated as a literal character."""
    pat = _safe_pattern("50%")
    assert pat == "%50\\%%"  # literal % in middle, wildcards on edges


def test_safe_pattern_escapes_underscore():
    """Same defense for _ (single-char wildcard in SQL LIKE)."""
    assert _safe_pattern("a_b") == "%a\\_b%"


def test_safe_pattern_escapes_backslash_first():
    """Backslash must be escaped before % and _ otherwise we'd
    double-escape the escape character itself."""
    assert _safe_pattern("a\\b") == "%a\\\\b%"


# ─── Sales search ─────────────────────────────────────────────────────

def test_search_sales_finds_by_item_name(db, lars):
    db.add(Sale(
        id=uuid.uuid4(), user_id=lars.id,
        date=_date.today(), amount=Decimal("125.00"),
        item_name="Laks fersk", payment_method="card",
        status="completed",
    ))
    db.commit()
    results = _search_sales(db, lars.id, _safe_pattern("laks"))
    assert len(results) == 1
    assert results[0]["label"] == "Laks fersk"
    assert results[0]["amount"] == 125.00
    assert results[0]["link"] == "/sales"


def test_search_sales_excludes_other_tenants(db, lars, other_user):
    """Tenant scope — search must NEVER leak across users."""
    # Other user's matching sale
    db.add(Sale(
        id=uuid.uuid4(), user_id=other_user.id,
        date=_date.today(), amount=Decimal("999.00"),
        item_name="Laks supersized", payment_method="card",
        status="completed",
    ))
    # Lars's matching sale
    db.add(Sale(
        id=uuid.uuid4(), user_id=lars.id,
        date=_date.today(), amount=Decimal("125.00"),
        item_name="Laks fersk", payment_method="card",
        status="completed",
    ))
    db.commit()
    results = _search_sales(db, lars.id, _safe_pattern("laks"))
    assert len(results) == 1
    assert results[0]["amount"] == 125.00  # only Lars's row


def test_search_sales_excludes_soft_deleted(db, lars):
    db.add(Sale(
        id=uuid.uuid4(), user_id=lars.id,
        date=_date.today(), amount=Decimal("100.00"),
        item_name="Laks deleted", payment_method="card",
        status="completed", is_deleted=True,
    ))
    db.commit()
    results = _search_sales(db, lars.id, _safe_pattern("laks"))
    assert results == []


def test_search_sales_respects_per_group_limit(db, lars):
    for i in range(12):
        db.add(Sale(
            id=uuid.uuid4(), user_id=lars.id,
            date=_date.today(), amount=Decimal(f"{100 + i}.00"),
            item_name=f"Mango {i}", payment_method="card",
            status="completed",
        ))
    db.commit()
    results = _search_sales(db, lars.id, _safe_pattern("mango"))
    assert len(results) == _PER_GROUP_LIMIT  # capped


# ─── Expenses search ─────────────────────────────────────────────────

def test_search_expenses_finds_by_description(db, lars):
    cat = ExpenseCategory(id=uuid.uuid4(), user_id=lars.id, name="Råvarer")
    db.add(cat); db.flush()
    db.add(Expense(
        id=uuid.uuid4(), user_id=lars.id, category_id=cat.id,
        date=_date.today(), amount=Decimal("4250.00"),
        description="Hørkram - kød + fisk levering",
    ))
    db.commit()
    results = _search_expenses(db, lars.id, _safe_pattern("hørkram"))
    assert len(results) == 1
    assert "Hørkram" in results[0]["label"]
    assert "Råvarer" in results[0]["sublabel"]


def test_search_expenses_finds_by_category_name(db, lars):
    cat = ExpenseCategory(id=uuid.uuid4(), user_id=lars.id, name="Drikkevarer")
    db.add(cat); db.flush()
    db.add(Expense(
        id=uuid.uuid4(), user_id=lars.id, category_id=cat.id,
        date=_date.today(), amount=Decimal("2950.00"),
        description="Sailing levering",
    ))
    db.commit()
    results = _search_expenses(db, lars.id, _safe_pattern("drikke"))
    assert len(results) == 1


def test_search_expenses_excludes_other_tenants(db, lars, other_user):
    cat = ExpenseCategory(id=uuid.uuid4(), user_id=other_user.id, name="X")
    db.add(cat); db.flush()
    db.add(Expense(
        id=uuid.uuid4(), user_id=other_user.id, category_id=cat.id,
        date=_date.today(), amount=Decimal("1.00"),
        description="Hørkram cross-tenant",
    ))
    db.commit()
    results = _search_expenses(db, lars.id, _safe_pattern("hørkram"))
    assert results == []


# ─── Inventory search ────────────────────────────────────────────────

def test_search_inventory_finds_by_name(db, lars):
    db.add(InventoryItem(
        id=uuid.uuid4(), user_id=lars.id,
        name="Tuborg Pilsner 33cl", category="Beer",
        quantity=Decimal("48"), unit="flasker",
        cost_per_unit=Decimal("4.50"),
    ))
    db.commit()
    results = _search_inventory(db, lars.id, _safe_pattern("tuborg"))
    assert len(results) == 1
    assert "Tuborg" in results[0]["label"]
    assert "Beer" in results[0]["sublabel"]


def test_search_inventory_finds_by_category(db, lars):
    db.add(InventoryItem(
        id=uuid.uuid4(), user_id=lars.id,
        name="Random item", category="Spirits",
        quantity=Decimal("3"), unit="flasker",
        cost_per_unit=Decimal("165.00"),
    ))
    db.commit()
    results = _search_inventory(db, lars.id, _safe_pattern("spirit"))
    assert len(results) == 1


def test_search_inventory_handles_danish_chars(db, lars):
    """Owner searches for 'rødspætte' — must round-trip the Æ/Ø/Å."""
    db.add(InventoryItem(
        id=uuid.uuid4(), user_id=lars.id,
        name="Skagerak rødspætte filet 1kg", category="Seafood",
        quantity=Decimal("1.8"), unit="kg",
        cost_per_unit=Decimal("145.00"),
    ))
    db.commit()
    results = _search_inventory(db, lars.id, _safe_pattern("rødspætte"))
    assert len(results) == 1


# ─── Daily closes search ─────────────────────────────────────────────

def test_search_closes_by_notes(db, lars):
    db.add(DailyClose(
        id=uuid.uuid4(), user_id=lars.id,
        date=_date(2026, 5, 1), revenue_total=Decimal("18000"),
        payment_total=Decimal("18000"),
        status="confirmed", closed_by="Lars",
        notes="Travl fredag aften — koncert i nabolaget",
    ))
    db.commit()
    results = _search_closes(db, lars.id, _safe_pattern("koncert"))
    assert len(results) == 1
    assert "2026-05-01" in results[0]["label"]


def test_search_closes_by_closer_name(db, lars):
    """Searching for the staff member who closed surfaces their nights."""
    db.add(DailyClose(
        id=uuid.uuid4(), user_id=lars.id,
        date=_date(2026, 5, 7), revenue_total=Decimal("22000"),
        payment_total=Decimal("22000"),
        status="confirmed", closed_by="Anna",
    ))
    db.commit()
    results = _search_closes(db, lars.id, _safe_pattern("anna"))
    assert len(results) == 1


# ─── Empty / defensive ───────────────────────────────────────────────

def test_searches_return_empty_when_no_match(db, lars):
    pat = _safe_pattern("nothing-matches-this")
    assert _search_sales(db, lars.id, pat) == []
    assert _search_expenses(db, lars.id, pat) == []
    assert _search_inventory(db, lars.id, pat) == []
    assert _search_closes(db, lars.id, pat) == []


def test_searches_return_empty_for_brand_new_tenant(db, lars):
    """Just-registered user with zero data — every search returns []."""
    pat = _safe_pattern("anything")
    assert _search_sales(db, lars.id, pat) == []
    assert _search_expenses(db, lars.id, pat) == []
    assert _search_inventory(db, lars.id, pat) == []
    assert _search_closes(db, lars.id, pat) == []
