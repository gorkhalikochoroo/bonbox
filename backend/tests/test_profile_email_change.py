"""Changing the login email needs the current password.

The login email is where a password reset goes. PATCH /auth/profile changed it
with nothing but a session, so whoever held one — the shared iPad passed to
staff, a phone left unlocked — could set their own address and then reset the
password: a takeover in two steps. (Security review, Sep 2026.)

The profile form always sends `email`, so saving anything else with the email
unchanged must keep working without a password.

  cd backend && pytest tests/test_profile_email_change.py -v
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.testclient import TestClient

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services.auth import create_access_token, hash_password

_db_ready.set()


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    # The write guards open their own SessionLocal(); point it here too.
    import app.database as _dbmod
    orig = _dbmod.SessionLocal
    _dbmod.SessionLocal = SessionLocal
    from app.routers import auth as auth_router
    auth_router.limiter.reset()
    try:
        yield s
    finally:
        _dbmod.SessionLocal = orig
        auth_router.limiter.reset()
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def owner(db):
    u = User(email="owner@bonbox.dk", password_hash=hash_password("ownerpw123"),
             business_name="Bon Café", business_type="restaurant", currency="DKK",
             plan="pro", role="owner", email_verified=True)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _patch(body, owner):
    return TestClient(app).patch(
        "/api/auth/profile", json=body,
        headers={"Authorization": f"Bearer {create_access_token(str(owner.id), 0)}"},
    )


def test_a_session_alone_cannot_change_the_login_email(db, owner):
    r = _patch({"email": "attacker@example.com"}, owner)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "password_required"
    r = _patch({"email": "attacker@example.com", "current_password": "guess"}, owner)
    assert r.status_code == 403
    db.refresh(owner)
    assert owner.email == "owner@bonbox.dk"


def test_the_owner_changes_it_with_the_password(db, owner):
    r = _patch({"email": "new@bonbox.dk", "current_password": "ownerpw123"}, owner)
    assert r.status_code == 200, r.text
    db.refresh(owner)
    assert owner.email == "new@bonbox.dk"
    assert db.query(AuditLog).filter(AuditLog.action == "auth.email_changed").count() == 1


def test_saving_the_form_with_the_same_email_needs_no_password(db, owner):
    r = _patch({"email": "owner@bonbox.dk", "business_name": "Bon Bistro"}, owner)
    assert r.status_code == 200, r.text
    db.refresh(owner)
    assert owner.business_name == "Bon Bistro"


# ── A changed address is unconfirmed until its code is entered ───────
# (review, 8 Oct). Keeping email_verified=True let an owner who confirmed
# once switch to any address and still pass the verified-sender rule, and
# let a later Google sign-in for that address land in this account.


@pytest.fixture
def mails(monkeypatch):
    out = []

    def _fake(to, subject, html, **kw):
        out.append((to, subject, html))
        return True

    monkeypatch.setattr("app.services.email_service.send_email", _fake)
    monkeypatch.setattr("app.routers.auth.send_email", _fake)
    return out


def test_a_changed_email_is_unconfirmed_and_its_code_goes_to_the_new_address(db, owner, mails):
    r = _patch({"email": "new@bonbox.dk", "current_password": "ownerpw123"}, owner)
    assert r.status_code == 200, r.text
    assert r.json()["email_verified"] is False
    db.refresh(owner)
    assert owner.email == "new@bonbox.dk"
    assert owner.email_verified is False
    assert owner.verification_code and owner.verification_code_expires
    assert [to for to, _, _ in mails] == ["new@bonbox.dk"]
    assert owner.verification_code in mails[0][2]
    # Entering that code confirms the new address.
    r2 = TestClient(app).post(
        "/api/auth/verify-email", json={"code": owner.verification_code},
        headers={"Authorization": f"Bearer {create_access_token(str(owner.id), 0)}"},
    )
    assert r2.status_code == 200, r2.text
    db.refresh(owner)
    assert owner.email_verified is True


def test_the_unconfirmed_new_address_cannot_send_to_third_parties(db, owner, mails):
    from fastapi import HTTPException
    from app.services.revisor_mail import require_verified_sender
    require_verified_sender(owner)  # confirmed before the change
    _patch({"email": "new@bonbox.dk", "current_password": "ownerpw123"}, owner)
    db.refresh(owner)
    with pytest.raises(HTTPException) as e:
        require_verified_sender(owner)
    assert e.value.status_code == 403


def test_saving_the_form_unchanged_keeps_the_address_confirmed(db, owner, mails):
    r = _patch({"email": "owner@bonbox.dk", "business_name": "Bon Bistro"}, owner)
    assert r.status_code == 200, r.text
    db.refresh(owner)
    assert owner.email_verified is True
    assert mails == []


def test_a_few_email_changes_a_day(db, owner, mails):
    for i in range(3):
        r = _patch({"email": f"n{i}@bonbox.dk", "current_password": "ownerpw123"}, owner)
        assert r.status_code == 200, r.text
    r = _patch({"email": "n9@bonbox.dk", "current_password": "ownerpw123"}, owner)
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "email_change_daily_cap"
    db.refresh(owner)
    assert owner.email == "n2@bonbox.dk"
    assert len(mails) == 3


def test_a_changed_unconfirmed_address_never_catches_a_google_signin(db, owner, mails, monkeypatch):
    """The reviewer's chain: a Google-made account (it set a password via
    reset) switches its login e-mail to the victim's address. The victim's
    later, Google-verified sign-in for that address must NOT land in it."""
    from app.config import settings
    from app.services.oauth_jti_cache import _reset_for_tests
    from tests.test_oauth_signin import _google_claims, _patch_google
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "google-test-client.apps.googleusercontent.com",
                        raising=False)
    _reset_for_tests()
    owner.oauth_provider = "google"
    owner.google_sub = "g-attacker"
    db.commit()
    r = _patch({"email": "victim@example.com", "current_password": "ownerpw123"}, owner)
    assert r.status_code == 200, r.text
    db.refresh(owner)
    assert owner.email_verified is False
    for n, (path, body) in enumerate((("/api/auth/oauth/google", {"id_token": "x"}),
                                      ("/api/auth/google", {"credential": "x"}))):
        with _patch_google(_google_claims(f"g-victim-{n}", email="victim@example.com")):
            r = TestClient(app).post(path, json=body)
        assert r.status_code == 409, (path, r.text)
        assert r.json()["detail"]["code"] == "account_exists_login_first"
        assert "access_token" not in r.text
    db.refresh(owner)
    assert owner.google_sub == "g-attacker"


# ── /auth/resend-verification: a per-account daily ceiling ──────────
# The per-IP limiter is per minute only; the address is unconfirmed —
# possibly someone else's — so an account may mail it a few codes a day.


def _resend(owner):
    from app.routers import auth as auth_router
    auth_router.limiter.reset()  # the per-minute IP limiter is not under test
    return TestClient(app).post(
        "/api/auth/resend-verification",
        headers={"Authorization": f"Bearer {create_access_token(str(owner.id), 0)}"},
    )


def test_resend_verification_has_a_daily_ceiling(db, owner, mails):
    from app.routers.auth import _VERIFY_CODES_PER_DAY
    owner.email_verified = False
    db.commit()
    for _ in range(_VERIFY_CODES_PER_DAY):
        assert _resend(owner).status_code == 200
    r = _resend(owner)
    assert r.status_code == 429, r.text
    d = r.json()["detail"]
    assert d["code"] == "verification_resend_daily_cap" and d["message"] and d["message_da"]
    assert len(mails) == _VERIFY_CODES_PER_DAY


def test_codes_mailed_for_a_changed_address_count_toward_it(db, owner, mails):
    from app.routers.auth import _VERIFY_CODES_PER_DAY
    _patch({"email": "new@bonbox.dk", "current_password": "ownerpw123"}, owner)
    for _ in range(_VERIFY_CODES_PER_DAY - 1):
        assert _resend(owner).status_code == 200
    assert _resend(owner).status_code == 429
    assert len(mails) == _VERIFY_CODES_PER_DAY


def test_a_verified_account_resend_is_a_no_op(db, owner, mails):
    r = _resend(owner)
    assert r.status_code == 200 and mails == []
