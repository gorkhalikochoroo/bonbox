"""
Unified OAuth sign-in — tests for /api/auth/oauth/apple + /oauth/google
(Task #65).

We can't mint a real Apple- or Google-signed JWT in tests, so we patch
the verifier services (`oauth_apple.verify_apple_token` /
`oauth_google.verify_google_token`) and exercise the router's
find-or-create / link / audit / rate-limit logic end-to-end.

Coverage:
  • Valid Apple token → creates User row with apple_sub on first sign-in
  • Valid Google token → creates User row with google_sub on first sign-in
  • Invalid signature → 401
  • Expired token → 401
  • Wrong audience → 401
  • Missing audience config (Apple) → 503
  • Missing GOOGLE_CLIENT_ID → 503
  • Existing email-password user signs in with Apple → apple_sub linked,
    no duplicate row
  • Existing email-password user signs in with Google → google_sub linked,
    no duplicate row
  • Apple private-relay email (`@privaterelay.appleid.com`) → treated as
    real email for storage but NEVER bridges into existing real-email user
  • Audit log entries written for signin + linked actions
  • Cross-tenant isolation — Apple sub for user A never returns user B
  • Rate limit — 31st request in 1 hour → 429
  • oauth_provider stamp updates on each sign-in
  • Locked accounts can't bypass OAuth

Run: cd backend && pytest tests/test_oauth_signin.py -v
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
# Force-load every model so create_all wires up FKs (Sale, Expense, etc.)
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture
def db_session():
    """Per-test in-memory SQLite. StaticPool keeps the single connection
    alive so SessionLocal() lands on the same DB our test uses."""
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


@pytest.fixture(autouse=True)
def configure_oauth_env(monkeypatch):
    """All tests run with both providers configured. Individual tests
    can override (e.g. to test the 503 path)."""
    from app.config import settings as _settings

    monkeypatch.setattr(_settings, "APPLE_CLIENT_ID", "dk.bonbox.web", raising=False)
    monkeypatch.setattr(_settings, "APPLE_ALLOWED_AUDIENCES", "dk.bonbox.app", raising=False)
    monkeypatch.setattr(_settings, "GOOGLE_CLIENT_ID", "google-test-client.apps.googleusercontent.com", raising=False)


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """Reset slowapi between tests — the module-level limiter bucket
    leaks across tests otherwise and the 30/hour cap fires spuriously."""
    try:
        from app.routers.auth_oauth import limiter as _ol
        _ol.reset()
    except Exception:  # noqa: BLE001
        pass


@pytest.fixture(autouse=True)
def reset_jti_cache():
    """Wipe the jti replay cache between tests (Audit P1, Task #75).
    Otherwise tests reusing the same stub jti would trip the replay
    block on the second run."""
    from app.services.oauth_jti_cache import _reset_for_tests
    _reset_for_tests()


# ── Helpers ──────────────────────────────────────────────────────────


def _patch_apple(claims=None, side_effect=None):
    """Replace verify_apple_token with a stub returning `claims` or
    raising `side_effect`. Patches the import site (not the service
    module) so the router's own import binding is replaced."""
    if side_effect is not None:
        return patch("app.routers.auth_oauth.verify_apple_token", side_effect=side_effect)
    return patch("app.routers.auth_oauth.verify_apple_token", return_value=claims)


def _patch_google(claims=None, side_effect=None):
    if side_effect is not None:
        return patch("app.routers.auth_oauth.verify_google_token", side_effect=side_effect)
    return patch("app.routers.auth_oauth.verify_google_token", return_value=claims)


def _apple_claims(
    sub: str,
    email: str = "user@example.com",
    email_verified: bool = True,
    jti: str | None = None,
) -> dict:
    # Audit P1 (Task #75): every test claim carries a unique jti by
    # default — derived from sub so re-running the same sub re-uses
    # the same jti and triggers the replay defense (which is exactly
    # what the test wants when re-checking re-sign-in by sub).  For
    # tests that need a truly distinct jti, pass `jti=...` explicitly.
    return {
        "sub": sub,
        "email": email,
        "email_verified": email_verified,
        "jti": jti if jti is not None else f"jti-{sub}",
        "exp": None,
    }


def _google_claims(
    sub: str,
    email: str = "user@example.com",
    email_verified: bool = True,
    name: str = "",
    picture: str = "",
    jti: str | None = None,
) -> dict:
    return {
        "sub": sub,
        "email": email,
        "email_verified": email_verified,
        "name": name,
        "picture": picture,
        "jti": jti if jti is not None else f"jti-{sub}",
        "exp": None,
    }


# ─── Apple — new user creation ───────────────────────────────────────


def test_apple_new_user_created_with_sub(db_session, client):
    sub = "001234.apple.new.0001"
    with _patch_apple(_apple_claims(sub, email="new@bonbox.test")):
        r = client.post(
            "/api/auth/oauth/apple",
            json={"id_token": "stub", "name": "Jonas Møller"},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "access_token" in body
    assert body["user"]["email"] == "new@bonbox.test"

    u = db_session.query(User).filter(User.email == "new@bonbox.test").first()
    assert u is not None
    assert u.apple_sub == sub
    # Legacy column also populated so /auth/apple keeps finding them.
    assert u.apple_user_id == sub
    assert u.oauth_provider == "apple"
    assert u.email_verified is True
    assert u.role == "owner"
    assert u.business_name == "Jonas Møller"


def test_apple_returning_user_found_by_sub(db_session, client):
    """Same sub on second call → finds existing row, doesn't duplicate.
    Each call uses a distinct jti because real Apple sign-ins issue a
    fresh token per session (Audit P1 — Task #75 replay defense)."""
    sub = "001234.apple.return.0001"
    with _patch_apple(_apple_claims(sub, email="ret@bonbox.test", jti="jti-ret-1")):
        client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    with _patch_apple(_apple_claims(sub, email="ret@bonbox.test", jti="jti-ret-2")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 200
    n = db_session.query(User).filter(User.apple_sub == sub).count()
    assert n == 1


# ─── Apple — linking flow ────────────────────────────────────────────


def test_apple_existing_password_account_refuses_silent_link(db_session, client):
    """Audit P1 (Task #75): a user with an email+password account who
    has NOT yet signed in via OAuth must NOT be silently linked when
    a same-email Apple token shows up.  Returns 409 with a structured
    error so the frontend can route them to the password login first."""
    existing = User(
        email="caro@bonbox.test",
        password_hash=hash_password("Password123"),
        business_name="Caro Cafe",
        business_type="cafe",
        currency="DKK",
        oauth_provider="password",
    )
    db_session.add(existing)
    db_session.commit()
    db_session.refresh(existing)

    sub = "001234.apple.link.0001"
    with _patch_apple(_apple_claims(sub, email="caro@bonbox.test")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 409
    detail = r.json().get("detail") or {}
    assert detail.get("code") == "account_exists_login_first"

    db_session.refresh(existing)
    # apple_sub MUST remain unset — link was refused
    assert existing.apple_sub is None
    # And no duplicate User created
    n = db_session.query(User).filter(User.email == "caro@bonbox.test").count()
    assert n == 1


def test_apple_audit_log_signin_recorded(db_session, client):
    sub = "001234.apple.audit.0001"
    with _patch_apple(_apple_claims(sub, email="aud@bonbox.test")):
        client.post("/api/auth/oauth/apple", json={"id_token": "stub"})

    entries = db_session.query(AuditLog).filter(
        AuditLog.action == "auth.oauth_signin",
    ).all()
    assert len(entries) >= 1
    assert entries[0].entity_type == "user"
    # after_state JSON should include provider=apple
    assert "apple" in (entries[0].after_state or "")


def test_apple_audit_log_link_refused_recorded(db_session, client):
    """Audit P1 (Task #75): when we refuse the silent link, we leave
    an `auth.oauth_link_refused` row so security can spot brute-force
    attempts.  No oauth_signin row for the would-be attacker."""
    existing = User(
        email="link-audit@bonbox.test",
        password_hash=hash_password("Password123"),
        business_name="Link",
        business_type="cafe",
        currency="DKK",
    )
    db_session.add(existing)
    db_session.commit()

    sub = "001234.apple.link.audit"
    with _patch_apple(_apple_claims(sub, email="link-audit@bonbox.test")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 409

    refused = db_session.query(AuditLog).filter(
        AuditLog.action == "auth.oauth_link_refused",
    ).count()
    assert refused >= 1
    # No oauth_signin should have been recorded — we never let them in
    signin = db_session.query(AuditLog).filter(
        AuditLog.action == "auth.oauth_signin",
        AuditLog.user_id == existing.id,
    ).count()
    assert signin == 0


# ─── Apple — privacy-relay email ─────────────────────────────────────


def test_apple_private_relay_email_creates_new_user(db_session, client):
    """A relay address (@privaterelay.appleid.com) → store it as the
    user's email, but NEVER bridge into an existing real-email account.
    Pre-create a real-email user and verify it stays untouched."""
    real_user = User(
        email="real@bonbox.test",
        password_hash=hash_password("Password123"),
        business_name="Real",
        business_type="cafe",
        currency="DKK",
    )
    db_session.add(real_user)
    db_session.commit()
    db_session.refresh(real_user)

    sub = "001234.apple.relay.0001"
    relay = "xy9876@privaterelay.appleid.com"
    with _patch_apple(_apple_claims(sub, email=relay)):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 200

    db_session.refresh(real_user)
    assert real_user.apple_sub is None  # untouched

    # A new row exists with the relay email + apple_sub
    new_row = db_session.query(User).filter(User.email == relay).first()
    assert new_row is not None
    assert new_row.apple_sub == sub
    # Two distinct rows now exist
    assert db_session.query(User).count() == 2


def test_apple_private_relay_returning_user_found_by_sub(db_session, client):
    """Same relay-email user signing in twice → finds them via
    apple_sub (which is stable), not via the relay address.  Distinct
    jti per call (Audit P1 — Task #75)."""
    sub = "001234.apple.relay.return"
    relay = "abc@privaterelay.appleid.com"
    with _patch_apple(_apple_claims(sub, email=relay, jti="jti-relay-1")):
        client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    with _patch_apple(_apple_claims(sub, email=relay, jti="jti-relay-2")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 200
    n = db_session.query(User).filter(User.apple_sub == sub).count()
    assert n == 1


# ─── Apple — failure modes ───────────────────────────────────────────


def test_apple_missing_audience_returns_503(db_session, client, monkeypatch):
    from app.config import settings as _s
    monkeypatch.setattr(_s, "APPLE_CLIENT_ID", "", raising=False)
    monkeypatch.setattr(_s, "APPLE_ALLOWED_AUDIENCES", "", raising=False)
    # Don't patch verify_apple_token — let the real one run and raise
    # RuntimeError on missing config.
    r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 503


def test_apple_invalid_signature_returns_401(db_session, client):
    with _patch_apple(side_effect=ValueError("Apple token signature invalid")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 401
    assert "Invalid or expired" in r.json()["detail"]


def test_apple_expired_token_returns_401(db_session, client):
    with _patch_apple(side_effect=ValueError("Apple token claims invalid: Signature has expired.")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 401


def test_apple_wrong_audience_returns_401(db_session, client):
    with _patch_apple(side_effect=ValueError("Apple token claims invalid: Invalid audience")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 401


def test_apple_token_missing_sub_returns_401(db_session, client):
    with _patch_apple({"email": "noid@bonbox.test", "email_verified": True}):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 401
    assert "sub" in r.json()["detail"]


def test_apple_no_email_no_existing_user_returns_401(db_session, client):
    """If Apple gives us no email AND no row matches the sub, we can't
    create a new row (email column is NOT NULL) → 401."""
    with _patch_apple({"sub": "abc.123", "email": None, "email_verified": False}):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 401


# ─── Google — new user creation ──────────────────────────────────────


def test_google_new_user_created_with_sub(db_session, client):
    sub = "google-sub-001"
    with _patch_google(_google_claims(sub, email="gnew@bonbox.test", name="Anna G")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["email"] == "gnew@bonbox.test"

    u = db_session.query(User).filter(User.email == "gnew@bonbox.test").first()
    assert u is not None
    assert u.google_sub == sub
    assert u.oauth_provider == "google"
    assert u.email_verified is True
    assert u.business_name == "Anna G"


def test_google_returning_user_found_by_sub(db_session, client):
    """Same sub on second call → existing row found.  Distinct jti
    per call so the replay defense (Audit P1 — Task #75) doesn't fire."""
    sub = "google-sub-return"
    with _patch_google(_google_claims(sub, email="gret@bonbox.test", jti="jti-gret-1")):
        client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    with _patch_google(_google_claims(sub, email="gret@bonbox.test", jti="jti-gret-2")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 200
    n = db_session.query(User).filter(User.google_sub == sub).count()
    assert n == 1


# ─── Google — linking flow ───────────────────────────────────────────


def test_google_existing_password_account_refuses_silent_link(db_session, client):
    """Audit P1 (Task #75): mirror of the Apple test — silent linking
    of Google to a password account is refused with 409."""
    existing = User(
        email="glink@bonbox.test",
        password_hash=hash_password("Password123"),
        business_name="GLink",
        business_type="cafe",
        currency="DKK",
        oauth_provider="password",
    )
    db_session.add(existing)
    db_session.commit()
    db_session.refresh(existing)

    sub = "google-sub-link"
    with _patch_google(_google_claims(sub, email="glink@bonbox.test")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 409
    detail = r.json().get("detail") or {}
    assert detail.get("code") == "account_exists_login_first"

    db_session.refresh(existing)
    assert existing.google_sub is None
    n = db_session.query(User).filter(User.email == "glink@bonbox.test").count()
    assert n == 1


def test_google_audit_log_signin_recorded(db_session, client):
    sub = "google-sub-audit"
    with _patch_google(_google_claims(sub, email="gaud@bonbox.test")):
        client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    entries = db_session.query(AuditLog).filter(
        AuditLog.action == "auth.oauth_signin",
    ).all()
    assert len(entries) >= 1
    assert "google" in (entries[0].after_state or "")


# ─── Google — failure modes ──────────────────────────────────────────


def test_google_missing_client_id_returns_503(db_session, client, monkeypatch):
    from app.config import settings as _s
    monkeypatch.setattr(_s, "GOOGLE_CLIENT_ID", "", raising=False)
    r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 503


def test_google_invalid_signature_returns_401(db_session, client):
    with _patch_google(side_effect=ValueError("Google token signature invalid")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 401


def test_google_expired_token_returns_401(db_session, client):
    with _patch_google(side_effect=ValueError("Google token claims invalid: Signature has expired.")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 401


def test_google_wrong_audience_returns_401(db_session, client):
    with _patch_google(side_effect=ValueError("Google token claims invalid: Invalid audience")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 401


def test_google_token_missing_sub_returns_401(db_session, client):
    with _patch_google({"email": "noid@bonbox.test", "email_verified": True, "name": "", "picture": ""}):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 401


def test_google_token_missing_email_returns_401(db_session, client):
    with _patch_google({"sub": "abc-no-email", "email": "", "email_verified": False, "name": "", "picture": ""}):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 401


# ─── Cross-tenant isolation ──────────────────────────────────────────


def test_cross_tenant_isolation_apple_sub_per_user(db_session, client):
    """User A's apple_sub cannot return user B. Two distinct subs → two
    distinct rows, accessible only by their own sub."""
    sub_a = "001234.cross.A"
    sub_b = "001234.cross.B"
    with _patch_apple(_apple_claims(sub_a, email="a@bonbox.test")):
        r_a = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    with _patch_apple(_apple_claims(sub_b, email="b@bonbox.test")):
        r_b = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r_a.status_code == 200
    assert r_b.status_code == 200
    uid_a = r_a.json()["user"]["id"]
    uid_b = r_b.json()["user"]["id"]
    assert uid_a != uid_b

    # Re-sign in with A's sub but a fresh jti → returns A only
    with _patch_apple(_apple_claims(sub_a, email="a@bonbox.test", jti="cross-a-2")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.json()["user"]["id"] == uid_a


# ─── Rate limiting ───────────────────────────────────────────────────


def test_apple_rate_limit_combined_per_hour(db_session, client):
    """Audit P2 (Task #78): rate limit is now 20/hour COMBINED across
    /oauth/apple + /oauth/google, not 30/hour per-endpoint.  The 21st
    request from the same IP in an hour → 429.

    Each request rotates the sub so we don't hit any DB-level UNIQUE
    or find-or-create short-circuit — the rate limit MUST fire from
    slowapi alone."""
    last_status = None
    for i in range(25):
        with _patch_apple(_apple_claims(f"sub-{i}", email=f"rl{i}@bonbox.test")):
            r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
        last_status = r.status_code
        if r.status_code == 429:
            break
    assert last_status == 429


def test_google_rate_limit_combined_per_hour(db_session, client):
    last_status = None
    for i in range(25):
        with _patch_google(_google_claims(f"g-sub-{i}", email=f"grl{i}@bonbox.test")):
            r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
        last_status = r.status_code
        if r.status_code == 429:
            break
    assert last_status == 429


def test_oauth_rate_limit_is_shared_across_providers(db_session, client):
    """Audit P2 (Task #78): an attacker must NOT be able to get 20/h
    on Apple AND a separate 20/h on Google.  After 20 successful
    Apple calls, the 1st Google call should already hit 429."""
    # Burn the bucket via Apple
    for i in range(20):
        with _patch_apple(_apple_claims(f"shared-a-{i}", email=f"sh{i}@bonbox.test")):
            r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
        if r.status_code == 429:
            break
    # The very next Google call from the same IP must be rate-limited
    with _patch_google(_google_claims("shared-g-0", email="sh-g@bonbox.test")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 429


# ─── oauth_provider stamp ────────────────────────────────────────────


def test_oauth_provider_stamp_updates_on_each_signin(db_session, client):
    """Same user signing in via Apple → Google → Apple updates
    oauth_provider on every call (it tracks the LAST method used)."""
    sub_apple = "001234.stamp.apple"
    sub_google = "google-stamp"

    # 1) Apple — creates user, provider=apple
    with _patch_apple(_apple_claims(sub_apple, email="stamp@bonbox.test")):
        client.post("/api/auth/oauth/apple", json={"id_token": "stub"})

    # 2) Same email signs in via Google → links google_sub, provider=google
    with _patch_google(_google_claims(sub_google, email="stamp@bonbox.test")):
        client.post("/api/auth/oauth/google", json={"id_token": "stub"})

    u = db_session.query(User).filter(User.email == "stamp@bonbox.test").first()
    assert u is not None
    assert u.apple_sub == sub_apple
    assert u.google_sub == sub_google
    assert u.oauth_provider == "google"  # last used

    # 3) Apple again → flips back to apple (distinct jti, Audit P1 #75)
    with _patch_apple(_apple_claims(sub_apple, email="stamp@bonbox.test", jti="stamp-apple-2")):
        client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    db_session.expire_all()
    u = db_session.query(User).filter(User.email == "stamp@bonbox.test").first()
    assert u.oauth_provider == "apple"


# ─── Locked-account refusal ──────────────────────────────────────────


def test_apple_locked_account_refused(db_session, client):
    """A user with is_locked=True can't bypass the lock via OAuth."""
    sub = "001234.locked.apple"
    locked = User(
        email="locked@bonbox.test",
        password_hash=hash_password("Password123"),
        business_name="Locked",
        business_type="cafe",
        currency="DKK",
        apple_sub=sub,
        apple_user_id=sub,
        is_locked=True,
    )
    db_session.add(locked)
    db_session.commit()

    with _patch_apple(_apple_claims(sub, email="locked@bonbox.test")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 401
    assert "locked" in r.json()["detail"].lower()


# ─── Audit P1 (Task #75) — replay protection ────────────────────────


def test_apple_same_jti_replay_blocked(db_session, client):
    """Audit P1 (Task #75): the same id_token (same jti) must not be
    POSTable twice within its TTL.  Mitigates token theft + replay."""
    sub = "001234.apple.replay.0001"
    claims = _apple_claims(sub, email="replay@bonbox.test", jti="static-jti-replay-apple")
    # First POST — succeeds, creates the user
    with _patch_apple(claims):
        r1 = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r1.status_code == 200
    # Second POST with the SAME jti — refused as replay
    with _patch_apple(claims):
        r2 = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r2.status_code == 401
    assert "replay" in r2.json()["detail"].lower()


def test_google_same_jti_replay_blocked(db_session, client):
    """Same as Apple — replay defense applies to Google equally."""
    sub = "google-sub-replay-0001"
    claims = _google_claims(sub, email="replay@bonbox.test", jti="static-jti-replay-google")
    with _patch_google(claims):
        r1 = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r1.status_code == 200
    with _patch_google(claims):
        r2 = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r2.status_code == 401
    assert "replay" in r2.json()["detail"].lower()


def test_jti_cache_missing_jti_does_not_block():
    """Audit P1 (Task #75): providers that omit jti must not lock out
    legitimate sign-ins.  claim_jti returns True (allow) on None input."""
    from app.services.oauth_jti_cache import claim_jti, _reset_for_tests
    _reset_for_tests()
    assert claim_jti(None) is True
    assert claim_jti("") is True
