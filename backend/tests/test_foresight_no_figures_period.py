"""MOMS hero with NO figures for the period must not say "~0 kr." (M, 15 Oct).

THE DEFECT. A quarterly owner on 16 Oct (Q3 over, frist 1 Dec) — or a brand-new
signup — with nothing entered for July–September saw "Forventet MOMS ~0 kr. ·
forfald 1. dec." The MOMS range was 0 / 0 because there was nothing to add up,
and _first_data_day returned None, so the "BonBox only has figures from …"
caveat never fired either. Zero booked was printed as zero owed: it understates
a tax bill.

THE FIX. The payload's `moms.has_data` is False exactly when the account holds
no money data (confirmed close, sale, expense, sent faktura) dated inside the
period so far; the card then says BonBox has no figures for the period and asks
for them. Only asked when the booked MOMS is 0 — data with MOMS proves itself,
so an active owner pays no extra query.

Money doctrine: nothing here changes a figure. `expected`, `realized`, `low`,
`high` are the same numbers as before; the tests below pin them alongside.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — register all models
from app.database import Base
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.services import foresight_payload as fp

AS_OF = date(2026, 10, 16)          # Q3 is over; quarterly frist = 1 Dec


@pytest.fixture
def engine():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng


@pytest.fixture
def db(engine):
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _no_recurring(monkeypatch):
    monkeypatch.setattr(fp, "detect_recurring_outflows", lambda *a, **k: [])


def _owner(db, email="q@bonbox.dk", freq="quarterly"):
    u = User(email=email, password_hash="x", business_name="Kvartal Café",
             business_type="cafe", currency="DKK", tax_filing_frequency=freq)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def test_quarter_with_no_figures_is_flagged_not_zero(db):
    u = _owner(db)
    out = fp.build_foresight_payload(u, db, as_of=AS_OF)
    assert out["available"] is True
    assert out["deadline"]["date"] == "2026-12-01"
    assert out["moms"]["period_start"] == "2026-07-01"
    assert out["moms"]["period_end"] == "2026-09-30"
    assert out["moms"]["has_data"] is False
    # The figures themselves are unchanged — still the honest 0 of nothing.
    assert out["moms"]["expected"] == 0.0
    assert out["moms"]["realized"] == 0.0


def test_established_owner_who_entered_nothing_this_quarter_is_flagged(db):
    """Data BEFORE the period (so no "figures from" caveat), none inside it."""
    u = _owner(db)
    db.add(DailyClose(user_id=u.id, date=date(2026, 6, 20), revenue_total=Decimal("12000"),
                      status="confirmed"))
    db.commit()
    out = fp.build_foresight_payload(u, db, as_of=AS_OF)
    assert out["moms"]["data_from"] is None
    assert out["moms"]["has_data"] is False


@pytest.mark.parametrize("kind", ["close", "sale", "expense"])
def test_any_money_row_in_the_period_counts_as_figures(db, kind):
    u = _owner(db)
    d = date(2026, 8, 3)
    if kind == "close":
        db.add(DailyClose(user_id=u.id, date=d, revenue_total=Decimal("0"), status="confirmed"))
    elif kind == "sale":
        db.add(Sale(user_id=u.id, date=d, amount=0, payment_method="card"))
    else:
        cat = ExpenseCategory(user_id=u.id, name="Varer", color="#999999")
        db.add(cat)
        db.flush()
        db.add(Expense(user_id=u.id, category_id=cat.id, date=d, amount=500,
                       description="Leverandør", payment_method="card"))
    db.commit()
    out = fp.build_foresight_payload(u, db, as_of=AS_OF)
    assert out["moms"]["has_data"] is True


def test_a_draft_close_is_not_a_figure(db):
    """Only CONFIRMED closes feed MOMS; a draft is not figures for the period."""
    u = _owner(db)
    db.add(DailyClose(user_id=u.id, date=date(2026, 8, 3), revenue_total=Decimal("9000"),
                      status="draft"))
    db.commit()
    assert fp.build_foresight_payload(u, db, as_of=AS_OF)["moms"]["has_data"] is False


def test_booked_moms_needs_no_lookup(db, engine, monkeypatch):
    """Realized MOMS > 0 proves data: no extra queries for an active owner."""
    u = _owner(db)
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": 4321})
    called = []
    monkeypatch.setattr(fp, "_period_has_data", lambda *a, **k: called.append(1) or False)
    out = fp.build_foresight_payload(u, db, as_of=AS_OF)
    assert out["moms"]["has_data"] is True
    assert called == []
    assert out["moms"]["realized"] == 4321.0


def test_no_session_or_failure_never_claims_missing_data(monkeypatch):
    """Doubt keeps the old wording: db=None (unit callers) → has_data True."""
    from types import SimpleNamespace
    u = SimpleNamespace(id="u1", currency="DKK", tax_filing_frequency="quarterly",
                        prices_include_moms=True)
    monkeypatch.setattr(fp.tax_service, "_calc_vat", lambda *a, **k: {"vat_payable": 0})
    out = fp.build_foresight_payload(u, db=None, as_of=AS_OF)
    assert out["moms"]["has_data"] is True


def test_other_payload_keys_are_unchanged(db):
    """Only `period_end` and `has_data` are new in `moms`; nothing else moved."""
    u = _owner(db)
    out = fp.build_foresight_payload(u, db, as_of=AS_OF)
    assert set(out["moms"]) == {
        "low", "expected", "high", "confidence", "realized", "projected",
        "period_start", "data_from", "period_end", "has_data",
    }
