"""The receipt's MOMS vs the MOMS we file.

Two numbers exist for the same purchase:

  PRINTED — "HERAF MOMS 10,41" on the paper. The OCR reads it and the
    confirm screen has always shown it to the owner, then discarded it.
  DERIVED — what tax_service._calc_vat actually claims: the
    fradrag-weighted base with 25% extracted from it, never looking at
    the paper.

They agree on an ordinary all-25% Danish receipt and come apart on a
mixed-rate one, a zero-rated one, or one from a vendor with no MOMS
registration. When they do, the derived figure is TOO HIGH — the
direction SKAT audits.

These tests pin three things:
  • the printed figure is stored, with SERVER-stamped provenance;
  • a disagreement is found and pointed the right way;
  • the filing basis is NOT changed by any of it.

Run:
  cd backend && python3 -m pytest tests/test_moms_crosscheck.py -q
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
from app.services.moms_crosscheck import (
    TOLERANCE_KR, derived_input_vat, find_conflicts, summarise,
)

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


def _owner(db) -> User:
    u = User(
        email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Café Hygge", business_type="cafe",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _cat(db, user, name="Vareforbrug") -> ExpenseCategory:
    c = ExpenseCategory(user_id=user.id, name=name)
    db.add(c); db.commit(); db.refresh(c)
    return c


# ── storage + provenance ─────────────────────────────────────────────

def test_the_meny_receipt_keeps_its_printed_moms(client, db):
    """The reported receipt: 52,05 total, HERAF MOMS 10,41."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.post("/api/expenses", json={
        "amount": 52.05, "description": "MENY", "date": "2026-07-17",
        "payment_method": "cash", "category_id": str(c.id),
        "vat_amount": 10.41, "vat_rate": 0.25,
    })
    assert r.status_code in (200, 201), r.text
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert float(row.vat_amount) == 10.41
    assert float(row.vat_rate) == 0.25
    assert row.vat_source == "receipt"


def test_no_printed_moms_means_no_provenance(client, db):
    """A row with no receipt figure is UNKNOWN, not 'derived'. Writing a
    provenance we don't have would make the cross-check compare a number
    with itself."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses", json={
        "amount": 52.05, "description": "MENY", "date": "2026-07-17",
        "payment_method": "cash", "category_id": str(c.id),
    })
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert row.vat_amount is None and row.vat_source is None


def test_client_cannot_assert_its_own_provenance(client, db):
    """vat_source is server-stamped. If a client could claim "receipt"
    for a figure it invented, the whole comparison is theatre."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/expenses", json={
        "amount": 100.0, "description": "x", "date": "2026-07-17",
        "payment_method": "card", "category_id": str(c.id),
        "vat_source": "receipt",          # ignored — not a schema field
    })
    assert r.status_code in (200, 201), r.text
    assert db.query(Expense).filter(Expense.user_id == u.id).one().vat_source is None


@pytest.mark.parametrize("bad", [25, 1.5, -0.1, 100])
def test_a_percentage_rate_is_refused(client, db, bad):
    """0.25, never 25. Storing 25 would put a 2500% rate on a bilag."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/expenses", json={
        "amount": 100.0, "description": "x", "date": "2026-07-17",
        "payment_method": "card", "category_id": str(c.id),
        "vat_amount": 20.0, "vat_rate": bad,
    })
    assert r.status_code == 422, r.text


# ── the comparison ───────────────────────────────────────────────────

def test_an_ordinary_danish_receipt_is_not_a_conflict(db):
    """52,05 at 25% derives to exactly the 10,41 the paper prints."""
    u = _owner(db); c = _cat(db, u)
    db.add(Expense(
        user_id=u.id, category_id=c.id, date=date(2026, 7, 17),
        amount=52.05, description="MENY", payment_method="cash",
        vat_amount=10.41, vat_rate=0.25, vat_source="receipt",
    ))
    db.commit()
    assert find_conflicts(db, u.id) == []


def test_a_zero_rated_receipt_shows_we_over_claim(db):
    """The dangerous case: the paper says there is no MOMS, the filing
    claims 25% of it anyway."""
    u = _owner(db); c = _cat(db, u)
    db.add(Expense(
        user_id=u.id, category_id=c.id, date=date(2026, 7, 17),
        amount=500.00, description="Avis-abonnement", payment_method="card",
        vat_amount=0.00, vat_rate=0.00, vat_source="receipt",
    ))
    db.commit()

    conflicts = find_conflicts(db, u.id)
    assert len(conflicts) == 1
    c0 = conflicts[0]
    assert c0.printed_vat == 0.0
    assert c0.derived_vat == 100.0        # 500 * 0.25/1.25
    assert c0.over_claiming is True
    assert c0.difference == -100.0

    s = summarise(conflicts)
    assert s["over_claiming_count"] == 1 and s["over_claimed_kr"] == 100.0
    # Direction is reported separately — a net figure would let an
    # over-claim and an under-claim cancel into a reassuring zero.
    assert s["under_claiming_count"] == 0


def test_a_sub_krone_difference_is_not_a_conflict(db):
    """Rounding noise is not a finding. Tolerance is in KRONER — a
    rate-based one hides a large gap on a large receipt."""
    u = _owner(db); c = _cat(db, u)
    db.add(Expense(
        user_id=u.id, category_id=c.id, date=date(2026, 7, 17),
        amount=52.05, description="MENY", payment_method="cash",
        vat_amount=10.41 + (TOLERANCE_KR / 2), vat_rate=0.25, vat_source="receipt",
    ))
    db.commit()
    assert find_conflicts(db, u.id) == []


def test_rows_without_a_printed_figure_are_not_conflicts(db):
    """Unknown is not disagreement. Reporting unknowns would bury the
    real findings under every typed expense the owner ever made."""
    u = _owner(db); c = _cat(db, u)
    db.add(Expense(
        user_id=u.id, category_id=c.id, date=date(2026, 7, 17),
        amount=500.00, description="typed", payment_method="card",
    ))
    db.commit()
    assert find_conflicts(db, u.id) == []


def test_drafts_are_not_in_any_filing_yet(db):
    u = _owner(db); c = _cat(db, u)
    db.add(Expense(
        user_id=u.id, category_id=c.id, date=date(2026, 7, 17),
        amount=500.00, description="draft", payment_method="card",
        vat_amount=0.00, vat_source="receipt", status="pending",
    ))
    db.commit()
    assert find_conflicts(db, u.id) == []


def test_fradrag_class_is_respected(db):
    """Repræsentation is 0% fradrag, so the filing claims nothing — and
    a printed MOMS on such a receipt is not an over-claim."""
    u = _owner(db)
    rep = _cat(db, u, "Repræsentation & gaver")
    assert derived_input_vat(1000.0, "Repræsentation & gaver") == 0.0
    db.add(Expense(
        user_id=u.id, category_id=rep.id, date=date(2026, 7, 17),
        amount=1000.00, description="gave", payment_method="card",
        vat_amount=200.00, vat_rate=0.25, vat_source="receipt",
    ))
    db.commit()
    conflicts = find_conflicts(db, u.id)
    assert len(conflicts) == 1 and conflicts[0].over_claiming is False


def test_conflicts_never_cross_tenants(db):
    a, b = _owner(db), _owner(db)
    ca = _cat(db, a)
    db.add(Expense(
        user_id=a.id, category_id=ca.id, date=date(2026, 7, 17),
        amount=500.00, description="x", payment_method="card",
        vat_amount=0.00, vat_source="receipt",
    ))
    db.commit()
    assert len(find_conflicts(db, a.id)) == 1
    assert find_conflicts(db, b.id) == []


# ── the invariant: reporting must not change the filing ──────────────

def test_storing_printed_moms_does_not_change_the_filed_figure(db):
    """Switching the filing basis is the owner's and their revisor's
    decision. This slice stores and compares; it must not quietly move
    what gets told to SKAT."""
    from app.services.tax_service import _calc_vat

    u = _owner(db); c = _cat(db, u)
    kw = dict(
        user_id=u.id, category_id=c.id, date=date(2026, 7, 17),
        amount=500.00, description="x", payment_method="card",
    )
    db.add(Expense(**kw)); db.commit()
    before = _calc_vat(db, u.id, date(2026, 7, 1), date(2026, 7, 31), 0.25)["input_vat"]

    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    row.vat_amount, row.vat_rate, row.vat_source = 0.00, 0.00, "receipt"
    db.commit()
    after = _calc_vat(db, u.id, date(2026, 7, 1), date(2026, 7, 31), 0.25)["input_vat"]

    assert before == after, "the filing basis must be unchanged by this slice"


def test_endpoint_reports_without_resolving(client, db):
    u = _owner(db); c = _cat(db, u)
    db.add(Expense(
        user_id=u.id, category_id=c.id, date=date(2026, 7, 17),
        amount=500.00, description="Avis", payment_method="card",
        vat_amount=0.00, vat_rate=0.00, vat_source="receipt",
    ))
    db.commit()
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.get("/api/expenses/moms-conflicts")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1
    assert body["over_claiming_count"] == 1
    assert body["conflicts"][0]["derived_vat"] == 100.0
    # and the row is untouched
    assert float(db.query(Expense).filter(Expense.user_id == u.id).one().vat_amount) == 0.0


# ── Composition: FX (#145) meets stored MOMS (#153) ──────────────────
#
# Each was right alone. Together they stored a EUR VAT figure beside a
# DKK amount, in a column everything downstream reads as DKK — and the
# cross-check then reported a large phantom over-claim.
#
# The fix is not unit conversion. Foreign VAT is not Danish MOMS: German
# MwSt is not købsmoms and is not deducted on a MOMS-angivelse at all,
# it is reclaimed through a separate EU refund. Converting it would fix
# the units and still assert something false.

def test_a_foreign_receipt_stores_no_dk_moms(client, db):
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.post("/api/expenses", json={
        "amount": 746.00,            # account currency (DKK)
        "original_amount": 100.00,   # what the paper says
        "currency": "EUR", "fx_rate": 7.46,
        "description": "Grossist GmbH", "date": "2026-07-20",
        "payment_method": "card", "category_id": str(c.id),
        "vat_amount": 20.00,         # EUR MwSt — must NOT be stored as MOMS
        "vat_rate": 0.19,
    })
    assert r.status_code in (200, 201), r.text

    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert float(row.amount) == 746.00
    assert row.currency == "EUR" and float(row.fx_rate) == 7.46
    assert row.vat_amount is None, "foreign VAT is not Danish MOMS"
    assert row.vat_rate is None
    assert row.vat_source is None


def test_a_foreign_receipt_raises_no_phantom_moms_conflict(client, db):
    """The composed bug's visible symptom: 746 DKK derives ~149 kr of
    købsmoms, and a stored EUR 20 would have read as a 129 kr
    over-claim that does not exist."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses", json={
        "amount": 746.00, "original_amount": 100.00,
        "currency": "EUR", "fx_rate": 7.46,
        "description": "Grossist GmbH", "date": "2026-07-20",
        "payment_method": "card", "category_id": str(c.id),
        "vat_amount": 20.00, "vat_rate": 0.19,
    })
    assert find_conflicts(db, u.id) == []


def test_a_domestic_receipt_still_stores_its_moms(client, db):
    """The guard keys on `currency`, which is NULL for a same-currency
    expense — the DK path must be untouched."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses", json={
        "amount": 52.05, "description": "MENY", "date": "2026-07-17",
        "payment_method": "cash", "category_id": str(c.id),
        "vat_amount": 10.41, "vat_rate": 0.25,
    })
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert float(row.vat_amount) == 10.41 and row.vat_source == "receipt"
