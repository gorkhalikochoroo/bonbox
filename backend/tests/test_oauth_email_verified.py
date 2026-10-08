"""OAuth sign-in never keys on an unverified e-mail; the legacy Google route
runs the same handler (security round, 8 Oct).

Before: /auth/oauth/* created accounts with `email_verified or True` and
looked up / linked by an e-mail whatever the provider's email_verified said,
and the legacy POST /api/auth/google resolved the Google e-mail to ANY
existing account (password accounts included) with no replay check.

Providers are stubbed at the router's import site — no network.
"""
from app.models.user import User
from app.services.auth import hash_password
from tests.test_oauth_signin import (  # noqa: F401 — pytest fixtures
    _apple_claims, _google_claims, _patch_apple, _patch_google, client,
    configure_oauth_env, db_session, reset_jti_cache, reset_rate_limiter,
)


def _password_owner(db, email):
    u = User(email=email, password_hash=hash_password("pw123456"), business_name="Café",
             business_type="cafe", currency="DKK", role="owner")
    db.add(u); db.commit(); db.refresh(u)
    return u


def test_google_unverified_email_is_not_created(db_session, client):
    with _patch_google(_google_claims("g-unv-1", email="new@example.com", email_verified=False)):
        r = client.post("/api/auth/oauth/google", json={"id_token": "x"})
    assert r.status_code == 401, r.text
    assert r.json()["detail"]["code"] == "email_not_verified"
    assert db_session.query(User).count() == 0


def test_google_unverified_email_never_links(db_session, client):
    u = User(email="oauth@example.com", password_hash=hash_password("x"), business_name="O",
             business_type="cafe", currency="DKK", role="owner", oauth_provider="apple")
    db_session.add(u); db_session.commit()
    with _patch_google(_google_claims("g-unv-2", email="oauth@example.com", email_verified=False)):
        r = client.post("/api/auth/oauth/google", json={"id_token": "x"})
    assert r.status_code == 401, r.text
    db_session.refresh(u)
    assert u.google_sub is None


def test_google_string_false_is_unverified(db_session, client):
    with _patch_google(_google_claims("g-unv-3", email="s@example.com", email_verified="false")):
        r = client.post("/api/auth/oauth/google", json={"id_token": "x"})
    assert r.status_code == 401, r.text


def test_apple_unverified_email_is_not_created(db_session, client):
    with _patch_apple(_apple_claims("a-unv-1", email="new@example.com", email_verified=False)):
        r = client.post("/api/auth/oauth/apple", json={"id_token": "x"})
    assert r.status_code == 401, r.text
    assert r.json()["detail"]["code"] == "email_not_verified"
    assert db_session.query(User).count() == 0


def test_returning_user_by_sub_is_unaffected(db_session, client):
    u = User(email="sub@example.com", password_hash=hash_password("x"), business_name="S",
             business_type="cafe", currency="DKK", role="owner", google_sub="g-sub-9",
             oauth_provider="google")
    db_session.add(u); db_session.commit()
    with _patch_google(_google_claims("g-sub-9", email="sub@example.com", email_verified=False)):
        r = client.post("/api/auth/oauth/google", json={"id_token": "x"})
    assert r.status_code == 200, r.text


# ── Legacy POST /api/auth/google ─────────────────────────────────────


def test_legacy_google_refuses_silent_link_to_a_password_account(db_session, client):
    owner = _password_owner(db_session, "owner@example.com")
    with _patch_google(_google_claims("g-legacy-1", email="owner@example.com")):
        r = client.post("/api/auth/google", json={"credential": "x"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "account_exists_login_first"
    db_session.refresh(owner)
    assert owner.google_sub is None
    assert "access_token" not in r.text


def test_legacy_google_refuses_unverified_email(db_session, client):
    with _patch_google(_google_claims("g-legacy-2", email="x@example.com", email_verified=False)):
        r = client.post("/api/auth/google", json={"credential": "x"})
    assert r.status_code == 401, r.text
    assert db_session.query(User).count() == 0


def test_legacy_google_still_signs_up_and_in(db_session, client):
    claims = _google_claims("g-legacy-3", email="fresh@example.com", name="Fresh Café")
    with _patch_google(claims):
        r = client.post("/api/auth/google", json={"credential": "x"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"] and body["user"]["email"] == "fresh@example.com"
    u = db_session.query(User).filter(User.email == "fresh@example.com").one()
    assert u.google_sub == "g-legacy-3" and u.oauth_provider == "google" and u.email_verified is True
    # The same id_token twice is a replay (the legacy route had no check).
    with _patch_google(claims):
        r2 = client.post("/api/auth/google", json={"credential": "x"})
    assert r2.status_code == 401, r2.text
