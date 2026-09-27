"""Notifications to the owner follow the language they use the app in.

The app's language lived only on the device, so the server could not know it:
reservation, sick-call and waste pushes were always Danish, the morning brief
push always English, and the close push guessed Danish from DKK. The app now
saves its language to users.ui_language (PATCH /auth/profile) and every owner
notification reads it through services/owner_language.owner_lang.

  cd backend && pytest tests/test_owner_notification_language.py -v
"""
import uuid
from datetime import datetime
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.testclient import TestClient

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import NotificationLog
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.services.notification_service import notify_owner_new_reservation, notify_owner_sick_call
from app.services.owner_language import owner_lang
from app.services.push_sender import _compose_brief_payload

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


def _owner(db, *, lang=None, currency="DKK"):
    u = User(email=f"{uuid.uuid4().hex[:8]}@bonbox.dk", password_hash=hash_password("ownerpw123"),
             business_name="Bon Café", business_type="restaurant", currency=currency,
             plan="pro", role="owner", email_verified=True, ui_language=lang)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _patch(body, owner):
    return TestClient(app).patch(
        "/api/auth/profile", json=body,
        headers={"Authorization": f"Bearer {create_access_token(str(owner.id), 0)}"},
    )


# ── The app saves its language ───────────────────────────────────────────

def test_the_app_saves_the_language_it_runs_in(db):
    owner = _owner(db)
    r = _patch({"ui_language": "en"}, owner)
    assert r.status_code == 200, r.text
    assert r.json()["ui_language"] == "en"
    db.refresh(owner)
    assert owner.ui_language == "en"


def test_a_language_the_app_does_not_ship_is_refused(db):
    owner = _owner(db, lang="da")
    assert _patch({"ui_language": "xx"}, owner).status_code == 422
    assert _patch({"ui_language": "<b>"}, owner).status_code == 422
    db.refresh(owner)
    assert owner.ui_language == "da"


def test_the_code_is_normalised(db):
    owner = _owner(db)
    assert _patch({"ui_language": " DA "}, owner).status_code == 200
    db.refresh(owner)
    assert owner.ui_language == "da"


# ── Which language a notification is written in ──────────────────────────

@pytest.mark.parametrize("lang,currency,expected", [
    ("da", "EUR", "da"),     # a saved choice wins over the currency guess
    ("en", "DKK", "en"),
    ("de", "DKK", "en"),     # no German notifications — English, like the app's fallback
    (None, "DKK", "da"),     # never saved: the old DKK guess stands
    (None, "EUR", "en"),
])
def test_owner_lang(lang, currency, expected):
    assert owner_lang(SimpleNamespace(ui_language=lang, currency=currency)) == expected


def _booking(status="confirmed"):
    return SimpleNamespace(id=uuid.uuid4(), starts_at=datetime(2026, 9, 27, 19, 30),
                           status=status, party_size=4)


def _last_log(db, owner):
    return (db.query(NotificationLog).filter(NotificationLog.user_id == owner.id)
            .order_by(NotificationLog.created_at.desc()).first())


def test_a_new_booking_push_is_in_english_for_an_english_owner(db):
    owner = _owner(db, lang="en")
    notify_owner_new_reservation(db, owner, _booking("requested"))
    log = _last_log(db, owner)
    assert log.subject == "BonBox · New request"
    assert log.body == "4 guests · 27/09 19:30 — waiting for your answer"


def test_a_new_booking_push_stays_danish_for_a_danish_owner(db):
    owner = _owner(db, lang="da")
    notify_owner_new_reservation(db, owner, _booking())
    log = _last_log(db, owner)
    assert log.subject == "BonBox · Ny reservation"
    assert log.body == "4 pers · 27/09 19:30"


def test_a_cancelled_booking_push_follows_the_language(db):
    owner = _owner(db, lang="en")
    notify_owner_new_reservation(db, owner, _booking(), cancelled=True)
    assert _last_log(db, owner).subject == "BonBox · Reservation cancelled"


def test_a_sick_call_push_is_in_english_for_an_english_owner(db):
    owner = _owner(db, lang="en")
    notify_owner_sick_call(db, owner=owner, staff_name="Sofie",
                           absence_date=datetime(2026, 9, 28).date())
    log = _last_log(db, owner)
    assert log.subject == "BonBox · Sick call"
    assert log.body.startswith("Sofie called in sick 28/09")


def test_the_morning_brief_push_title_follows_the_language():
    brief = {"headline": "Omsætningen er op i dag", "insights": []}
    assert _compose_brief_payload(brief, "da")["title"] == "BonBox · Morgenbrief"
    assert _compose_brief_payload(brief)["title"] == "BonBox · Daily brief"
