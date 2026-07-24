"""A replayed expense create must not book the cost twice.

MEASURED IN PRODUCTION: 5 collision groups in 253 expenses — all typed
rows (receipt_photo NULL), four of five created 6, 23, 90 and 143
seconds apart. Two live mechanisms produced that:

  1. The axios interceptor replayed POSTs whose response never arrived
     (dropped socket, or our own 60s timeout) at 2s / 6s / 14s / 26s
     cumulative backoff — the 6-second pair is that backoff exactly.
  2. The typed forms had no in-flight lock, so a second tap during a
     slow save posted again.

Both send a byte-identical payload seconds apart. That is one intent
delivered twice, and collapsing it is provably correct — unlike
"these two expenses look similar", which is a guess.

THE FAILURE MODE THESE TESTS EXIST TO PREVENT
An adversarial review of five independent designs killed all five on the
same flaw: an idempotency key that is matched WITHOUT comparing the
payload. If the key outlives one submit — and on an always-mounted form
that clears and stays open, it does — the owner's NEXT, DIFFERENT
expense reuses it, the server returns the OLD row, and a real expense
plus its §42 fradrag is destroyed while the UI shows success. That is
worse than the bug being fixed.

Hashing the CONTENT makes it impossible by construction, and the tests
below pin exactly that: anything the owner could have changed produces a
different fingerprint and therefore a new row.

Run:
  cd backend && python3 -m pytest tests/test_expense_replay_guard.py -q
"""
from __future__ import annotations

import uuid
from pathlib import Path
from datetime import date, timedelta
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
from app.services.expense_dedup import REPLAY_WINDOW_SECONDS, fingerprint
from app.utils.time import utc_now

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


def _payload(cat, **over) -> dict:
    base = {
        "amount": 5000.00, "description": "Utilities",
        "date": date.today().isoformat(), "payment_method": "card",
        "category_id": str(cat.id),
    }
    base.update(over)
    return base


def _count(db, user) -> int:
    return db.query(Expense).filter(Expense.user_id == user.id).count()


# ── the measured bug ─────────────────────────────────────────────────

def test_replayed_post_books_the_cost_once(client, db):
    """The production case: Utilities 5.000,00 posted twice, 6s apart."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    r1 = client.post("/api/expenses", json=_payload(c))
    r2 = client.post("/api/expenses", json=_payload(c))
    assert r1.status_code in (200, 201) and r2.status_code in (200, 201), r2.text

    assert _count(db, u) == 1, "a replay must not book 5.000 kr twice"
    assert r1.json()["id"] == r2.json()["id"], "the replay returns the original row"


def test_four_replays_still_book_once(client, db):
    """The interceptor retried up to 4 times."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u
    ids = {client.post("/api/expenses", json=_payload(c)).json()["id"] for _ in range(5)}
    assert _count(db, u) == 1
    assert len(ids) == 1, "every replay collapses onto the same original"


# ── THE FAILURE MODE THE REVIEW KILLED FIVE DESIGNS OVER ─────────────

@pytest.mark.parametrize("field,value", [
    ("amount", 5000.01),
    ("description", "Utilities (anden regning)"),
    ("date", (date.today() - timedelta(days=1)).isoformat()),
    ("payment_method", "cash"),
])
def test_any_difference_makes_a_new_expense(client, db, field, value):
    """A DIFFERENT expense must never be swallowed by the guard.

    Losing a real expense — and its §42 fradrag — while showing the
    owner a success is strictly worse than the duplicate this guard
    exists to prevent.
    """
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    client.post("/api/expenses", json=_payload(c))
    r2 = client.post("/api/expenses", json=_payload(c, **{field: value}))
    assert r2.status_code in (200, 201), r2.text
    assert _count(db, u) == 2, f"changing {field} must produce a real second row"


def test_a_different_category_is_a_different_expense(client, db):
    u = _owner(db)
    c1, c2 = _cat(db, u, "Vareforbrug"), _cat(db, u, "Emballage")
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses", json=_payload(c1))
    client.post("/api/expenses", json=_payload(c1, category_id=str(c2.id)))
    assert _count(db, u) == 2


# ── the owner always wins ────────────────────────────────────────────

def test_allow_duplicate_forces_a_genuine_repeat_through(client, db):
    """A café really can buy the same thing twice in two minutes. The
    guard is a convenience, never a wall."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    client.post("/api/expenses", json=_payload(c))
    r2 = client.post("/api/expenses", json=_payload(c, allow_duplicate=True))
    assert r2.status_code in (200, 201), r2.text
    assert _count(db, u) == 2


def test_outside_the_window_it_is_a_real_repeat(client, db):
    """Same shop, same amount, next week — obviously not a replay."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u

    client.post("/api/expenses", json=_payload(c))
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    row.created_at = utc_now() - timedelta(seconds=REPLAY_WINDOW_SECONDS + 60)
    db.commit()

    client.post("/api/expenses", json=_payload(c))
    assert _count(db, u) == 2, "an old identical expense must not block a new one"


def test_guard_never_crosses_tenants(client, db):
    a, b = _owner(db), _owner(db)
    ca, cb = _cat(db, a), _cat(db, b)
    app.dependency_overrides[get_current_user] = lambda: a
    client.post("/api/expenses", json=_payload(ca))
    app.dependency_overrides[get_current_user] = lambda: b
    client.post("/api/expenses", json=_payload(cb))
    assert _count(db, a) == 1 and _count(db, b) == 1


def test_a_deleted_original_does_not_block_a_re_entry(client, db):
    """Deleting a mistake and typing it again must work immediately."""
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u
    client.post("/api/expenses", json=_payload(c))
    row = db.query(Expense).filter(Expense.user_id == u.id).one()
    row.is_deleted = True
    db.commit()

    client.post("/api/expenses", json=_payload(c))
    live = db.query(Expense).filter(
        Expense.user_id == u.id, Expense.is_deleted.isnot(True)
    ).count()
    assert live == 1


# ── the fingerprint itself ───────────────────────────────────────────

def test_fingerprint_folds_only_cosmetic_differences():
    u = uuid.uuid4(); d = date(2026, 7, 17)
    a = fingerprint(user_id=u, amount=52.05, date=d, description="MENY", payment_method="cash")
    b = fingerprint(user_id=u, amount=52.05, date=d, description="  meny ", payment_method="CASH")
    assert a == b, "whitespace/case are not a different expense"

    c = fingerprint(user_id=u, amount=52.06, date=d, description="MENY", payment_method="cash")
    assert a != c, "one øre IS a different expense"


def test_fingerprint_is_user_scoped():
    d = date(2026, 7, 17)
    kw = dict(amount=52.05, date=d, description="MENY", payment_method="cash")
    assert fingerprint(user_id=uuid.uuid4(), **kw) != fingerprint(user_id=uuid.uuid4(), **kw)


def test_every_request_only_field_is_stripped_before_the_model(client, db):
    """/expenses/from-receipt splats the whole ExpenseCreate dump into
    Expense(), so every REQUEST-ONLY field must be popped first.

    This has now broken twice — vendor_hint/autofill once, then
    allow_duplicate — each time as a hard 500 on a live endpoint. The
    check is structural rather than a third one-off fix: any future
    field on ExpenseCreate that isn't a column fails here first.
    """
    from app.schemas.expense import ExpenseCreate

    model_columns = {c.name for c in Expense.__table__.columns}
    schema_fields = set(ExpenseCreate.model_fields)
    request_only = schema_fields - model_columns

    router_src = (
        Path(__file__).resolve().parent.parent
        / "app" / "routers" / "expenses.py"
    ).read_text()
    unstripped = [f for f in sorted(request_only) if f'"{f}"' not in router_src]
    assert not unstripped, (
        f"{unstripped} are on ExpenseCreate but never named in the router — "
        "they will be splatted into Expense() and 500 the create paths"
    )

    # ...and prove it end to end on the endpoint that keeps breaking.
    u = _owner(db); c = _cat(db, u)
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/expenses/from-receipt", json=_payload(c))
    assert r.status_code in (200, 201), r.text
