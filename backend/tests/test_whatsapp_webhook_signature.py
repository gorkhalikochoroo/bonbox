"""POST /api/whatsapp/webhook — only Twilio may write through it (sweep 8 Oct,
item 8).

The webhook trusted the form's From field: it logged the message, verified a
pending phone against Body, and ran the bot as the owner linked to that
phone (log_sale / log_expense write rows; summary / profit read figures
back). Nothing checked X-Twilio-Signature. The feature is off by default
(WHATSAPP_ENABLED → 404), so this was latent — but turning the flag on would
have opened every linked owner's books to a forged POST.

Now the signature is checked FIRST, before anything is read or written, and
the check fails closed: no auth token configured, no header, or a signature
that does not match the configured public webhook URL → 403.

  cd backend && pytest tests/test_whatsapp_webhook_signature.py -v
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from twilio.request_validator import RequestValidator

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.sale import Sale
from app.models.user import User
from app.models.whatsapp import WhatsAppMessage, WhatsAppUser
from app.services.auth import hash_password

_db_ready.set()

TOKEN = "twilio-test-auth-token"
URL = "https://api.bonbox.example/api/whatsapp/webhook"
PHONE = "+4512345678"


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        yield s

    app.dependency_overrides[get_db] = _override
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.clear()


@pytest.fixture
def enabled(monkeypatch):
    import app.routers.whatsapp as wa
    monkeypatch.setattr(wa, "WHATSAPP_ENABLED", True)
    monkeypatch.setattr(wa, "TWILIO_TOKEN", TOKEN)
    monkeypatch.setenv("WHATSAPP_WEBHOOK_URL", URL)
    return wa


def _linked_owner(db):
    u = User(email="ejer@cafe.dk", password_hash=hash_password("x"), business_name="Café",
             business_type="cafe", currency="DKK", role="owner")
    db.add(u); db.commit(); db.refresh(u)
    db.add(WhatsAppUser(id=uuid.uuid4(), user_id=u.id, phone_number=PHONE, verified=True))
    db.commit()
    return u


def _post(form, signature=None):
    headers = {} if signature is None else {"X-Twilio-Signature": signature}
    return TestClient(app).post("/api/whatsapp/webhook", data=form, headers=headers)


def _sig(form, url=URL, token=TOKEN):
    return RequestValidator(token).compute_signature(url, form)


FORGED = {"From": f"whatsapp:{PHONE}", "Body": "sale 5000"}


def _nothing_written(db):
    db.expire_all()
    assert db.query(WhatsAppMessage).count() == 0
    assert db.query(Sale).count() == 0


def test_no_signature_is_refused_before_anything_is_written(db, enabled):
    _linked_owner(db)
    r = _post(FORGED)
    assert r.status_code == 403, r.text
    _nothing_written(db)


def test_a_wrong_signature_is_refused(db, enabled):
    _linked_owner(db)
    r = _post(FORGED, signature=_sig(FORGED, token="someone-elses-token"))
    assert r.status_code == 403, r.text
    _nothing_written(db)


def test_a_signature_for_another_url_is_refused(db, enabled):
    _linked_owner(db)
    r = _post(FORGED, signature=_sig(FORGED, url="https://evil.example/api/whatsapp/webhook"))
    assert r.status_code == 403, r.text
    _nothing_written(db)


def test_without_a_configured_token_nothing_is_accepted(db, enabled, monkeypatch):
    monkeypatch.setattr(enabled, "TWILIO_TOKEN", "")
    _linked_owner(db)
    # Even a "signature" made with an empty key is refused.
    r = _post(FORGED, signature=_sig(FORGED, token=""))
    assert r.status_code == 403, r.text
    _nothing_written(db)


def test_a_real_twilio_request_still_works(db, enabled):
    _linked_owner(db)
    form = {"From": f"whatsapp:{PHONE}", "Body": "help", "MessageSid": "SM123"}
    r = _post(form, signature=_sig(form))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/xml")
    db.expire_all()
    assert db.query(WhatsAppMessage).filter(WhatsAppMessage.direction == "inbound").count() == 1


def test_still_404_while_the_feature_is_off(db, monkeypatch):
    import app.routers.whatsapp as wa
    monkeypatch.setattr(wa, "WHATSAPP_ENABLED", False)
    r = _post(FORGED)
    assert r.status_code == 404, r.text
