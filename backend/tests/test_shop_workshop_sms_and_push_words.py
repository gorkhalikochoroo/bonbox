"""A shop's and a workshop's SMS reminder and owner pushes (Push 8 review, round 5).

Round 4 made every MAIL from a shop or a workshop speak appointments
(tests/test_shop_workshop_owner_allergy_and_mail.py). QA then found the two
messages that leave the app by another channel still spoke a restaurant:

  • the day-before SMS (jobs/reservation_jobs.py): "Påmindelse: bord til 1 hos
    Cykelværkstedet Amager 15/10 11:00. Vi ses!";
  • the owner's lock-screen push on a public booking or a cancel
    (notification_service.notify_owner_new_reservation): "BonBox · Ny
    reservation" and "BonBox · Reservation aflyst · 1 pers · 15/10 11:00 —
    bord frigivet". The freed-place nudge (notify_owner_freed_table) said
    "BonBox · Bord frigivet" the same way.

A salon, a shop or a repair trade (reservation_emails.speaks_appointments), or
any booking with a service, now reads "aftale" / "tiden"; English owners get
"appointment" and "1 person", and a restaurant's English push says "1 guest",
never "1 guests".

And one edit fix: on a shop or a workshop the server stores no allergy, so an
edit that touched an older note erased the note but left its severity and
tags — the drawer showed a bare "Alvorlig". Touching the note now clears the
whole allergy record there.

Control cases: a restaurant's SMS and pushes are unchanged word for word.

Run: cd backend && pytest tests/test_shop_workshop_sms_and_push_words.py -q
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.models.user import User
from app.services.auth import hash_password
from app.services.notification_service import notify_owner_freed_table, notify_owner_new_reservation

_db_ready.set()

DA_RESTAURANT = re.compile(r"\bbord|reservation|gæst|selskab", re.I)
EN_RESTAURANT = re.compile(r"\btable|reservation|guest|party", re.I)


@pytest.fixture
def session_factory():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)


@pytest.fixture
def db(session_factory) -> Iterator:
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


def _owner(db, business_type: str, *, name="Cykelværkstedet Amager", lang="da", phone=None,
           sms=True) -> User:
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash=hash_password("x"),
             business_name=name, business_type=business_type, currency="DKK", role="owner",
             timezone="Europe/Copenhagen", plan="pro", ui_language=lang)
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id, phone=phone,
                           reservation_settings_json=json.dumps({"sms_reminders": sms})))
    db.commit()
    return u


# ── the day-before SMS ────────────────────────────────────────────────────

@pytest.fixture
def texts(db, monkeypatch) -> list:
    """Run the reminder job on the test session with an SMS provider that
    captures instead of sending (no real SMS ever leaves a test)."""
    import app.jobs.reservation_jobs as jobs
    import app.services.billing as billing
    import app.services.sms_service as sms

    monkeypatch.setattr(jobs, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(sms, "sms_configured", lambda: True)
    monkeypatch.setattr(billing, "has_feature", lambda *a, **k: True)
    monkeypatch.setattr(billing, "at_cap", lambda *a, **k: False)
    box: list = []

    def _send(*, to, text, sender=None):
        box.append(text)
        return {"ok": True}

    monkeypatch.setattr(sms, "send_sms", _send)
    return box


def _upcoming(db, owner, *, party=1, service=None) -> Reservation:
    # Naive local wall clock ~20 h out: inside the job's 36 h window under
    # any real offset (the same anchor test_reservation_reminder_escaping uses).
    start = (datetime.now() + timedelta(hours=20)).replace(second=0, microsecond=0)
    r = Reservation(user_id=owner.id, starts_at=start, ends_at=start + timedelta(minutes=60),
                    party_size=party, guest_name="Sofie", guest_phone="+4512345678",
                    status="confirmed", service_name=service)
    db.add(r); db.commit(); db.refresh(r)
    return r


@pytest.mark.parametrize("btype", ["workshop", "clothing"])
def test_a_shop_or_workshop_sms_reminds_of_an_appointment_not_a_table(db, texts, btype):
    from app.jobs.reservation_jobs import send_reservation_reminders

    owner = _owner(db, btype, phone="+45 70 10 20 30")
    r = _upcoming(db, owner)
    assert send_reservation_reminders() == 1
    assert len(texts) == 1, texts
    when = r.starts_at.strftime("%d/%m %H:%M")
    assert texts[0] == (
        f"Påmindelse: din aftale hos Cykelværkstedet Amager {when}. "
        "Ring +45 70 10 20 30 for ændringer. Vi ses!"
    )
    assert not DA_RESTAURANT.search(texts[0]), texts[0]


def test_a_salon_treatment_sms_is_an_appointment_too(db, texts):
    from app.jobs.reservation_jobs import send_reservation_reminders

    owner = _owner(db, "salon", name="Salon Lys")
    _upcoming(db, owner, service="Klip og farve")
    send_reservation_reminders()
    assert len(texts) == 1
    assert texts[0].startswith("Påmindelse: din aftale hos Salon Lys ")
    assert not DA_RESTAURANT.search(texts[0]), texts[0]


def test_a_restaurant_sms_is_unchanged(db, texts):
    from app.jobs.reservation_jobs import send_reservation_reminders

    owner = _owner(db, "restaurant", name="Bistro")
    r = _upcoming(db, owner, party=4)
    send_reservation_reminders()
    when = r.starts_at.strftime("%d/%m %H:%M")
    assert texts == [f"Påmindelse: bord til 4 hos Bistro {when}. Vi ses!"]


# ── the owner's lock-screen push ──────────────────────────────────────────

def _booking(*, status="confirmed", party=1, service=None):
    return SimpleNamespace(id=uuid.uuid4(), starts_at=datetime(2026, 10, 15, 11, 0),
                           status=status, party_size=party, service_name=service)


def _last_log(db, owner):
    return (db.query(NotificationLog).filter(NotificationLog.user_id == owner.id)
            .order_by(NotificationLog.created_at.desc()).first())


@pytest.mark.parametrize("btype", ["workshop", "clothing"])
def test_a_shop_or_workshop_owner_push_says_appointment_in_danish(db, btype):
    owner = _owner(db, btype)
    notify_owner_new_reservation(db, owner, _booking())
    log = _last_log(db, owner)
    assert (log.subject, log.body) == ("BonBox · Ny aftale", "1 pers · 15/10 11:00")

    notify_owner_new_reservation(db, owner, _booking(), cancelled=True)
    log = _last_log(db, owner)
    assert (log.subject, log.body) == ("BonBox · Aftale aflyst", "1 pers · 15/10 11:00 — tiden er ledig igen")

    # A request is a request on any vertical.
    notify_owner_new_reservation(db, owner, _booking(status="requested"))
    log = _last_log(db, owner)
    assert (log.subject, log.body) == ("BonBox · Ny forespørgsel", "1 pers · 15/10 11:00 — afventer svar")
    for row in db.query(NotificationLog).filter(NotificationLog.user_id == owner.id):
        assert not DA_RESTAURANT.search(f"{row.subject} {row.body}"), (row.subject, row.body)


def test_a_workshop_owner_push_in_english(db):
    owner = _owner(db, "workshop", lang="en")
    notify_owner_new_reservation(db, owner, _booking())
    log = _last_log(db, owner)
    assert (log.subject, log.body) == ("BonBox · New appointment", "1 person · 15/10 11:00")
    notify_owner_new_reservation(db, owner, _booking(party=2), cancelled=True)
    log = _last_log(db, owner)
    assert (log.subject, log.body) == (
        "BonBox · Appointment cancelled", "2 people · 15/10 11:00 — the time is free again")
    for row in db.query(NotificationLog).filter(NotificationLog.user_id == owner.id):
        assert not EN_RESTAURANT.search(f"{row.subject} {row.body}"), (row.subject, row.body)


def test_a_salon_treatment_push_is_an_appointment(db):
    owner = _owner(db, "salon", name="Salon Lys")
    notify_owner_new_reservation(db, owner, _booking(service="Klip"))
    assert _last_log(db, owner).subject == "BonBox · Ny aftale"


def test_a_restaurant_push_is_unchanged_and_one_guest_is_singular(db):
    owner = _owner(db, "restaurant", name="Bistro")
    notify_owner_new_reservation(db, owner, _booking(party=4))
    log = _last_log(db, owner)
    assert (log.subject, log.body) == ("BonBox · Ny reservation", "4 pers · 15/10 11:00")
    notify_owner_new_reservation(db, owner, _booking(party=4), cancelled=True)
    log = _last_log(db, owner)
    assert (log.subject, log.body) == ("BonBox · Reservation aflyst", "4 pers · 15/10 11:00 — bord frigivet")

    en = _owner(db, "restaurant", name="Bistro", lang="en")
    notify_owner_new_reservation(db, en, _booking(party=1))
    assert _last_log(db, en).body == "1 guest · 15/10 11:00"
    notify_owner_new_reservation(db, en, _booking(party=3))
    assert _last_log(db, en).body == "3 guests · 15/10 11:00"


def _freed(db, owner, match):
    freed = SimpleNamespace(id=uuid.uuid4())
    notify_owner_freed_table(db, owner, freed, match)
    row = (db.query(NotificationLog)
           .filter(NotificationLog.user_id == owner.id, NotificationLog.event_type == "waitlist_freed_table")
           .order_by(NotificationLog.created_at.desc()).first())
    return row.subject, row.body


def test_a_workshop_freed_place_push_speaks_a_time(db):
    owner = _owner(db, "workshop")
    assert _freed(db, owner, {"id": "w1", "guest_name": "Peter Hansen", "party_size": 1}) == (
        "BonBox · Tid ledig", "Peter (1 pers) passer — tryk for at tilbyde")
    en = _owner(db, "workshop", lang="en")
    subject, body = _freed(db, en, {"id": "w2", "guest_name": "", "party_size": 1})
    assert subject == "BonBox · Time free"
    assert not EN_RESTAURANT.search(f"{subject} {body}"), body
    subject, body = _freed(db, en, {"id": "w3", "guest_name": "Peter", "party_size": 1})
    assert body == "Peter (1 person) fits — tap to offer it"


def test_a_restaurant_freed_table_push_is_unchanged(db):
    owner = _owner(db, "restaurant", name="Bistro")
    assert _freed(db, owner, {"id": "r1", "guest_name": "Anna B", "party_size": 4}) == (
        "BonBox · Bord frigivet", "Anna (4 pers) passer — tryk for at tilbyde")
    en = _owner(db, "restaurant", name="Bistro", lang="en")
    assert _freed(db, en, {"id": "r2", "guest_name": "Anna", "party_size": 1})[1] == (
        "Anna (1 guest) fits — tap to offer it")


# ── an edit of an older allergy note on a workshop ────────────────────────

@pytest.fixture
def client(session_factory):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _as(user):
    from app.routers import reservations as R
    app.dependency_overrides[R.get_current_user] = lambda: user


def _legacy_booking(db, owner) -> uuid.UUID:
    db.add(BookableResource(user_id=owner.id, kind="table", label="Plads 1", capacity_seats=2, sort_order=0))
    start = datetime(2026, 7, 4, 10, 0)
    r = Reservation(user_id=owner.id, starts_at=start, ends_at=start + timedelta(minutes=60),
                    party_size=1, guest_name="Peter Hansen", status="confirmed", source="manual",
                    allergy_note="nødder", allergy_severity="severe", allergen_tags=["nuts"])
    db.add(r); db.commit(); db.refresh(r)
    return r.id


def _row(db, rid) -> Reservation:
    db.expire_all()
    return db.query(Reservation).filter(Reservation.id == rid).one()


@pytest.mark.parametrize("note", ["nødder, gluten", ""])
def test_touching_an_old_note_on_a_workshop_clears_the_whole_allergy(client, db, note):
    owner = _owner(db, "workshop")
    _as(owner)
    rid = _legacy_booking(db, owner)
    r = client.patch(f"/api/reservations/reservations/{rid}", json={"allergy_note": note})
    assert r.status_code == 200, r.text
    row = _row(db, rid)
    # No bare "Alvorlig" left on a booking with no allergy.
    assert row.allergy_note is None
    assert row.allergy_severity is None
    assert (row.allergen_tags or []) == []
    assert row.guest_name == "Peter Hansen"


def test_a_workshop_edit_that_leaves_the_allergy_alone_keeps_it(client, db):
    owner = _owner(db, "workshop")
    _as(owner)
    rid = _legacy_booking(db, owner)
    r = client.patch(f"/api/reservations/reservations/{rid}", json={"guest_phone": "+4512345678"})
    assert r.status_code == 200, r.text
    row = _row(db, rid)
    assert (row.allergy_note, row.allergy_severity, row.allergen_tags) == ("nødder", "severe", ["nuts"])


def test_a_restaurant_note_edit_keeps_its_severity(client, db):
    owner = _owner(db, "restaurant", name="Bistro")
    _as(owner)
    rid = _legacy_booking(db, owner)
    r = client.patch(f"/api/reservations/reservations/{rid}", json={"allergy_note": "nødder, gluten"})
    assert r.status_code == 200, r.text
    row = _row(db, rid)
    assert (row.allergy_note, row.allergy_severity, row.allergen_tags) == ("nødder, gluten", "severe", ["nuts"])
