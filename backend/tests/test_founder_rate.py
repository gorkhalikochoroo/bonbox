"""Tests for the public founder-rate-status endpoint (Task #85).

The endpoint is the live source of truth for the landing page's
"X of 100 founder seats taken" urgency pill.  Two invariants to pin:

  1. Aggregate-only — no PII (emails, names, business_name, ids)
     ever appears in the response.
  2. Count contract — exactly the rows that locked in the founder
     rate (plan != 'free' AND stripe_customer_id IS NOT NULL).
     Trial users, free users, and users mid-Stripe-checkout (no
     customer_id yet) are NOT counted.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.user import User

_db_ready.set()


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
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


def _user(db, *, plan: str = "free", stripe_id: str | None = None) -> User:
    u = User(
        email=f"u-{uuid.uuid4()}@x.test",
        password_hash="x",
        business_name="biz",
        business_type="cafe",
        currency="DKK",
        plan=plan,
        stripe_customer_id=stripe_id,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


# ── Tests ────────────────────────────────────────────────────────────


def test_empty_db_returns_zero_claimed(client, db):
    res = client.get("/api/public/founder-rate-status")
    assert res.status_code == 200
    body = res.json()
    assert body["claimed"] == 0
    assert body["max_slots"] >= 1
    assert body["available"] == body["max_slots"]
    assert body["locked"] is True


def test_free_users_not_counted(client, db):
    """Free-tier users haven't locked the founder rate — exclude them."""
    for _ in range(5):
        _user(db, plan="free")
    res = client.get("/api/public/founder-rate-status")
    assert res.status_code == 200
    assert res.json()["claimed"] == 0


def test_paid_with_no_stripe_id_not_counted(client, db):
    """A plan != 'free' WITHOUT a Stripe customer_id is mid-checkout
    or admin-promoted — don't count until the customer record exists."""
    _user(db, plan="starter", stripe_id=None)
    _user(db, plan="pro", stripe_id=None)
    res = client.get("/api/public/founder-rate-status")
    assert res.json()["claimed"] == 0


def test_paid_with_stripe_id_counted(client, db):
    """Starter + Pro paying customers count toward the founder cap."""
    _user(db, plan="starter", stripe_id="cus_a")
    _user(db, plan="pro", stripe_id="cus_b")
    _user(db, plan="starter", stripe_id="cus_c")
    res = client.get("/api/public/founder-rate-status")
    body = res.json()
    assert body["claimed"] == 3
    assert body["available"] == body["max_slots"] - 3
    assert body["locked"] is True


def test_locked_flag_flips_at_cap(client, db, monkeypatch):
    """When claimed reaches max_slots, locked becomes False (no
    more founder seats available).  Verify the boundary by tweaking
    FOUNDER_MAX_SLOTS down to a small number."""
    from app.config import settings
    monkeypatch.setattr(settings, "FOUNDER_MAX_SLOTS", 2, raising=False)
    _user(db, plan="starter", stripe_id="cus_1")
    _user(db, plan="pro", stripe_id="cus_2")
    res = client.get("/api/public/founder-rate-status")
    body = res.json()
    assert body["claimed"] == 2
    assert body["available"] == 0
    assert body["locked"] is False


def test_response_has_no_pii(client, db):
    """Aggregate-only contract: no emails, no business names, no
    user ids, no Stripe customer ids in the response payload."""
    _user(db, plan="pro", stripe_id="cus_x")
    res = client.get("/api/public/founder-rate-status")
    body = res.json()
    # Top-level keys are EXACTLY the four contract keys
    assert set(body.keys()) == {"claimed", "max_slots", "available", "locked"}
    # And none of those values contain stringy PII shapes
    for v in body.values():
        assert not isinstance(v, str) or "@" not in v
