"""Pengestrøm may not forecast from a balance nobody entered.

THE DEFECT. The 30-day projection started from the Kassebog total. An owner
who doesn't keep a Kassebog has a total of 0 kr. — which is not a
measurement, it is "we don't know". The projection then subtracted a month of
expenses from nothing and the page raised a red "Cash shortfall predicted …
You'll be 70,006 short" with "RISIKODAGE 30 af 30", while the verdict band on
the same page said "Indtast din banksaldo". Couldn't-check read as at-risk.

THE RULE these tests hold:
  • the start is the Kassebog when it has entries (unchanged), else the bank
    balance the owner typed in, else UNKNOWN (None — never 0);
  • a forecast needs a known start AND a sales history; without it there is
    no lowest point, no risk days and no balance-based alarm at all;
  • alerts carry their numbers in `params`, so the page can say them in
    Danish money format instead of the server's English "70,006";
  • a failed forecast reads as a failure, not as "0 kr.".

  cd backend && pytest tests/test_cashflow_honesty.py -v
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.cashbook import CashTransaction
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.services.cashflow_service import get_cashflow_forecast

BALANCE_ALARMS = {"shortfall", "tight", "expense_cluster", "healthy"}


@pytest.fixture
def db():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def user(db):
    u = User(email="cash@bonbox.test", password_hash="x", business_name="Café", currency="DKK", plan="free")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _sales(db, user, per_day=4000, days=21):
    for i in range(1, days + 1):
        db.add(Sale(user_id=user.id, date=date.today() - timedelta(days=i), amount=per_day))
    db.commit()


def _expenses(db, user, per_day=6000, days=21):
    cat = ExpenseCategory(user_id=user.id, name="Vareforbrug", color="#3B82F6")
    db.add(cat); db.commit(); db.refresh(cat)
    for i in range(1, days + 1):
        db.add(Expense(user_id=user.id, category_id=cat.id, date=date.today() - timedelta(days=i),
                       amount=per_day, description="Varer"))
    db.commit()


def test_no_balance_anywhere_means_no_forecast_and_no_alarm(db, user):
    # Sales AND heavy expenses — the exact shape that used to scream red.
    _sales(db, user)
    _expenses(db, user)

    out = get_cashflow_forecast(user.id, db)

    assert out["current_balance"] is None, "an unknown balance must not read as 0 kr."
    assert out["forecast_ready"] is False
    assert out["lowest_point"] is None and out["danger_days"] is None
    assert out["projection"] == []
    assert not [a for a in out["alerts"] if a["type"] in BALANCE_ALARMS]


def test_the_typed_bank_balance_is_the_start_when_there_is_no_kassebog(db, user):
    _sales(db, user)
    _expenses(db, user, per_day=1000)

    out = get_cashflow_forecast(user.id, db, manual_balance=50_000)

    assert out["balance_source"] == "bank_manual"
    assert out["current_balance"] == 50_000
    assert out["forecast_ready"] is True
    assert out["projection"][0]["balance"] == 50_000
    assert out["lowest_point"] is not None and out["danger_days"] is not None


def test_a_kept_kassebog_still_wins(db, user):
    _sales(db, user)
    db.add(CashTransaction(user_id=user.id, date=date.today(), type="cash_in", amount=12_000,
                           description="Byttepenge"))
    db.commit()

    out = get_cashflow_forecast(user.id, db, manual_balance=99_999)

    assert out["balance_source"] == "cashbook"
    assert out["current_balance"] == 12_000


def test_a_balance_without_sales_history_is_not_a_forecast(db, user):
    _expenses(db, user)

    out = get_cashflow_forecast(user.id, db, manual_balance=10_000)

    assert out["current_balance"] == 10_000          # the balance itself is real
    assert out["forecast_ready"] is False
    assert out["lowest_point"] is None
    assert not [a for a in out["alerts"] if a["type"] in BALANCE_ALARMS]
    assert any(a["type"] == "no_data" for a in out["alerts"])


def test_a_real_shortfall_still_alarms_and_carries_its_numbers(db, user):
    _sales(db, user, per_day=1000)
    _expenses(db, user, per_day=5000)

    out = get_cashflow_forecast(user.id, db, manual_balance=20_000)

    short = next(a for a in out["alerts"] if a["type"] == "shortfall")
    p = short["params"]
    assert p["amount"] < 0 and p["short"] == pytest.approx(-p["amount"])
    assert p["date"] == out["lowest_point"]["date"]
    for a in out["alerts"]:
        assert "params" in a, f"{a['type']} alert has no params for the page to translate"


def test_a_failed_forecast_reads_as_a_failure(monkeypatch):
    import app.routers.cashflow as r
    empty = r._safe_empty()
    assert empty["_error"]
    assert empty["current_balance"] is None
    assert empty["projection"] == [] and empty["lowest_point"] is None
