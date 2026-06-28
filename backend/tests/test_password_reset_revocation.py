"""Session revocation on password change / reset (auth.py).

Security invariant: changing OR resetting a password MUST invalidate every
OTHER live session. Before this fix, both endpoints rewrote password_hash +
committed but never bumped User.token_version — so a thief who had stolen a
session cookie kept full access even after the legitimate owner changed the
password (the whole point of a reset).

These tests pin three behaviors for BOTH /auth/change-password and
/auth/reset-password:
  1. token_version is incremented (old `tv` tokens are now rejected).
  2. an audit row is written (auth.password_changed / auth.password_reset).
  3. the response carries a FRESH token at the new version, so the device
     that performed the change stays / becomes signed in.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register all models on Base
from app.main import app, _db_ready
from app.models.user import User
from app.models.audit_log import AuditLog
from app.services.auth import hash_password, get_current_user, _decode_token
from app.utils.time import utc_now

_db_ready.set()


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
    try:
        from app.routers.auth import limiter
        limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, email="owner@example.com", password="hunter2pass", tv=0):
    from datetime import timedelta
    u = User(
        email=email,
        password_hash=hash_password(password),
        business_name="Test Café",
        business_type="restaurant",
        currency="DKK",
        role="owner",
        email_verified=True,
        token_version=tv,
        created_at=utc_now() - timedelta(days=2),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _token_version_claim(token: str):
    return _decode_token(token).get("tv")


# ─────────────────────────── change-password ───────────────────────────


def test_change_password_bumps_token_version(db_session, client):
    user = _make_user(db_session, tv=3)
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.post("/api/auth/change-password", json={
        "current_password": "hunter2pass",
        "new_password": "brandNewPass99",
    })
    assert r.status_code == 200, r.text

    db_session.refresh(user)
    # token_version must have advanced — every older-tv token is now dead.
    assert user.token_version == 4


def test_change_password_remints_current_session(db_session, client):
    user = _make_user(db_session, tv=0)
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.post("/api/auth/change-password", json={
        "current_password": "hunter2pass",
        "new_password": "brandNewPass99",
    })
    assert r.status_code == 200, r.text
    fresh = r.json().get("token")
    assert fresh, "change-password must return a fresh token for this device"
    # Fresh token carries the NEW version so it survives the bump.
    db_session.refresh(user)
    assert _token_version_claim(fresh) == user.token_version == 1


def test_change_password_writes_audit_row(db_session, client):
    user = _make_user(db_session)
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.post("/api/auth/change-password", json={
        "current_password": "hunter2pass",
        "new_password": "brandNewPass99",
    })
    assert r.status_code == 200, r.text

    rows = db_session.query(AuditLog).filter(AuditLog.action == "auth.password_changed").all()
    assert len(rows) == 1


def test_change_password_wrong_current_does_not_bump(db_session, client):
    user = _make_user(db_session, tv=5)
    app.dependency_overrides[get_current_user] = lambda: user

    r = client.post("/api/auth/change-password", json={
        "current_password": "WRONG",
        "new_password": "brandNewPass99",
    })
    assert r.status_code == 400
    db_session.refresh(user)
    # A rejected attempt must NOT revoke the user's own live sessions.
    assert user.token_version == 5


# ─────────────────────────── reset-password ────────────────────────────


def test_reset_password_bumps_token_version_and_audits(db_session, client):
    from datetime import timedelta
    user = _make_user(db_session, email="reset@example.com", tv=2)
    user.reset_token = "123456"
    user.reset_token_expires = utc_now() + timedelta(minutes=10)
    user.reset_attempts = 0
    db_session.commit()

    r = client.post("/api/auth/reset-password", json={
        "email": "reset@example.com",
        "reset_token": "123456",
        "new_password": "freshResetPass1",
    })
    assert r.status_code == 200, r.text

    db_session.refresh(user)
    assert user.token_version == 3          # all old sessions revoked
    assert user.reset_token is None         # code burned
    fresh = r.json().get("token")
    assert fresh and _token_version_claim(fresh) == 3   # signs the device in fresh

    rows = db_session.query(AuditLog).filter(AuditLog.action == "auth.password_reset").all()
    assert len(rows) == 1


def test_reset_password_bad_code_does_not_revoke(db_session, client):
    from datetime import timedelta
    user = _make_user(db_session, email="reset2@example.com", tv=7)
    user.reset_token = "123456"
    user.reset_token_expires = utc_now() + timedelta(minutes=10)
    user.reset_attempts = 0
    db_session.commit()

    r = client.post("/api/auth/reset-password", json={
        "email": "reset2@example.com",
        "reset_token": "000000",
        "new_password": "freshResetPass1",
    })
    assert r.status_code == 400
    db_session.refresh(user)
    # A failed reset attempt must NOT bump token_version.
    assert user.token_version == 7
