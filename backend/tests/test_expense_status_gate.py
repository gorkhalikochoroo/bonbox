"""Godkend-kø honesty gate — a pending draft must touch NO money total.

The approve-queue creates draft expenses (status='pending'): AI-proposed rows
the owner has not yet approved. These tests pin the keystone invariant — a
pending draft is invisible to the MOMS bill (_calc_vat) and to the Foresight
burn-rate (_get_daily_expense_average) — so an unconfirmed guess can never
understate what the owner owes SKAT or fake a "you're covered". Back-compat:
legacy rows (status NULL) and 'approved' rows still count, byte-identical.

Run:
  cd backend && python3 -m pytest tests/test_expense_status_gate.py -q
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.services.cashflow_service import _get_daily_expense_average
from app.services.expense_status import not_pending
from app.services.tax_service import _calc_vat

PERIOD_START = date(2026, 6, 1)
PERIOD_END = date(2026, 7, 1)
IN_PERIOD = date(2026, 6, 15)


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
    u = User(email="gate@bonbox.test", password_hash="x", business_name="Café", currency="DKK", plan="free")
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def category(db, user):
    c = ExpenseCategory(user_id=user.id, name="Vareforbrug", color="#3B82F6")
    db.add(c); db.commit(); db.refresh(c)
    return c


def _exp(db, user, category, *, amount, status, when=IN_PERIOD):
    e = Expense(user_id=user.id, category_id=category.id, date=when,
                amount=amount, description="x", payment_method="card", status=status)
    db.add(e); db.commit(); db.refresh(e)
    return e


# ── the clause itself ────────────────────────────────────────────────
def test_not_pending_excludes_only_pending(db, user, category):
    _exp(db, user, category, amount=100, status="approved")
    _exp(db, user, category, amount=100, status=None)       # legacy → counts
    _exp(db, user, category, amount=100, status="pending")  # draft → excluded
    visible = db.query(Expense).filter(Expense.user_id == user.id, not_pending()).count()
    assert visible == 2


# ── MOMS / input_vat ─────────────────────────────────────────────────
def test_pending_draft_invisible_to_calc_vat(db, user, category):
    _exp(db, user, category, amount=250.0, status="approved")     # real
    _exp(db, user, category, amount=9999.0, status="pending")     # draft guess
    vat = _calc_vat(db, user.id, PERIOD_START, PERIOD_END, 0.25, prices_include_moms=True)
    # Only the approved 250 is in the base — the 9999 draft must NOT inflate it.
    assert round(vat["expenses_total"], 2) == 250.0
    assert round(vat["input_vat"], 2) == round(250.0 * 0.25 / 1.25, 2)  # 50.00


def test_legacy_null_status_still_counts_in_vat(db, user, category):
    _exp(db, user, category, amount=500.0, status=None)  # pre-migration row
    vat = _calc_vat(db, user.id, PERIOD_START, PERIOD_END, 0.25, prices_include_moms=True)
    assert round(vat["expenses_total"], 2) == 500.0  # byte-identical to before the gate


# ── Foresight burn-rate ──────────────────────────────────────────────
def test_pending_draft_invisible_to_foresight_burnrate(db, user, category):
    recent = date.today() - timedelta(days=5)
    # ONLY a pending draft exists → burn-rate sees no spend at all.
    _exp(db, user, category, amount=99999.0, status="pending", when=recent)
    assert _get_daily_expense_average(user.id, db) == 0.0
    # Add a real approved expense → now it registers.
    _exp(db, user, category, amount=300.0, status="approved", when=recent)
    assert _get_daily_expense_average(user.id, db) > 0.0
