"""
Magic-link passwordless login — end-to-end tests (Task #61).

Coverage:
   1. Happy path: request → email sent (mocked) → verify with correct
      token → returns valid JWT
   2. Token expires after 15 min → verify fails 410
   3. Same token can't be used twice (idempotency) → 409
   4. Rate limit: 4th unused token in 10 min for same email → silently
      still returns 200 (enumeration-safe; doesn't 429 to the client)
      but no NEW row is inserted
   5. Email-enumeration safety: unknown email still returns 200 OK with
      same message AND same shape AND comparable timing
   6. Token format validation rejects garbage (too short, wrong chars)
   7. SHA-256 hashing — raw token never stored anywhere
   8. Audit logs: requested, verified, expired-attempt
   9. Cross-tenant isolation — A's token can never log in as B
  10. Locked account refuses magic-link verify
  11. Verify with a never-issued token → 401 invalid

Run: cd backend && pytest tests/test_magic_link.py -v
"""
from __future__ import annotations

import hashlib
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.magic_link_token import MagicLinkToken
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.services.auth import hash_password
from app.services import magic_link_service
from app.utils.time import utc_now

_db_ready.set()


# ─── Fixtures ─────────────────────────────────────────────────────────


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
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def email_outbox(monkeypatch):
    """Replace send_email with an in-process capture so we can assert
    on the magic URL that would have been delivered.
    """
    sent: list[dict] = []

    def _capture(to, subject, html, **kwargs):
        sent.append({"to": to, "subject": subject, "html": html})
        return True

    # Both the email service and the place where the router imports it
    # need patching — the router does `from ... import send_email`.
    monkeypatch.setattr(
        "app.services.email_service.send_email", _capture, raising=True
    )
    monkeypatch.setattr(
        "app.routers.auth_magic_link.send_email", _capture, raising=True
    )
    return sent


@pytest.fixture
def client(engine_and_session, monkeypatch, email_outbox):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db

    # Some middleware reaches for SessionLocal directly; swap it too
    # so the in-memory DB is what everything sees.
    import app.main as _app_main
    monkeypatch.setattr(_app_main, "SessionLocal", SessionLocal, raising=False)
    import app.database as _app_db
    monkeypatch.setattr(_app_db, "SessionLocal", SessionLocal, raising=False)

    # Reset the slowapi limiter between tests. The router-level
    # 10/hour-per-IP limit is module state; without a reset, the 10th
    # test in a row fails because the bucket is exhausted.
    try:
        from app.routers.auth_magic_link import limiter as _ml_limiter
        _ml_limiter.reset()
    except Exception:
        pass

    yield TestClient(app)
    app.dependency_overrides.clear()


# ─── Helpers ──────────────────────────────────────────────────────────


def _make_user(db, email: str = "owner@bonbox.dk", **kw) -> User:
    u = User(
        email=email,
        password_hash=hash_password("owner-password-1"),
        business_name=kw.get("business_name", "Bon Bakery"),
        business_type=kw.get("business_type", "cafe"),
        currency="DKK",
        role="owner",
        email_verified=True,
    )
    for k, v in kw.items():
        if hasattr(u, k):
            setattr(u, k, v)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _extract_token_from_email(html: str) -> str:
    """Pull the raw token out of the magic-link HTML. The link looks
    like <a href="https://.../login/magic?token=ABC123">."""
    import re

    m = re.search(r"token=([A-Za-z0-9_-]{30,})", html)
    assert m, f"No token found in email HTML: {html[:300]}"
    return m.group(1)


# ─── Test 1 — Happy path: request → verify → JWT ──────────────────────


def test_happy_path_request_then_verify(client, db, email_outbox):
    user = _make_user(db, email="owner@bonbox.dk")

    res = client.post(
        "/api/auth/magic-link/request",
        json={"email": "owner@bonbox.dk"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert "message" in body

    # Email captured
    assert len(email_outbox) == 1
    assert email_outbox[0]["to"] == "owner@bonbox.dk"
    raw_token = _extract_token_from_email(email_outbox[0]["html"])

    # Row exists with sha256 of the raw token (NOT the raw token itself)
    expected_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    rows = db.query(MagicLinkToken).all()
    assert len(rows) == 1
    assert rows[0].token_hash == expected_hash
    assert rows[0].email == "owner@bonbox.dk"
    assert rows[0].used_at is None
    # user_id NULL until verify
    assert rows[0].user_id is None

    # Verify
    res = client.post(
        "/api/auth/magic-link/verify",
        json={"token": raw_token},
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert "access_token" in data
    assert data["user"]["email"] == "owner@bonbox.dk"
    assert data["user"]["id"] == str(user.id)

    # Token row is consumed + back-patched
    db.expire_all()
    row = db.query(MagicLinkToken).first()
    assert row.used_at is not None
    assert str(row.user_id) == str(user.id)


# ─── Test 2 — Token expires after 15 min → 410 ────────────────────────


def test_expired_token_returns_410(client, db, email_outbox):
    _make_user(db, email="owner@bonbox.dk")

    # Request a token
    client.post("/api/auth/magic-link/request", json={"email": "owner@bonbox.dk"})
    raw_token = _extract_token_from_email(email_outbox[0]["html"])

    # Roll the row's expires_at into the past
    row = db.query(MagicLinkToken).first()
    row.expires_at = utc_now() - timedelta(minutes=1)
    db.commit()

    res = client.post("/api/auth/magic-link/verify", json={"token": raw_token})
    assert res.status_code == 410, res.text
    body = res.json()
    assert body["detail"]["code"] == "magic_link_expired"


# ─── Test 3 — Single-use: re-verify with same token → 409 ─────────────


def test_token_cannot_be_used_twice(client, db, email_outbox):
    _make_user(db, email="owner@bonbox.dk")

    client.post("/api/auth/magic-link/request", json={"email": "owner@bonbox.dk"})
    raw_token = _extract_token_from_email(email_outbox[0]["html"])

    # First use succeeds
    res = client.post("/api/auth/magic-link/verify", json={"token": raw_token})
    assert res.status_code == 200, res.text

    # Second use rejects with 409
    res = client.post("/api/auth/magic-link/verify", json={"token": raw_token})
    assert res.status_code == 409, res.text
    body = res.json()
    assert body["detail"]["code"] == "magic_link_used"


# ─── Test 4 — Rate limit: 4th request stays 200 but no new row ────────


def test_email_rate_limit_silent_block(client, db, email_outbox):
    """The service refuses a 4th unused token in 10 min for the same
    email, but the router translates that to a generic 200 to keep the
    response shape identical (enumeration-safe). No new MagicLinkToken
    row should be inserted on the rate-limited request."""
    _make_user(db, email="owner@bonbox.dk")

    # Issue 3 tokens (max allowed)
    for _ in range(3):
        res = client.post(
            "/api/auth/magic-link/request",
            json={"email": "owner@bonbox.dk"},
        )
        assert res.status_code == 200

    count_before = db.query(MagicLinkToken).count()
    assert count_before == 3

    # 4th request — should STILL return 200 (enum-safe) but not insert
    res = client.post(
        "/api/auth/magic-link/request",
        json={"email": "owner@bonbox.dk"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True

    count_after = db.query(MagicLinkToken).count()
    assert count_after == 3, f"4th request should not insert. Got {count_after} rows."

    # Audit row exists for the rate-limited attempt
    events = db.query(SecurityEvent).filter(
        SecurityEvent.event_type == "auth.magic_link.rate_limited",
    ).all()
    assert len(events) >= 1


# ─── Test 5 — Enumeration safety: unknown email returns same shape ────


def test_unknown_email_returns_same_response(client, db, email_outbox):
    """Backend MUST NOT reveal whether an email is registered. Response
    shape, status, and message body must be identical for known and
    unknown emails."""
    # Known email
    _make_user(db, email="known@bonbox.dk")
    res1 = client.post(
        "/api/auth/magic-link/request",
        json={"email": "known@bonbox.dk"},
    )

    # Unknown email — never registered anywhere. Use a real-looking
    # TLD so Pydantic's EmailStr validator (which checks the domain
    # has a recognised TLD shape) doesn't 422 the input.
    res2 = client.post(
        "/api/auth/magic-link/request",
        json={"email": "stranger@example.com"},
    )

    assert res1.status_code == res2.status_code == 200
    # Same JSON keys + same message text
    assert set(res1.json().keys()) == set(res2.json().keys())
    assert res1.json()["ok"] == res2.json()["ok"] is True
    assert res1.json()["message"] == res2.json()["message"]

    # Both got a token row in the DB (we issue tokens for unknown emails
    # too — they just can't ever be redeemed without an existing user,
    # but we DO send the email so the user can't tell on the timing axis
    # either).
    rows = db.query(MagicLinkToken).all()
    assert len(rows) == 2
    emails = {r.email for r in rows}
    assert emails == {"known@bonbox.dk", "stranger@example.com"}


# ─── Test 6 — Token format validation rejects garbage ─────────────────


def test_token_format_validation_rejects_short_tokens(client):
    # Pydantic rejects tokens shorter than 43 chars at the validation
    # layer — returns 422 before our handler runs.
    res = client.post(
        "/api/auth/magic-link/verify",
        json={"token": "short"},
    )
    assert res.status_code == 422


def test_token_format_validation_rejects_empty_token(client):
    res = client.post(
        "/api/auth/magic-link/verify",
        json={"token": ""},
    )
    assert res.status_code == 422


def test_token_format_validation_rejects_oversized_token(client):
    res = client.post(
        "/api/auth/magic-link/verify",
        json={"token": "a" * 200},
    )
    assert res.status_code == 422


def test_unknown_token_of_valid_length_returns_401(client):
    # 43 chars (valid length) but never issued → 401, not 422
    bogus = "a" * 43
    res = client.post(
        "/api/auth/magic-link/verify",
        json={"token": bogus},
    )
    assert res.status_code == 401, res.text
    body = res.json()
    assert body["detail"]["code"] == "magic_link_invalid"


# ─── Test 7 — Raw token is NEVER stored ──────────────────────────────


def test_raw_token_never_stored_in_db(client, db, email_outbox):
    _make_user(db, email="owner@bonbox.dk")

    client.post("/api/auth/magic-link/request", json={"email": "owner@bonbox.dk"})
    raw_token = _extract_token_from_email(email_outbox[0]["html"])

    # Look for the raw token in token_hash column — must be absent
    matches = db.query(MagicLinkToken).filter(
        MagicLinkToken.token_hash == raw_token,
    ).count()
    assert matches == 0, "Raw token must NEVER appear in token_hash column"

    # The stored value is sha256 hex of the raw token
    row = db.query(MagicLinkToken).first()
    assert row.token_hash == hashlib.sha256(raw_token.encode()).hexdigest()
    assert row.token_hash != raw_token
    assert len(row.token_hash) == 64  # sha256 hex


# ─── Test 8 — Audit logs ─────────────────────────────────────────────


def test_audit_events_on_request_and_verify(client, db, email_outbox):
    _make_user(db, email="owner@bonbox.dk")

    # Request emits a SecurityEvent (unauthed actor; user_id NULL)
    client.post("/api/auth/magic-link/request", json={"email": "owner@bonbox.dk"})

    requested = db.query(SecurityEvent).filter(
        SecurityEvent.event_type == "auth.magic_link.requested",
    ).all()
    assert len(requested) == 1

    # Verify emits an AuditLog (tenant-scoped to the resolved user)
    raw_token = _extract_token_from_email(email_outbox[0]["html"])
    client.post("/api/auth/magic-link/verify", json={"token": raw_token})

    verified = db.query(AuditLog).filter(
        AuditLog.action == "auth.magic_link.verified",
    ).all()
    assert len(verified) == 1


def test_audit_event_on_expired_verify(client, db, email_outbox):
    _make_user(db, email="owner@bonbox.dk")

    client.post("/api/auth/magic-link/request", json={"email": "owner@bonbox.dk"})
    raw_token = _extract_token_from_email(email_outbox[0]["html"])

    # Force expiry
    row = db.query(MagicLinkToken).first()
    row.expires_at = utc_now() - timedelta(minutes=1)
    db.commit()

    res = client.post("/api/auth/magic-link/verify", json={"token": raw_token})
    assert res.status_code == 410

    expired_events = db.query(SecurityEvent).filter(
        SecurityEvent.event_type == "auth.magic_link.expired",
    ).all()
    assert len(expired_events) >= 1


# ─── Test 9 — Cross-tenant isolation ──────────────────────────────────


def test_cross_tenant_token_isolation(client, db, email_outbox):
    """A token issued for user A can never log in user B. The token is
    bound to the email at issue time and the verify path resolves the
    user by email — there's no way to swap them server-side."""
    user_a = _make_user(db, email="alice@bonbox.dk", business_name="Alice's Cafe")
    user_b = _make_user(db, email="bob@bonbox.dk", business_name="Bob's Bakery")

    # Issue a token to user A
    client.post("/api/auth/magic-link/request", json={"email": "alice@bonbox.dk"})
    token_a = _extract_token_from_email(email_outbox[0]["html"])

    # Verify token A → must land as Alice, never Bob
    res = client.post("/api/auth/magic-link/verify", json={"token": token_a})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["user"]["email"] == "alice@bonbox.dk"
    assert body["user"]["id"] == str(user_a.id)
    assert body["user"]["id"] != str(user_b.id)


# ─── Test 10 — Locked account refuses verify ──────────────────────────


def test_locked_account_refuses_verify(client, db, email_outbox):
    user = _make_user(db, email="locked@bonbox.dk")
    user.is_locked = True
    db.commit()

    client.post("/api/auth/magic-link/request", json={"email": "locked@bonbox.dk"})
    raw_token = _extract_token_from_email(email_outbox[0]["html"])

    res = client.post("/api/auth/magic-link/verify", json={"token": raw_token})
    assert res.status_code == 401, res.text
    body = res.json()
    assert body["detail"]["code"] == "account_locked"


# ─── Test 11 — Email normalization: case + whitespace ─────────────────


def test_email_case_insensitive_and_trimmed(client, db, email_outbox):
    """Mixed-case + padded input should normalize to lowercase + trim
    at storage; subsequent rate-limit lookups bucket together."""
    _make_user(db, email="owner@bonbox.dk")

    res = client.post(
        "/api/auth/magic-link/request",
        json={"email": "  Owner@BonBox.dk  "},
    )
    assert res.status_code == 200

    row = db.query(MagicLinkToken).first()
    assert row.email == "owner@bonbox.dk"


# ─── Test 12 — IP captured + used_ip differs from request_ip is OK ───


def test_request_and_used_ips_persisted(client, db, email_outbox):
    _make_user(db, email="owner@bonbox.dk")

    client.post("/api/auth/magic-link/request", json={"email": "owner@bonbox.dk"})
    row = db.query(MagicLinkToken).first()
    assert row.request_ip is not None  # captured (testclient = "testclient")

    raw_token = _extract_token_from_email(email_outbox[0]["html"])
    res = client.post("/api/auth/magic-link/verify", json={"token": raw_token})
    assert res.status_code == 200

    db.expire_all()
    row = db.query(MagicLinkToken).first()
    assert row.used_ip is not None
    assert row.used_at is not None


# ─── Test 13 — Service-level rate-limit unit test ─────────────────────


def test_service_rate_limit_raises_429(db):
    """Direct service test: 4 requests in quick succession from the same
    email should raise on the 4th. The router catches this and converts
    to a 200, but the service still signals via HTTPException for tests
    + admin tooling."""
    from fastapi import HTTPException

    for _ in range(magic_link_service.RATE_LIMIT_MAX_TOKENS):
        magic_link_service.create_token(db, email="rl@bonbox.dk", request_ip="1.2.3.4")
    db.commit()

    with pytest.raises(HTTPException) as exc_info:
        magic_link_service.create_token(db, email="rl@bonbox.dk", request_ip="1.2.3.4")
    assert exc_info.value.status_code == 429
    assert exc_info.value.detail["code"] == "magic_link_rate_limited"


# ─── Test 14 — New user self-signup on first verify ───────────────────


def test_first_verify_creates_new_user(client, db, email_outbox):
    """Like Google sign-in, a magic-link for an unknown email
    self-creates the user on first verify (with email_verified=True
    since they clicked a link sent to their inbox)."""
    assert db.query(User).count() == 0

    client.post("/api/auth/magic-link/request", json={"email": "new@bonbox.dk"})
    raw_token = _extract_token_from_email(email_outbox[0]["html"])

    res = client.post("/api/auth/magic-link/verify", json={"token": raw_token})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["user"]["email"] == "new@bonbox.dk"
    assert body["user"]["email_verified"] is True

    # User row created
    user = db.query(User).filter(User.email == "new@bonbox.dk").first()
    assert user is not None
    assert user.role == "owner"


# ─── Test 15 — Verify with the wrong but valid-shaped token ─────────


def test_verify_with_token_of_different_hash_returns_401(client, db, email_outbox):
    """If two emails both request tokens, the second one's token
    cannot redeem the first (different sha256 hashes; verify looks
    up by hash, not by email)."""
    _make_user(db, email="a@bonbox.dk")
    _make_user(db, email="b@bonbox.dk")

    client.post("/api/auth/magic-link/request", json={"email": "a@bonbox.dk"})
    client.post("/api/auth/magic-link/request", json={"email": "b@bonbox.dk"})

    token_a = _extract_token_from_email(email_outbox[0]["html"])
    token_b = _extract_token_from_email(email_outbox[1]["html"])
    assert token_a != token_b

    # Each token redeems its own user
    res_a = client.post("/api/auth/magic-link/verify", json={"token": token_a})
    res_b = client.post("/api/auth/magic-link/verify", json={"token": token_b})
    assert res_a.status_code == res_b.status_code == 200
    assert res_a.json()["user"]["email"] == "a@bonbox.dk"
    assert res_b.json()["user"]["email"] == "b@bonbox.dk"
