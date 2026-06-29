"""Snap-a-pile burst capture (S3) — POST /expenses/burst-scan → drafts.

The capture hook: shoot N receipts, each lands in the Godkend-kø as a pending
DRAFT with its bilag attached — never a posted row. OCR failure never blocks a
draft (it lands amount-0 'Mangler beløb' for the owner to fix). Non-images are
skipped. Drafts stay out of every money total until approved (the S0 gate).

Run:
  cd backend && python3 -m pytest tests/test_burst_scan.py -q
"""
from __future__ import annotations

import uuid
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.services.receipt_ocr as receipt_ocr
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.expense import Expense
from app.models.user import User
from app.routers.expenses import _limiter as _exp_limiter
from app.services.auth import get_current_user

_db_ready.set()
_exp_limiter.enabled = False

_IMG = b"\xff\xd8\xff\xe0fakejpeg"


@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
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

    monkeypatch.setattr(receipt_ocr, "save_receipt_photo",
                        lambda raw, fn, uid, kind="expense": f"uploads/receipts/{uid}_x.jpg")
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": None, "amount": None, "date": None})
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db) -> User:
    u = User(email=f"b-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Café", business_type="cafe", currency="DKK", plan="free")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _files(n):
    return [("files", (f"r{i}.jpg", _IMG, "image/jpeg")) for i in range(n)]


def test_burst_creates_pending_drafts(client, db):
    owner = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: owner
    r = client.post("/api/expenses/burst-scan", files=_files(3))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 3
    assert body["cap_reached"] is False

    # all three are pending drafts with the bilag attached
    rows = db.query(Expense).filter(Expense.user_id == owner.id).all()
    assert len(rows) == 3
    assert all(e.status == "pending" for e in rows)
    assert all(e.receipt_photo for e in rows)
    assert all(e.receipt_source == "scan" for e in rows)
    # OCR returned nothing → honest amount-0 draft (owner fixes 'Mangler beløb')
    assert all(float(e.amount) == 0 for e in rows)

    # and they show up in the queue, not the posted list
    assert len(client.get("/api/expenses/pending").json()) == 3
    assert client.get("/api/expenses").json() == []


def test_burst_skips_non_images(client, db):
    owner = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: owner
    files = _files(2) + [("files", ("note.txt", b"hi", "text/plain"))]
    r = client.post("/api/expenses/burst-scan", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 2
    assert body["skipped"] == 1


def test_burst_stops_at_free_cap(client, db):
    # Free cap is 10 scans/month — an 12-pile should stop honestly at the cap.
    owner = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: owner
    r = client.post("/api/expenses/burst-scan", files=_files(12))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 10
    assert body["cap_reached"] is True
