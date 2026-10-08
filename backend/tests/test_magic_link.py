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


# ─── A login link on a never-confirmed account ASKS (Manoj, 8 Oct) ──────
# Someone signed up with a password and never typed the code — the inbox
# owner, or somebody who pre-registered their address. The link proves the
# inbox: the address is confirmed and this browser is signed in, but nothing
# else changes until the inbox owner answers "Did you create this BonBox
# account yourself on <date> and choose the password?":
#   keep   (Ja, det var mig)  — password, other devices, grants unchanged;
#   secure (Nej / Ved ikke)   — password replaced, every session signed out,
#                               revisor grants + host-stand links closed.
# Only a ticket answers: the page's (30 min, in the verify body) or the one in
# the notice mail (7 days). The squatter's own session cannot answer.


def _link_signin(client, email_outbox, email):
    email_outbox.clear()
    r = client.post("/api/auth/magic-link/request", json={"email": email})
    assert r.status_code == 200, r.text
    token = _extract_token_from_email(email_outbox[-1]["html"])
    return client.post("/api/auth/magic-link/verify", json={"token": token})


def _grant_and_stand(db, owner):
    import secrets as _s
    from app.models.accountant_grant import AccountantGrant
    from app.models.stand_link import StandLink
    revisor = User(email="revisor@example.dk", password_hash=hash_password("rev-pw-1"),
                   business_name="", business_type="", currency="DKK", role="accountant",
                   email_verified=True)
    db.add(revisor); db.commit(); db.refresh(revisor)
    g = AccountantGrant(accountant_user_id=revisor.id, accountant_email=revisor.email,
                        owner_user_id=owner.id, granted_by=owner.id, status="active",
                        invited_at=utc_now(), activated_at=utc_now())
    pending = AccountantGrant(accountant_email="pending@example.dk", owner_user_id=owner.id,
                              granted_by=owner.id, status="pending",
                              invite_token="pending-token-abc", invited_at=utc_now())
    stand = StandLink(user_id=owner.id, token=_s.token_urlsafe(24), active=True)
    db.add_all([g, pending, stand]); db.commit()
    return revisor, g, pending, stand


def _squatter(db, email="victim@bonbox.dk", **kw):
    return _make_user(db, email=email, email_verified=False,
                      password_hash=hash_password("attacker-pw-1"),
                      verification_code="123456", **kw)


def _notices(email_outbox, to):
    """Mails to `to` that are not the login link itself."""
    return [m for m in email_outbox if m["to"] == to and "/login/magic?token=" not in m["html"]]


def _mail_ticket(mail_html):
    import re
    m = re.search(r"/login/claim\?token=([A-Za-z0-9_-]{43,})&amp;answer=keep|/login/claim\?token=([A-Za-z0-9_-]{43,})&answer=keep", mail_html)
    assert m, mail_html[:400]
    return m.group(1) or m.group(2)


def _answer(client, ticket, answer, **extra):
    return client.post("/api/auth/claim-decision", json={"ticket": ticket, "answer": answer, **extra})


def _me(client, jwt):
    return client.get("/api/auth/me", headers={"Authorization": f"Bearer {jwt}"}).status_code


def _actions(db, action):
    return db.query(AuditLog).filter(AuditLog.action == action).count()


def test_link_on_an_unconfirmed_account_asks_and_changes_nothing_yet(client, db, email_outbox):
    from app.models.accountant_grant import AccountantGrant
    from app.models.stand_link import StandLink
    from app.services.auth import create_access_token, verify_password
    squatter = _squatter(db)
    _revisor, g, pending, stand = _grant_and_stand(db, squatter)
    old_tv = squatter.token_version or 0
    squatter_jwt = create_access_token(str(squatter.id), old_tv)

    res = _link_signin(client, email_outbox, "victim@bonbox.dk")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["user"]["id"] == str(squatter.id)
    assert body["user"]["email_verified"] is True            # the link proved the inbox
    q = body["claim_question"]
    from app.services.claim_decision import created_on
    # The day it was made, in the owner's timezone (Europe/Copenhagen).
    assert q == {"created_at": created_on(squatter).isoformat(), "has_password": True}
    assert len(q["created_at"]) == 10                          # the date only
    assert isinstance(body["claim_ticket"], str) and len(body["claim_ticket"]) >= 43
    assert body["password_reset"] is False and body["access_closed"] is False

    db.expire_all()
    u = db.query(User).filter(User.id == squatter.id).one()
    assert u.email_verified is True and u.verification_code is None
    assert verify_password("attacker-pw-1", u.password_hash)  # NOT replaced
    assert (u.token_version or 0) == old_tv
    assert _me(client, squatter_jwt) == 200                    # other sessions untouched
    assert _me(client, body["access_token"]) == 200            # this browser is signed in
    assert db.query(AccountantGrant).filter(AccountantGrant.id == g.id).one().status == "active"
    assert db.query(AccountantGrant).filter(AccountantGrant.id == pending.id).one().status == "pending"
    assert db.query(StandLink).filter(StandLink.id == stand.id).one().active is True
    assert _actions(db, "auth.claim.asked") == 1
    assert _actions(db, "auth.claim.secured") == 0
    # Only hashes are stored.
    from app.models.account_claim_ticket import AccountClaimTicket
    rows = db.query(AccountClaimTicket).filter(AccountClaimTicket.user_id == squatter.id).all()
    assert {r.kind for r in rows} == {"page", "mail"}
    assert all(r.token_hash != body["claim_ticket"] and len(r.token_hash) == 64 for r in rows)
    page = next(r for r in rows if r.kind == "page")
    assert page.sign_in_ref is not None                          # bound to this sign-in
    assert (page.expires_at - page.created_at).total_seconds() == 30 * 60
    mail = next(r for r in rows if r.kind == "mail")
    assert (mail.expires_at - mail.created_at).days == 7


def test_one_notice_mail_asks_the_same_question_with_two_links(client, db, email_outbox):
    squatter = _squatter(db)   # DKK, no app language yet → Danish
    res = _link_signin(client, email_outbox, "victim@bonbox.dk")
    assert res.status_code == 200, res.text
    notices = _notices(email_outbox, "victim@bonbox.dk")
    assert len(notices) == 1
    html = notices[0]["html"]
    from app.services.claim_decision import created_on, long_date
    assert f"Har du selv oprettet denne BonBox-konto den {long_date(created_on(squatter), 'da')} og valgt adgangskoden?" in html
    assert "Ja, det var mig" in html and "Nej / Ved ikke" in html
    ticket = _mail_ticket(html)
    assert f"/login/claim?token={ticket}&answer=keep" in html
    assert f"/login/claim?token={ticket}&answer=secure" in html
    assert ticket != res.json()["claim_ticket"]                 # its own ticket
    assert notices[0]["subject"] == "BonBox: Har du selv oprettet din konto?"


def test_the_notice_mail_is_english_for_an_english_account(client, db, email_outbox):
    _squatter(db, ui_language="en")
    assert _link_signin(client, email_outbox, "victim@bonbox.dk").status_code == 200
    html = _notices(email_outbox, "victim@bonbox.dk")[0]["html"]
    assert "Did you create this BonBox account yourself on" in html
    assert "Yes, it was me" in html and "No / Not sure" in html


def test_kept_leaves_password_sessions_and_grants_as_they_are(client, db, email_outbox):
    from app.models.accountant_grant import AccountantGrant
    from app.models.stand_link import StandLink
    from app.services.auth import create_access_token, verify_password
    from app.services.claim_decision import question_open
    squatter = _squatter(db)
    _revisor, g, _pending, stand = _grant_and_stand(db, squatter)
    old_tv = squatter.token_version or 0
    other_jwt = create_access_token(str(squatter.id), old_tv)
    res = _link_signin(client, email_outbox, "victim@bonbox.dk")
    mail_ticket = _mail_ticket(_notices(email_outbox, "victim@bonbox.dk")[0]["html"])

    r = _answer(client, res.json()["claim_ticket"], "keep")
    assert r.status_code == 200, r.text
    assert r.json()["decision"] == "keep" and r.json()["already_decided"] is False
    assert r.json()["access_token"] is None

    db.expire_all()
    u = db.query(User).filter(User.id == squatter.id).one()
    assert verify_password("attacker-pw-1", u.password_hash)
    assert (u.token_version or 0) == old_tv and u.email_verified is True
    assert _me(client, other_jwt) == 200 and _me(client, res.json()["access_token"]) == 200
    assert db.query(AccountantGrant).filter(AccountantGrant.id == g.id).one().status == "active"
    assert db.query(StandLink).filter(StandLink.id == stand.id).one().active is True
    assert _actions(db, "auth.claim.kept") == 1 and _actions(db, "auth.claim.secured") == 0
    assert question_open(db, u) is False
    # Decided: the mail's ticket is void now.
    r2 = _answer(client, mail_ticket, "secure")
    assert r2.status_code == 409 and r2.json()["detail"]["code"] == "claim_already_decided"
    assert r2.json()["detail"]["decision"] == "keep"
    db.expire_all()
    assert verify_password("attacker-pw-1", db.query(User).filter(User.id == squatter.id).one().password_hash)
    # A later login link is an ordinary sign-in again.
    later = _link_signin(client, email_outbox, "victim@bonbox.dk")
    assert later.json()["claim_question"] is None and later.json()["claim_ticket"] is None


def test_secured_replaces_the_password_signs_out_and_closes_access(client, db, email_outbox):
    import json as _json
    from app.models.accountant_grant import AccountantGrant
    from app.models.stand_link import StandLink
    from app.services.auth import create_access_token, verify_password
    squatter = _squatter(db)
    revisor, g, pending, stand = _grant_and_stand(db, squatter)
    old_tv = squatter.token_version or 0
    squatter_jwt = create_access_token(str(squatter.id), old_tv)
    revisor_hdr = {"Authorization": f"Bearer {create_access_token(str(revisor.id), revisor.token_version or 0)}"}
    assert client.post(f"/api/accountants/switch-client/{squatter.id}", headers=revisor_hdr).status_code == 200
    res = _link_signin(client, email_outbox, "victim@bonbox.dk")
    page_jwt = res.json()["access_token"]

    r = _answer(client, res.json()["claim_ticket"], "secure")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["decision"] == "secure" and out["access_closed"] is True
    assert out["access_token"] and out["user"]["id"] == str(squatter.id)
    assert "bonbox_session" in r.headers.get("set-cookie", "")   # this browser stays in

    db.expire_all()
    u = db.query(User).filter(User.id == squatter.id).one()
    assert not verify_password("attacker-pw-1", u.password_hash)   # old password fails
    assert u.token_version == old_tv + 1 and u.email_verified is True
    assert _me(client, squatter_jwt) == 401                         # old sessions 401
    assert _me(client, page_jwt) == 401                             # incl. the one minted before the answer
    assert _me(client, out["access_token"]) == 200                  # the answering browser's new one
    assert client.post("/api/auth/login", json={"email": "victim@bonbox.dk",
                                                "password": "attacker-pw-1"}).status_code in (400, 401)
    assert db.query(AccountantGrant).filter(AccountantGrant.id == g.id).one().status == "revoked"
    p = db.query(AccountantGrant).filter(AccountantGrant.id == pending.id).one()
    assert p.status == "revoked" and p.invite_token is None and p.revoked_at is not None
    assert db.query(StandLink).filter(StandLink.id == stand.id).one().active is False
    assert client.post(f"/api/accountants/switch-client/{squatter.id}", headers=revisor_hdr).status_code == 403
    row = db.query(AuditLog).filter(AuditLog.action == "auth.claim.secured").one()
    after = _json.loads(row.after_state)
    assert after["revoked_grants"] == 2 and after["revoked_stand_links"] == 1
    assert after["via"] == "magic_link" and after["ticket"] == "page"


def test_secure_from_the_mail_link_claims_but_signs_nobody_in(client, db, email_outbox):
    from app.services.auth import create_access_token, verify_password
    squatter = _squatter(db)
    squatter_jwt = create_access_token(str(squatter.id), squatter.token_version or 0)
    res = _link_signin(client, email_outbox, "victim@bonbox.dk")
    mail_ticket = _mail_ticket(_notices(email_outbox, "victim@bonbox.dk")[0]["html"])

    st = client.post("/api/auth/claim-decision/status", json={"ticket": mail_ticket})
    assert st.status_code == 200, st.text
    assert st.json()["state"] == "open"
    from app.services.claim_decision import created_on
    assert st.json()["question"]["created_at"] == created_on(squatter).isoformat()

    r = _answer(client, mail_ticket, "secure")
    assert r.status_code == 200, r.text
    assert r.json()["access_token"] is None and r.json()["user"] is None
    assert "bonbox_session" not in r.headers.get("set-cookie", "")
    db.expire_all()
    u = db.query(User).filter(User.id == squatter.id).one()
    assert not verify_password("attacker-pw-1", u.password_hash)
    assert _me(client, squatter_jwt) == 401 and _me(client, res.json()["access_token"]) == 401
    st2 = client.post("/api/auth/claim-decision/status", json={"ticket": mail_ticket})
    assert st2.json()["state"] == "decided" and st2.json()["decision"] == "secure"
    # The page's ticket is void now.
    r2 = _answer(client, res.json()["claim_ticket"], "keep")
    assert r2.status_code == 409 and r2.json()["detail"]["decision"] == "secure"


def test_a_ticket_answers_once(client, db, email_outbox):
    _squatter(db)
    res = _link_signin(client, email_outbox, "victim@bonbox.dk")
    t = res.json()["claim_ticket"]
    assert _answer(client, t, "secure").status_code == 200
    db.expire_all()
    tv = db.query(User).filter(User.email == "victim@bonbox.dk").one().token_version
    # The same answer again: idempotent — nothing more happens, no new session.
    again = _answer(client, t, "secure")
    assert again.status_code == 200 and again.json()["already_decided"] is True
    assert again.json()["access_token"] is None
    db.expire_all()
    assert db.query(User).filter(User.email == "victim@bonbox.dk").one().token_version == tv
    assert _actions(db, "auth.claim.secured") == 1
    # Another answer with the same ticket: refused.
    other = _answer(client, t, "keep")
    assert other.status_code == 409 and other.json()["detail"]["code"] == "claim_already_decided"
    assert _actions(db, "auth.claim.kept") == 0


def test_an_expired_ticket_is_refused_and_the_question_stays_open(client, db, email_outbox):
    from datetime import timedelta as _td
    from app.models.account_claim_ticket import AccountClaimTicket
    from app.services.auth import verify_password
    from app.services.claim_decision import question_open
    squatter = _squatter(db)
    res = _link_signin(client, email_outbox, "victim@bonbox.dk")
    for row in db.query(AccountClaimTicket).all():
        row.expires_at = utc_now() - _td(seconds=1)
    db.commit()
    r = _answer(client, res.json()["claim_ticket"], "keep")
    assert r.status_code == 410 and r.json()["detail"]["code"] == "claim_ticket_expired"
    assert r.json()["detail"]["message_da"]
    mail_ticket = _mail_ticket(_notices(email_outbox, "victim@bonbox.dk")[0]["html"])
    assert _answer(client, mail_ticket, "secure").status_code == 410
    st = client.post("/api/auth/claim-decision/status", json={"ticket": mail_ticket})
    assert st.json()["state"] == "expired"
    db.expire_all()
    u = db.query(User).filter(User.id == squatter.id).one()
    assert verify_password("attacker-pw-1", u.password_hash)
    assert question_open(db, u) is True       # unanswered is not "kept"

    # The next login link asks again — with a fresh page ticket, and no second mail.
    again = _link_signin(client, email_outbox, "victim@bonbox.dk")
    assert again.json()["claim_question"] is not None
    assert again.json()["claim_ticket"] not in (None, res.json()["claim_ticket"])
    assert _notices(email_outbox, "victim@bonbox.dk") == []
    assert _actions(db, "auth.claim.asked") == 1
    assert _answer(client, again.json()["claim_ticket"], "keep").status_code == 200


def test_leaving_the_question_unanswered_asks_again_next_time_without_a_second_mail(client, db, email_outbox):
    from app.services.auth import verify_password
    _squatter(db)
    first = _link_signin(client, email_outbox, "victim@bonbox.dk")
    assert len(_notices(email_outbox, "victim@bonbox.dk")) == 1
    second = _link_signin(client, email_outbox, "victim@bonbox.dk")   # page closed, came back
    assert second.status_code == 200
    assert second.json()["claim_question"] is not None
    assert second.json()["claim_ticket"] != first.json()["claim_ticket"]
    assert _notices(email_outbox, "victim@bonbox.dk") == []
    db.expire_all()
    assert verify_password("attacker-pw-1",
                           db.query(User).filter(User.email == "victim@bonbox.dk").one().password_hash)


def test_a_forged_ticket_or_an_account_id_cannot_answer(client, db, email_outbox):
    import secrets as _s
    from app.services.auth import create_access_token, verify_password
    squatter = _squatter(db)
    squatter_jwt = create_access_token(str(squatter.id), squatter.token_version or 0)
    _link_signin(client, email_outbox, "victim@bonbox.dk")
    hdr = {"Authorization": f"Bearer {squatter_jwt}"}
    # The squatter holds a session but no ticket: a guessed one is unknown.
    forged = client.post("/api/auth/claim-decision",
                         json={"ticket": _s.token_urlsafe(32), "answer": "keep"}, headers=hdr)
    assert forged.status_code == 404 and forged.json()["detail"]["code"] == "claim_ticket_invalid"
    # An account id is never accepted in place of (or next to) the ticket.
    by_id = client.post("/api/auth/claim-decision",
                        json={"user_id": str(squatter.id), "answer": "keep"}, headers=hdr)
    assert by_id.status_code == 422
    with_id = _answer(client, _s.token_urlsafe(32), "keep", user_id=str(squatter.id))
    assert with_id.status_code == 422
    assert _answer(client, "short", "keep").status_code == 422
    assert _answer(client, _s.token_urlsafe(32), "maybe").status_code == 422
    assert client.post("/api/auth/claim-decision/status",
                       json={"ticket": _s.token_urlsafe(32)}).status_code == 404
    db.expire_all()
    u = db.query(User).filter(User.id == squatter.id).one()
    assert verify_password("attacker-pw-1", u.password_hash)
    assert _actions(db, "auth.claim.kept") == 0 and _actions(db, "auth.claim.secured") == 0


def test_the_answer_endpoint_is_rate_limited(client, db, email_outbox):
    import secrets as _s
    codes = [_answer(client, _s.token_urlsafe(32), "keep").status_code for _ in range(21)]
    assert codes[:20] == [404] * 20 and codes[20] == 429


@pytest.mark.parametrize("answer", ["keep", "secure"])
def test_a_changed_login_email_follows_the_same_flow(client, db, email_outbox, monkeypatch, answer):
    """The owner changes the login e-mail (now unconfirmed), then signs in with
    a link to the new address: asked, not claimed — the owner answers."""
    from app.routers import auth as auth_router
    from app.services.auth import create_access_token, verify_password
    monkeypatch.setattr("app.routers.auth.send_email", lambda *a, **k: True)
    auth_router.limiter.reset()
    owner = _make_user(db, email="owner@bonbox.dk")   # confirmed, password owner-password-1
    jwt = create_access_token(str(owner.id), owner.token_version or 0)
    r = client.patch("/api/auth/profile", headers={"Authorization": f"Bearer {jwt}"},
                     json={"email": "new@bonbox.dk", "current_password": "owner-password-1"})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(User).filter(User.id == owner.id).one().email_verified is False

    res = _link_signin(client, email_outbox, "new@bonbox.dk")
    assert res.status_code == 200, res.text
    from app.services.claim_decision import created_on
    assert res.json()["claim_question"]["created_at"] == created_on(owner).isoformat()
    assert len(_notices(email_outbox, "new@bonbox.dk")) == 1
    db.expire_all()
    u = db.query(User).filter(User.id == owner.id).one()
    assert verify_password("owner-password-1", u.password_hash) and _me(client, jwt) == 200

    assert _answer(client, res.json()["claim_ticket"], answer).status_code == 200
    db.expire_all()
    u = db.query(User).filter(User.id == owner.id).one()
    assert u.email_verified is True and u.email == "new@bonbox.dk"
    if answer == "keep":
        assert verify_password("owner-password-1", u.password_hash) and _me(client, jwt) == 200
    else:
        assert not verify_password("owner-password-1", u.password_hash) and _me(client, jwt) == 401


def test_the_login_email_cannot_move_while_the_question_is_open(client, db, email_outbox, monkeypatch):
    from app.routers import auth as auth_router
    from app.services.auth import create_access_token
    monkeypatch.setattr("app.routers.auth.send_email", lambda *a, **k: True)
    squatter = _squatter(db)
    jwt = create_access_token(str(squatter.id), squatter.token_version or 0)
    res = _link_signin(client, email_outbox, "victim@bonbox.dk")
    auth_router.limiter.reset()
    body = {"email": "elsewhere@example.com", "current_password": "attacker-pw-1"}
    r = client.patch("/api/auth/profile", headers={"Authorization": f"Bearer {jwt}"}, json=body)
    assert r.status_code == 409, r.text
    d = r.json()["detail"]
    assert d["code"] == "claim_question_open" and d["message"] and d["message_da"]
    db.expire_all()
    assert db.query(User).filter(User.id == squatter.id).one().email == "victim@bonbox.dk"
    # Answered (keep): the address can change again.
    assert _answer(client, res.json()["claim_ticket"], "keep").status_code == 200
    auth_router.limiter.reset()
    r2 = client.patch("/api/auth/profile", headers={"Authorization": f"Bearer {jwt}"}, json=body)
    assert r2.status_code == 200, r2.text


def test_magic_link_leaves_a_confirmed_account_untouched(client, db, email_outbox):
    from app.services.auth import verify_password
    owner = _make_user(db, email="owner@bonbox.dk")  # email_verified=True
    old_hash, old_tv = owner.password_hash, owner.token_version or 0
    res = _link_signin(client, email_outbox, "owner@bonbox.dk")
    assert res.status_code == 200, res.text
    assert res.json()["claim_question"] is None and res.json()["claim_ticket"] is None
    db.expire_all()
    u = db.query(User).filter(User.id == owner.id).one()
    assert u.password_hash == old_hash and verify_password("owner-password-1", u.password_hash)
    assert (u.token_version or 0) == old_tv
    assert _actions(db, "auth.claim.asked") == 0


def test_a_confirmed_account_gets_no_reset_flag_and_keeps_its_access(client, db, email_outbox):
    from app.models.accountant_grant import AccountantGrant
    from app.models.stand_link import StandLink
    owner = _make_user(db, email="owner@bonbox.dk")   # confirmed
    _revisor, g, _pending, stand = _grant_and_stand(db, owner)
    res = _link_signin(client, email_outbox, "owner@bonbox.dk")
    assert res.status_code == 200, res.text
    assert res.json()["password_reset"] is False
    assert res.json()["access_closed"] is False
    db.expire_all()
    assert db.query(AccountantGrant).filter(AccountantGrant.id == g.id).one().status == "active"
    assert db.query(StandLink).filter(StandLink.id == stand.id).one().active is True
    # Only the link mail itself — no notice.
    assert [m for m in email_outbox if "token=" not in m["html"]] == []


def test_the_question_names_the_owners_own_calendar_day():
    """created_at is naive UTC; 22:30 UTC on 8 Oct is already 9 Oct in
    Copenhagen, and the question says the day the owner lived."""
    from datetime import datetime as _dt
    from app.services.claim_decision import created_on, long_date
    u = User(email="x@bonbox.dk", password_hash="x", business_name="", business_type="",
             created_at=_dt(2026, 10, 8, 22, 30))
    assert created_on(u).isoformat() == "2026-10-09"
    assert long_date(created_on(u), "da") == "9. oktober 2026"
    assert long_date(created_on(u), "en") == "9 October 2026"


def test_a_browser_holding_the_session_cookie_can_answer_without_a_csrf_header(engine_and_session, client, db, email_outbox):
    """First-party host: the CSRF middleware enforces X-CSRF-Token on cookie
    requests. The answer endpoints read no cookie (the ticket is the
    credential), so the browser that just signed in — cookie and all — must
    not get a 403 for it."""
    from fastapi.testclient import TestClient as _TC
    _squatter(db)
    browser = _TC(app, base_url="https://api.bonbox.dk")
    email_outbox.clear()
    assert browser.post("/api/auth/magic-link/request", json={"email": "victim@bonbox.dk"}).status_code == 200
    token = _extract_token_from_email(email_outbox[-1]["html"])
    res = browser.post("/api/auth/magic-link/verify", json={"token": token})
    assert res.status_code == 200, res.text
    assert browser.cookies.get("bonbox_session")          # the browser holds the session cookie
    # Enforcement is live on this host: a cookie POST elsewhere without the header is refused.
    assert browser.post("/api/auth/logout").status_code == 403
    st = browser.post("/api/auth/claim-decision/status", json={"ticket": res.json()["claim_ticket"]})
    assert st.status_code == 200, st.text
    r = browser.post("/api/auth/claim-decision", json={"ticket": res.json()["claim_ticket"], "answer": "keep"})
    assert r.status_code == 200, r.text
