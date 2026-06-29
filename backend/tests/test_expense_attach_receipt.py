"""Per-row "snap to attach a bilag" — POST /expenses/{id}/attach-receipt.

Backs the one-tap Mangler-bilag loop: the owner already typed the amount +
category, they just staple the legal receipt so the MOMS-fradrag is defensible
under Bogføringsloven. The endpoint STORES the image + links it — it runs NO
OCR and must NOT consume an `expense_receipt_scans` credit.

Covers:
  (a) attach sets receipt_photo + receipt_source='attach', returns the row.
  (b) the INVARIANT — an attach is excluded from the monthly scan meter, so
      a Free owner (cap=10) attaching evidence never burns OCR scans; a real
      scan-created row (receipt_source NULL) still counts.
  (c) tenant scope — another owner's expense → 404, no mutation.
  (d) bounds — a non-image upload → 400.

App-level in-memory SQLite, mirroring tests/test_gavekort_orders.py.

Run:
  cd backend && python3 -m pytest tests/test_expense_attach_receipt.py -q
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

import app.services.receipt_ocr as receipt_ocr
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.routers.expenses import _limiter as _exp_limiter, _count_receipt_scans_this_month
from app.services.auth import get_current_user

_db_ready.set()
# All TestClient requests share one "testclient" IP — disable the per-IP
# attach limiter so it doesn't bleed across tests.
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
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    # Skip real PIL.verify + filesystem write — we only need a stored path.
    monkeypatch.setattr(
        receipt_ocr,
        "save_receipt_photo",
        lambda raw, filename, user_id, kind="expense": f"uploads/receipts/{user_id}_attached.jpg",
    )
    try:
        app.state.limiter.reset()
    except Exception:
        pass

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, *, name="Café Hygge") -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name=name,
        business_type="cafe", currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _expense(db, user, *, receipt=None, source=None, when=None) -> Expense:
    cat = ExpenseCategory(user_id=user.id, name="Råvarer", color="#3B82F6")
    db.add(cat); db.commit(); db.refresh(cat)
    e = Expense(
        user_id=user.id, category_id=cat.id,
        date=when or date.today(), amount=199.50,
        description="Frugt & grønt", payment_method="card",
        receipt_photo=receipt, receipt_source=source,
    )
    db.add(e); db.commit(); db.refresh(e)
    return e


_IMG = ("bilag.jpg", b"\xff\xd8\xff\xe0fake", "image/jpeg")


# ── (a) attach sets receipt_photo + source, returns row ──────────────
def test_attach_sets_receipt_photo_and_source(client, db):
    owner = _owner(db)
    exp = _expense(db, owner)            # no receipt yet
    assert exp.receipt_photo is None
    _override_user(owner)

    r = client.post(f"/api/expenses/{exp.id}/attach-receipt", files={"file": _IMG})
    assert r.status_code == 200, r.text
    assert r.json()["receipt_photo"].endswith("_attached.jpg")

    db.expire_all()
    row = db.query(Expense).filter(Expense.id == exp.id).first()
    assert row.receipt_photo is not None
    assert row.receipt_source == "attach"


# ── (b) THE INVARIANT — attach never burns a scan credit ─────────────
def test_attach_excluded_from_scan_meter(client, db):
    owner = _owner(db)
    # A real OCR scan-created row this month → counts toward the cap.
    _expense(db, owner, receipt="uploads/receipts/scan.jpg", source=None)
    assert _count_receipt_scans_this_month(db, owner.id) == 1

    # Attaching a bilag to a typed row must NOT bump the meter.
    typed = _expense(db, owner)
    _override_user(owner)
    r = client.post(f"/api/expenses/{typed.id}/attach-receipt", files={"file": _IMG})
    assert r.status_code == 200, r.text

    db.expire_all()
    assert _count_receipt_scans_this_month(db, owner.id) == 1  # still 1, not 2


# ── (c) tenant scope — cross-owner attach → 404, no mutation ─────────
def test_attach_cross_tenant_is_404(client, db):
    owner_a = _owner(db, name="A")
    owner_b = _owner(db, name="B")
    exp = _expense(db, owner_a)
    _override_user(owner_b)

    r = client.post(f"/api/expenses/{exp.id}/attach-receipt", files={"file": _IMG})
    assert r.status_code == 404

    db.expire_all()
    assert db.query(Expense).filter(Expense.id == exp.id).first().receipt_photo is None


# ── (d) bounds — non-image rejected ──────────────────────────────────
def test_attach_rejects_non_image(client, db):
    owner = _owner(db)
    exp = _expense(db, owner)
    _override_user(owner)

    r = client.post(
        f"/api/expenses/{exp.id}/attach-receipt",
        files={"file": ("note.txt", b"not an image", "text/plain")},
    )
    assert r.status_code == 400
