"""
Login e-mail letter case (push 6) — one mailbox, one account.

Registration stored the address as typed while login, forgot/reset, the
e-mail link and Google/Apple looked it up exactly: an owner who signed up as
"Ole@…" could not sign in as "ole@…", and the e-mail link or a Google sign-in
for "ole@…" quietly made a second, empty account. Now:

  • every lookup ignores case (utils/login_email.user_by_email)
  • a NEW address is stored lower-cased (register, legacy Apple, a changed
    login e-mail); existing rows are never rewritten
  • the checks that create an account or change an address use the same
    lookup, so no case-duplicate pair can be made

No mail leaves the test.

Run: cd backend && python3 -m pytest tests/test_login_email_case.py -q
"""
from __future__ import annotations

import re
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.user import User
from app.services.auth import hash_password
from app.utils.login_email import normalize_login_email, user_by_email

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
    # Middleware (the accountant write guard) opens its own session for a
    # signed-in request: point it at this database too.
    import app.database as _dbmod
    orig = _dbmod.SessionLocal
    _dbmod.SessionLocal = SessionLocal
    try:
        yield s
    finally:
        _dbmod.SessionLocal = orig
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    for mod in ("app.routers.auth", "app.routers.auth_oauth", "app.routers.auth_magic_link"):
        try:
            __import__(mod, fromlist=["limiter"]).limiter.reset()
        except Exception:  # noqa: BLE001
            pass
    from app.utils import login_guard
    try:
        login_guard._reset_for_tests()  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def no_mail(monkeypatch):
    sent: list[tuple] = []
    monkeypatch.setattr("app.routers.auth.send_email", lambda *a, **k: sent.append((a, k)))
    monkeypatch.setattr("app.services.email_service.send_email", lambda *a, **k: sent.append((a, k)))
    return sent


@pytest.fixture(autouse=True)
def magic_mail(monkeypatch):
    sent: list[tuple] = []
    monkeypatch.setattr("app.routers.auth_magic_link.send_email",
                        lambda to, subject, html, **k: sent.append((to, html)) or True)
    return sent


@pytest.fixture(autouse=True)
def providers_configured(monkeypatch):
    from app.config import settings as _settings
    monkeypatch.setattr(_settings, "APPLE_CLIENT_ID", "dk.bonbox.web", raising=False)
    monkeypatch.setattr(_settings, "APPLE_ALLOWED_AUDIENCES", "dk.bonbox.app", raising=False)
    monkeypatch.setattr(_settings, "GOOGLE_CLIENT_ID", "google-test.apps.googleusercontent.com", raising=False)


@pytest.fixture(autouse=True)
def reset_jti_cache():
    from app.services.oauth_jti_cache import _reset_for_tests
    _reset_for_tests()


def _count(db, addr: str) -> int:
    return db.query(User).filter(func.lower(User.email) == addr.lower()).count()


def _existing(db, email="Ole.Hansen@gmail.com", password="Kaffe2026", **kw):
    """A row as production has them: stored with capitals, before this release."""
    u = User(
        email=email, password_hash=hash_password(password),
        business_name="Café Solsikke", business_type="cafe", currency="DKK",
        email_verified=True, **kw,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _claims(sub, email):
    return {"sub": sub, "email": email, "email_verified": True, "name": "",
            "jti": f"jti-{sub}", "exp": None}


# ── The helper ───────────────────────────────────────────────────────


def test_normalize_and_lookup(db_session):
    _existing(db_session)
    assert normalize_login_email("  Ole.Hansen@Gmail.COM ") == "ole.hansen@gmail.com"
    assert normalize_login_email(None) == ""
    for typed in ("ole.hansen@gmail.com", "OLE.HANSEN@GMAIL.COM", " Ole.Hansen@gmail.com "):
        u = user_by_email(db_session, typed)
        assert u is not None and u.email == "Ole.Hansen@gmail.com", typed
    assert user_by_email(db_session, "") is None
    assert user_by_email(db_session, "someone.else@gmail.com") is None


# ── Register ─────────────────────────────────────────────────────────


def test_signed_up_as_Ole_logs_in_as_ole(db_session, client):
    r = client.post("/api/auth/register", json={
        "email": "Ole.Hansen@Gmail.com", "password": "Kaffe2026", "business_name": "Café Solsikke",
        "accept_terms": True,
    })
    assert r.status_code == 201, r.text
    # Stored lower-cased (a NEW address).
    u = db_session.query(User).one()
    assert u.email == "ole.hansen@gmail.com"
    for typed in ("ole.hansen@gmail.com", "OLE.HANSEN@GMAIL.COM", "Ole.Hansen@Gmail.com"):
        # A session cookie on the request sends the write guard to the real
        # DB (not this test's); each sign-in starts signed out.
        client.cookies.clear()
        r = client.post("/api/auth/login", json={"email": typed, "password": "Kaffe2026"})
        assert r.status_code == 200, (typed, r.text)
        assert r.json()["user"]["id"] == str(u.id)


def test_register_leaves_out_type_and_currency_gets_the_defaults(db_session, client):
    """/register no longer sends business_type or currency (push 6, B1):
    the schema's defaults — restaurant (food service, 06:00) and DKK — apply."""
    r = client.post("/api/auth/register", json={
        "email": "kaffe.bar@gmail.com", "password": "Kaffe2026", "business_name": "Kaffebaren",
        "accept_terms": True, "ui_language": "da",
    })
    assert r.status_code == 201, r.text
    u = db_session.query(User).one()
    assert u.business_type == "restaurant"
    assert u.currency == "DKK"


def test_register_refuses_a_case_variant_of_an_existing_account(db_session, client):
    _existing(db_session)
    client.cookies.clear()
    r = client.post("/api/auth/register", json={
        "email": "ole.hansen@gmail.com", "password": "Kaffe2026", "business_name": "Café 2",
    })
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "Email already registered"
    assert _count(db_session, "ole.hansen@gmail.com") == 1


# ── Existing mixed-case rows: found, never rewritten ─────────────────


def test_existing_capitals_row_logs_in_lowercase_and_is_not_rewritten(db_session, client):
    u = _existing(db_session)
    r = client.post("/api/auth/login", json={"email": "ole.hansen@gmail.com", "password": "Kaffe2026"})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["id"] == str(u.id)
    db_session.expire_all()
    assert db_session.get(User, u.id).email == "Ole.Hansen@gmail.com"
    # a wrong password is still the same generic 401
    client.cookies.clear()
    r = client.post("/api/auth/login", json={"email": "ole.hansen@gmail.com", "password": "Forkert123"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid email or password"


def test_forgot_and_reset_ignore_case(db_session, client):
    u = _existing(db_session)
    client.cookies.clear()
    r = client.post("/api/auth/forgot-password", json={"email": "OLE.HANSEN@gmail.com"})
    assert r.status_code == 200, r.text
    db_session.expire_all()
    token = db_session.get(User, u.id).reset_token
    assert token, "the reset code went to the Ole@ account"
    r = client.post("/api/auth/reset-password", json={
        "email": "ole.hansen@GMAIL.com", "reset_token": token, "new_password": "NyKaffe2026",
    })
    # (the reset signs this device straight in)
    assert r.status_code == 200, r.text
    client.cookies.clear()
    r = client.post("/api/auth/login", json={"email": "ole.hansen@gmail.com", "password": "NyKaffe2026"})
    assert r.status_code == 200, r.text
    db_session.expire_all()
    assert db_session.get(User, u.id).email == "Ole.Hansen@gmail.com"


# ── No duplicate account via the e-mail link, Google or Apple ────────


def test_magic_link_for_lowercase_signs_in_to_the_capitals_account(db_session, client, magic_mail):
    u = _existing(db_session)
    r = client.post("/api/auth/magic-link/request", json={"email": "ole.hansen@gmail.com"})
    assert r.status_code == 200, r.text
    _, html = magic_mail[-1]
    token = re.search(r"token=([A-Za-z0-9_-]{30,})", html).group(1)
    client.cookies.clear()
    r = client.post("/api/auth/magic-link/verify", json={"token": token})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["id"] == str(u.id)
    assert _count(db_session, "ole.hansen@gmail.com") == 1


def test_google_for_lowercase_finds_the_capitals_account(db_session, client):
    # An account that already signs in with Google: Google's lower-cased
    # address finds it — no second row.
    u = _existing(db_session, oauth_provider="google")
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-ole-1", "ole.hansen@gmail.com")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["id"] == str(u.id)
    assert _count(db_session, "ole.hansen@gmail.com") == 1


def test_google_on_a_capitals_password_account_refuses_and_never_makes_a_second(db_session, client):
    _existing(db_session)  # a password account
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-ole-2", "ole.hansen@gmail.com")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub", "accept_terms": True})
    # The existing no-silent-link rule answers; before this release the
    # exact-match lookup missed the row and a new, empty account was made.
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "account_exists_login_first"
    assert _count(db_session, "ole.hansen@gmail.com") == 1


def test_apple_for_lowercase_finds_the_capitals_account(db_session, client):
    u = _existing(db_session, email="Mette@icloud.com", oauth_provider="apple")
    with patch("app.routers.auth_oauth.verify_apple_token",
               return_value=_claims("a-mette-1", "mette@icloud.com")):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "stub"})
    assert r.status_code == 200, r.text
    assert r.json()["user"]["id"] == str(u.id)
    assert _count(db_session, "mette@icloud.com") == 1


# ── A changed login e-mail ───────────────────────────────────────────


def _bearer(client, email, password="Kaffe2026"):
    client.cookies.clear()
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    client.cookies.clear()
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_change_to_a_case_variant_of_another_account_is_refused(db_session, client):
    _existing(db_session, email="Taken@gmail.com")
    _existing(db_session, email="ole@gmail.com")
    h = _bearer(client, "ole@gmail.com")
    r = client.patch("/api/auth/profile", headers=h,
                     json={"email": "taken@GMAIL.com", "current_password": "Kaffe2026"})
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Email already in use"


def test_a_new_login_email_is_stored_lowercase_and_a_case_only_change_is_no_change(db_session, client):
    u = _existing(db_session, email="Ole@gmail.com")
    h = _bearer(client, "ole@gmail.com")
    # Case only: nothing changes — still confirmed, no code mailed.
    r = client.patch("/api/auth/profile", headers=h, json={"email": "OLE@gmail.com"})
    assert r.status_code == 200, r.text
    db_session.expire_all()
    row = db_session.get(User, u.id)
    assert row.email == "Ole@gmail.com" and row.email_verified is True
    # A real change: stored lower-cased, unconfirmed until its code.
    r = client.patch("/api/auth/profile", headers=h,
                     json={"email": "Ny.Adresse@Gmail.com", "current_password": "Kaffe2026"})
    assert r.status_code == 200, r.text
    db_session.expire_all()
    row = db_session.get(User, u.id)
    assert row.email == "ny.adresse@gmail.com"
    assert row.email_verified is False
