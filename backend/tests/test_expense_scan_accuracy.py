"""Receipt-scan → expense: the scan must SAVE, and the payment method
must be READ, not guessed.

Two reported prod bugs:
  1. "scanned but not added" — the scan flow only sent category_id when
     the vendor→category guess hit. `ExpenseCreate.category_id` was
     required, so a miss 422'd and the expense vanished silently.
  2. "paid with cash but shows card" — nothing extracted the payment
     method, and three separate layers defaulted to "card", so cash
     purchases booked as card and quietly broke the owner's cash
     position.

Covers:
  (a) POST /expenses with NO category_id saves, filed under "Andet".
  (b) The "Andet" fallback is get-or-create — two uncategorised scans
      share one category, they don't spawn duplicates.
  (c) A category_id belonging to ANOTHER owner → 404, nothing written.
  (d) A supplied own category is still honoured.
  (e) _detect_payment_method reads Danish receipt wording, and returns
      None (never a guess) when the receipt doesn't say.
  (f) parse_expense_receipt carries payment_method through the
      structured (Mindee/Claude) path, including None when the provider
      couldn't read it.

App-level in-memory SQLite, mirroring tests/test_expense_attach_receipt.py.

Run:
  cd backend && python3 -m pytest tests/test_expense_scan_accuracy.py -q
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
from app.routers.expenses import _limiter as _exp_limiter
from app.services.auth import get_current_user
from app.services.receipt_ocr import _detect_payment_method, parse_expense_receipt

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

    try:
        app.state.limiter.reset()
    except Exception:
        pass

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, *, name="Café Hygge") -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name=name,
        business_type="cafe", currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _scan_payload(**over) -> dict:
    """What ReceiptCapture posts after a scan — note: NO category_id."""
    base = {
        "amount": 247.50,
        "description": "SuperBrugsen",
        "date": date.today().isoformat(),
        "payment_method": "cash",
        "receipt_photo": "uploads/receipts/abc.jpg",
    }
    base.update(over)
    return base


# ── (a) + (b) uncategorised scan saves under "Andet" ─────────────────

def test_scan_without_category_saves_under_andet(client, db):
    user = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.post("/api/expenses", json=_scan_payload())
    assert r.status_code in (200, 201), r.text

    rows = db.query(Expense).filter(Expense.user_id == user.id).all()
    assert len(rows) == 1, "the scanned expense must not be lost"
    cat = db.query(ExpenseCategory).filter(
        ExpenseCategory.id == rows[0].category_id
    ).first()
    assert cat is not None and cat.name == "Andet"
    assert cat.user_id == user.id
    # The scan's own figures survive intact.
    assert float(rows[0].amount) == 247.50
    assert rows[0].payment_method == "cash"
    assert rows[0].receipt_photo == "uploads/receipts/abc.jpg"


def test_andet_fallback_is_get_or_create(client, db):
    user = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: user

    for _ in range(3):
        assert client.post("/api/expenses", json=_scan_payload()).status_code in (200, 201)

    andet = db.query(ExpenseCategory).filter(
        ExpenseCategory.user_id == user.id,
        ExpenseCategory.name == "Andet",
    ).all()
    assert len(andet) == 1, "must reuse one Andet, not spawn a category per scan"


# ── (c) + (d) tenant scope on a supplied category ────────────────────

def test_other_owners_category_is_rejected(client, db):
    mine = _owner(db)
    theirs = _owner(db, name="Anden Café")
    foreign_cat = ExpenseCategory(user_id=theirs.id, name="Deres Råvarer")
    db.add(foreign_cat); db.commit(); db.refresh(foreign_cat)

    app.dependency_overrides[get_current_user] = lambda: mine
    r = client.post(
        "/api/expenses",
        json=_scan_payload(category_id=str(foreign_cat.id)),
    )
    assert r.status_code == 404, r.text
    assert db.query(Expense).filter(Expense.user_id == mine.id).count() == 0


def test_own_category_is_honoured(client, db):
    user = _owner(db)
    cat = ExpenseCategory(user_id=user.id, name="Råvarer")
    db.add(cat); db.commit(); db.refresh(cat)

    app.dependency_overrides[get_current_user] = lambda: user
    r = client.post("/api/expenses", json=_scan_payload(category_id=str(cat.id)))
    assert r.status_code in (200, 201), r.text

    row = db.query(Expense).filter(Expense.user_id == user.id).one()
    assert row.category_id == cat.id
    assert db.query(ExpenseCategory).filter(
        ExpenseCategory.user_id == user.id,
        ExpenseCategory.name == "Andet",
    ).count() == 0, "no Andet should be created when a real category was sent"


# ── (e) payment method is READ, not guessed ──────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("SuperBrugsen\nI alt 247,50\nKontant 250,00\nByttepenge 2,50", "cash"),
    ("Kontantbetaling\nI alt 88,00", "cash"),
    ("Føtex\nTOTAL 189,00\nDANKORT\nGodkendt", "card"),
    ("Metro\nI alt 1.204,00\nKontaktløs Visa", "card"),
    ("Bilka\nI alt 502,00\nMastercard", "card"),
    ("Café\nAt betale 95,00\nMobilePay", "mobilepay"),
    # MobilePay must win over the bare "kort" family, and Dankort must
    # not be read as cash when the receipt also prints a cash-sale line.
    ("MobilePay\nKortbetaling annulleret\nI alt 60,00", "mobilepay"),
    ("Kontantsalg\nDankort\nI alt 120,00", "card"),
])
def test_detect_payment_method_reads_danish_receipts(text, expected):
    assert _detect_payment_method(text) == expected


@pytest.mark.parametrize("text", [
    "",
    "Faktura 4412\nGrossist ApS\nI alt 3.000,00\nMOMS 600,00",
    "Kvittering\n12-06-2026\nTotal 45,00",
])
def test_detect_payment_method_returns_none_rather_than_guessing(text):
    assert _detect_payment_method(text) is None


# ── (f) structured layer carries payment_method through ──────────────

def test_structured_layer_passes_payment_method_through(monkeypatch):
    monkeypatch.setattr(receipt_ocr, "_try_mindee", lambda *a, **k: None)
    monkeypatch.setattr(receipt_ocr, "_try_claude", lambda *a, **k: {
        "vendor": "Føtex", "total": 189.0, "date": "2026-06-12",
        "currency": "DKK", "payment_method": "cash",
        "confidence": {"overall": 0.93, "vendor": 0.9, "date": 0.9, "total": 0.97},
        "_provider": "claude",
    })
    out = parse_expense_receipt("/tmp/does-not-matter.jpg")
    assert out["payment_method"] == "cash"
    assert out["amount"] == 189.0


def test_structured_layer_without_payment_method_stays_none(monkeypatch):
    """Mindee's Receipt v5 doesn't expose payment method. The pipeline must
    surface None so the UI ASKS — never inherit a 'card' default."""
    monkeypatch.setattr(receipt_ocr, "_try_mindee", lambda *a, **k: {
        "vendor": "Grossist", "total": 3000.0, "date": "2026-06-12",
        "currency": "DKK",
        "confidence": {"overall": 0.95, "vendor": 0.9, "date": 0.9, "total": 0.99},
        "_provider": "mindee",
    })
    out = parse_expense_receipt("/tmp/does-not-matter.jpg")
    assert out["payment_method"] is None


# ── The scanned receipt that could not be saved ──────────────────────
#
# Reported from prod with a real MENY receipt: the scan worked, the photo
# and the 52,05 total were on screen, and Save returned "couldn't save".
#
# Cause: storage moved to a private bucket in 2026-05 and now returns a
# 1-year SIGNED URL carrying a JWT. Every one measures 597 chars, and
# ExpenseCreate.cap_receipt_photo_length rejected anything over 500 — a
# limit copied from a VARCHAR(500) that no longer exists (the production
# column is TEXT). So the validator rejected EVERY scanned receipt.
#
# It stayed invisible because a 422 `detail` is a list, not a string, so
# the client's error path fell through to a generic message.

def _signed_url(n: int = 597) -> str:
    """Shaped like the real thing: /object/sign/ + a long ?token= JWT."""
    base = (
        "https://ahlqhztujpeccmaivkhr.supabase.co/storage/v1/object/sign/"
        "receipts/6f2a1c88-1111-2222-3333-444455556666/expense/"
        "0123456789abcdef0123456789abcdef0123456789abcdef.jpg?token="
    )
    return base + "e" * (n - len(base))


def test_scanned_receipt_with_a_signed_url_saves(client, db):
    """The exact prod failure: a 597-char signed URL must not be rejected."""
    user = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: user
    url = _signed_url(597)
    assert len(url) == 597

    r = client.post("/api/expenses", json=_scan_payload(
        amount=52.05, description="MENY", payment_method="cash",
        receipt_photo=url, date="2026-07-17",
    ))
    assert r.status_code in (200, 201), r.text
    row = db.query(Expense).filter(Expense.user_id == user.id).one()
    assert row.receipt_photo == url, "the full signed URL must round-trip intact"
    assert float(row.amount) == 52.05
    assert row.payment_method == "cash"


def test_absurdly_long_receipt_photo_is_still_refused(client, db):
    """Still bounded — this is request input, not trusted storage output."""
    user = _owner(db)
    app.dependency_overrides[get_current_user] = lambda: user
    r = client.post("/api/expenses", json=_scan_payload(receipt_photo="x" * 5000))
    assert r.status_code == 422, r.text
    assert db.query(Expense).filter(Expense.user_id == user.id).count() == 0


def test_kontant_normalises_to_cash():
    """The MENY receipt prints 'KONTANT'. The schema already folds it, and
    it must keep doing so — 'kontant' would never match the cash-sync
    branch, so the drawer would silently not move."""
    from app.schemas.expense import ExpenseCreate
    m = ExpenseCreate(
        amount=52.05, description="MENY", date=date(2026, 7, 17),
        payment_method="Kontant",
    )
    assert m.payment_method == "cash"
