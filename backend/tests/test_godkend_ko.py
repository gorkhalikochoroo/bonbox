"""Godkend-kø approve endpoints (S2) — read pending, approve, bulk-approve.

The queue's contract: drafts are listed separately, a draft only becomes a real
booked expense on an explicit approve (AI proposes, owner approves), a draft
with no beløb can NEVER be approved (never a silent 0-kr posted row), and a
draft burns no bilagsnummer until it's approved (§10 sequence integrity).

Run:
  cd backend && python3 -m pytest tests/test_godkend_ko.py -q
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.routers.expenses import _limiter as _exp_limiter
from app.services.auth import get_current_user

_db_ready.set()
_exp_limiter.enabled = False


@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def db(engine_and_session) -> Iterator:
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, *, name="Café") -> User:
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name=name, business_type="cafe", currency="DKK", plan="free")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _cat(db, user) -> ExpenseCategory:
    c = ExpenseCategory(user_id=user.id, name="Vareforbrug", color="#3B82F6")
    db.add(c); db.commit(); db.refresh(c)
    return c


def _draft(db, user, cat, *, amount, status="pending") -> Expense:
    e = Expense(user_id=user.id, category_id=cat.id, date=date.today(),
                amount=amount, description="Hørkram", payment_method="card", status=status)
    db.add(e); db.commit(); db.refresh(e)
    return e


# ── read ─────────────────────────────────────────────────────────────
def test_pending_endpoint_lists_only_drafts(client, db):
    owner = _owner(db); cat = _cat(db, owner)
    _draft(db, owner, cat, amount=100, status="approved")
    _draft(db, owner, cat, amount=250, status="pending")
    _override_user(owner)
    r = client.get("/api/expenses/pending")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["status"] == "pending"


# ── approve one ───────────────────────────────────────────────────────
def test_approve_promotes_draft_and_no_voucher_until_then(client, db):
    owner = _owner(db); cat = _cat(db, owner)
    d = _draft(db, owner, cat, amount=250.0)
    assert d.voucher_number is None  # a draft burns NO bilagsnummer
    _override_user(owner)

    r = client.post(f"/api/expenses/{d.id}/approve")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"

    db.expire_all()
    row = db.query(Expense).filter(Expense.id == d.id).first()
    assert row.status == "approved"
    # and it has left the queue
    assert client.get("/api/expenses/pending").json() == []


def test_approve_rejects_a_draft_with_no_belob(client, db):
    owner = _owner(db); cat = _cat(db, owner)
    d = _draft(db, owner, cat, amount=0)
    _override_user(owner)
    r = client.post(f"/api/expenses/{d.id}/approve")
    assert r.status_code == 422
    db.expire_all()
    assert db.query(Expense).filter(Expense.id == d.id).first().status == "pending"  # stays in kø


def test_approve_is_idempotent(client, db):
    owner = _owner(db); cat = _cat(db, owner)
    d = _draft(db, owner, cat, amount=99.0, status="approved")
    _override_user(owner)
    r = client.post(f"/api/expenses/{d.id}/approve")
    assert r.status_code == 200
    assert r.json()["status"] == "approved"


def test_approve_cross_tenant_is_404(client, db):
    a = _owner(db, name="A"); b = _owner(db, name="B")
    d = _draft(db, a, _cat(db, a), amount=200.0)
    _override_user(b)
    r = client.post(f"/api/expenses/{d.id}/approve")
    assert r.status_code == 404
    db.expire_all()
    assert db.query(Expense).filter(Expense.id == d.id).first().status == "pending"


# ── bulk approve ──────────────────────────────────────────────────────
def test_approve_batch_skips_belob_less_drafts(client, db):
    owner = _owner(db); cat = _cat(db, owner)
    ok1 = _draft(db, owner, cat, amount=120.0)
    ok2 = _draft(db, owner, cat, amount=340.0)
    bad = _draft(db, owner, cat, amount=0)  # missing beløb
    _override_user(owner)

    r = client.post("/api/expenses/approve-batch",
                    json={"ids": [str(ok1.id), str(ok2.id), str(bad.id)]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 2
    assert str(bad.id) in body["skipped"]

    db.expire_all()
    assert db.query(Expense).filter(Expense.id == bad.id).first().status == "pending"
    assert db.query(Expense).filter(Expense.id == ok1.id).first().status == "approved"
