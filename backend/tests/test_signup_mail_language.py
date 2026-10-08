"""The signup mails — the e-mail verification code and the welcome — in the
signup's language (Danish first 15 minutes, item 1).

They were English for everyone: a Danish café owner who signed up in a Danish
app got "Your verification code is …" as BonBox's first word to them.

Pinned here, with the sender stubbed (nothing is ever sent):
  • a Danish signup (the app's ui_language "da") gets both mails in Danish,
    with the same code, a text/plain part and the same dashboard link;
  • an English signup keeps the English mails;
  • no ui_language: the browser's Accept-Language decides, then the currency;
  • the signup's ui_language is saved on the account (and validated);
  • the business name is escaped in the html;
  • "Send ny kode" (resend) follows the account's language.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.user import User
from app.services.signup_mail import (
    signup_mail_lang, verification_mail, welcome_mail,
)

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
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def sent(monkeypatch):
    """Stub the sender: record every mail, send nothing."""
    out: list[dict] = []

    def _fake_send(to, subject, html, **kw):
        out.append({"to": to, "subject": subject, "html": html, **kw})
        return True

    monkeypatch.setattr("app.routers.auth.send_email", _fake_send)
    return out


@pytest.fixture
def client():
    try:
        from app.routers.auth import limiter
        limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


_BASE = {
    "password": "Validpass1",
    "business_name": "Café Mælkebøtten",
    "business_type": "cafe",
    "currency": "DKK",
}


def _register(client, email, headers=None, **extra):
    r = client.post("/api/auth/register", json={**_BASE, "email": email, **extra},
                    headers=headers or {})
    assert r.status_code == 201, r.text
    return r


def _code(db_session, email):
    u = db_session.query(User).filter(User.email == email).first()
    return u.verification_code


def test_danish_signup_gets_danish_mails(db_session, client, sent):
    _register(client, "ejer.dk@gmail.com", ui_language="da")
    code = _code(db_session, "ejer.dk@gmail.com")
    assert len(sent) == 2
    verify, welcome = sent
    # Verification: Danish subject with the same code, code in html AND text
    assert verify["subject"] == f"BonBox — din bekræftelseskode er {code}"
    assert "Bekræft din e-mail" in verify["html"]
    assert code in verify["html"]
    assert verify.get("text") and code in verify["text"]
    assert "Koden udløber om 30 minutter." in verify["text"]
    assert "Your verification code" not in verify["subject"]
    # Welcome: Danish, same link, text part, the first steps named
    assert welcome["subject"] == "Velkommen til BonBox"
    assert "Velkommen til BonBox" in welcome["html"]
    assert "https://bonbox.dk/dashboard" in welcome["html"]
    assert "Lav din første kasserapport" in welcome["html"]
    assert welcome.get("text") and "https://bonbox.dk/dashboard" in welcome["text"]
    assert "Hej Café Mælkebøtten," in welcome["text"]
    assert "Welcome" not in welcome["html"]


def test_english_signup_keeps_english_mails(db_session, client, sent):
    _register(client, "owner.en@gmail.com", ui_language="en")
    code = _code(db_session, "owner.en@gmail.com")
    verify, welcome = sent
    assert verify["subject"] == f"BonBox — Your verification code is {code}"
    assert "Verify your email" in verify["html"] and code in verify["text"]
    assert welcome["subject"] == "Welcome to BonBox!"
    assert "Welcome to BonBox!" in welcome["html"]
    assert "https://bonbox.dk/dashboard" in welcome["html"]
    assert "Velkommen" not in welcome["html"]


def test_other_app_language_gets_english(db_session, client, sent):
    """The mails exist in da + en; a German app reads the English ones."""
    _register(client, "owner.de@gmail.com", ui_language="de")
    assert sent[0]["subject"].startswith("BonBox — Your verification code is")


def test_no_ui_language_uses_browser_then_currency(db_session, client, sent):
    _register(client, "browser.da@gmail.com", headers={"Accept-Language": "da-DK,da;q=0.9,en;q=0.8"})
    assert sent[0]["subject"].startswith("BonBox — din bekræftelseskode er")
    sent.clear()
    _register(client, "browser.en@gmail.com", headers={"Accept-Language": "en-GB,en;q=0.9"})
    assert sent[0]["subject"].startswith("BonBox — Your verification code is")
    sent.clear()
    # No signal at all → the currency: DKK reads Danish, EUR English
    _register(client, "nothing.dkk@gmail.com")
    assert sent[0]["subject"].startswith("BonBox — din bekræftelseskode er")
    sent.clear()
    _register(client, "nothing.eur@gmail.com", currency="EUR")
    assert sent[0]["subject"].startswith("BonBox — Your verification code is")


def test_app_language_beats_browser(db_session, client, sent):
    _register(client, "app.wins@gmail.com", ui_language="da",
              headers={"Accept-Language": "en-US"})
    assert sent[0]["subject"].startswith("BonBox — din bekræftelseskode er")


def test_signup_language_is_saved_and_validated(db_session, client, sent):
    _register(client, "saved.da@gmail.com", ui_language="da")
    u = db_session.query(User).filter(User.email == "saved.da@gmail.com").first()
    assert u.ui_language == "da"
    # Omitted → stays NULL (AccountLanguageSync fills it on first load)
    _register(client, "saved.none@gmail.com")
    u2 = db_session.query(User).filter(User.email == "saved.none@gmail.com").first()
    assert u2.ui_language is None
    # Not a shipped language → dropped (never the reason a signup fails),
    # and the mail falls back to the browser / currency rule
    sent.clear()
    r = client.post("/api/auth/register", json={**_BASE, "email": "bad.lang@gmail.com",
                                                "ui_language": "<b>"})
    assert r.status_code == 201
    u3 = db_session.query(User).filter(User.email == "bad.lang@gmail.com").first()
    assert u3.ui_language is None
    assert sent[0]["subject"].startswith("BonBox — din bekræftelseskode er")


def test_business_name_is_escaped(db_session, client, sent):
    _register(client, "escape.me@gmail.com", ui_language="da",
              business_name='<img src=x onerror="alert(1)">')
    welcome = sent[1]
    assert "<img" not in welcome["html"]
    assert "&lt;img" in welcome["html"]


def test_resend_follows_account_language(db_session, client, sent):
    r = _register(client, "resend.da@gmail.com", ui_language="da")
    token = r.json()["access_token"]
    sent.clear()
    try:
        from app.routers.auth import limiter
        limiter.reset()
    except Exception:
        pass
    r2 = client.post("/api/auth/resend-verification",
                     headers={"Authorization": f"Bearer {token}"})
    assert r2.status_code == 200, r2.text
    assert len(sent) == 1
    code = _code(db_session, "resend.da@gmail.com")
    assert sent[0]["subject"] == f"BonBox — din bekræftelseskode er {code}"
    assert code in sent[0]["text"]


# ── The pure helpers ────────────────────────────────────────────────────

def test_lang_rule_order():
    assert signup_mail_lang("da", "en-US", "EUR") == "da"
    assert signup_mail_lang("en", "da-DK", "DKK") == "en"
    assert signup_mail_lang(None, "da", "EUR") == "da"
    assert signup_mail_lang(None, "*", "DKK") == "da"
    assert signup_mail_lang(None, "", "SEK") == "en"
    assert signup_mail_lang("", None, None) == "da"  # DKK is the default currency


def test_mail_parts_say_the_same_thing():
    s, h, t = verification_mail("482913", "da")
    assert "482913" in s and "482913" in h and "482913" in t
    s, h, t = welcome_mail("", "da")
    assert "Hej," in t and "Hej <strong>" not in h
    s, h, t = welcome_mail("there", "en")  # the old placeholder is no name
    assert "Hi," in t and "there" not in t
