"""Tests for incident-response account lockdown + disposable email gate.

Two attack surfaces:

1. **Account lockdown** — super-admin can lock a hostile account, which:
   • Invalidates active JWT (get_current_user raises 401)
   • Blocks re-login at /auth/login (same error as bad password — no enumeration)
   • Is audited (admin_locked_user / admin_unlocked_user SecurityEvents)
   • Refuses to lock self or another super_admin (privilege-escalation guard)

2. **Disposable-email denylist** — registration refuses known throwaway
   providers (hilostar.com & friends) at /auth/register. Apple/Google SSO
   share the same gate for NEW signups; existing users are exempt.

Regression context: 2026-05-16 incident — nejesap768@hilostar.com signed
up via disposable email, verified, and fuzzed endpoints for 6 hours.
hilostar.com was not on the denylist. This test pins both behaviors so
the next attacker family gets the same response.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register all models
from app.main import app, _db_ready
from app.models.user import User
from app.services.admin_security import require_super_admin
from app.services.auth import hash_password
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
    # The /auth/register endpoint has a 5/minute slowapi limit. Tests
    # in this file fire multiple register calls back-to-back to exercise
    # different denylist scenarios — reset the limiter between tests so
    # we don't accidentally trip 429.
    try:
        from app.routers.auth import limiter
        limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, email, role="owner", email_verified=True, password="hunter2"):
    from datetime import timedelta
    u = User(
        email=email,
        password_hash=hash_password(password),
        business_name="Test",
        business_type="restaurant",
        currency="DKK",
        role=role,
        email_verified=email_verified,
        # Backdate creation so 24h-old admin guard would pass if we used it
        created_at=utc_now() - timedelta(days=2),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _override_admin(admin_user):
    """Override require_super_admin to bypass the 7-layer email allowlist
    check — those layers have their own dedicated test suite. Here we
    only care about the lock/unlock business logic."""
    app.dependency_overrides[require_super_admin] = lambda: admin_user


# ─────────────────────── Disposable email denylist ───────────────────────


def test_register_blocks_hilostar_attacker_pattern(db_session, client):
    """nejesap768@hilostar.com regression — the exact email family the
    2026-05-16 attacker used must be refused with 422."""
    r = client.post("/api/auth/register", json={
        "email": "anyone123@hilostar.com",
        "password": "validpassword123",
        "business_name": "Café Test",
        "business_type": "restaurant",
        "currency": "DKK",
    })
    assert r.status_code == 422
    assert "disposable" in r.json()["detail"].lower() or "real email" in r.json()["detail"].lower()


def test_register_blocks_1secmail_family(db_session, client):
    """1secmail is a high-volume throwaway used by SaaS abusers."""
    r = client.post("/api/auth/register", json={
        "email": "user@1secmail.com",
        "password": "validpassword123",
        "business_name": "X",
        "business_type": "restaurant",
        "currency": "DKK",
    })
    assert r.status_code == 422


def test_register_blocks_mailinator_classic(db_session, client):
    r = client.post("/api/auth/register", json={
        "email": "ceo@mailinator.com",
        "password": "validpassword123",
        "business_name": "X",
        "business_type": "restaurant",
        "currency": "DKK",
    })
    assert r.status_code == 422


def test_register_allows_real_gmail(db_session, client):
    """Don't false-positive on the world's most common email provider."""
    r = client.post("/api/auth/register", json={
        "email": "real-user@gmail.com",
        "password": "validpassword123",
        "business_name": "Real Café",
        "business_type": "restaurant",
        "currency": "DKK",
    })
    assert r.status_code == 201


def test_register_allows_custom_business_domain(db_session, client):
    """Don't false-positive on a small-biz custom domain (e.g. their
    restaurant's own .dk address). Mock DNS so this test doesn't depend
    on the actual MX records for my-restaurant.dk (which is fictional)."""
    from unittest.mock import patch
    from app.routers.auth import _domain_has_mx
    _domain_has_mx.cache_clear()
    with patch("dns.resolver.Resolver") as mock_resolver_cls:
        # Simulate a successful MX lookup — real custom domain has mail server
        mock_resolver_cls.return_value.resolve.return_value = [object()]
        r = client.post("/api/auth/register", json={
            "email": "info@my-restaurant.dk",
            "password": "validpassword123",
            "business_name": "My Café",
            "business_type": "restaurant",
            "currency": "DKK",
        })
        assert r.status_code == 201


def test_disposable_check_is_case_insensitive(db_session, client):
    """Domain comparison must be case-insensitive — UpperCase@HILOSTAR.COM
    must still be refused."""
    r = client.post("/api/auth/register", json={
        "email": "MixedCase@HILOSTAR.COM",
        "password": "validpassword123",
        "business_name": "X",
        "business_type": "restaurant",
        "currency": "DKK",
    })
    assert r.status_code == 422


# ─────────────────────── Account lockdown ───────────────────────


def test_lock_user_invalidates_active_jwt(db_session, client):
    """Locking a user immediately invalidates their existing JWT — no
    need to wait for the token to expire."""
    target = _make_user(db_session, "victim@example.com")
    admin = _make_user(db_session, "admin@bonbox.dk", role="super_admin")

    # Target logs in, gets a valid JWT
    login = client.post("/api/auth/login", json={"email": "victim@example.com", "password": "hunter2"})
    assert login.status_code == 200
    token = login.json()["access_token"]
    H = {"Authorization": f"Bearer {token}"}

    # Token works before lock (just hit /auth/me which uses get_current_user)
    pre = client.get("/api/auth/me", headers=H)
    assert pre.status_code == 200

    # Super-admin locks the account
    _override_admin(admin)
    r = client.post(f"/api/admin/users/{target.id}/lock", json={"reason": "fuzzing endpoints"})
    assert r.status_code == 200
    assert r.json()["is_locked"] is True
    assert r.json()["locked_reason"] == "fuzzing endpoints"

    # Same JWT now rejected with 401
    post = client.get("/api/auth/me", headers=H)
    assert post.status_code == 401
    assert "locked" in post.json()["detail"].lower()


def test_locked_user_cannot_relogin(db_session, client):
    """Locked account refuses fresh login — same error as bad password
    (no enumeration of which emails are banned)."""
    target = _make_user(db_session, "banned@example.com")
    target.is_locked = True
    db_session.commit()

    r = client.post("/api/auth/login", json={"email": "banned@example.com", "password": "hunter2"})
    assert r.status_code == 401
    # Same generic detail as bad password
    assert r.json()["detail"] == "Invalid email or password"


def test_admin_cannot_lock_self(db_session, client):
    """Defense: don't let a super-admin accidentally (or maliciously)
    lock their own account and brick admin access."""
    admin = _make_user(db_session, "admin@bonbox.dk", role="super_admin")
    _override_admin(admin)

    r = client.post(f"/api/admin/users/{admin.id}/lock", json={"reason": "oops"})
    assert r.status_code == 400
    assert "own account" in r.json()["detail"].lower()


def test_admin_cannot_lock_another_super_admin(db_session, client):
    """Defense: super-admins are peers, not adversaries — one can't lock
    out the other."""
    admin1 = _make_user(db_session, "admin1@bonbox.dk", role="super_admin")
    admin2 = _make_user(db_session, "admin2@bonbox.dk", role="super_admin")
    _override_admin(admin1)

    r = client.post(f"/api/admin/users/{admin2.id}/lock", json={"reason": "x"})
    assert r.status_code == 400
    assert "super_admin" in r.json()["detail"]


def test_unlock_restores_access(db_session, client):
    """False-positive lock should be reversible. After unlock the user
    can log in again and use the API."""
    admin = _make_user(db_session, "admin@bonbox.dk", role="super_admin")
    target = _make_user(db_session, "alice@example.com")
    target.is_locked = True
    target.locked_at = utc_now()
    target.locked_reason = "false positive"
    db_session.commit()

    _override_admin(admin)
    r = client.post(f"/api/admin/users/{target.id}/unlock")
    assert r.status_code == 200
    assert r.json()["is_locked"] is False

    # Can log in again
    login = client.post("/api/auth/login", json={"email": "alice@example.com", "password": "hunter2"})
    assert login.status_code == 200


def test_lock_writes_security_event_audit_trail(db_session, client):
    """Every lock/unlock leaves a SecurityEvent so a rogue admin can't
    silently lock customer accounts."""
    from app.models.security_event import SecurityEvent

    admin = _make_user(db_session, "admin@bonbox.dk", role="super_admin")
    target = _make_user(db_session, "target@example.com")
    _override_admin(admin)

    client.post(f"/api/admin/users/{target.id}/lock", json={"reason": "test"})

    events = (
        db_session.query(SecurityEvent)
        .filter(SecurityEvent.event_type == "admin_locked_user")
        .all()
    )
    assert len(events) == 1
    assert str(events[0].user_id) == str(admin.id)  # the admin who did it
    assert str(target.id) in (events[0].detail or "")
    assert "target@example.com" in (events[0].detail or "")


def test_lock_nonexistent_user_returns_404(db_session, client):
    admin = _make_user(db_session, "admin@bonbox.dk", role="super_admin")
    _override_admin(admin)
    r = client.post("/api/admin/users/00000000-0000-0000-0000-000000000000/lock", json={"reason": "x"})
    assert r.status_code == 404


def test_lock_is_idempotent(db_session, client):
    """Locking an already-locked user is a no-op success (not an error).
    Useful so the UI button can be clicked twice without weird states."""
    admin = _make_user(db_session, "admin@bonbox.dk", role="super_admin")
    target = _make_user(db_session, "target@example.com")
    target.is_locked = True
    target.locked_at = utc_now()
    db_session.commit()
    _override_admin(admin)

    r = client.post(f"/api/admin/users/{target.id}/lock", json={"reason": "second time"})
    assert r.status_code == 200
    assert r.json()["is_locked"] is True
