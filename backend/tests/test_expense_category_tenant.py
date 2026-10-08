"""Expense categories stay inside the tenant on edit and delete (sweep 8 Oct,
item 4).

* PUT /api/expenses/{id} copied any category_id onto the owner's expense —
  create checks ownership, edit did not. Another venue's category could be
  planted on the expense, its name flowing into the response and the
  caller's vendor memory. Now a category the caller does not own is refused
  (404, as create), a null one is refused (422 — the column is NOT NULL, it
  was a 500), and the expense is unchanged.
* DELETE /api/expenses/categories/{id} re-pointed EVERY expense that named
  the category, in any tenant. Both bulk updates now also filter on the
  caller's own expenses.

  cd backend && pytest tests/test_expense_category_tenant.py -v
"""
from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        yield s

    app.dependency_overrides[get_db] = _override
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.clear()


@pytest.fixture
def signals(monkeypatch):
    out = []
    monkeypatch.setattr("app.routers.expenses.record_signal",
                        lambda db, uid, key, field, value, **kw: out.append((uid, field, value)))
    return out


def _owner(db, email):
    u = User(email=email, password_hash=hash_password("x"), business_name="Café",
             business_type="cafe", currency="DKK", role="owner", plan="pro")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _cat(db, user, name):
    c = ExpenseCategory(user_id=user.id, name=name, color="#3B82F6")
    db.add(c); db.commit(); db.refresh(c)
    return c


def _exp(db, user, cat, **kw):
    e = Expense(user_id=user.id, category_id=cat.id, date=date(2026, 9, 1), amount=125.0,
                description="Metro Cash", payment_method="card", vendor_key=kw.pop("vendor_key", "metro"),
                **kw)
    db.add(e); db.commit(); db.refresh(e)
    return e


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def test_editing_onto_another_venues_category_is_refused(db, signals):
    a, b = _owner(db, "a@cafe.dk"), _owner(db, "b@cafe.dk")
    mine = _cat(db, a, "Vareforbrug")
    theirs = _cat(db, b, "Hemmelig leverandør")
    e = _exp(db, a, mine)
    r = _as(a).put(f"/api/expenses/{e.id}", json={"category_id": str(theirs.id)})
    assert r.status_code == 404, r.text
    assert "Hemmelig" not in r.text
    db.expire_all()
    assert db.get(Expense, e.id).category_id == mine.id
    assert all(v != "Hemmelig leverandør" for _, _, v in signals)


def test_a_null_category_is_refused_not_a_server_error(db, signals):
    a = _owner(db, "a@cafe.dk")
    mine = _cat(db, a, "Vareforbrug")
    e = _exp(db, a, mine)
    r = _as(a).put(f"/api/expenses/{e.id}", json={"category_id": None})
    assert r.status_code == 422, r.text
    db.expire_all()
    assert db.get(Expense, e.id).category_id == mine.id


def test_editing_onto_an_own_category_works_as_before(db, signals):
    a = _owner(db, "a@cafe.dk")
    old, new = _cat(db, a, "Vareforbrug"), _cat(db, a, "Emballage")
    e = _exp(db, a, old)
    r = _as(a).put(f"/api/expenses/{e.id}", json={"category_id": str(new.id), "amount": 130.0})
    assert r.status_code == 200, r.text
    assert r.json()["category_id"] == str(new.id)
    assert (a.id, "category_name", "Emballage") in signals
    # Fields without a category change are untouched by the check.
    r = _as(a).put(f"/api/expenses/{e.id}", json={"description": "Metro"})
    assert r.status_code == 200, r.text


def test_deleting_a_category_never_rewrites_another_venues_expense(db):
    a, b = _owner(db, "a@cafe.dk"), _owner(db, "b@cafe.dk")
    doomed = _cat(db, a, "Gammel")
    b_own = _cat(db, b, "B's egen")
    mine = _exp(db, a, doomed)
    # A row of B's that names A's category (planted before this fix by the
    # unchecked edit above).
    planted = _exp(db, b, b_own)
    planted.category_id = doomed.id
    db.commit()
    r = _as(a).delete(f"/api/expenses/categories/{doomed.id}")
    assert r.status_code == 204, r.text      # the planted row never blocks A's delete
    db.expire_all()
    a_andet = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == a.id,
                                               ExpenseCategory.name == "Andet").one()
    b_andet = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == b.id,
                                               ExpenseCategory.name == "Andet").one()
    assert db.get(Expense, mine.id).category_id == a_andet.id      # A's own → A's "Andet"
    # B's row is never put in one of A's categories: it goes back to B's own.
    assert db.get(Expense, planted.id).category_id == b_andet.id
    assert db.get(ExpenseCategory, doomed.id) is None
    # Nothing else of B's moved.
    assert db.query(Expense).filter(Expense.user_id == b.id).count() == 1


def test_deleting_a_category_moves_own_expenses_to_a_same_name_sibling(db):
    a = _owner(db, "a@cafe.dk")
    first, twin = _cat(db, a, "Vareforbrug"), _cat(db, a, "Vareforbrug")
    e = _exp(db, a, first)
    r = _as(a).delete(f"/api/expenses/categories/{first.id}")
    assert r.status_code == 204, r.text
    db.expire_all()
    assert db.get(Expense, e.id).category_id == twin.id
