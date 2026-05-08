"""Tests for Sign in with Apple — POST /api/auth/apple.

We don't have a way to mint a real Apple-signed JWT in tests, so we
mock _verify_apple_identity_token and exercise the find-or-create
logic, tenant creation, idempotency, and the privacy-relay branch.

Coverage:
  • New user from Apple (real email) → row created with apple_user_id
  • Existing email-based user signs in with Apple → linked via
    apple_user_id (no duplicate row)
  • Returning Apple user (sub matches) → existing user logged in
  • Privacy-relay email NEVER bridges into existing real-email
    account (security boundary)
  • Missing email + missing sub → 401
  • Missing audience config → 503
"""
from __future__ import annotations

import secrets
import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
# Importing the models package registers EVERY model on Base — needed
# before create_all so all FK targets exist (User has relationships to
# Sale, Expense, etc.). Tests that skip this end up with "no such
# table: users" because SQLAlchemy can't resolve FKs. Use `from app
# import models as _all_models` rather than `import app.models` so we
# don't shadow the FastAPI `app` instance imported next.
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()


@pytest.fixture
def db_session():
    """Per-test in-memory database. We override get_db so the FastAPI
    routes use this session.

    StaticPool keeps a single connection alive for the whole test —
    SQLite in-memory DBs are connection-scoped, so without this each
    new SessionLocal() would land on a fresh empty DB and tables
    appear "missing".
    """
    from sqlalchemy.pool import StaticPool
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()
    def _override_get_db():
        # Always yield the same session bound to the StaticPool engine
        try: yield s
        finally: pass
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


@pytest.fixture(autouse=True)
def configure_apple_audience(monkeypatch):
    """All tests run with a configured Apple audience (would otherwise
    503). Production sets this via env var APPLE_ALLOWED_AUDIENCES."""
    from app.config import settings as _settings
    monkeypatch.setattr(_settings, "APPLE_ALLOWED_AUDIENCES", "dk.bonbox.app", raising=False)


def _patch_verify(claims):
    """Stub _verify_apple_identity_token to return given claims."""
    return patch(
        "app.routers.auth._verify_apple_identity_token",
        return_value=claims,
    )


# ─── New user from Apple ──────────────────────────────────────────────


def test_apple_new_user_creates_row_with_apple_user_id(db_session, client):
    apple_sub = "001234.abcdef1234567890.0001"
    with _patch_verify({"sub": apple_sub, "email": "newuser@bonbox.test"}):
        r = client.post("/api/auth/apple", json={
            "identity_token": "stub-jwt",
            "full_name": "Jonas Møller",
        })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["email"] == "newuser@bonbox.test"
    user = db_session.query(User).filter(User.email == "newuser@bonbox.test").first()
    assert user is not None
    assert user.apple_user_id == apple_sub
    assert user.email_verified is True


def test_apple_returning_user_links_via_sub(db_session, client):
    """Same Apple sub on second call → finds existing user, doesn't
    create a duplicate."""
    apple_sub = "001234.abcdef1234567890.0002"
    with _patch_verify({"sub": apple_sub, "email": "second@bonbox.test"}):
        client.post("/api/auth/apple", json={"identity_token": "x"})
    with _patch_verify({"sub": apple_sub, "email": "second@bonbox.test"}):
        r = client.post("/api/auth/apple", json={"identity_token": "x"})
    assert r.status_code == 200
    n = db_session.query(User).filter(User.apple_user_id == apple_sub).count()
    assert n == 1


def test_existing_email_user_links_apple_on_first_apple_signin(db_session, client):
    """User registered with email/password → signs in with Apple →
    we LINK their apple_user_id, don't create a duplicate."""
    existing = User(
        email="caro@bonbox.test", password_hash=hash_password("x"),
        business_name="Caro", business_type="restaurant", currency="DKK",
    )
    db_session.add(existing); db_session.commit(); db_session.refresh(existing)

    apple_sub = "001234.linked.0003"
    with _patch_verify({"sub": apple_sub, "email": "caro@bonbox.test"}):
        r = client.post("/api/auth/apple", json={"identity_token": "x"})
    assert r.status_code == 200
    db_session.refresh(existing)
    assert existing.apple_user_id == apple_sub
    n = db_session.query(User).filter(User.email == "caro@bonbox.test").count()
    assert n == 1


# ─── Privacy-relay email handling ─────────────────────────────────────


def test_privacy_relay_email_creates_new_user_not_linked_to_existing(db_session, client):
    """Critical security check: when Apple returns a privacy-relay
    address (`<random>@privaterelay.appleid.com`), the find-or-create
    must create a NEW user. We never bridge to an existing real-email
    account via the relay address — that's how identity-merging bugs
    are born.

    Verified by: pre-create an existing real-email user, then sign in
    with a relay address. Existing user's apple_user_id stays null;
    a brand-new row with the relay email is created."""
    real_email_user = User(
        email="real@bonbox.test", password_hash=hash_password("x"),
        business_name="Real", business_type="cafe", currency="DKK",
    )
    db_session.add(real_email_user); db_session.commit(); db_session.refresh(real_email_user)

    apple_sub = "001234.relay.0004"
    relay = "xy9876@privaterelay.appleid.com"
    with _patch_verify({"sub": apple_sub, "email": relay}):
        r = client.post("/api/auth/apple", json={"identity_token": "x"})
    assert r.status_code == 200
    # Existing user untouched
    db_session.refresh(real_email_user)
    assert real_email_user.apple_user_id is None
    # New user created with relay email + apple_user_id
    new_user = db_session.query(User).filter(User.email == relay).first()
    assert new_user is not None
    assert new_user.apple_user_id == apple_sub
    # Two distinct rows
    assert db_session.query(User).count() == 2


def test_privacy_relay_returning_user_finds_by_sub(db_session, client):
    """Same relay-email user signing in twice → finds them via
    apple_user_id (which is stable), not via the relay address."""
    apple_sub = "001234.relay.0005"
    relay = "xyz9876@privaterelay.appleid.com"
    with _patch_verify({"sub": apple_sub, "email": relay}):
        client.post("/api/auth/apple", json={"identity_token": "x"})
    with _patch_verify({"sub": apple_sub, "email": relay}):
        r = client.post("/api/auth/apple", json={"identity_token": "x"})
    assert r.status_code == 200
    n = db_session.query(User).filter(User.apple_user_id == apple_sub).count()
    assert n == 1


# ─── Failure modes ────────────────────────────────────────────────────


def test_apple_missing_audience_config_503(db_session, client, monkeypatch):
    from app.config import settings as _settings
    monkeypatch.setattr(_settings, "APPLE_ALLOWED_AUDIENCES", "", raising=False)
    r = client.post("/api/auth/apple", json={"identity_token": "x"})
    assert r.status_code == 503


def test_apple_token_missing_sub_401(db_session, client):
    with _patch_verify({"email": "noid@bonbox.test"}):  # no sub
        r = client.post("/api/auth/apple", json={"identity_token": "x"})
    assert r.status_code == 401
    assert "sub" in r.json()["detail"]


def test_apple_token_no_email_401(db_session, client):
    with _patch_verify({"sub": "abc.123"}):  # no email
        r = client.post("/api/auth/apple", json={"identity_token": "x"})
    assert r.status_code == 401


def test_apple_invalid_token_401(db_session, client):
    """The verify function raises ValueError on bad signature/claims;
    the endpoint maps that to 401."""
    with patch(
        "app.routers.auth._verify_apple_identity_token",
        side_effect=ValueError("Token signature invalid"),
    ):
        r = client.post("/api/auth/apple", json={"identity_token": "x"})
    assert r.status_code == 401
    assert "Invalid Apple token" in r.json()["detail"]
