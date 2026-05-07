"""Tests for receipt_photo round-trip on Sale + Expense.

Backlog item #2 — receipt review UI. The frontend's <ReceiptViewer>
opens from a list-row chip when the row carries `receipt_photo`.
For that to work end-to-end the field must:

  1. Be persistable on the model (Sale already had it; Expense
     model didn't expose the column even though the migration in
     main.py created it via IF NOT EXISTS).
  2. Be acceptable on ExpenseCreate input (was missing — receipts
     scanned via Snap Receipt would land but lose the photo URL).
  3. Be returned on the response schemas (SaleResponse and
     ExpenseResponse) so the list endpoints surface it to the UI.

These tests pin all three layers so the contract can't silently regress.
"""
from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.schemas.expense import ExpenseCreate, ExpenseResponse
from app.schemas.sale import SaleResponse


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


@pytest.fixture
def user(db):
    u = User(
        email="receipt-test@bonbox.test",
        password_hash="x",
        business_name="Receipt Test",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def category(db, user):
    c = ExpenseCategory(user_id=user.id, name="Råvarer", color="#3B82F6")
    db.add(c); db.commit(); db.refresh(c)
    return c


# ─── Schema acceptance ────────────────────────────────────────────────


def test_expense_create_accepts_receipt_photo():
    """ExpenseCreate must accept a receipt_photo string. Without this,
    /expenses POSTs from the Snap-Receipt flow would 422 the moment
    we started passing the OCR'd path through."""
    payload = ExpenseCreate(
        category_id=uuid.uuid4(),
        date=date.today(),
        amount=42.50,
        description="Receipt scan",
        receipt_photo="https://supabase.example/receipts/u1/abc.jpg",
    )
    assert payload.receipt_photo == "https://supabase.example/receipts/u1/abc.jpg"


def test_expense_create_normalises_empty_string_to_none():
    """A frontend that's defensive ('|| ""' fallback) should not
    accidentally write an empty string to the column. The validator
    converts "" → None so the row gets a clean NULL."""
    payload = ExpenseCreate(
        category_id=uuid.uuid4(),
        date=date.today(),
        amount=42.50,
        description="x",
        receipt_photo="",
    )
    assert payload.receipt_photo is None


def test_expense_create_rejects_oversize_receipt_photo():
    """DB column is VARCHAR(500). Reject obviously too-long input
    rather than letting Postgres cut the URL off mid-string at insert."""
    too_long = "https://example.com/" + ("x" * 500)
    with pytest.raises(ValueError):
        ExpenseCreate(
            category_id=uuid.uuid4(),
            date=date.today(),
            amount=42.50,
            description="x",
            receipt_photo=too_long,
        )


def test_expense_create_omitted_receipt_photo_defaults_to_none():
    """Manually-typed expenses (no Snap Receipt) MUST still work —
    receipt_photo is optional and defaults to None."""
    payload = ExpenseCreate(
        category_id=uuid.uuid4(),
        date=date.today(),
        amount=42.50,
        description="Manual entry, no receipt",
    )
    assert payload.receipt_photo is None


# ─── Model + DB round-trip ────────────────────────────────────────────


def test_expense_round_trips_receipt_photo_through_db(db, user, category):
    """Persist an expense with receipt_photo, re-fetch, confirm value
    survived. Catches a regression where someone removes the Mapped
    field from the Expense model thinking it's unused."""
    photo_url = "https://supabase.example/receipts/u1/expense_abc.jpg"
    e = Expense(
        user_id=user.id,
        category_id=category.id,
        date=date.today(),
        amount=199.50,
        description="Snap Receipt — råvarer",
        payment_method="card",
        receipt_photo=photo_url,
    )
    db.add(e); db.commit(); db.refresh(e)

    fetched = db.query(Expense).filter(Expense.id == e.id).first()
    assert fetched is not None
    assert fetched.receipt_photo == photo_url


def test_expense_response_serialises_receipt_photo(db, user, category):
    """ExpenseResponse.from_attributes(expense) must include
    receipt_photo so the /expenses GET listing surfaces the URL to
    the Sales/Expenses page UI. Without this the frontend chip would
    never render."""
    photo_url = "https://supabase.example/receipts/u1/abc.jpg"
    e = Expense(
        user_id=user.id,
        category_id=category.id,
        date=date.today(),
        amount=88.00,
        description="x",
        receipt_photo=photo_url,
    )
    db.add(e); db.commit(); db.refresh(e)
    response = ExpenseResponse.model_validate(e)
    assert response.receipt_photo == photo_url


def test_expense_response_handles_null_receipt_photo(db, user, category):
    """Receipt-less expenses must serialize cleanly with
    receipt_photo=None — not raise on missing attribute, not coerce
    to empty string (which would make `if exp.receipt_photo` truthy
    in the frontend chip-render condition and show an empty modal)."""
    e = Expense(
        user_id=user.id,
        category_id=category.id,
        date=date.today(),
        amount=12.00,
        description="No receipt",
    )
    db.add(e); db.commit(); db.refresh(e)
    response = ExpenseResponse.model_validate(e)
    assert response.receipt_photo is None


# ─── Sale schema response ──────────────────────────────────────────────
#
# Sale.receipt_photo has existed for months but SaleResponse never
# exposed it — the listing endpoint stripped it from the payload before
# the frontend could render a chip. This test pins the fix.


def test_sale_response_serialises_receipt_photo(db, user):
    """SaleResponse must include receipt_photo when the sale row carries
    one. Catches a regression where someone removes the field from the
    response schema."""
    photo_url = "https://supabase.example/receipts/u1/sale_xyz.jpg"
    s = Sale(
        user_id=user.id,
        date=date.today(),
        amount=275.00,
        payment_method="card",
        receipt_photo=photo_url,
    )
    db.add(s); db.commit(); db.refresh(s)
    response = SaleResponse.model_validate(s)
    assert response.receipt_photo == photo_url


def test_sale_response_handles_null_receipt_photo(db, user):
    """Sales logged manually (Quick Sale, repeat-yesterday, etc.) won't
    have a photo. Response must serialise None cleanly, not raise."""
    s = Sale(
        user_id=user.id,
        date=date.today(),
        amount=100.00,
        payment_method="cash",
    )
    db.add(s); db.commit(); db.refresh(s)
    response = SaleResponse.model_validate(s)
    assert response.receipt_photo is None
