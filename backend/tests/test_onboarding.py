"""
First-run onboarding wizard — end-to-end tests (Task #55).

Multi-layer invariants pinned:
  • Default state — a brand-new signup has onboarding_completed_at = NULL
  • Endpoint is auth-required — anonymous callers get 401, not 200
  • Idempotency — calling /complete twice keeps the first timestamp
    (preserves the "time-to-value" analytics signal)
  • Cross-tenant isolation — one user's completion never affects another's
  • Audit row — every completion + reset writes an immutable audit
    log entry, tenant-scoped
  • Reset is owner-only — team members and accountants get 403
    (defense-in-depth even if the frontend showed the button)
  • Reset clears the field — followed by /auth/me, the user's
    response shows None again

Why these tests matter:
  Without the idempotency check, an attacker (or a buggy frontend retry
  loop) could keep moving `onboarding_completed_at` forward, wiping the
  signal that proves a user finished onboarding within 5 minutes of
  signup. Without the tenant test, the audit log alone wouldn't catch
  a cross-tenant bug — we'd just see the wrong user_id in the audit
  row and miss it.

Run: cd backend && pytest tests/test_onboarding.py -v
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services.auth import get_current_user, hash_password

# Mark the app as DB-ready so middleware doesn't 503 mid-test
_db_ready.set()


# ─── Fixtures ──────────────────────────────────────────────────────────


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(engine_and_session, monkeypatch):
    """TestClient wired to the in-memory DB. Reset slowapi limiter
    between tests so the /onboarding/* 10-and-5-per-minute caps don't
    bleed across cases.
    """
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db

    # Reset the auth limiter so back-to-back tests don't trip rate limits
    try:
        from app.routers.auth import limiter
        limiter.reset()
    except Exception:
        pass

    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, email, role="owner", onboarding_completed_at=None):
    """Factory — creates a user with the given role + onboarding state."""
    u = User(
        email=email,
        password_hash=hash_password("hunter2pass"),
        business_name="Café Test",
        business_type="restaurant",
        currency="DKK",
        role=role,
        email_verified=True,
        onboarding_completed_at=onboarding_completed_at,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _override_user(user):
    """Make get_current_user return `user` for the duration of the test."""
    app.dependency_overrides[get_current_user] = lambda: user


# ─── 1. Default state — fresh user has NULL onboarding_completed_at ───


def test_new_user_has_null_onboarding(db):
    """The whole feature hinges on this default — a brand-new owner
    must land with onboarding_completed_at = None so AuthProvider
    redirects them to /onboarding."""
    user = _make_user(db, "new@bonbox.test")
    assert user.onboarding_completed_at is None


def test_registration_leaves_onboarding_null(client, db):
    """Going through the real /auth/register flow must leave the
    onboarding flag NULL — otherwise new users land on /dashboard
    without seeing the welcome wizard."""
    # gmail.com is on the MX-whitelist (so the signup gate skips DNS)
    # and isn't on the disposable blocklist — perfect for tests.
    r = client.post("/api/auth/register", json={
        "email": "fresh-onboarding-test@gmail.com",
        "password": "hunter2pass",
        "business_name": "Café Fresh",
        "business_type": "restaurant",
        "currency": "DKK",
    })
    assert r.status_code == 201, r.text
    # Verify on the DB row, not just the API response — the API may
    # legitimately not echo nullable fields.
    u = db.query(User).filter(User.email == "fresh-onboarding-test@gmail.com").first()
    assert u is not None
    assert u.onboarding_completed_at is None


# ─── 2. Endpoint requires auth ────────────────────────────────────────


def test_complete_endpoint_requires_auth(client):
    """Anonymous POST must 401 — never lets a caller stamp an arbitrary
    user's onboarding without proving identity first."""
    r = client.post("/api/auth/onboarding/complete")
    # 401 from get_current_user; 403 acceptable on some setups
    assert r.status_code in (401, 403), r.text


def test_reset_endpoint_requires_auth(client):
    """Same for /reset — unauthenticated callers get 401."""
    r = client.post("/api/auth/onboarding/reset")
    assert r.status_code in (401, 403), r.text


# ─── 3. Complete stamps the timestamp ─────────────────────────────────


def test_complete_sets_timestamp(client, db):
    """The endpoint actually writes onboarding_completed_at = now."""
    user = _make_user(db, "first@bonbox.test")
    _override_user(user)

    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["already_completed"] is False
    assert payload["completed_at"] is not None

    # DB-level pin — the row must show the timestamp.
    db.refresh(user)
    assert user.onboarding_completed_at is not None


def test_complete_writes_audit_row(client, db):
    """Every completion leaves an audit trail — entity_type='user',
    action='user.onboarding_completed', tenant-scoped via user_id."""
    user = _make_user(db, "audit@bonbox.test")
    _override_user(user)

    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200

    # Audit row should exist for this user
    audit = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == user.id,
            AuditLog.action == "user.onboarding_completed",
        )
        .first()
    )
    assert audit is not None, "Expected audit row for onboarding completion"
    assert audit.entity_type == "user"
    assert str(audit.entity_id) == str(user.id)


# ─── 4. Idempotency — second call preserves the original timestamp ────


def test_complete_is_idempotent(client, db):
    """Calling /complete twice must NOT overwrite the original
    timestamp. Otherwise a frontend retry loop could erase the
    time-to-value analytics signal."""
    user = _make_user(db, "twice@bonbox.test")
    _override_user(user)

    r1 = client.post("/api/auth/onboarding/complete")
    assert r1.status_code == 200
    first_stamp = r1.json()["completed_at"]

    # Pull user with new session to capture the persisted value
    db.refresh(user)
    persisted = user.onboarding_completed_at

    r2 = client.post("/api/auth/onboarding/complete")
    assert r2.status_code == 200
    assert r2.json()["already_completed"] is True
    assert r2.json()["completed_at"] == first_stamp

    db.refresh(user)
    # The persisted timestamp must not have moved
    assert user.onboarding_completed_at == persisted


# ─── 5. Cross-tenant isolation ────────────────────────────────────────


def test_complete_only_touches_caller(client, db):
    """User A completing onboarding must NEVER touch user B's flag.
    The endpoint takes no user_id parameter, so this is mostly a
    sanity pin — but worth testing because if someone refactors the
    handler to accept a user_id, this catches the regression."""
    user_a = _make_user(db, "tenant-a@bonbox.test")
    user_b = _make_user(db, "tenant-b@bonbox.test")
    assert user_a.onboarding_completed_at is None
    assert user_b.onboarding_completed_at is None

    _override_user(user_a)
    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200

    db.refresh(user_a)
    db.refresh(user_b)
    assert user_a.onboarding_completed_at is not None
    # User B's flag must remain untouched — no cross-tenant write
    assert user_b.onboarding_completed_at is None


# ─── 6. Reset endpoint ────────────────────────────────────────────────


def test_reset_clears_timestamp_for_owner(client, db):
    """The owner can re-run the wizard — reset nulls out the flag."""
    from datetime import datetime, timezone
    user = _make_user(
        db, "rerun@bonbox.test",
        onboarding_completed_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
    )
    _override_user(user)

    r = client.post("/api/auth/onboarding/reset")
    assert r.status_code == 200, r.text
    assert r.json()["onboarding_completed_at"] is None

    db.refresh(user)
    assert user.onboarding_completed_at is None


def test_reset_writes_audit_row(client, db):
    """Reset is audited too — operator can see when the wizard was
    re-triggered. Defends against a future bug where the analytics
    cohort 'never completed onboarding' is silently inflated by
    re-runs."""
    from datetime import datetime, timezone
    user = _make_user(
        db, "rerun-audit@bonbox.test",
        onboarding_completed_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
    )
    _override_user(user)

    r = client.post("/api/auth/onboarding/reset")
    assert r.status_code == 200

    audit = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == user.id,
            AuditLog.action == "user.onboarding_reset",
        )
        .first()
    )
    assert audit is not None, "Expected audit row for onboarding reset"


def test_reset_forbidden_for_non_owner(client, db):
    """Team members and accountants can't reset onboarding — they
    didn't sign up cold so the welcome wizard has no value for them.
    Defense-in-depth: the frontend hides the button, but the API
    refuses too."""
    for role in ("cashier", "manager", "viewer", "accountant"):
        user = _make_user(db, f"{role}@bonbox.test", role=role)
        _override_user(user)
        r = client.post("/api/auth/onboarding/reset")
        assert r.status_code == 403, (
            f"role={role} expected 403, got {r.status_code}: {r.text}"
        )


# ─── 7. Schema visibility ─────────────────────────────────────────────


def test_auth_me_returns_onboarding_field(client, db, engine_and_session):
    """The frontend AuthProvider reads user.onboarding_completed_at —
    the /auth/me UserResponse must surface it.

    Resolve via a per-call lookup against the SessionLocal so /auth/me
    sees fresh state after /complete has mutated the row (an in-memory
    override of the same instance would cache the stale None)."""
    _, SessionLocal = engine_and_session
    user = _make_user(db, "me-check@bonbox.test")
    uid = user.id

    def _resolve_fresh():
        s = SessionLocal()
        try:
            return s.query(User).filter(User.id == uid).first()
        finally:
            s.close()

    app.dependency_overrides[get_current_user] = _resolve_fresh

    # Before completion — null
    r1 = client.get("/api/auth/me")
    assert r1.status_code == 200
    assert "onboarding_completed_at" in r1.json()
    assert r1.json()["onboarding_completed_at"] is None

    # After completion — non-null
    rc = client.post("/api/auth/onboarding/complete")
    assert rc.status_code == 200
    r2 = client.get("/api/auth/me")
    assert r2.status_code == 200
    assert r2.json()["onboarding_completed_at"] is not None
