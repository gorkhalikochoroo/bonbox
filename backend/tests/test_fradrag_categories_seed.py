"""§42 categories seed (S1) — make the fradrag reduction actually fire.

dk_fradrag computes 25%/0% correctly, but only for Danish category NAMES. The
accreted (English) category list has no "restaurant visit 25%" bucket, so §42
never fires and meals/gifts over-claim at 100%. These tests pin the fix: seeding
the three canonical §42 categories (idempotently, additively) so the owner can
tag meals/gifts where dk_fradrag's factor actually applies.

Run:
  cd backend && python3 -m pytest tests/test_fradrag_categories_seed.py -q
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.expense import ExpenseCategory
from app.models.user import User
from app.services.dk_fradrag import FRADRAG_CATEGORIES, fradrag_factor
from app.services.expense_categories import ensure_fradrag_categories


@pytest.fixture
def db():
    eng = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def user(db):
    u = User(email="seed@bonbox.test", password_hash="x", business_name="Café", currency="DKK", plan="free")
    db.add(u); db.commit(); db.refresh(u)
    return u


def test_seed_creates_the_three_s42_categories(db, user):
    created = ensure_fradrag_categories(db, user.id)
    assert created == 3
    names = {c.name for c in db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id).all()}
    assert names == {"Restaurantbesøg, erhverv", "Hotel & overnatning", "Repræsentation & gaver"}


def test_seed_is_idempotent(db, user):
    assert ensure_fradrag_categories(db, user.id) == 3
    assert ensure_fradrag_categories(db, user.id) == 0  # second run adds nothing
    n = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id).count()
    assert n == 3


def test_seed_does_not_clobber_existing_english_categories(db, user):
    # An existing account with English categories keeps them (forward-only).
    db.add(ExpenseCategory(user_id=user.id, name="Food Cost", color="#000000"))
    db.commit()
    ensure_fradrag_categories(db, user.id)
    names = {c.name for c in db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id).all()}
    assert "Food Cost" in names           # untouched
    assert "Restaurantbesøg, erhverv" in names  # added alongside


def test_seeded_categories_actually_fire_s42():
    # The whole point: dk_fradrag must reduce these to 25% / 0%.
    factors = {name: fradrag_factor(name) for name, _c, _f in FRADRAG_CATEGORIES}
    assert factors["Restaurantbesøg, erhverv"] == 0.25
    assert factors["Hotel & overnatning"] == 0.25
    assert factors["Repræsentation & gaver"] == 0.0
    # And a normal English category stays 100% — no under-claiming.
    assert fradrag_factor("Food Cost") == 1.0
    assert fradrag_factor("Vareforbrug / råvarer") == 1.0
