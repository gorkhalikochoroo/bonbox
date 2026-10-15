"""A team member who accepts an invite on the web is signed in (Push 8, 12 Oct 2026).

THE DEFECT. POST /api/team/accept-invite/{token} set the password, burnt the
invite and returned an access token — but set no session cookie. The web app
rides on the HttpOnly session cookie (only the native app keeps the token),
so TeamAcceptInvitePage's hard navigation to /dashboard found no session and
the new member landed on /login, right after choosing a password.

Accept now signs the member in exactly as /auth/login does: the same
_set_auth_cookie (HttpOnly session cookie + double-submit CSRF cookie, the
same Domain/SameSite scope per host), and the same locked-account refusal
before anything is written — so a locked invitee gets no cookie at all.

Run: cd backend && python -m pytest -q tests/test_team_accept_invite_signs_in.py
"""
from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.user import User
from app.services.auth import AUTH_COOKIE_NAME, CSRF_COOKIE_NAME, hash_password
from app.utils.time import utc_now

_db_ready.set()

PASSWORD = "annaspw123"


@pytest.fixture
def factory():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()


@pytest.fixture
def db(factory):
    s = factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _overrides(factory):
    def _get_test_db():
        s = factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    for mod in ("app.routers.auth", "app.routers.team"):
        __import__(mod, fromlist=["limiter"]).limiter.reset()
    yield
    app.dependency_overrides.clear()


def _invite(db, *, locked=False):
    owner = User(email=f"own-{uuid.uuid4().hex[:6]}@bakery.dk", password_hash=hash_password("x" * 10),
                 business_name="Bon Bakery", business_type="cafe", currency="DKK", role="owner",
                 email_verified=True)
    db.add(owner)
    db.commit()
    raw = secrets.token_urlsafe(32)
    invitee = User(email=f"anna-{uuid.uuid4().hex[:6]}@cafe-example.dk",
                   password_hash=hash_password(secrets.token_urlsafe(16)),
                   business_name="Anna", business_type="cafe", currency="DKK", role="cashier",
                   email_verified=False, is_locked=locked,
                   invite_token_hash=hashlib.sha256(raw.encode()).hexdigest(),
                   invite_expires_at=utc_now() + timedelta(days=7),
                   invited_by_user_id=owner.id, owner_id=owner.id)
    db.add(invitee)
    db.commit()
    return raw, invitee.email


def _set_cookies(res) -> dict[str, dict]:
    """name → {"value": …, attr: value} from every Set-Cookie header."""
    out: dict[str, dict] = {}
    for line in res.headers.get_list("set-cookie"):
        parts = [p.strip() for p in line.split(";")]
        name, _, value = parts[0].partition("=")
        attrs = {"value": value}
        for p in parts[1:]:
            k, _, v = p.partition("=")
            attrs[k.lower()] = v.lower() if v else True
        out[name] = attrs
    return out


def _shape(attrs: dict) -> dict:
    return {k: v for k, v in attrs.items() if k not in ("value", "expires")}


def _accept(client, raw):
    return client.post(f"/api/team/accept-invite/{raw}",
                       json={"password": PASSWORD, "full_name": "Anna Hansen"})


def test_accept_sets_the_session_and_csrf_cookies_login_sets(db):
    raw, email = _invite(db)
    client = TestClient(app)
    r = _accept(client, raw)
    assert r.status_code == 200, r.text
    got = _set_cookies(r)
    assert AUTH_COOKIE_NAME in got and CSRF_COOKIE_NAME in got, got
    assert got[AUTH_COOKIE_NAME]["value"] == r.json()["access_token"]
    assert got[AUTH_COOKIE_NAME].get("httponly") is True
    assert got[CSRF_COOKIE_NAME].get("httponly") is None    # JS must read it

    # Byte-for-byte the same cookie shape as a normal sign-in.
    login = TestClient(app).post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    ref = _set_cookies(login)
    for name in (AUTH_COOKIE_NAME, CSRF_COOKIE_NAME):
        assert _shape(got[name]) == _shape(ref[name]), (name, got[name], ref[name])


def test_the_member_is_signed_in_on_the_next_request(db):
    raw, email = _invite(db)
    client = TestClient(app)
    assert _accept(client, raw).status_code == 200
    me = client.get("/api/auth/me")      # cookie only — no Authorization header
    assert me.status_code == 200, me.text
    assert me.json()["email"] == email


def test_first_party_scope_and_csrf_work_like_login(db):
    raw, _ = _invite(db)
    client = TestClient(app, base_url="https://api.bonbox.dk")
    r = _accept(client, raw)
    assert r.status_code == 200, r.text
    got = _set_cookies(r)
    assert got[AUTH_COOKIE_NAME].get("domain") == ".bonbox.dk"
    assert got[AUTH_COOKIE_NAME].get("samesite") == "lax"
    # The CSRF pair is live: a cookie-authenticated write without the header
    # is refused on the first-party host, and passes with it.
    no_header = client.post("/api/auth/logout")
    assert no_header.status_code == 403, no_header.text
    ok = client.post("/api/auth/logout",
                     headers={"X-CSRF-Token": client.cookies.get(CSRF_COOKIE_NAME)})
    assert ok.status_code == 200, ok.text


def test_a_locked_invitee_gets_no_cookie(db):
    raw, _ = _invite(db, locked=True)
    r = _accept(TestClient(app), raw)
    assert r.status_code == 401, r.text
    assert r.headers.get_list("set-cookie") == []
