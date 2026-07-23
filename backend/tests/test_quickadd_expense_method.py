"""POST /expenses must not invent a payment method.

The bug these pin, in the owner's terms: they tap "+", type 400 kr, "Frugt
hos Netto", pay the greengrocer in cash out of the till — and the books say
card. QuickAdd's expense tab had no method picker, so the POST omitted
payment_method entirely and ExpenseCreate's `= "card"` default filled one in.
sync_cash_out_for_expense only fires on payment_method == "cash", so that
cash never left the drawer in the books and kassebeholdning drifted upward by
the amount of every cash purchase ever quick-added.

Same class of bug as the single scan (#139) and the pile (#146). Those two
paths already refuse to guess; this pins the typed path to the same rule and
moves the refusal down into the schema so no future caller can re-open it:
an unsent method stays NULL, and NULL is honest.

Mirrors the payment-method block of tests/test_burst_scan.py.

Run:
  cd backend && python3 -m pytest tests/test_quickadd_expense_method.py -q
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
from app.models.cashbook import CashTransaction
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.models.vendor_profile import VendorProfile
from app.routers.expenses import _limiter as _exp_limiter
from app.schemas.expense import ExpenseCreate
from app.services.auth import get_current_user

_db_ready.set()
_exp_limiter.enabled = False


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
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db) -> User:
    u = User(email=f"q-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Café", business_type="cafe", currency="DKK", plan="free")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _category(db, user) -> ExpenseCategory:
    c = ExpenseCategory(user_id=user.id, name="Vareforbrug", color="#3B82F6")
    db.add(c); db.commit(); db.refresh(c)
    return c


def _payload(cat, **over):
    body = {
        "category_id": str(cat.id),
        "date": date.today().isoformat(),
        "amount": 400.0,
        "description": "Frugt hos Netto",
        "is_recurring": False,
    }
    body.update(over)
    return body


def _cash_rows(db, user, expense):
    return (
        db.query(CashTransaction)
        .filter(
            CashTransaction.user_id == user.id,
            CashTransaction.reference_id == f"expense_{expense.id}",
        )
        .all()
    )


# ── The schema must not answer a question nobody was asked ────────────

def test_schema_leaves_an_unsent_method_unknown():
    """ExpenseCreate used to default to "card". A method nobody chose is not
    data — the only honest value is None."""
    parsed = ExpenseCreate(
        category_id=uuid.uuid4(), date=date.today(), amount=400.0,
        description="Frugt hos Netto",
    )
    assert parsed.payment_method is None, \
        "an unsent payment method must stay unknown, not become 'card'"
    assert "payment_method" not in parsed.model_fields_set


def test_schema_still_normalises_kontant():
    parsed = ExpenseCreate(
        category_id=uuid.uuid4(), date=date.today(), amount=400.0,
        description="x", payment_method="Kontant",
    )
    assert parsed.payment_method == "cash"


# ── …and neither must the POST ────────────────────────────────────────

def test_expense_posted_without_a_method_stores_null(client, db):
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.post("/api/expenses", json=_payload(cat))
    assert r.status_code == 201, r.text
    assert r.json()["payment_method"] is None

    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert row.payment_method is None, \
        "a quick-added expense with no method must not be booked as card"


def test_methodless_expense_posts_nothing_to_the_drawer(client, db):
    """The silent half of the bug: booked as 'card', a cash purchase never
    reached the kassekladde. NULL must not sneak one in the other way."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    client.post("/api/expenses", json=_payload(cat))
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert _cash_rows(db, u, row) == []


def test_cash_expense_actually_reaches_the_drawer(client, db):
    """The invariant the whole fix exists for: a cash purchase must move
    kassebeholdning. Booked as 'card' it silently never did."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.post("/api/expenses", json=_payload(cat, payment_method="cash"))
    assert r.status_code == 201, r.text
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert row.payment_method == "cash"

    cash = _cash_rows(db, u, row)
    assert len(cash) == 1, "a cash expense must post a cash-out"
    assert float(cash[0].amount) == 400.0


def test_card_expense_leaves_the_drawer_alone(client, db):
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    client.post("/api/expenses", json=_payload(cat, payment_method="card"))
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert _cash_rows(db, u, row) == []


def test_kontant_from_the_client_reaches_the_drawer(client, db):
    """The Danish spelling normalises to "cash" — and must therefore also
    trigger the cash-out, not just store a prettier string."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    client.post("/api/expenses", json=_payload(cat, payment_method="kontant"))
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert row.payment_method == "cash"
    assert len(_cash_rows(db, u, row)) == 1


# ── Personal entries: offered, not required, never fabricated ─────────

def test_personal_entry_without_a_method_stores_null(client, db):
    """QuickAdd's personal tabs hardcoded payment_method:"cash" with no UI.
    Personal rows skip the cashbook sync, so this never moved the drawer —
    but it still wrote a choice nobody made into a column the personal
    ledger displays."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    r = client.post("/api/expenses", json=_payload(cat, is_personal=True))
    assert r.status_code == 201, r.text
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert row.payment_method is None
    assert row.is_personal is True


def test_personal_cash_entry_still_skips_the_business_drawer(client, db):
    """Now that the personal tabs can send "cash", pin the gate that keeps a
    private grocery run out of the business kassekladde."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    client.post("/api/expenses", json=_payload(cat, is_personal=True, payment_method="cash"))
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    assert row.payment_method == "cash"
    assert _cash_rows(db, u, row) == [], \
        "a personal cash entry must not post to the business cashbook"


# ── An unsent method is not evidence either ───────────────────────────

def _method_profiles(db, user):
    return (
        db.query(VendorProfile)
        .filter(VendorProfile.user_id == user.id, VendorProfile.field == "payment_method")
        .all()
    )


def test_unsent_method_is_never_learned(client, db):
    """Guarded by `"payment_method" in data.model_fields_set`. Learning a
    schema default is how the app ends up saying "kort — som de sidste 3
    gange hos Netto" about a choice the owner never made."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    for _ in range(3):
        client.post("/api/expenses", json=_payload(cat, vendor_hint="Netto"))

    assert _method_profiles(db, u) == [], \
        "a method the client never sent must mint no vendor evidence"


def test_a_chosen_method_is_learned(client, db):
    """The other half — an ASSERTED method is exactly what memory is for."""
    u = _owner(db)
    cat = _category(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    client.post("/api/expenses", json=_payload(cat, vendor_hint="Netto", payment_method="cash"))

    rows = _method_profiles(db, u)
    assert len(rows) == 1
    assert rows[0].value == "cash"
