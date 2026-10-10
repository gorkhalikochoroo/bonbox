"""SEC-7 (R-f) — the unsubscribe-link signer fails closed in production.

utils/email_unsubscribe_token._secret() fell back to a literal written in the
file when APP_SECRET_KEY and SECRET_KEY were both unset, with no production
guard: a deploy that lost its key would sign every one-click unsubscribe and
revisor opt-out link with a public key, so anyone could switch off any
owner's or revisor's mail. Now:

  • production, no key → no token is minted (UnsubscribeKeyUnset) and none
    verifies; the lock still locks and the owner's copy still goes;
  • a key in the environment → used exactly as before (APP_SECRET_KEY first),
    so links already in inboxes stay valid;
  • dev/test, no key → settings.SECRET_KEY; never the old literal.
"""
import base64
import hashlib
import hmac
import json
import time

import pytest

from app.config import settings
from app.utils import email_unsubscribe_token as tok

OLD_LITERAL = "dev-fallback-secret-do-not-use-in-prod"


def _forge(key: str, user_id="victim", topic="daily_brief") -> str:
    """A token signed with `key`, the way the module signs."""
    raw = json.dumps({"u": user_id, "t": topic, "e": int(time.time()) + 3600},
                     separators=(",", ":")).encode()
    body = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    sig = hmac.new(key.encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


@pytest.fixture
def no_env_key(monkeypatch):
    monkeypatch.delenv("APP_SECRET_KEY", raising=False)
    monkeypatch.delenv("SECRET_KEY", raising=False)


@pytest.fixture
def production(monkeypatch):
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")


def test_production_without_a_key_mints_nothing(no_env_key, production):
    with pytest.raises(tok.UnsubscribeKeyUnset):
        tok.make_unsubscribe_token("u1", "daily_brief")


def test_production_without_a_key_verifies_nothing(no_env_key, production):
    for key in (OLD_LITERAL, str(settings.SECRET_KEY)):
        forged = _forge(key)
        assert tok.parse_unsubscribe_token(forged) is None
        assert tok.parse_unsubscribe_token_unexpired_or_not(forged) is None


def test_the_old_literal_never_signs_anything(no_env_key):
    # Development, no key in the environment: the app's own key, not the literal.
    assert tok.parse_unsubscribe_token(_forge(OLD_LITERAL)) is None
    good = tok.make_unsubscribe_token("u1", "daily_brief")
    assert tok.parse_unsubscribe_token(good)["u"] == "u1"
    assert good == _forge_like(good, str(settings.SECRET_KEY))


def _forge_like(token: str, key: str) -> str:
    body = token.split(".", 1)[0]
    sig = hmac.new(key.encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"


def test_production_with_a_key_works_and_signs_with_it(monkeypatch, production):
    monkeypatch.delenv("APP_SECRET_KEY", raising=False)
    monkeypatch.setenv("SECRET_KEY", "prod-key-for-test")
    t = tok.make_unsubscribe_token("u1", "daily_brief")
    assert tok.parse_unsubscribe_token(t)["t"] == "daily_brief"
    assert t == _forge_like(t, "prod-key-for-test"), "the same key as before the change"
    assert tok.parse_unsubscribe_token(_forge(OLD_LITERAL)) is None


def test_app_secret_key_still_wins(monkeypatch, production):
    monkeypatch.setenv("APP_SECRET_KEY", "app-key")
    monkeypatch.setenv("SECRET_KEY", "session-key")
    t = tok.make_unsubscribe_token("u1", "daily_brief")
    assert t == _forge_like(t, "app-key")


@pytest.mark.parametrize("stored", ["prod-key-value\n", " prod-key-value", "prod-key-value \r\n"])
def test_a_key_with_whitespace_signs_exactly_as_before(monkeypatch, production, stored):
    """Review, 10 Oct: the key is used exactly as stored. A trailing newline
    pasted into the host's settings is part of the key every link already in
    an inbox was signed with; stripping it would void them all."""
    monkeypatch.delenv("APP_SECRET_KEY", raising=False)
    monkeypatch.setenv("SECRET_KEY", stored)
    old_link = _forge(stored)  # signed the pre-R-f way: the raw value
    assert tok.parse_unsubscribe_token(old_link)["u"] == "victim"
    t = tok.make_unsubscribe_token("u1", "daily_brief")
    assert t == _forge_like(t, stored)


def test_a_whitespace_only_app_secret_key_is_no_key(monkeypatch, production):
    """Whitespace is not a key: SECRET_KEY signs, never " " (forgeable)."""
    monkeypatch.setenv("APP_SECRET_KEY", "  \n")
    monkeypatch.setenv("SECRET_KEY", "session-key")
    t = tok.make_unsubscribe_token("u1", "daily_brief")
    assert t == _forge_like(t, "session-key")
    monkeypatch.setenv("SECRET_KEY", " ")
    with pytest.raises(tok.UnsubscribeKeyUnset):
        tok.make_unsubscribe_token("u1", "daily_brief")


def test_a_garbage_token_is_refused_not_a_crash():
    assert tok.parse_unsubscribe_token("æøå.ü") is None
    assert tok.parse_unsubscribe_token("abc.") is None


def test_the_lock_still_locks_when_no_opt_out_link_can_be_made(monkeypatch):
    """The lock mail's revisor copy needs an opt-out link. Without a signing
    key it is not sent; the lock and the owner's copy still happen, and the
    owner's copy says the revisor's was NOT sent."""
    from datetime import date, timedelta

    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from app.database import Base, get_db
    from app.main import app, _db_ready
    from app.models.business_profile import BusinessProfile
    from app.models.daily_close import DailyClose
    from app.models.user import User
    from app.services.auth import create_access_token, hash_password
    from app.utils.time import utc_now

    _db_ready.set()
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    SL = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SL()
    app.dependency_overrides[get_db] = lambda: (yield s)
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SL, raising=False)
    monkeypatch.setattr("app.services.billing.SessionLocal", SL, raising=False)

    sent = []
    monkeypatch.setattr("app.services.email_service.resend.Emails.send",
                        lambda payload: sent.append(payload) or None)
    monkeypatch.setattr("app.services.email_service.resend.api_key", "test_key")

    def _no_key(*a, **k):
        raise tok.UnsubscribeKeyUnset("no key")

    monkeypatch.setattr("app.services.revisor_mail.revisor_unsubscribe_url", _no_key)
    try:
        u = User(email="anders@mirabelle.dk", password_hash=hash_password("x"),
                 business_name="Mirabelle Café", business_type="restaurant",
                 currency="DKK", plan="starter", auto_email_on_close=True,
                 email_verified=True, created_at=utc_now() - timedelta(days=2))
        s.add(u); s.commit(); s.refresh(u)
        s.add(BusinessProfile(user_id=u.id, company_name="Mirabelle Café ApS",
                              org_number="12345678", country="DK",
                              email="owner@mirabelle.dk",
                              accountant_email="revisor@bonbox.dk"))
        s.commit()
        r = TestClient(app).post("/api/daily-close", json={
            "date": date(2026, 5, 23).isoformat(), "branch_id": None,
            "status": "confirmed",
            "revenue_breakdown": {"food": 8000, "drinks": 4500},
            "payment_breakdown": {"cash": 3200, "card": 9300},
            "moms_total": 2500, "moms_mode": "auto", "tips_total": 0,
            "cash_counted": 3200, "closed_by": "Anders", "receipt_photo": None,
        }, headers={"Authorization": f"Bearer {create_access_token(str(u.id))}"})
        assert r.status_code == 200, r.text
        assert s.query(DailyClose).one().status == "confirmed", "the lock happened"
        to = [p["to"][0] for p in sent]
        assert to == ["anders@mirabelle.dk"], "only the owner's own copy went"
        assert "IKKE sendt" in sent[0]["html"]
        assert r.json()["close_ritual"]["email_status"] == "partial"
    finally:
        app.dependency_overrides.pop(get_db, None)
        s.close()
