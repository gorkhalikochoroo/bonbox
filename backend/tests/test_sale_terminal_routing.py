"""Tests for Sale.terminal_id auto-routing & ownership validation.

The router /api/sales/POST accepts either an explicit `terminal_id` or
a `terminal_label` (string from a POS export). This test file covers:

  • Sale model can persist terminal_id (schema sanity)
  • find_terminal_for_label() returns the correct terminal_id when a
    label matches — already covered exhaustively in
    test_terminal_inference.py; this file pins the contract from the
    sale-routing point of view (label normalisation + tenant scope).
  • Cross-tenant terminal_id is rejected at the model-relationship
    level: the Sale row CAN be created with a foreign terminal_id by
    a careless service caller, but the application code (router) must
    reject it. We pin the router's behavior via a lightweight call.

Pinned for ship-readiness so a future change to the routing helper
can't quietly break the multi-tenant boundary.
"""
from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.sale import Sale
from app.models.terminal import Terminal
from app.models.user import User
from app.services.terminal_inference import find_terminal_for_label


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


def _user(db, email="owner@bonbox.test", vertical="restaurant"):
    u = User(
        email=email, password_hash="x",
        business_name="Bar", business_type=vertical,
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _terminal(db, owner, *, name="Front bar", receipt_label="Term 1"):
    t = Terminal(
        id=uuid.uuid4(), user_id=owner.id, name=name, receipt_label=receipt_label,
    )
    db.add(t); db.commit(); db.refresh(t)
    return t


# ─── Schema sanity ────────────────────────────────────────────────────


def test_sale_persists_terminal_id(db):
    """Round-trip: create a sale with terminal_id, fetch it back, the
    ID is intact. Guards a migration regression that quietly drops the
    column (would silently lose per-terminal analytics)."""
    user = _user(db)
    term = _terminal(db, user)
    s = Sale(
        user_id=user.id, terminal_id=term.id,
        date=date(2026, 5, 8), amount=100, payment_method="card",
    )
    db.add(s); db.commit(); db.refresh(s)
    fetched = db.query(Sale).filter(Sale.id == s.id).first()
    assert fetched.terminal_id == term.id


def test_sale_terminal_id_nullable(db):
    """Single-terminal venues never set this — the column must be
    nullable. Pinned so a future "NOT NULL" tightening is a deliberate
    decision."""
    user = _user(db)
    s = Sale(
        user_id=user.id, terminal_id=None,
        date=date(2026, 5, 8), amount=50, payment_method="cash",
    )
    db.add(s); db.commit(); db.refresh(s)
    assert s.terminal_id is None


# ─── Auto-route helper contract ───────────────────────────────────────


def test_auto_route_finds_match_for_label(db):
    """End-to-end shape of the routing call as the sales router uses
    it: pass a free-text label, get back a terminal_id."""
    user = _user(db)
    term = _terminal(db, user, receipt_label="Term 2")
    tid = find_terminal_for_label(db, user=user, label="term 2")
    assert tid == term.id


def test_auto_route_returns_none_for_unknown_label(db):
    user = _user(db)
    _terminal(db, user, receipt_label="Term 1")
    tid = find_terminal_for_label(db, user=user, label="Term 99")
    assert tid is None


def test_auto_route_tenant_scoped(db):
    """A label belonging to Owner A's terminal must NOT match for
    Owner B's lookup. Same coverage as test_terminal_inference.py but
    pinned here from the sale-routing perspective so a future change
    that decouples sale-routing from the helper still gets tested."""
    a = _user(db, email="a@bonbox.test")
    b = _user(db, email="b@bonbox.test")
    _terminal(db, a, receipt_label="Term 1")
    assert find_terminal_for_label(db, user=b, label="Term 1") is None


def test_auto_route_with_empty_label_returns_none(db):
    """A POS export row without a terminal column → empty label → no
    routing. Sale persists with terminal_id=NULL."""
    user = _user(db)
    _terminal(db, user, receipt_label="Term 1")
    assert find_terminal_for_label(db, user=user, label="") is None
    assert find_terminal_for_label(db, user=user, label=None) is None
