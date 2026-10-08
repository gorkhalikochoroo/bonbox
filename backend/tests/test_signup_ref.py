"""
users.signup_ref — the printed door-visit code survives to the account.

Fieldwork, Oct 2026: the leave-behind QR opens /register?ref=r1-a-03. The
frontend keeps the code and sends it with the register call or the Google /
Apple completion. These tests pin what the backend does with it:

  • a valid code is stored on a NEW account (register, /oauth/google,
    /oauth/apple, legacy /google and /apple, and the magic-link verify —
    whose mailed link carries the code as &ref=)
  • it survives e-mail verification
  • an invalid code is ignored — the signup still succeeds, nothing stored
  • a sign-in to an existing account never adds or replaces a code
  • the migration and the SQLite mirror both carry the column
  • the owner's own data export includes it (it is stored about them)
  • a valid code is always stored on a new account (no end date), and the
    nightly maintenance clears it once the account is more than 12 months
    (SIGNUP_REF_RETENTION_DAYS = 365) old — Manoj's decision 2, 8 Oct 2026,
    promised on /privacy and /cookies

No mail leaves the test: send_email is replaced by a list.

Run:
  cd backend && python3 -m pytest tests/test_signup_ref.py -x -q
"""
from __future__ import annotations

from datetime import datetime, timedelta
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
from app.services.signup_ref import (
    SIGNUP_REF_RETENTION_DAYS, apply_signup_ref, clean_signup_ref, purge_signup_refs, ref_prefix,
)

_db_ready.set()

INVALID_REFS = [
    "", "   ", "R1-A-03", "r1_a_03", "r1 a 03", "a" * 25, "<script>",
    "jens@cafe.dk", "r1-a\n03", "æøå", 42, None, ["r1-a-03"], {"ref": "x"},
]


# ── Fixtures ─────────────────────────────────────────────────────────


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
    for mod in ("app.routers.auth", "app.routers.auth_oauth", "app.routers.auth_magic_link"):
        try:
            __import__(mod, fromlist=["limiter"]).limiter.reset()
        except Exception:  # noqa: BLE001
            pass
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def no_mail(monkeypatch):
    """Every mail the auth router would send lands here instead."""
    sent: list[tuple] = []
    monkeypatch.setattr("app.routers.auth.send_email", lambda *a, **k: sent.append((a, k)))
    # The legacy /google route now runs auth_oauth.google_signin, whose
    # signup mails go through email_service.send_email (looked up per call).
    monkeypatch.setattr("app.services.email_service.send_email", lambda *a, **k: sent.append((a, k)))
    return sent


@pytest.fixture(autouse=True)
def magic_mail(monkeypatch):
    """Every magic-link mail lands here instead: (to, html)."""
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
    # gmail.com is on the MX allow-list, so no DNS lookup happens.
    _N["i"] += 1
    return f"fieldwork.owner{_N['i']}@gmail.com"


def _register(client, **extra):
    body = {
        "email": _email(),
        "password": "Validpass1",
        "business_name": "Café Test",
        "business_type": "cafe",
        "currency": "DKK",
        **extra,
    }
    return client.post("/api/auth/register", json=body), body["email"]


def _claims(sub, email, name=""):
    return {"sub": sub, "email": email, "email_verified": True, "name": name,
            "jti": f"jti-{sub}", "exp": None}


# ── The rule itself ──────────────────────────────────────────────────


def test_clean_accepts_only_the_pattern():
    for ok in ("r1-a-03", "r2-b-10", "a", "0", "-", "x" * 24, "  r1-a-03  "):
        assert clean_signup_ref(ok) == ok.strip()
    for bad in INVALID_REFS:
        assert clean_signup_ref(bad) is None, bad


def test_apply_never_overwrites():
    class U:
        signup_ref = "r1-a-01"
    u = U()
    assert apply_signup_ref(u, "r2-b-05") is False
    assert u.signup_ref == "r1-a-01"


def test_prefix_is_round_and_argument():
    assert ref_prefix("r1-a-03") == "r1-a"
    assert ref_prefix("r2-b-10") == "r2-b"
    assert ref_prefix("flyer-01") == "other"
    assert ref_prefix(None) is None


def test_qr_test_code_is_kept_and_rolls_up_under_other():
    # The frontend (utils/signupRef.js) keeps only fieldwork codes and
    # "test-NN"; a test code must be stored here and never count as a round.
    assert clean_signup_ref("test-01") == "test-01"
    assert ref_prefix("test-01") == "other"
    assert ref_prefix("test-99") == "other"


# ── Register + e-mail verification ───────────────────────────────────


def test_register_stores_ref_and_it_survives_verification(db_session, client, no_mail):
    r, email = _register(client, signup_ref="r1-a-03")
    assert r.status_code == 201, r.text
    # The ref is not echoed back to the client.
    assert "signup_ref" not in r.json()["user"]
    u = db_session.query(User).filter(User.email == email).first()
    assert u.signup_ref == "r1-a-03"
    assert u.email_verified is False

    code = u.verification_code
    token = r.json()["access_token"]
    client.cookies.clear()
    v = client.post("/api/auth/verify-email", json={"code": code},
                    headers={"Authorization": f"Bearer {token}"})
    assert v.status_code == 200, v.text
    db_session.expire_all()
    u = db_session.query(User).filter(User.email == email).first()
    assert u.email_verified is True
    assert u.signup_ref == "r1-a-03"
    # The verification mail went to the stub, not out.
    assert no_mail, "register should have tried to send the code"


def test_register_without_ref_stores_nothing(db_session, client):
    r, email = _register(client)
    assert r.status_code == 201, r.text
    assert db_session.query(User).filter(User.email == email).first().signup_ref is None


@pytest.mark.parametrize("bad", INVALID_REFS)
def test_register_with_invalid_ref_still_signs_up_and_ignores_it(db_session, client, bad):
    r, email = _register(client, signup_ref=bad)
    assert r.status_code == 201, (bad, r.text)
    assert db_session.query(User).filter(User.email == email).first().signup_ref is None


def test_a_huge_ref_is_ignored_not_rejected(db_session, client):
    r, email = _register(client, signup_ref="r" * 5000)
    assert r.status_code == 201, r.text
    assert db_session.query(User).filter(User.email == email).first().signup_ref is None


# ── Unified OAuth (/oauth/google, /oauth/apple) ───────────────────────


def test_oauth_google_new_account_gets_ref(db_session, client):
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-new-1", "g.new1@gmail.com", "Kaffebaren")):
        r = client.post("/api/auth/oauth/google",
                        json={"id_token": "stub", "signup_ref": "r2-b-04"})
    assert r.status_code == 200, r.text
    u = db_session.query(User).filter(User.email == "g.new1@gmail.com").first()
    assert u.signup_ref == "r2-b-04"


def test_oauth_apple_new_account_gets_ref(db_session, client):
    with patch("app.routers.auth_oauth.verify_apple_token",
               return_value=_claims("a-new-1", "a.new1@icloud.com")):
        r = client.post("/api/auth/oauth/apple",
                        json={"id_token": "stub", "name": "Bageriet", "signup_ref": "r1-a-07"})
    assert r.status_code == 200, r.text
    u = db_session.query(User).filter(User.email == "a.new1@icloud.com").first()
    assert u.signup_ref == "r1-a-07"


def test_oauth_invalid_ref_still_signs_up(db_session, client):
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-bad-1", "g.bad1@gmail.com")):
        r = client.post("/api/auth/oauth/google",
                        json={"id_token": "stub", "signup_ref": "Robert'); DROP TABLE users;--"})
    assert r.status_code == 200, r.text
    assert db_session.query(User).filter(User.email == "g.bad1@gmail.com").first().signup_ref is None


def test_oauth_sign_in_to_existing_account_never_overwrites(db_session, client):
    existing = User(
        email="g.old@gmail.com", password_hash=hash_password("x" * 12),
        business_name="Old", business_type="cafe", currency="DKK",
        email_verified=True, google_sub="g-old", oauth_provider="google",
        signup_ref="r1-a-01",
    )
    no_ref = User(
        email="g.noref@gmail.com", password_hash=hash_password("x" * 12),
        business_name="NoRef", business_type="cafe", currency="DKK",
        email_verified=True, google_sub="g-noref", oauth_provider="google",
    )
    db_session.add_all([existing, no_ref])
    db_session.commit()

    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-old", "g.old@gmail.com")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub", "signup_ref": "r2-b-09"})
    assert r.status_code == 200, r.text
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-noref", "g.noref@gmail.com")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "stub", "signup_ref": "r2-b-09"})
    assert r.status_code == 200, r.text

    db_session.expire_all()
    assert db_session.query(User).filter(User.email == "g.old@gmail.com").first().signup_ref == "r1-a-01"
    # A sign-in is not a signup: an account without a ref does not gain one.
    assert db_session.query(User).filter(User.email == "g.noref@gmail.com").first().signup_ref is None


# ── Legacy /google and /apple (still used by the web Google fallback + iOS) ──


# The legacy /google route now runs auth_oauth.google_signin (security
# round, 8 Oct), so its token is checked by auth_oauth.verify_google_token —
# stubbed there, with the claims a real Google token carries (sub, verified).


def test_legacy_google_new_account_gets_ref(db_session, client):
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-legacy-new", "legacy.g@gmail.com", "Legacy")):
        r = client.post("/api/auth/google", json={"credential": "stub", "signup_ref": "r1-a-02"})
    assert r.status_code == 200, r.text
    assert db_session.query(User).filter(User.email == "legacy.g@gmail.com").first().signup_ref == "r1-a-02"


def test_legacy_apple_new_account_gets_ref(db_session, client):
    # email_verified: the legacy route now refuses an address Apple does not
    # vouch for (security round, 8 Oct).
    with patch("app.routers.auth._verify_apple_identity_token",
               return_value={"sub": "legacy-a-1", "email": "legacy.a@icloud.com",
                             "email_verified": "true"}):
        r = client.post("/api/auth/apple",
                        json={"identity_token": "stub", "full_name": "Legacy", "signup_ref": "r2-b-02"})
    assert r.status_code == 200, r.text
    assert db_session.query(User).filter(User.email == "legacy.a@icloud.com").first().signup_ref == "r2-b-02"


def test_legacy_google_existing_account_keeps_its_ref(db_session, client):
    # A Google-made account (the legacy route stamped oauth_provider="google"
    # before google_sub existed) signing in again: linked by its verified
    # e-mail, never given the new ref.
    db_session.add(User(
        email="legacy.old@gmail.com", password_hash=hash_password("x" * 12),
        business_name="Old", business_type="cafe", currency="DKK",
        email_verified=True, oauth_provider="google", signup_ref="r1-a-05",
    ))
    db_session.add(User(
        email="legacy.noref@gmail.com", password_hash=hash_password("x" * 12),
        business_name="NoRef", business_type="cafe", currency="DKK",
        email_verified=True, oauth_provider="google",
    ))
    db_session.commit()
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-legacy-old", "legacy.old@gmail.com", "Old")):
        r = client.post("/api/auth/google", json={"credential": "stub", "signup_ref": "r2-b-01"})
    assert r.status_code == 200, r.text
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-legacy-noref", "legacy.noref@gmail.com", "NoRef")):
        r = client.post("/api/auth/google", json={"credential": "stub", "signup_ref": "r2-b-01"})
    assert r.status_code == 200, r.text
    db_session.expire_all()
    assert db_session.query(User).filter(User.email == "legacy.old@gmail.com").first().signup_ref == "r1-a-05"
    # A sign-in is not a signup: an account without a ref does not gain one.
    assert db_session.query(User).filter(User.email == "legacy.noref@gmail.com").first().signup_ref is None


def test_legacy_google_refused_link_never_stamps_a_ref(db_session, client):
    # A PASSWORD account is never silently linked by the legacy route any
    # more (409) — and the refused attempt leaves its ref alone.
    db_session.add(User(
        email="legacy.pw@gmail.com", password_hash=hash_password("x" * 12),
        business_name="Pw", business_type="cafe", currency="DKK",
        email_verified=True,
    ))
    db_session.commit()
    with patch("app.routers.auth_oauth.verify_google_token",
               return_value=_claims("g-legacy-pw", "legacy.pw@gmail.com", "Pw")):
        r = client.post("/api/auth/google", json={"credential": "stub", "signup_ref": "r2-b-03"})
    assert r.status_code == 409, r.text
    db_session.expire_all()
    assert db_session.query(User).filter(User.email == "legacy.pw@gmail.com").first().signup_ref is None


# ── Magic link (e-mail me a link) — also a self-signup ───────────────


def _magic_link(client, magic_mail, email, **extra):
    """Request a link; return (token, the mailed URL)."""
    import re
    r = client.post("/api/auth/magic-link/request", json={"email": email, **extra})
    assert r.status_code == 200, r.text
    to, html = magic_mail[-1]
    assert to == email
    url = re.search(r'href="([^"]*/login/magic\?token=[^"]+)"', html).group(1)
    token = re.search(r"token=([A-Za-z0-9_-]{30,})", url).group(1)
    return token, url


def test_magic_link_new_account_gets_ref_and_the_link_carries_it(db_session, client, magic_mail):
    email = _email()
    token, url = _magic_link(client, magic_mail, email, signup_ref="r1-a-07")
    # The link is opened in whatever tab/browser the mail app picks — the
    # code travels in it, not in that device's storage.
    assert url.endswith("&ref=r1-a-07"), url
    client.cookies.clear()
    r = client.post("/api/auth/magic-link/verify", json={"token": token, "signup_ref": "r1-a-07"})
    assert r.status_code == 200, r.text
    u = db_session.query(User).filter(User.email == email).first()
    assert u is not None and u.signup_ref == "r1-a-07"


def test_magic_link_without_or_with_a_bad_ref_signs_up_and_stores_nothing(db_session, client, magic_mail):
    for extra in ({}, {"signup_ref": "R1_A<03>"}, {"signup_ref": "a" * 300}):
        email = _email()
        token, url = _magic_link(client, magic_mail, email, **extra)
        assert "ref=" not in url, url
        client.cookies.clear()
        r = client.post("/api/auth/magic-link/verify", json={"token": token, **extra})
        assert r.status_code == 200, r.text
        assert db_session.query(User).filter(User.email == email).first().signup_ref is None


def test_magic_link_sign_in_to_existing_account_is_never_stamped(db_session, client, magic_mail):
    for email, kept in (("ml.noref@gmail.com", None), ("ml.ref@gmail.com", "r1-a-02")):
        db_session.add(User(
            email=email, password_hash=hash_password("x" * 12),
            business_name="Old", business_type="cafe", currency="DKK",
            email_verified=True, signup_ref=kept,
        ))
    db_session.commit()
    for email, kept in (("ml.noref@gmail.com", None), ("ml.ref@gmail.com", "r1-a-02")):
        token, _ = _magic_link(client, magic_mail, email, signup_ref="r2-b-09")
        client.cookies.clear()
        r = client.post("/api/auth/magic-link/verify", json={"token": token, "signup_ref": "r2-b-09"})
        assert r.status_code == 200, r.text
        db_session.expire_all()
        assert db_session.query(User).filter(User.email == email).first().signup_ref == kept


# ── Schema + the owner's own copy ────────────────────────────────────


def test_migration_and_sqlite_mirror_carry_signup_ref():
    import inspect
    import app.main as m
    src = inspect.getsource(m)
    assert "ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_ref VARCHAR(24)" in src
    assert '_add("users", "signup_ref", "VARCHAR(24)")' in src
    assert User.__table__.c.signup_ref.nullable is True
    assert User.__table__.c.signup_ref.type.length == 24


def test_owner_data_export_includes_the_ref(db_session, client):
    r, email = _register(client, signup_ref="r1-a-03")
    token = r.json()["access_token"]
    client.cookies.clear()
    e = client.get("/api/auth/export-data", headers={"Authorization": f"Bearer {token}"})
    assert e.status_code == 200, e.text
    text = e.text
    assert "signup_ref" in text and "r1-a-03" in text


# ── Retention: deleted 12 months after the account was created ─────
#
# Manoj's decision 2 (8 Oct 2026) replaced the fixed 31 Jan 2027 date: the
# code is kept on an account for 12 months after signup. /privacy and
# /cookies say "deleted 12 months after you create your account".


def _age_account(db_session, email, days, now):
    u = db_session.query(User).filter(User.email == email).one()
    u.created_at = now - timedelta(days=days)
    db_session.commit()
    return u


def _ref_of(db_session, email):
    db_session.expire_all()
    return db_session.query(User).filter(User.email == email).one().signup_ref


def test_retention_is_the_12_months_the_privacy_policy_promises():
    assert SIGNUP_REF_RETENTION_DAYS == 365


def test_apply_always_stores_a_valid_code_for_a_new_account(monkeypatch):
    # No end date: even with the clock past the old 31 Jan 2027 rule, a new
    # account keeps the code it signed up with.
    import app.utils.time as _time
    monkeypatch.setattr(_time, "utc_now", lambda: datetime(2027, 2, 1, 12, 0))

    class U:
        signup_ref = None
    u = U()
    assert apply_signup_ref(u, "r1-a-03") is True
    assert u.signup_ref == "r1-a-03"
    # …and still never overwrites, never stores an invalid code.
    assert apply_signup_ref(u, "r2-b-07") is False
    assert u.signup_ref == "r1-a-03"
    fresh = U()
    assert apply_signup_ref(fresh, "R1-A-03") is False
    assert fresh.signup_ref is None


def test_purge_clears_only_accounts_older_than_12_months(db_session, client):
    now = datetime(2027, 10, 20, 3, 0)
    _, young = _register(client, signup_ref="r1-a-03")
    _, on_day = _register(client, signup_ref="r1-a-04")
    _, old = _register(client, signup_ref="r2-b-07")
    _, no_code = _register(client)
    _age_account(db_session, young, 364, now)
    _age_account(db_session, on_day, 365, now)
    _age_account(db_session, old, 366, now)
    _age_account(db_session, no_code, 400, now)

    assert purge_signup_refs(db_session, now) == 1
    db_session.commit()
    assert _ref_of(db_session, young) == "r1-a-03"   # 364 days: kept
    assert _ref_of(db_session, on_day) == "r1-a-04"  # exactly 365 days: kept until next night
    assert _ref_of(db_session, old) is None          # 366 days: cleared
    assert _ref_of(db_session, no_code) is None
    assert db_session.query(User).count() == 4  # accounts stay, only the code goes
    # Idempotent: nothing more is due the same night.
    assert purge_signup_refs(db_session, now) == 0
    # Two nights later the 365-day account is past the line too; the 364-day
    # one (now 366) as well.
    assert purge_signup_refs(db_session, now + timedelta(days=2)) == 2
    db_session.commit()
    assert db_session.query(User).filter(User.signup_ref.isnot(None)).count() == 0


def test_nightly_job_boundary_364_kept_366_cleared(db_session, client, monkeypatch):
    import inspect
    import app.jobs.retention_and_patterns as job

    now = datetime(2027, 10, 20, 3, 0)
    _, kept = _register(client, signup_ref="r1-a-05")
    _, cleared = _register(client, signup_ref="r2-b-08")
    _age_account(db_session, kept, 364, now)
    _age_account(db_session, cleared, 366, now)
    monkeypatch.setattr(job, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(job, "utc_now", lambda: now)

    assert job.purge_expired_signup_refs() == 1
    assert _ref_of(db_session, kept) == "r1-a-05"
    assert _ref_of(db_session, cleared) is None
    assert job.purge_expired_signup_refs() == 0
    # …and daily_maintenance calls it.
    assert "purge_expired_signup_refs()" in inspect.getsource(job.daily_maintenance)
