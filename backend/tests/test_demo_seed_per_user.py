"""Tests for per-user demo seed / clear (Task #68).

Distinct from test_demo_seed.py — those cover the shared
demo@bonbox.dk account.  These cover the new seed_for_user /
clear_for_user / status_for_user functions that let any owner
populate their own account with realistic sample data, then
clear it cleanly.

Coverage:
  • status_for_user returns the right has_demo / has_real flags
  • seed_for_user refuses when the user already has real data
  • seed_for_user refuses when demo data is already seeded
  • seed_for_user inserts rows tagged " · demo"
  • clear_for_user removes only " · demo" rows, leaving real data intact
  • clear_for_user is idempotent — second call deletes 0 rows
  • clear_for_user honors tenant boundaries (won't touch other users)
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.daily_close import DailyClose, encode_breakdown
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.user import User
from app.services.demo_seed import (
    _count_non_demo_rows,
    clear_for_user,
    seed_for_user,
    status_for_user,
)


# ─── Fixtures ──────────────────────────────────────────────────────

@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


def _make_user(db, email: str) -> User:
    u = User(
        email=email,
        password_hash="x",
        business_name="(unset)",
        currency="DKK",
        plan="free",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture
def owner(db):
    return _make_user(db, "owner@example.com")


@pytest.fixture
def other_owner(db):
    """A second user so we can verify tenant isolation."""
    return _make_user(db, "other@example.com")


# ─── status_for_user ────────────────────────────────────────────────

def test_status_empty_account(db, owner):
    """Brand-new account: no demo data, no real data."""
    s = status_for_user(db, owner)
    assert s == {"has_demo": False, "has_real": False}


def test_status_with_real_data(db, owner):
    """Owner has typed in one expense — has_real flips True."""
    cat = ExpenseCategory(
        id=uuid.uuid4(), user_id=owner.id, name="Food", color="#10b981",
    )
    db.add(cat)
    db.commit()
    db.add(Expense(
        id=uuid.uuid4(),
        user_id=owner.id,
        category_id=cat.id,
        date=date.today(),
        amount=Decimal("100"),
        description="real expense",   # NO " · demo" suffix
        payment_method="card",
        is_personal=False,
    ))
    db.commit()

    s = status_for_user(db, owner)
    assert s["has_real"] is True
    assert s["has_demo"] is False


# ─── seed_for_user ──────────────────────────────────────────────────

def test_seed_for_user_happy_path(db, owner):
    result = seed_for_user(db, owner)
    assert result["ok"] is True
    assert result["closes"] >= 25       # 30 closes
    assert result["inventory"] >= 20    # 26 items
    assert result["expenses"] >= 8      # 11 sample expenses

    # And every row carries the " · demo" marker
    for e in db.query(Expense).filter(Expense.user_id == owner.id).all():
        assert e.description.endswith(" · demo"), (
            f"expense missing demo marker: {e.description!r}"
        )
    for inv in db.query(InventoryItem).filter(InventoryItem.user_id == owner.id).all():
        assert inv.name.endswith(" · demo")
    for c in db.query(DailyClose).filter(DailyClose.user_id == owner.id).all():
        # notes are filled with the demo sentinel for the per-user path
        assert (c.notes or "").endswith(" · demo")


def test_seed_for_user_refuses_when_real_data_present(db, owner):
    """If the owner has even one real row, refuse — never overwrite work."""
    cat = ExpenseCategory(
        id=uuid.uuid4(), user_id=owner.id, name="Food", color="#10b981",
    )
    db.add(cat)
    db.commit()
    db.add(Expense(
        id=uuid.uuid4(),
        user_id=owner.id,
        category_id=cat.id,
        date=date.today(),
        amount=Decimal("100"),
        description="manual entry",  # no marker → counts as real
        payment_method="card",
        is_personal=False,
    ))
    db.commit()

    result = seed_for_user(db, owner)
    assert result["ok"] is False
    assert result["reason"] == "user has real data"
    assert result["real_row_count"] >= 1


def test_seed_for_user_refuses_when_already_seeded(db, owner):
    """Second call to seed without clearing first should refuse."""
    first = seed_for_user(db, owner)
    assert first["ok"] is True

    second = seed_for_user(db, owner)
    assert second["ok"] is False
    assert second["reason"] == "demo data already seeded"


# ─── clear_for_user ─────────────────────────────────────────────────

def test_clear_removes_demo_rows(db, owner):
    seed_for_user(db, owner)

    # Sanity: there are seeded rows
    assert db.query(Expense).filter_by(user_id=owner.id).count() > 0
    assert db.query(InventoryItem).filter_by(user_id=owner.id).count() > 0
    assert db.query(DailyClose).filter_by(user_id=owner.id).count() > 0

    result = clear_for_user(db, owner)
    assert result["ok"] is True
    d = result["deleted"]
    assert d["expenses"] > 0
    assert d["closes"] > 0
    assert d["inventory"] > 0
    # Expense categories with no remaining refs should also be cleaned
    assert d["expense_cats"] > 0

    # And the rows are gone
    assert db.query(Expense).filter_by(user_id=owner.id).count() == 0
    assert db.query(InventoryItem).filter_by(user_id=owner.id).count() == 0
    assert db.query(DailyClose).filter_by(user_id=owner.id).count() == 0


def test_clear_preserves_real_rows(db, owner):
    """A real expense typed by the owner is NOT removed by clear."""
    # Seed demo data first
    seed_for_user(db, owner)
    # Now add one real row
    real_cat = ExpenseCategory(
        id=uuid.uuid4(),
        user_id=owner.id,
        name="Owner-typed category",   # no " · demo" suffix
        color="#000000",
    )
    db.add(real_cat)
    db.commit()
    real = Expense(
        id=uuid.uuid4(),
        user_id=owner.id,
        category_id=real_cat.id,
        date=date.today(),
        amount=Decimal("250"),
        description="lunch with supplier",   # no marker
        payment_method="card",
        is_personal=False,
    )
    db.add(real)
    db.commit()
    real_id = real.id
    real_cat_id = real_cat.id

    clear_for_user(db, owner)

    # The real row survives
    survivor = db.query(Expense).filter_by(id=real_id).one_or_none()
    assert survivor is not None
    assert survivor.description == "lunch with supplier"
    # Its category survives because it still has a reference
    cat_survivor = db.query(ExpenseCategory).filter_by(id=real_cat_id).one_or_none()
    assert cat_survivor is not None


def test_clear_is_idempotent(db, owner):
    seed_for_user(db, owner)
    first = clear_for_user(db, owner)
    second = clear_for_user(db, owner)
    assert second["ok"] is True
    d = second["deleted"]
    # Nothing left to delete on the second pass
    assert d["expenses"] == 0
    assert d["closes"] == 0
    assert d["inventory"] == 0
    assert d["expense_cats"] == 0
    # And the first pass actually deleted things
    assert first["deleted"]["expenses"] > 0


def test_clear_honors_tenant_boundary(db, owner, other_owner):
    """Owner A's clear must not touch Owner B's demo rows."""
    seed_for_user(db, owner)
    seed_for_user(db, other_owner)

    a_count = db.query(Expense).filter_by(user_id=owner.id).count()
    b_count = db.query(Expense).filter_by(user_id=other_owner.id).count()
    assert a_count > 0 and b_count > 0

    clear_for_user(db, owner)

    # Owner A is empty, Owner B is untouched
    assert db.query(Expense).filter_by(user_id=owner.id).count() == 0
    assert db.query(Expense).filter_by(user_id=other_owner.id).count() == b_count


def test_count_non_demo_rows_ignores_marker(db, owner):
    """The internal counter must NOT count demo-tagged rows."""
    seed_for_user(db, owner)
    # All seeded rows carry the marker → real count should be 0
    assert _count_non_demo_rows(db, owner.id) == 0
