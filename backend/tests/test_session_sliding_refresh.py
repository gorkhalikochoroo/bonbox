"""
Session sliding-refresh — backend middleware tests.

Behavioural contract (locked with Manoj):
  • Access tokens are minted with 30d exp + an iat claim.
  • sliding_refresh_middleware fires on every authenticated, non-exempt
    request: when `now > iat + (exp - iat) / 2` (past midway), it mints
    a fresh JWT and re-issues it via either:
        - cookie path (web)   → Set-Cookie bonbox_session + bonbox_csrf
        - bearer path (iOS)   → Response header `X-New-Token`
  • Fresh tokens (< 15d old) are left alone — no Set-Cookie, no header.
  • Genuinely expired tokens → 401, no refresh.
  • Login endpoint sets a 30d cookie max_age (not 24h).
  • Exempt paths (login/logout/health) don't trigger refresh even when
    auth is present.
  • Native Capacitor (Bearer header, no cookie) → X-New-Token, never
    Set-Cookie.
  • Audit log row `auth.token_refreshed` is written when refresh fires,
    capped at 1 per user per 24h.
  • Locked users (users.is_locked = TRUE) never get a refreshed token.

Run: cd backend && python3 -m pytest tests/test_session_sliding_refresh.py -x -q
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base, get_db
from app import models as _all_models  # noqa: F401  — forces all model registration
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services.auth import (
    AUTH_COOKIE_NAME,
    CSRF_COOKIE_NAME,
    create_access_token,
    hash_password,
)

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
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
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
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _override_get_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _override_get_db

    # The middleware reaches for SessionLocal directly for the locked-
    # account re-check and the audit write — swap both so the in-memory
    # DB is what everything sees.
    import app.main as _app_main
    monkeypatch.setattr(_app_main, "SessionLocal", SessionLocal, raising=False)
    import app.database as _app_db
    monkeypatch.setattr(_app_db, "SessionLocal", SessionLocal, raising=False)

    # Clear the in-process audit dedup cache between tests so each test
    # gets a clean slate for the "1 row per user per 24h" assertion.
    try:
        from app.main import _refresh_audit_dedup as _cache
        _cache.clear()
    except Exception:
        pass

    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, email: str = "owner@bonbox.dk", is_locked: bool = False) -> User:
    u = User(
        email=email,
        password_hash=hash_password("owner-password-1"),
        business_name="Bon Bakery",
        business_type="cafe",
        currency="DKK",
        role="owner",
        email_verified=True,
        is_locked=is_locked,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _aged_token(user_id: str, age_days: int) -> str:
    """Mint a JWT with iat backdated `age_days` so the middleware sees
    it as `age_days` old. Lifetime stays 30d so age=20 puts us past
    midway."""
    now = datetime.now(timezone.utc)
    iat = now - timedelta(days=age_days)
    # exp = original iat + 30d (the lifetime when the token was minted)
    exp = iat + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": user_id, "iat": iat, "exp": exp}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


# ── Test 1 — Fresh token (within first 15 days) → no refresh ────────


def test_fresh_token_does_not_trigger_refresh_cookie(client, db):
    user = _make_user(db)
    # Day 1 of a 30d token — well before midway
    token = _aged_token(str(user.id), age_days=1)

    res = client.get(
        "/api/auth/me",
        cookies={AUTH_COOKIE_NAME: token, CSRF_COOKIE_NAME: "csrf-xyz"},
    )
    assert res.status_code == 200, res.text

    # No new auth cookie set in the response — the existing one is still good
    set_cookie_blob = res.headers.get("set-cookie", "")
    assert AUTH_COOKIE_NAME not in set_cookie_blob, (
        f"Fresh token should NOT trigger refresh, got: {set_cookie_blob}"
    )
    assert "x-new-token" not in {k.lower() for k in res.headers.keys()}


def test_fresh_token_does_not_trigger_refresh_bearer(client, db):
    user = _make_user(db)
    token = _aged_token(str(user.id), age_days=2)

    res = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text
    assert "x-new-token" not in {k.lower() for k in res.headers.keys()}
    set_cookie_blob = res.headers.get("set-cookie", "")
    assert AUTH_COOKIE_NAME not in set_cookie_blob


# ── Test 2 — Past midway → refresh fires ────────────────────────────


def test_past_midway_refresh_cookie_path(client, db):
    user = _make_user(db)
    # Day 20 of a 30d token — past the 15d midway
    token = _aged_token(str(user.id), age_days=20)

    res = client.get(
        "/api/auth/me",
        cookies={AUTH_COOKIE_NAME: token, CSRF_COOKIE_NAME: "csrf-old"},
    )
    assert res.status_code == 200, res.text

    # Set-Cookie should now contain a fresh bonbox_session
    set_cookie_blob = res.headers.get("set-cookie", "")
    assert AUTH_COOKIE_NAME in set_cookie_blob, (
        f"Past-midway token must trigger Set-Cookie refresh; got: {set_cookie_blob}"
    )
    # Max-Age should be the new 30d value (not 24h)
    expected_max_age = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
    assert f"Max-Age={expected_max_age}" in set_cookie_blob or f"max-age={expected_max_age}" in set_cookie_blob.lower(), (
        f"Expected Max-Age={expected_max_age} in {set_cookie_blob}"
    )
    # CSRF cookie also re-issued because the request carried one
    assert CSRF_COOKIE_NAME in set_cookie_blob


def test_past_midway_refresh_bearer_path(client, db):
    user = _make_user(db)
    token = _aged_token(str(user.id), age_days=20)

    res = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert res.status_code == 200, res.text

    new_token = res.headers.get("x-new-token") or res.headers.get("X-New-Token")
    assert new_token, "Bearer mode past midway must include X-New-Token header"
    assert len(new_token) > 20
    # Verify it's a valid JWT signed under the current secret
    decoded = jwt.decode(new_token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    assert decoded["sub"] == str(user.id)
    assert "iat" in decoded
    assert "exp" in decoded
    # New iat should be roughly now (within last few seconds)
    new_iat = int(decoded["iat"])
    now_ts = int(datetime.now(timezone.utc).timestamp())
    assert abs(now_ts - new_iat) < 10, f"Expected fresh iat near now, got {new_iat} vs {now_ts}"
    # And NO Set-Cookie for bearer-mode requests
    set_cookie_blob = res.headers.get("set-cookie", "") or ""
    assert AUTH_COOKIE_NAME not in set_cookie_blob


# ── Test 3 — Truly expired token → 401, no refresh ──────────────────


def test_expired_token_returns_401_no_refresh(client, db):
    user = _make_user(db)
    # Day 31 — past 30d exp. _aged_token computes exp from the iat so
    # this token is genuinely past its expiry.
    token = _aged_token(str(user.id), age_days=31)

    res = client.get(
        "/api/auth/me",
        cookies={AUTH_COOKIE_NAME: token},
    )
    assert res.status_code == 401, res.text
    # No refresh on a 4xx response
    set_cookie_blob = res.headers.get("set-cookie", "")
    assert AUTH_COOKIE_NAME not in set_cookie_blob
    assert "x-new-token" not in {k.lower() for k in res.headers.keys()}


# ── Test 4 — Login endpoint sets 30d cookie max_age ─────────────────


def test_login_sets_30d_cookie_max_age(client, db):
    """Login mints a brand-new cookie; max_age must reflect the new 30d
    lifetime, not the old 24h value (60 * 24 = 86400)."""
    _make_user(db, email="owner@bonbox.dk")

    res = client.post(
        "/api/auth/login",
        json={"email": "owner@bonbox.dk", "password": "owner-password-1"},
    )
    assert res.status_code == 200, res.text

    set_cookie_blob = res.headers.get("set-cookie", "")
    assert AUTH_COOKIE_NAME in set_cookie_blob
    # 30 days * 86400 = 2,592,000
    expected = 60 * 60 * 24 * 30
    assert f"Max-Age={expected}" in set_cookie_blob or f"max-age={expected}" in set_cookie_blob.lower(), (
        f"Expected Max-Age={expected} (30d) in {set_cookie_blob}"
    )
    # And NOT the old 24h value (86400)
    assert "Max-Age=86400" not in set_cookie_blob and "max-age=86400" not in set_cookie_blob.lower()


# ── Test 5 — Exempt paths don't refresh even with stale token ───────


def test_exempt_path_no_refresh_on_health(client, db):
    user = _make_user(db)
    token = _aged_token(str(user.id), age_days=20)

    # Health is on _REFRESH_EXEMPT_PATHS
    res = client.get(
        "/api/health",
        cookies={AUTH_COOKIE_NAME: token, CSRF_COOKIE_NAME: "csrf"},
    )
    # Whatever status health returns is fine — we just want NO refresh
    set_cookie_blob = res.headers.get("set-cookie", "")
    assert AUTH_COOKIE_NAME not in set_cookie_blob
    assert "x-new-token" not in {k.lower() for k in res.headers.keys()}


def test_exempt_path_no_refresh_on_login_endpoint(client, db):
    """Even if a stale cookie is sent on /api/auth/login (e.g. an old
    tab posting login again), don't trigger refresh — login is on the
    exempt list because it mints its own token."""
    user = _make_user(db, email="re@bonbox.dk")
    stale = _aged_token(str(user.id), age_days=20)

    res = client.post(
        "/api/auth/login",
        json={"email": "re@bonbox.dk", "password": "owner-password-1"},
        cookies={AUTH_COOKIE_NAME: stale},
    )
    assert res.status_code == 200, res.text
    # Login DOES set a cookie (its own fresh one) — that's expected.
    # What we're asserting: no X-New-Token header from the refresh path.
    assert "x-new-token" not in {k.lower() for k in res.headers.keys()}


# ── Test 6 — Capacitor Bearer mode never gets Set-Cookie ────────────


def test_bearer_session_never_sets_cookie(client, db):
    user = _make_user(db)
    token = _aged_token(str(user.id), age_days=22)

    res = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
        # explicitly no cookies — pure native iOS shell
    )
    assert res.status_code == 200, res.text
    assert res.headers.get("x-new-token") or res.headers.get("X-New-Token")
    set_cookie_blob = res.headers.get("set-cookie", "") or ""
    assert AUTH_COOKIE_NAME not in set_cookie_blob, (
        f"Bearer mode must use X-New-Token, never Set-Cookie. Got: {set_cookie_blob}"
    )


# ── Test 7 — Audit row written + capped at 1/user/24h ───────────────


def test_refresh_audit_row_written_and_deduped(client, db):
    user = _make_user(db)
    token = _aged_token(str(user.id), age_days=20)

    # Fire 3 refreshable requests in quick succession
    for _ in range(3):
        res = client.get(
            "/api/auth/me",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert res.status_code == 200, res.text
        # Each one DOES re-mint (header present)
        assert res.headers.get("x-new-token") or res.headers.get("X-New-Token")

    # But the audit table should have at most ONE row for this user
    # (the dedup cache caps it at 1/24h).
    rows = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == user.id, AuditLog.action == "auth.token_refreshed")
        .all()
    )
    assert len(rows) == 1, (
        f"Expected exactly 1 deduped auth.token_refreshed row, got {len(rows)}"
    )
    row = rows[0]
    assert row.entity_type == "user"
    assert row.actor_type == "system.session_refresh"
    # after_state should have old_token_iat + new_token_iat + mode
    import json as _json
    after = _json.loads(row.after_state or "{}")
    assert after.get("mode") == "bearer"
    assert "old_token_iat" in after and "new_token_iat" in after
    assert after["new_token_iat"] > after["old_token_iat"]


# ── Test 8 — Locked user gets no refresh ────────────────────────────


def test_locked_user_no_refresh(client, db):
    user = _make_user(db, is_locked=True)
    token = _aged_token(str(user.id), age_days=20)

    res = client.get(
        "/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    # Locked users get 401 from get_current_user, and 4xx responses are
    # never refreshed — both layers agree no refresh fires.
    assert res.status_code == 401
    assert "x-new-token" not in {k.lower() for k in res.headers.keys()}


# ── Test 9 — Anonymous requests don't trigger refresh ───────────────


def test_anonymous_request_no_refresh(client, db):
    # No cookie, no Bearer — the route should 401 and no refresh fires.
    res = client.get("/api/auth/me")
    assert res.status_code == 401
    set_cookie_blob = res.headers.get("set-cookie", "") or ""
    assert AUTH_COOKIE_NAME not in set_cookie_blob
    assert "x-new-token" not in {k.lower() for k in res.headers.keys()}
