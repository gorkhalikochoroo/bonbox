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

    monkeypatch.setattr(receipt_ocr, "save_receipt_photo_ex",
                        lambda raw, fn, uid, kind="expense": (
                            f"uploads/receipts/{uid}_x.jpg",
                            f"uploads/receipts/{uid}_x.jpg",
                        ))
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


# ── The pile must not guess how a receipt was paid ────────────────────
#
# burst_scan hardcoded payment_method="card". A pile of cash purchases
# therefore booked as card, and sync_cash_out_for_expense — which only
# fires on payment_method == "cash" — never ran. Cash left the drawer and
# the books never saw it, so kassebeholdning drifted up by the amount of
# every cash receipt ever scanned in a pile.
#
# The single-scan path has refused to guess this since #139. These pin
# the pile to the same rule.

def test_burst_draft_has_no_method_when_the_receipt_is_silent(client, db, monkeypatch):
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": None})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/expenses/burst-scan", files=_files(2))
    assert r.status_code == 200, r.text
    drafts = db.query(Expense).filter(Expense.user_id == u.id).all()
    assert len(drafts) == 2
    assert all(d.payment_method is None for d in drafts), \
        "an unread payment method must stay unknown, not become 'card'"


def test_burst_draft_keeps_the_method_the_receipt_printed(client, db, monkeypatch):
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": "cash"})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    assert client.post("/api/expenses/burst-scan", files=_files(1)).status_code == 200
    assert db.query(Expense).filter(Expense.user_id == u.id).one().payment_method == "cash"


def test_draft_without_a_method_cannot_be_approved(client, db, monkeypatch):
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": None})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses/burst-scan", files=_files(1))
    d = db.query(Expense).filter(Expense.user_id == u.id).one()

    r = client.post(f"/api/expenses/{d.id}/approve")
    assert r.status_code == 422, r.text
    assert "betalingsmåde" in r.json()["detail"]
    db.refresh(d)
    assert d.status == "pending", "a refused approval must not book the row"


def test_approve_batch_skips_methodless_drafts_and_says_so(client, db, monkeypatch):
    """'Godkend alle' silently doing less than its count implies is how an
    owner ends up believing a receipt was booked when it wasn't."""
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": None})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses/burst-scan", files=_files(3))
    rows = db.query(Expense).filter(Expense.user_id == u.id).all()
    # Answer one of them, leave two unanswered.
    rows[0].payment_method = "cash"
    db.commit()

    r = client.post("/api/expenses/approve-batch",
                    json={"ids": [str(x.id) for x in rows]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1
    assert len(body["skipped_no_method"]) == 2
    assert body["skipped_no_amount"] == []


def test_approved_cash_draft_actually_reaches_the_drawer(client, db, monkeypatch):
    """The invariant the whole fix exists for: a cash purchase must move
    kassebeholdning. Booked as 'card' it silently never did."""
    from app.models.cashbook import CashTransaction
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": "cash"})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses/burst-scan", files=_files(1))
    d = db.query(Expense).filter(Expense.user_id == u.id).one()

    assert client.post(f"/api/expenses/{d.id}/approve").status_code == 200
    cash = db.query(CashTransaction).filter(
        CashTransaction.user_id == u.id,
        CashTransaction.reference_id == f"expense_{d.id}",
    ).all()
    assert len(cash) == 1, "an approved cash expense must post a cash-out"
    assert float(cash[0].amount) == 120.0


# ── Phase 2: the pile joins per-vendor memory ────────────────────────
#
# Drafts previously carried no vendor_key at all, so the pile neither
# read the owner's habits nor taught them: a correction made on a draft
# went nowhere, and a supplier confirmed ten times through the pile
# still arrived blank on the eleventh.
#
# The honesty hinge is `kind`. One Godkend on one draft is the owner
# agreeing. One tap on "Godkend alle 8" is NOT eight agreements — if it
# minted evidence, auto-fill would validate itself: memory fills a
# draft, the sweep approves it unread, that mints a streak, and memory
# fills more confidently next time, all without a human ever looking.

from app.models.vendor_profile import VendorProfile
from app.services.vendor_identity import canonical_vendor_key
from app.services.vendor_memory import record_signal


def _mem(db, user, key, field, value):
    return db.query(VendorProfile).filter(
        VendorProfile.user_id == user.id, VendorProfile.vendor_key == key,
        VendorProfile.field == field, VendorProfile.value == value,
    ).first()


def test_burst_draft_carries_the_vendor_key(client, db, monkeypatch):
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "NETTO 1284 LYNGBY", "amount": 120.0,
                                      "date": None, "payment_method": "cash"})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses/burst-scan", files=_files(1))
    d = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert d.vendor_key == canonical_vendor_key("NETTO 1284 LYNGBY")


def test_prefill_memory_fills_a_draft_when_the_receipt_is_silent(client, db, monkeypatch):
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": None})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    for _ in range(3):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()

    client.post("/api/expenses/burst-scan", files=_files(1))
    assert db.query(Expense).filter(Expense.user_id == u.id).one().payment_method == "card"


def test_paper_still_beats_memory_on_the_pile(client, db, monkeypatch):
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": "cash"})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    for _ in range(9):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()

    client.post("/api/expenses/burst-scan", files=_files(1))
    assert db.query(Expense).filter(Expense.user_id == u.id).one().payment_method == "cash", \
        "the receipt said Kontant — memory must not overrule it"


def test_a_two_sighting_hunch_does_not_fill_a_draft(client, db, monkeypatch):
    """Only PREFILL (3+ clean agreements) may fill a row that a sweep
    could later approve without anyone reading it."""
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": None})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    for _ in range(2):
        record_signal(db, u.id, "netto", "payment_method", "card", kind="confirm")
    db.commit()

    client.post("/api/expenses/burst-scan", files=_files(1))
    assert db.query(Expense).filter(Expense.user_id == u.id).one().payment_method is None


def test_single_godkend_teaches_the_vendor(client, db, monkeypatch):
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": "cash"})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses/burst-scan", files=_files(1))
    d = db.query(Expense).filter(Expense.user_id == u.id).one()

    assert client.post(f"/api/expenses/{d.id}/approve").status_code == 200
    row = _mem(db, u, "netto", "payment_method", "cash")
    assert row is not None and row.agree_count == 1


def test_godkend_alle_mints_no_evidence(client, db, monkeypatch):
    """THE INVARIANT. One tap must not become N agreements, or the loop
    validates itself and nobody ever looked."""
    monkeypatch.setattr(receipt_ocr, "parse_expense_receipt",
                        lambda path: {"vendor": "Netto", "amount": 120.0,
                                      "date": None, "payment_method": "cash"})
    u = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses/burst-scan", files=_files(4))
    rows = db.query(Expense).filter(Expense.user_id == u.id).all()
    assert len(rows) == 4

    r = client.post("/api/expenses/approve-batch",
                    json={"ids": [str(x.id) for x in rows]})
    assert r.status_code == 200 and r.json()["count"] == 4
    assert _mem(db, u, "netto", "payment_method", "cash") is None, \
        "a sweep the owner never read must mint zero evidence"
    # ...and the rows really were booked. expire_all first: the endpoint
    # committed on its own session, so this session's identity map still
    # holds the pre-approval instances.
    db.expire_all()
    assert all(db.query(Expense).filter(Expense.id == x.id).one().status == "approved"
               for x in rows)
