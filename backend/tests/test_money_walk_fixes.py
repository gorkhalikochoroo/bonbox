"""Stock + Money walk (12 Oct 2026) — backend fixes.

  P0  The MOMS forecast spread booked MOMS over every day since the period
      started, even days before the account had data: an owner who joined
      on 11 Sep was told to set aside ~50 % of what they will owe.
  P1  Pengestrøm said "not enough sales data" when the bank balance was the
      thing missing.

  cd backend && DATABASE_URL=sqlite:///<scratch> python3 -m pytest tests/test_money_walk_fixes.py -q
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — register all models
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services import foresight_payload as fp
from app.services.cashflow_service import get_cashflow_forecast

_db_ready.set()


@pytest.fixture
def db():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng, autoflush=False, autocommit=False)()

    def _get():
        yield s
    app.dependency_overrides[get_db] = _get
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.clear()


def _owner(db, **k):
    u = User(email=k.pop("email", "owner@walk.dk"), password_hash="x",
             business_name="Restaurant Nord", business_type="restaurant",
             currency="DKK", tax_filing_frequency="half_yearly", **k)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _closes(db, user, first: date, last: date, revenue=20000):
    d = first
    while d <= last:
        db.add(DailyClose(user_id=user.id, date=d, revenue_total=Decimal(str(revenue)),
                          status="confirmed"))
        d += timedelta(days=1)
    db.commit()


# ═════════════════════════════════════════════════════════════════════
# P0 — MOMS forecast: run-rate per day OF DATA
# ═════════════════════════════════════════════════════════════════════
def test_moms_forecast_uses_days_with_data_not_days_since_period_start(db, monkeypatch):
    u = _owner(db)
    _closes(db, u, date(2026, 9, 11), date(2026, 10, 9))      # 29 days of closes
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": 116924})
    realized, projected = fp._moms_range_split(
        u, db, date(2026, 7, 1), date(2026, 12, 31), date(2026, 10, 11))
    # 1 Jul → 11 Oct is 103 days, but data only from 11 Sep: 31 days.
    # Remaining 12 Oct → 31 Dec = 81 days.
    assert realized == Decimal("116924")
    assert projected == Decimal("116924") * 81 / 31            # was × 81 / 103
    # A full-period account is unchanged.
    u2 = _owner(db, email="old@walk.dk")
    _closes(db, u2, date(2026, 7, 1), date(2026, 7, 1))
    _r, p2 = fp._moms_range_split(u2, db, date(2026, 7, 1), date(2026, 12, 31), date(2026, 10, 11))
    assert p2 == Decimal("116924") * 81 / 103


def test_payload_says_from_when_the_numbers_start(db, monkeypatch):
    u = _owner(db)
    _closes(db, u, date(2026, 9, 11), date(2026, 10, 9))
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": 116924})
    monkeypatch.setattr(fp, "detect_recurring_outflows", lambda *a, **k: [])
    out = fp.build_foresight_payload(u, db, as_of=date(2026, 10, 11))
    assert out["moms"]["data_from"] == "2026-09-11"
    assert out["moms"]["period_start"] == "2026-07-01"


def test_payload_has_no_caveat_when_data_covers_the_period(db, monkeypatch):
    u = _owner(db)
    _closes(db, u, date(2026, 7, 1), date(2026, 7, 2))
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": 1000})
    monkeypatch.setattr(fp, "detect_recurring_outflows", lambda *a, **k: [])
    out = fp.build_foresight_payload(u, db, as_of=date(2026, 10, 11))
    assert out["moms"]["data_from"] is None


# ═════════════════════════════════════════════════════════════════════
# P1 — Pengestrøm: missing balance ≠ missing sales
# ═════════════════════════════════════════════════════════════════════
def test_cashflow_without_balance_does_not_claim_missing_sales(db):
    u = _owner(db)
    _closes(db, u, date.today() - timedelta(days=27), date.today() - timedelta(days=1))
    out = get_cashflow_forecast(u.id, db)
    assert out["forecast_ready"] is False                # no balance → no forecast
    assert not [a for a in out["alerts"] if a["type"] == "no_data"]
