"""First-run gate — `has_activity` signal (launch-breaker fix).

The Dashboard "Welcome to BonBox" first-run screen used to clear ONLY when a
Sale row existed (`isFirstRun = total_sales === 0`). But no archetype's guided
first action creates a Sale — café/bar/bakery/generic close a kasserapport
(DailyClose), salon books a Reservation, services/freelancer send a faktura
(Invoice), personal logs an Expense, retail adds an InventoryItem — and
"Try sample data" seeds DailyClose + Expense + InventoryItem but zero Sale.
So a brand-new owner did exactly what the app told them and Welcome never
cleared.

Both summary-emitting endpoints (`/api/dashboard/summary` and
`/api/dashboard/batch`) now carry a `has_activity` boolean that is true if the
user has ANY first-touch row. These tests pin that contract:

  • ZERO sales + ONE DailyClose        → has_activity True (both endpoints)
  • ZERO sales + ONE Expense           → has_activity True (both endpoints)
  • truly empty user                   → has_activity False (both endpoints)
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register tables
from app.main import app, _db_ready
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.utils.time import utc_now

_db_ready.set()


# ─── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, *, email="fresh@cafe.dk"):
    u = User(
        email=email,
        password_hash=hash_password("x"),
        business_name="Fresh Café",
        business_type="cafe",
        currency="DKK",
        plan="free",
        created_at=utc_now() - timedelta(days=1),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _make_daily_close(db, user, *, close_date=None, revenue_total=1350.0):
    c = DailyClose(
        user_id=user.id,
        date=close_date or date(2026, 5, 15),
        revenue_total=revenue_total,
        status="confirmed",
        is_deleted=False,
    )
    db.add(c); db.commit(); db.refresh(c)
    return c


def _make_expense(db, user, *, amount=500.0, expense_date=None):
    cat = ExpenseCategory(user_id=user.id, name="Varer")
    db.add(cat); db.commit(); db.refresh(cat)
    e = Expense(
        user_id=user.id,
        category_id=cat.id,
        date=expense_date or date(2026, 5, 15),
        amount=amount,
        description="Kaffebønner",
        is_deleted=False,
        is_personal=False,
        is_tax_exempt=False,
    )
    db.add(e); db.commit(); db.refresh(e)
    return e


def _auth_headers(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id))}"}


def _summary(client, user):
    r = client.get("/api/dashboard/summary", headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    return r.json()


def _batch(client, user):
    r = client.get("/api/dashboard/batch", headers=_auth_headers(user))
    assert r.status_code == 200, r.text
    body = r.json()
    # /batch nests the summary dict under "summary".
    return body["summary"]


# ─── Tests ────────────────────────────────────────────────────────────


def test_daily_close_only_clears_first_run(db_session, client):
    """A café owner who closed one kasserapport (zero Sale rows) is NOT
    first-run: both endpoints must report has_activity=True."""
    user = _make_user(db_session, email="close@cafe.dk")
    _make_daily_close(db_session, user)

    summary = _summary(client, user)
    batch = _batch(client, user)

    assert summary["total_sales"] == 0
    assert batch["total_sales"] == 0
    assert summary["has_activity"] is True
    assert batch["has_activity"] is True


def test_expense_only_clears_first_run(db_session, client):
    """A personal-mode / any owner who logged one expense (zero Sale rows)
    is NOT first-run on either endpoint."""
    user = _make_user(db_session, email="expense@shop.dk")
    _make_expense(db_session, user)

    summary = _summary(client, user)
    batch = _batch(client, user)

    assert summary["total_sales"] == 0
    assert batch["total_sales"] == 0
    assert summary["has_activity"] is True
    assert batch["has_activity"] is True


def test_truly_empty_user_is_first_run(db_session, client):
    """A brand-new account with no rows of any kind stays first-run:
    has_activity=False on both endpoints."""
    user = _make_user(db_session, email="empty@new.dk")

    summary = _summary(client, user)
    batch = _batch(client, user)

    assert summary["total_sales"] == 0
    assert batch["total_sales"] == 0
    assert summary["has_activity"] is False
    assert batch["has_activity"] is False
