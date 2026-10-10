"""
users.terms_version + users.terms_accepted_at — the acceptance record (R-e).

LEG-11 / PQ-03: a new account records WHICH Terms version its holder
accepted and WHEN, but only when the sign-up page showed the acceptance line
and the client said so (accept_terms=true). These tests pin:

  • every account-creating path stamps it on a NEW account when the flag is
    true: register, /oauth/google, /oauth/apple, legacy /google and /apple,
    and the magic-link verify that creates the account
  • no flag (an older app build), false, or an odd value → NULL, and the
    signup still succeeds (never 422 over this field)
  • a sign-in to an existing account never writes or replaces the record
  • the version stamped is the server's TERMS_VERSION — a client cannot pick it
  • the server's TERMS_VERSION and the frontend's (frontend/src/legal/terms.js,
    shown as the Terms date) are the same value
  • the migration and the SQLite mirror carry both columns
  • the owner's own data export includes both

No mail leaves the test; Google/Apple tokens are stubbed.
"""
from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.user import User
from app.services.auth import hash_password
from app.services.terms import (
    TERMS_VERSION, apply_terms_acceptance, clean_accept_terms, is_personal_account,
)

_db_ready.set()

ODD_VALUES = [False, None, "true", "yes", 1, 0, "1", [], {}, "accept"]


@pytest.fixture
def db_session(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()
    # The role guards in app/main.py read `users` through the GLOBAL
    # app.database.SessionLocal, not get_db. Point them at this engine too —
    # otherwise this file only passed when an earlier test (or a stale
    # ci.db) had already created the tables, and run alone on a fresh DB the
    # magic-link verify and the export answered 503 role_check_unavailable.
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)

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
    for mod in ("app.routers.auth", "app.routers.auth_oauth", "app.routers.auth_magic_link"):
        try:
            __import__(mod, fromlist=["limiter"]).limiter.reset()
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


_N = {"i": 0}


def _email() -> str:
    _N["i"] += 1
    return f"terms.owner{_N['i']}@gmail.com"


def _register(client, **extra):
    body = {
        "email": _email(),
        "password": "Validpass1",
        "business_name": "Café Vilkår",
        "business_type": "cafe",
        "currency": "DKK",
        **extra,
    }
    return client.post("/api/auth/register", json=body), body["email"]


def _claims(sub, email, name=""):
    return {"sub": sub, "email": email, "email_verified": True, "name": name,
            "jti": f"jti-{sub}", "exp": None}


def _user(db_session, email):
    db_session.expire_all()
    return db_session.query(User).filter(User.email == email).first()


def _assert_accepted(u):
    assert u is not None
    assert u.terms_version == TERMS_VERSION
    assert u.terms_accepted_at is not None


def _assert_none(u):
    assert u is not None
    assert u.terms_version is None
    assert u.terms_accepted_at is None


# ── The rule itself ──────────────────────────────────────────────────


def test_only_a_real_true_counts():
    assert clean_accept_terms(True) is True
    for odd in ODD_VALUES:
        assert clean_accept_terms(odd) is None, odd


def test_apply_writes_only_on_true():
    class U:
        terms_version = None
        terms_accepted_at = None
    for odd in ODD_VALUES:
        u = U()
        assert apply_terms_acceptance(u, odd) is False
        assert u.terms_version is None and u.terms_accepted_at is None
    u = U()
    assert apply_terms_acceptance(u, True) is True
    assert u.terms_version == TERMS_VERSION and u.terms_accepted_at is not None


def test_server_and_frontend_terms_version_are_the_same():
    """The date the Terms page shows and the version the server stamps must
    be one value. frontend/src/legal/terms.js exports TERMS_VERSION."""
    src = (Path(__file__).resolve().parents[2] / "frontend" / "src" / "legal" / "terms.js").read_text()
    m = re.search(r'export const TERMS_VERSION\s*=\s*"([0-9-]+)"', src)
    assert m, "frontend/src/legal/terms.js must export TERMS_VERSION"
    assert m.group(1) == TERMS_VERSION


def test_is_personal_account():
    class U:
        def __init__(self, bt):
            self.business_type = bt
    assert is_personal_account(U("personal"))
    assert is_personal_account(U(" Personal "))
    for bt in ("restaurant", "cafe", "", None, "personal_trainer"):
        assert not is_personal_account(U(bt)), bt


# ── Register ─────────────────────────────────────────────────────────


def test_register_with_accept_terms_stamps_the_version(db_session, client):
    r, email = _register(client, accept_terms=True)
    assert r.status_code == 201, r.text
    # Not echoed to the client.
    assert "terms_version" not in r.json()["user"]
    _assert_accepted(_user(db_session, email))


def test_register_without_the_flag_records_nothing(db_session, client):
    # An older app build that does not send accept_terms.
    r, email = _register(client)
    assert r.status_code == 201, r.text
    _assert_none(_user(db_session, email))


@pytest.mark.parametrize("odd", ODD_VALUES)
def test_register_with_an_odd_flag_signs_up_and_records_nothing(db_session, client, odd):
    r, email = _register(client, accept_terms=odd)
    assert r.status_code == 201, (odd, r.text)
    _assert_none(_user(db_session, email))


def test_client_cannot_choose_the_version(db_session, client):
    r, email = _register(client, accept_terms=True, terms_version="1999-01-01")
    assert r.status_code == 201, r.text
    assert _user(db_session, email).terms_version == TERMS_VERSION


# ── Google / Apple (unified + legacy routes) ─────────────────────────


def test_oauth_google_new_account(db_session, client):
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-terms-1", "g.terms1@gmail.com", "Kaffebaren")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub", "accept_terms": True})
    assert r.status_code == 200, r.text
    _assert_accepted(_user(db_session, "g.terms1@gmail.com"))


def test_oauth_google_new_account_without_flag(db_session, client):
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-terms-2", "g.terms2@gmail.com")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub"})
    assert r.status_code == 200, r.text
    _assert_none(_user(db_session, "g.terms2@gmail.com"))


def test_oauth_apple_new_account(db_session, client):
    with patch("app.routers.auth_oauth.verify_apple_token",
               return_value=_claims("a-terms-1", "a.terms1@icloud.com")):
        r = client.post("/api/auth/oauth/apple",
                        json={"id_token": "stub", "name": "Bageriet", "accept_terms": True})
    assert r.status_code == 200, r.text
    _assert_accepted(_user(db_session, "a.terms1@icloud.com"))


def test_legacy_google_new_account(db_session, client):
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-terms-legacy", "legacy.terms.g@gmail.com", "Legacy")):
        r = client.post("/api/auth/google", json={"credential": "stub", "accept_terms": True})
    assert r.status_code == 200, r.text
    _assert_accepted(_user(db_session, "legacy.terms.g@gmail.com"))


def test_legacy_apple_new_account(db_session, client):
    with patch("app.routers.auth._verify_apple_identity_token",
               return_value={"sub": "legacy-terms-a", "email": "legacy.terms.a@icloud.com",
                             "email_verified": "true"}):
        r = client.post("/api/auth/apple",
                        json={"identity_token": "stub", "full_name": "Legacy", "accept_terms": True})
    assert r.status_code == 200, r.text
    _assert_accepted(_user(db_session, "legacy.terms.a@icloud.com"))


def test_sign_in_to_existing_account_never_writes_the_record(db_session, client):
    from datetime import datetime
    stamped_at = datetime(2026, 5, 13, 9, 0, 0)
    db_session.add_all([
        User(email="g.old.terms@gmail.com", password_hash=hash_password("x" * 12),
             business_name="Old", business_type="cafe", currency="DKK",
             email_verified=True, google_sub="g-old-terms", oauth_provider="google",
             terms_version="2026-05-13", terms_accepted_at=stamped_at),
        User(email="g.none.terms@gmail.com", password_hash=hash_password("x" * 12),
             business_name="None", business_type="cafe", currency="DKK",
             email_verified=True, google_sub="g-none-terms", oauth_provider="google"),
    ])
    db_session.commit()
    for sub, email in (("g-old-terms", "g.old.terms@gmail.com"), ("g-none-terms", "g.none.terms@gmail.com")):
        client.cookies.clear()
        with patch("app.routers.auth_oauth.verify_google_token", return_value=_claims(sub, email)):
            r = client.post("/api/auth/oauth/google", json={"id_token": "stub", "accept_terms": True})
        assert r.status_code == 200, r.text
    old = _user(db_session, "g.old.terms@gmail.com")
    assert old.terms_version == "2026-05-13" and old.terms_accepted_at == stamped_at
    # A sign-in is not a signup: no record appears.
    _assert_none(_user(db_session, "g.none.terms@gmail.com"))


# ── Magic link ───────────────────────────────────────────────────────


def _magic_token(client, magic_mail, email):
    r = client.post("/api/auth/magic-link/request", json={"email": email})
    assert r.status_code == 200, r.text
    _to, html = magic_mail[-1]
    return re.search(r"token=([A-Za-z0-9_-]{30,})", html).group(1)


def test_magic_link_new_account_with_and_without_flag(db_session, client, magic_mail):
    e1 = _email()
    token = _magic_token(client, magic_mail, e1)
    client.cookies.clear()
    r = client.post("/api/auth/magic-link/verify", json={"token": token, "accept_terms": True})
    assert r.status_code == 200, r.text
    _assert_accepted(_user(db_session, e1))

    e2 = _email()
    token = _magic_token(client, magic_mail, e2)
    client.cookies.clear()
    r = client.post("/api/auth/magic-link/verify", json={"token": token})
    assert r.status_code == 200, r.text
    _assert_none(_user(db_session, e2))


def test_magic_link_request_carries_the_terms_flag_into_the_mailed_link(db_session, client, magic_mail):
    """R-e fix-up: /login shows the Terms line under "send me a link", and
    the request says so (accept_terms=true). The mailed link carries a fixed
    &terms=1, so the tab that opens it can send accept_terms back on verify.
    Without the flag (an older page) — or with any odd value — no &terms=."""
    r = client.post("/api/auth/magic-link/request", json={"email": _email(), "accept_terms": True})
    assert r.status_code == 200, r.text
    assert "&terms=1" in magic_mail[-1][1]
    for body in ({}, {"accept_terms": False}, {"accept_terms": "true"}, {"accept_terms": 1}):
        r = client.post("/api/auth/magic-link/request", json={"email": _email(), **body})
        assert r.status_code == 200, (body, r.text)
        assert "terms=" not in magic_mail[-1][1], body


def test_magic_link_requested_with_the_line_and_verified_creates_an_accepted_account(
    db_session, client, magic_mail,
):
    """The whole e-mail-link path from /login: request with the flag → the
    link carries &terms=1 → verify with accept_terms → new account stamped."""
    e = _email()
    r = client.post("/api/auth/magic-link/request", json={"email": e, "accept_terms": True})
    assert r.status_code == 200, r.text
    html = magic_mail[-1][1]
    assert "&terms=1" in html
    token = re.search(r"token=([A-Za-z0-9_-]{30,})", html).group(1)
    client.cookies.clear()
    r = client.post("/api/auth/magic-link/verify", json={"token": token, "accept_terms": True})
    assert r.status_code == 200, r.text
    _assert_accepted(_user(db_session, e))


def test_magic_link_sign_in_to_existing_account_never_writes(db_session, client, magic_mail):
    db_session.add(User(email="ml.terms@gmail.com", password_hash=hash_password("x" * 12),
                        business_name="Old", business_type="cafe", currency="DKK",
                        email_verified=True))
    db_session.commit()
    token = _magic_token(client, magic_mail, "ml.terms@gmail.com")
    client.cookies.clear()
    r = client.post("/api/auth/magic-link/verify", json={"token": token, "accept_terms": True})
    assert r.status_code == 200, r.text
    _assert_none(_user(db_session, "ml.terms@gmail.com"))


# ── Schema + the owner's own copy ────────────────────────────────────


def test_migration_and_sqlite_mirror_carry_both_columns():
    import inspect
    import app.main as m
    src = inspect.getsource(m)
    assert "ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version VARCHAR(16)" in src
    assert "ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP" in src
    assert '_add("users", "terms_version", "VARCHAR(16)")' in src
    assert '_add("users", "terms_accepted_at", "TIMESTAMP")' in src
    assert User.__table__.c.terms_version.nullable is True
    assert User.__table__.c.terms_accepted_at.nullable is True
    # The stamped value fits the column (SQLite would hide an overflow).
    assert len(TERMS_VERSION) <= User.__table__.c.terms_version.type.length


def test_owner_data_export_includes_the_record(db_session, client):
    r, _email_addr = _register(client, accept_terms=True)
    token = r.json()["access_token"]
    client.cookies.clear()
    e = client.get("/api/auth/export-data", headers={"Authorization": f"Bearer {token}"})
    assert e.status_code == 200, e.text
    assert "terms_version" in e.text and "terms_accepted_at" in e.text
    assert TERMS_VERSION in e.text
