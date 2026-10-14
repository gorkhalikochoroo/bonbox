"""A shop's and a workshop's owner booking and mails (Push 8 review, round 4).

Round 3 stopped the PUBLIC booking of a shop or a workshop from storing
allergy data (tests/test_allergens_shop_workshop.py). QA then found:

  • the owner's "Book en tid" still asked "ALLERGI (VALGFRI) · fx nødder,
    gluten", and POST /reservations/book stored it — a probe on the workshop
    stored allergy_note "nødder, gluten". Health data with no purpose is not
    collected (GDPR Art. 5(1)(c)): the owner's create paths and the edit path
    now follow allergens.collects_allergies too. An edit may still CLEAR a note
    a booking already carries (one stored before this fix), never write one.
  • the customer's confirmation mail from the workshop read "Cykelværkstedet
    Amager — reservation bekræftet: …", "Din reservation er bekræftet …
    Aflys din reservation her, så en anden gæst kan få bordet." —
    reservation_emails only treated a booking with a service (a salon
    treatment) as an appointment. The venue now says so too: a salon, a shop
    or a repair trade (archetypes salon / retail / services) gets "aftale",
    "tiden" and "en anden", in every guest and owner template.

Control cases: a restaurant keeps its allergy data and every word.

Run: cd backend && pytest tests/test_shop_workshop_owner_allergy_and_mail.py -q
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, timedelta
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
from app.models.user import User
from app.services import reservation_emails as mail
from app.services.auth import hash_password

_db_ready.set()

_START = "2026-07-04T10:00:00"


@pytest.fixture
def session_factory():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)


@pytest.fixture
def db(session_factory) -> Iterator:
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


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


def _owner(db, business_type: str, name: str = "Cykelværkstedet Amager") -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash=hash_password("x"),
        business_name=name, business_type=business_type,
        currency="DKK", role="owner", timezone="Europe/Copenhagen", plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id)); db.commit()
    for i in range(2):
        db.add(BookableResource(user_id=u.id, kind="table", label=f"Plads {i + 1}",
                                capacity_seats=2, sort_order=i))
    db.commit()
    return u


def _as(user):
    from app.routers import reservations as R
    app.dependency_overrides[R.get_current_user] = lambda: user


_ALLERGY = {"allergy_note": "nødder, gluten", "allergy_severity": "severe",
            "allergen_tags": ["nuts", "gluten"]}


def _book(client, **body):
    base = {"guest_name": "Owner Allergy Probe", "party_size": 1, "starts_at": _START,
            "auto_assign": False, "allow_overflow": True}
    base.update(body)
    r = client.post("/api/reservations/book", json=base)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _row(db, rid) -> Reservation:
    db.expire_all()
    return db.query(Reservation).filter(Reservation.id == uuid.UUID(str(rid))).one()


# ── the owner's "Book en tid" ─────────────────────────────────────────────

@pytest.mark.parametrize("btype", ["workshop", "clothing"])
def test_the_owner_path_stores_no_allergy_for_a_shop_or_a_workshop(client, db, btype):
    _as(_owner(db, btype))
    rid = _book(client, guest_notes="Bremserne hviner", **_ALLERGY)
    row = _row(db, rid)
    assert row.allergy_note is None
    assert row.allergy_severity is None
    assert (row.allergen_tags or []) == []
    # The customer's own words are kept — only the health data goes.
    assert row.guest_notes == "Bremserne hviner"


def test_a_restaurant_owner_booking_keeps_its_allergy(client, db):
    _as(_owner(db, "restaurant", "Bistro"))
    rid = _book(client, **_ALLERGY)
    row = _row(db, rid)
    assert row.allergy_note == "nødder, gluten"
    assert row.allergy_severity == "severe"
    assert row.allergen_tags == ["nuts", "gluten"]


def test_an_edit_never_writes_allergy_for_a_workshop_but_can_clear_an_old_one(client, db):
    owner = _owner(db, "workshop")
    _as(owner)
    rid = _book(client)
    r = client.patch(f"/api/reservations/reservations/{rid}", json={"allergy_note": "nødder", "allergy_severity": "severe"})
    assert r.status_code == 200, r.text
    row = _row(db, rid)
    assert row.allergy_note is None and row.allergy_severity is None
    # A note stored before this fix: the edit sheet shows it so it can go.
    row.allergy_note = "gammel note"; row.allergy_severity = "intolerance"; db.commit()
    r = client.patch(f"/api/reservations/reservations/{rid}", json={"allergy_note": "", "allergy_severity": ""})
    assert r.status_code == 200, r.text
    row = _row(db, rid)
    assert row.allergy_note is None and row.allergy_severity is None


def test_a_restaurant_edit_still_writes_its_allergy(client, db):
    _as(_owner(db, "restaurant", "Bistro"))
    rid = _book(client, party_size=2)
    r = client.patch(f"/api/reservations/reservations/{rid}", json={"allergy_note": "nødder", "allergy_severity": "severe"})
    assert r.status_code == 200, r.text
    row = _row(db, rid)
    assert row.allergy_note == "nødder" and row.allergy_severity == "severe"


# ── the mails ─────────────────────────────────────────────────────────────

def _venue(btype: str, name: str = "Cykelværkstedet Amager") -> mail.Venue:
    owner = SimpleNamespace(business_type=btype, business_name=name, email="owner@example.com")
    profile = SimpleNamespace(reservation_slug="booking-7gak", phone="+45 12 34 56 78",
                              public_address="Amagerbrogade 1", address=None,
                              company_name=name, reservation_settings_json=None)
    return mail.venue_context(owner, profile)


def _reservation(status="confirmed", service_name=None, party=1):
    return SimpleNamespace(
        id=uuid.uuid4(), user_id=uuid.uuid4(), status=status,
        starts_at=datetime(2026, 10, 16, 10, 0), party_size=party,
        guest_name="Sofie", guest_phone="+45 11 22 33 44", guest_email="sofie@example.com",
        guest_notes="Bremserne hviner", occasion=None, service_name=service_name,
        allergen_tags=[], allergy_note=None, allergy_severity=None,
        guest_lang=None, confirmation_sent_at=None,
    )


_NOW = datetime(2026, 10, 14, 12, 0)
_CANCEL = "https://www.bonbox.dk/r/booking-7gak?booking=1&token=t"
_RENDERS = {
    "confirmation": lambda r, v, l: mail.render_guest_confirmation(r, v, l, cancel_url=_CANCEL, now=_NOW),
    "request_received": lambda r, v, l: mail.render_guest_confirmation(r, v, l, cancel_url=_CANCEL, now=_NOW),
    "cancelled_by_guest": lambda r, v, l: mail.render_guest_cancelled_by_guest(r, v, l, now=_NOW),
    "withdrawn": lambda r, v, l: mail.render_guest_cancelled_by_guest(r, v, l, was_request=True, now=_NOW),
    "cancelled_by_venue": lambda r, v, l: mail.render_guest_cancelled_by_venue(r, v, l, now=_NOW),
    "request_declined": lambda r, v, l: mail.render_guest_cancelled_by_venue(r, v, l, was_request=True, now=_NOW),
    "request_confirmed": lambda r, v, l: mail.render_guest_request_confirmed(r, v, l, cancel_url=_CANCEL, now=_NOW),
    "moved": lambda r, v, l: mail.render_guest_moved(r, v, l, old_starts_at=datetime(2026, 10, 16, 9, 0), cancel_url=_CANCEL, now=_NOW),
    "reminder": lambda r, v, l: mail.render_guest_reminder(r, v, l, cancel_url=_CANCEL, now=_NOW),
    "reminder_no_link": lambda r, v, l: mail.render_guest_reminder(r, v, l, cancel_url=None, now=_NOW),
    "request_expired": lambda r, v, l: mail.render_guest_request_expired(r, v, l, now=_NOW),
    "owner_new_booking": lambda r, v, l: mail.render_owner_new_booking(
        r, v, l, booking_url="https://www.bonbox.dk/reservations?booking=1", now=_NOW),
    "owner_guest_cancelled": lambda r, v, l: mail.render_owner_guest_cancelled(
        r, v, l, booking_url="https://www.bonbox.dk/reservations", now=_NOW),
    "owner_request_withdrawn": lambda r, v, l: mail.render_owner_guest_cancelled(
        r, v, l, booking_url="https://www.bonbox.dk/reservations", was_request=True, now=_NOW),
}
_REQUESTS = {"request_received", "withdrawn", "request_declined", "request_expired",
             "owner_request_withdrawn"}


def _text(subject: str, html: str) -> str:
    """What the reader sees: the subject and the html without its tags (the
    links' addresses — "/reservations?booking=" — are not words)."""
    return subject + " " + re.sub(r"<[^>]+>", " ", html)


def test_the_venue_says_whether_it_books_appointments():
    assert _venue("workshop").appointment is True
    assert _venue("clothing").appointment is True
    assert _venue("Workshop ").appointment is True
    assert _venue("salon").appointment is True
    for btype in ("restaurant", "cafe", "bar", "other", None):
        assert _venue(btype).appointment is False, btype


def test_the_workshop_confirmation_reads_appointment_not_reservation():
    """The exact mail QA quoted, without a service (a table-engine booking)."""
    subject, html = mail.render_guest_confirmation(_reservation(), _venue("workshop"), "da",
                                                   cancel_url=_CANCEL, now=_NOW)
    assert subject.startswith("Cykelværkstedet Amager — aftale bekræftet: ")
    assert "Din aftale er bekræftet." in html
    assert "Aflys din aftale her</a>, så en anden kan få tiden." in html
    assert "1 person" in html


@pytest.mark.parametrize("btype", ["workshop", "clothing"])
@pytest.mark.parametrize("which", sorted(_RENDERS))
def test_no_restaurant_word_in_any_shop_or_workshop_mail(btype, which):
    r = _reservation(status="requested" if which in _REQUESTS else "confirmed")
    v = _venue(btype)
    da_text = _text(*_RENDERS[which](r, v, "da"))
    en_text = _text(*_RENDERS[which](r, v, "en"))
    assert not re.search(r"reservation|gæst|bord|selskab|køkken", da_text, re.I), (which, da_text)
    assert not re.search(r"reservation|guest|table|party|kitchen", en_text, re.I), (which, en_text)


@pytest.mark.parametrize("which", sorted(_RENDERS))
def test_a_restaurant_mail_keeps_its_words(which):
    r = _reservation(status="requested" if which in _REQUESTS else "confirmed", party=4)
    v = _venue("restaurant", "Bistro")
    for lang in ("da", "en"):
        text = _text(*_RENDERS[which](r, v, lang))
        # None of the appointment words reaches a restaurant's guest.
        assert not re.search(r"aftale|kunde|en anden kan|someone else|customer|your time is held",
                             text, re.I), (which, lang, text)


def test_restaurant_confirmation_unchanged():
    subject, html = mail.render_guest_confirmation(_reservation(party=4), _venue("restaurant", "Bistro"), "da",
                                                   cancel_url=_CANCEL, now=_NOW)
    assert "— reservation bekræftet: " in subject
    assert "Din reservation er bekræftet." in html
    assert "Aflys din reservation her</a>, så en anden gæst kan få bordet." in html
    _, en = mail.render_guest_confirmation(_reservation(party=4), _venue("restaurant", "Bistro"), "en",
                                           cancel_url=_CANCEL, now=_NOW)
    assert "so another guest can have the table." in en


def test_a_salon_treatment_reads_the_same_appointment_words():
    """A salon treatment was already an appointment (it has a service); it now
    says "aftale" too, and still names the treatment."""
    subject, html = mail.render_guest_confirmation(_reservation(service_name="Dameklip"),
                                                   _venue("salon", "Salon Sol"), "da",
                                                   cancel_url=_CANCEL, now=_NOW)
    assert "aftale bekræftet" in subject
    assert "Dameklip" in html
    assert "så en anden kan få tiden" in html
