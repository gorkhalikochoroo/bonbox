"""Regression: an unapproved (Godkend-kø) Expense draft must NOT seed a
Foresight recurring outflow.

The inventory spend-loop now auto-books a `status="pending"` expense from every
snapped supplier receipt. Repeated imports from the same leverandør normalise to
one description key — so without the gate they would form a "recurring outflow"
the "er du dækket?" burn projects against, built entirely from drafts the owner
never approved. `recurring_detection` must apply `not_pending()`.

Unlike test_recurring_detection.py (pure fakes whose .filter() is a no-op, so it
can't exercise the SQL gate), this uses a REAL SQLite session so the
`not_pending()` clause actually runs.

Run: cd backend && pytest tests/test_recurring_detection_pending_gate.py -v
"""
from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.services.auth import hash_password
from app.services.recurring_detection import (
    detect_recurring_outflows,
    detect_recurring_series,
)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _owner(db) -> User:
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("pw"),
        business_name="Restaurant", business_type="restaurant",
        currency="DKK", plan="free", role="owner",
    )
    db.add(u); db.commit(); db.refresh(u)
    cat = ExpenseCategory(id=uuid.uuid4(), user_id=u.id, name="Vareforbrug")
    db.add(cat); db.commit(); db.refresh(cat)
    u._cat_id = cat.id  # stash for _exp
    return u


def _exp(db, owner, *, d, amount, desc, status):
    db.add(Expense(
        id=uuid.uuid4(), user_id=owner.id, category_id=owner._cat_id, date=d,
        amount=Decimal(str(amount)), description=desc, status=status,
    ))


# Four monthly "Hørkram" rows that WOULD form a monthly series if counted.
_MONTHS = [date(2026, 2, 1), date(2026, 3, 1), date(2026, 4, 1), date(2026, 5, 1)]
_AS_OF = date(2026, 6, 14)


def test_approved_series_is_detected_baseline(db):
    owner = _owner(db)
    for d in _MONTHS:
        _exp(db, owner, d=d, amount=8000, desc=f"Hørkram faktura {d.month}", status="approved")
    db.commit()

    series = detect_recurring_series(owner, db, as_of=_AS_OF)
    assert len(series) == 1                      # the gate doesn't break the happy path
    assert series[0].cadence == "monthly"
    assert series[0].occurrences == 4


def test_pending_drafts_do_not_form_a_recurring_series(db):
    """The fix: 4 pending receipt drafts must NOT become a projected burn."""
    owner = _owner(db)
    for d in _MONTHS:
        _exp(db, owner, d=d, amount=8000, desc=f"Hørkram faktura {d.month}", status="pending")
    db.commit()

    series = detect_recurring_series(owner, db, as_of=_AS_OF)
    assert series == []                          # all drafts → excluded → no series

    events = detect_recurring_outflows(owner, db, as_of=_AS_OF, horizon_end=date(2026, 9, 1))
    assert all(e.label != "Hørkram" for e in events)
    assert not [e for e in events if "Hørkram" in (e.label or "")]


def test_only_approved_rows_count_when_mixed(db):
    """A pending draft sitting alongside an approved series must not inflate it
    (e.g. add a phantom 5th occurrence / bump the typical amount)."""
    owner = _owner(db)
    for d in _MONTHS:
        _exp(db, owner, d=d, amount=8000, desc=f"Hørkram faktura {d.month}", status="approved")
    # An unapproved draft for the same supplier in a 5th month — must be ignored.
    _exp(db, owner, d=date(2026, 6, 1), amount=99999, desc="Hørkram faktura 6", status="pending")
    db.commit()

    series = detect_recurring_series(owner, db, as_of=_AS_OF)
    assert len(series) == 1
    assert series[0].occurrences == 4            # NOT 5 — the draft is invisible
    assert series[0].typical_amount == Decimal("8000")   # not skewed by the 99999 draft
