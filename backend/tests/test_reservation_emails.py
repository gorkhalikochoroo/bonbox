"""Booking notifications a guest and an owner can trust.

Verified in production before this: a guest who booked in English got a
Danish-only confirmation; the confirmation claimed "sent" (confirmation_sent_at)
even when the send failed; a guest cancelling online told the owner only by a
push most owners never enabled; and a guest whose booking the venue cancelled,
confirmed or moved heard nothing at all.

Every send here goes through services/reservation_emails.py, and every test
runs the REAL wiring — the public endpoints, the owner endpoints, the host
stand, the background tasks (pointed at this in-memory DB) and the nightly
jobs — with only email_service.send_email replaced. Nothing touches the
network.

Run:
  cd backend && python -m pytest tests/test_reservation_emails.py -q
"""
from __future__ import annotations

import html as _html
import json
import logging
import uuid
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.models.user import User
from app.services import reservation_emails as mail
from app.services.auth import get_current_user
from app.services.owner_language import venue_language
from app.utils.time import utc_now

_db_ready.set()

GUEST = "sita.guest@example.com"
_DAY_DATE = date.today() + timedelta(days=3)
_DAY = _DAY_DATE.isoformat()

_SETTINGS = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 90}],
    "default_duration_min": 120,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 8,
    "retention_days": 90,
    "contact_phone": "+45 12 34 56 78",
}
_ALL_WEEK = {k: "11:00-23:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}


# ── fixtures ────────────────────────────────────────────────────────────

@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:",
                        connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def db(engine_and_session) -> Iterator:
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session, monkeypatch):
    """TestClient whose background tasks run against THIS database.

    The notification tasks open their own SessionLocal (the request's session
    is gone by then); both modules' factories are pointed at the test engine,
    so the sends under test really happen instead of silently finding nothing.
    """
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    import app.routers.public_reservations as pubres
    monkeypatch.setattr(pubres, "SessionLocal", SessionLocal)
    monkeypatch.setattr(mail, "SessionLocal", SessionLocal)
    app.dependency_overrides[get_db] = _get_test_db
    pubres._limiter.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()


class Outbox(list):
    """Every email that would have gone out. `fail_next(n)` makes the next n
    sends fail the way Resend does — send_email returns False."""
    failing = 0

    def fail_next(self, n: int) -> None:
        self.failing = n


@pytest.fixture
def outbox(monkeypatch) -> Outbox:
    import app.services.email_service as es

    box = Outbox()

    def _send(to=None, subject=None, html=None, reply_to=None, **kw):
        box.append({"to": to, "subject": subject, "html": html, "reply_to": reply_to})
        if box.failing > 0:
            box.failing -= 1
            return False
        return True

    monkeypatch.setattr(es, "send_email", _send)
    return box


@pytest.fixture
def sleeps(monkeypatch) -> list:
    """No real sleeping; record the retry delays asked for."""
    calls: list = []
    monkeypatch.setattr(mail, "_sleep", lambda s: calls.append(s))
    return calls


def _fail_next(outbox, n: int) -> None:
    outbox.fail_next(n)


def _to(outbox, addr) -> list:
    return [m for m in outbox if m["to"] == addr]


# ── builders ────────────────────────────────────────────────────────────

def _venue(db, *, country="DK", ui_language=None, currency="DKK", tables=6,
           seats=4, settings=None, hours=None, name="Test Bistro", timezone=None):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name=name, business_type="restaurant", currency=currency,
        plan="pro", ui_language=ui_language,
    )
    if timezone:
        u.timezone = timezone
    db.add(u); db.commit(); db.refresh(u)
    profile = BusinessProfile(
        user_id=u.id, company_name=name, country=country,
        reservation_slug=f"bistro-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(settings or _SETTINGS),
        operating_hours_json=json.dumps(hours or _ALL_WEEK),
    )
    db.add(profile); db.commit(); db.refresh(profile)
    for i in range(tables):
        db.add(BookableResource(user_id=u.id, kind="table", label=f"Bord {i + 1}",
                                capacity_seats=seats, sort_order=i))
    db.commit()
    return u, profile


def _booking(db, owner, *, days=3, hour=19, status="confirmed", email=GUEST,
             lang=None, name="Sita Sharma", party=4, confirmation_sent=True,
             service_name=None):
    start = datetime.combine(date.today() + timedelta(days=days),
                             datetime.min.time()).replace(hour=hour)
    r = Reservation(
        user_id=owner.id, starts_at=start, ends_at=start + timedelta(minutes=90),
        party_size=party, guest_name=name, guest_email=email, guest_phone="+45 11 22 33 44",
        guest_lang=lang, status=status, source="public", service_name=service_name,
        confirmation_sent_at=(utc_now() if confirmation_sent else None),
    )
    db.add(r); db.commit(); db.refresh(r)
    return r


def _book(client, slug, **extra):
    body = {"day": _DAY, "time": "19:00", "party_size": 2,
            "guest_name": "Sita Sharma", "guest_email": GUEST}
    body.update(extra)
    return client.post(f"/api/public/reservations/{slug}", json=body)


def _as_owner(owner):
    app.dependency_overrides[get_current_user] = lambda: owner


def _logs(db, **filters):
    db.expire_all()
    q = db.query(NotificationLog).filter(NotificationLog.channel == "email")
    for k, v in filters.items():
        q = q.filter(getattr(NotificationLog, k) == v)
    return q.all()


# ── 1. public create: the confirmation, in the guest's language ─────────

def test_english_guest_at_a_danish_venue_gets_english(client, db, outbox):
    owner, profile = _venue(db, country="DK")
    r = _book(client, profile.reservation_slug, lang="en")
    assert r.status_code == 200, r.text

    guest = _to(outbox, GUEST)
    assert len(guest) == 1
    when_en = mail.format_when(datetime.combine(_DAY_DATE, datetime.min.time()).replace(hour=19), "en")
    assert guest[0]["subject"] == f"Test Bistro — booking confirmed: {when_en}"
    assert "Hi Sita Sharma" in guest[0]["html"]
    assert when_en in guest[0]["html"] and " at 19:00" in when_en
    assert "Cancel your booking here" in guest[0]["html"]
    assert guest[0]["reply_to"] == owner.email

    # The owner still reads Danish — their own language, not the guest's.
    own = _to(outbox, owner.email)
    assert len(own) == 1 and "Ny reservation via din bookingside" in own[0]["html"]

    db.expire_all()
    row = db.query(Reservation).one()
    assert row.guest_lang == "en"
    assert row.confirmation_sent_at is not None


def test_danish_guest_at_a_foreign_venue_gets_danish(client, db, outbox):
    _, profile = _venue(db, country="DE", currency="EUR")
    assert _book(client, profile.reservation_slug, lang="da").status_code == 200
    guest = _to(outbox, GUEST)[0]
    assert "reservation bekræftet" in guest["subject"]
    assert "<p>Hej Sita Sharma,</p>" in guest["html"]
    assert " kl. 19:00" in guest["html"]


@pytest.mark.parametrize("country,expected", [("DK", "da"), ("GB", "en")])
def test_no_lang_falls_back_to_the_venue_language(client, db, outbox, country, expected):
    """Old clients don't send `lang` — they must keep working, in the venue's
    language (the same default the public page opens in)."""
    _, profile = _venue(db, country=country)
    assert _book(client, profile.reservation_slug).status_code == 200
    html = _to(outbox, GUEST)[0]["html"]
    assert f'lang="{expected}"' in html
    assert ("Din reservation er bekræftet" in html) == (expected == "da")
    db.expire_all()
    assert db.query(Reservation).one().guest_lang is None


@pytest.mark.parametrize("sent,stored", [
    ("en-GB", "en"), ("DA", "da"), ("da_DK", "da"),
    ("fr", None), ("x" * 500, None), (123, None), ([], None), (None, None),
])
def test_lang_is_cleaned_never_rejected(client, db, outbox, sent, stored):
    _, profile = _venue(db)
    r = _book(client, profile.reservation_slug, lang=sent)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(Reservation).one().guest_lang == stored


def test_a_group_request_gets_request_received_not_confirmed(client, db, outbox):
    _, profile = _venue(db)
    r = _book(client, profile.reservation_slug, party_size=10, lang="en")
    assert r.status_code == 200 and r.json()["status"] == "requested"
    guest = _to(outbox, GUEST)[0]
    assert "request received" in guest["subject"]
    assert "isn't held until" in guest["html"]
    assert "confirmed" not in guest["subject"]
    assert "Withdraw your request here" in guest["html"]


def test_confirmation_sent_at_is_not_stamped_when_the_send_fails(client, db, outbox, sleeps, monkeypatch):
    monkeypatch.setattr(mail, "_email_configured", lambda: True)
    _fail_next(outbox, 2)  # the first try AND the retry
    _, profile = _venue(db)
    assert _book(client, profile.reservation_slug).status_code == 200

    assert len(_to(outbox, GUEST)) == 2, "expected one send + exactly one retry"
    assert sleeps == [mail.RETRY_DELAY_SECONDS]
    db.expire_all()
    assert db.query(Reservation).one().confirmation_sent_at is None
    failed = _logs(db, event_type=mail.GUEST_CONFIRMATION)
    assert [(x.status, x.error_message) for x in failed] == [("failed", "send_failed")]


def test_one_retry_rescues_a_hiccup(client, db, outbox, sleeps, monkeypatch):
    monkeypatch.setattr(mail, "_email_configured", lambda: True)
    _fail_next(outbox, 1)
    _, profile = _venue(db)
    assert _book(client, profile.reservation_slug).status_code == 200
    assert len(_to(outbox, GUEST)) == 2
    assert sleeps == [1.5]
    db.expire_all()
    assert db.query(Reservation).one().confirmation_sent_at is not None
    assert [x.status for x in _logs(db, event_type=mail.GUEST_CONFIRMATION)] == ["sent"]


def test_no_pointless_retry_when_email_is_not_configured(client, db, outbox, sleeps, monkeypatch):
    monkeypatch.setattr(mail, "_email_configured", lambda: False)
    _fail_next(outbox, 5)
    _, profile = _venue(db)
    assert _book(client, profile.reservation_slug).status_code == 200
    assert len(_to(outbox, GUEST)) == 1 and sleeps == []
    assert _logs(db, event_type=mail.GUEST_CONFIRMATION)[0].error_message == "not_configured"


def test_a_raising_mailer_never_fails_the_booking(client, db, monkeypatch, sleeps):
    import app.services.email_service as es
    monkeypatch.setattr(es, "send_email",
                        lambda **k: (_ for _ in ()).throw(RuntimeError("resend down")))
    _, profile = _venue(db)
    r = _book(client, profile.reservation_slug)
    assert r.status_code == 200
    db.expire_all()
    assert db.query(Reservation).one().confirmation_sent_at is None


def test_log_rows_carry_no_guest_pii(client, db, outbox, caplog):
    owner, profile = _venue(db)
    caplog.set_level(logging.DEBUG)
    r = _book(client, profile.reservation_slug, guest_name="Zelda Unique-Name",
              guest_phone="+45 99 88 77 66", allergen_tags=["peanuts"],
              allergy_note="anafylaksi ved jordnødder")
    rid = r.json()["id"]

    rows = _logs(db)
    assert {x.event_type for x in rows} == {mail.GUEST_CONFIRMATION, mail.OWNER_NEW_BOOKING}
    for x in rows:
        blob = " ".join(str(v) for v in (x.subject, x.body, x.error_message, x.dedup_key))
        for pii in (GUEST, "Zelda", "Unique-Name", "99 88 77 66", "anafylaksi", "peanut"):
            assert pii not in blob, f"{pii!r} leaked into notification_log ({x.event_type})"
        assert x.body == f"reservation:{rid}"
        assert x.staff_id is None and str(x.user_id) == str(owner.id)
        assert x.status == "sent"
    for rec in caplog.records:
        msg = rec.getMessage()
        assert GUEST not in msg and "Zelda" not in msg and "anafylaksi" not in msg


def test_owner_email_follows_the_owners_app_language(client, db, outbox):
    owner, profile = _venue(db, ui_language="en")
    assert _book(client, profile.reservation_slug, lang="da",
                 occasion="Fødselsdag", guest_notes="Vindue tak").status_code == 200
    own = _to(outbox, owner.email)[0]
    assert "new booking" in own["subject"]
    assert "New booking via your booking page" in own["html"]
    assert "Occasion:" in own["html"] and "Fødselsdag" in own["html"]
    assert own["reply_to"] == GUEST
    # …while the guest reads Danish.
    assert "reservation bekræftet" in _to(outbox, GUEST)[0]["subject"]


def test_a_salon_booking_is_confirmed_off_the_request_path(client, db, outbox):
    """The provider path used to mail inline, on the request path. It now
    shares the background task — and still confirms, in the guest's language."""
    from app.models.behandling import Behandling
    owner, profile = _venue(db, tables=0, settings={**_SETTINGS, "booking_hours": _ALL_WEEK})
    chair = BookableResource(user_id=owner.id, kind="provider", label="Stol 1",
                             capacity_seats=1, follows_opening_hours=True)
    b = Behandling(user_id=owner.id, name="Dameklip", duration_min=45, active=True)
    db.add_all([chair, b]); db.commit()
    r = _book(client, profile.reservation_slug, behandling_id=str(b.id), party_size=1, lang="en")
    assert r.status_code == 200, r.text
    guest = _to(outbox, GUEST)[0]
    assert "booking confirmed" in guest["subject"]
    assert "Dameklip" in guest["html"] and "the slot" in guest["html"]


# ── 2. guest cancels online ─────────────────────────────────────────────

def _cancel(client, booking):
    return client.post(
        f"/api/public/reservations/booking/{booking['id']}/cancel",
        params={"token": booking["booking_token"]},
    )


def test_guest_cancel_tells_the_guest_and_emails_the_owner(client, db, outbox):
    owner, profile = _venue(db)
    booking = _book(client, profile.reservation_slug, lang="en",
                    guest_phone="+45 11 22 33 44").json()
    outbox.clear()

    assert _cancel(client, booking).json()["status"] == "cancelled"

    guest = _to(outbox, GUEST)
    assert len(guest) == 1
    assert "your booking is cancelled" in guest[0]["subject"]
    assert "Book again" in guest[0]["html"]
    assert f"/r/{profile.reservation_slug}" in guest[0]["html"]

    own = _to(outbox, owner.email)
    assert len(own) == 1, "the owner must hear about it even without push"
    assert "aflyst af gæsten" in own[0]["subject"]
    assert "Sita Sharma" in own[0]["html"] and "+45 11 22 33 44" in own[0]["html"]
    assert GUEST in own[0]["html"]
    assert f"booking={booking['id']}" in own[0]["html"]
    assert f"date={_DAY}" in own[0]["html"]
    assert "Se dagens reservationer" in own[0]["html"]
    assert own[0]["reply_to"] == GUEST
    assert {x.event_type for x in _logs(db, status="sent")} >= {
        mail.GUEST_CANCELLED_BY_GUEST, mail.OWNER_GUEST_CANCELLED}


def test_a_second_cancel_sends_nothing_more(client, db, outbox):
    _, profile = _venue(db)
    booking = _book(client, profile.reservation_slug).json()
    _cancel(client, booking)
    n = len(outbox)
    _cancel(client, booking)
    assert len(outbox) == n


def test_no_cancel_mail_to_an_address_we_never_confirmed(client, db, outbox, monkeypatch):
    """The cancel link works on every booking — including those whose
    confirmation the per-address cap withheld. Book-then-cancel must not be a
    way around that cap; the owner is still told."""
    owner, profile = _venue(db)
    monkeypatch.setattr(mail, "confirmation_quota_left", lambda *a, **k: False)
    booking = _book(client, profile.reservation_slug).json()
    assert _to(outbox, GUEST) == []
    _cancel(client, booking)
    assert _to(outbox, GUEST) == []
    assert len(_to(outbox, owner.email)) == 2  # new booking + guest cancelled
    assert [x.error_message for x in _logs(db, event_type=mail.GUEST_CANCELLED_BY_GUEST)] == [
        "no_prior_mail"]


def test_phone_only_guest_cancel_still_reaches_the_owner(client, db, outbox):
    owner, profile = _venue(db)
    booking = _book(client, profile.reservation_slug, guest_email=None,
                    guest_phone="+45 11 22 33 44").json()
    outbox.clear()
    _cancel(client, booking)
    assert [m["to"] for m in outbox] == [owner.email]
    assert outbox[0]["reply_to"] is None


def test_withdrawn_request_reads_as_withdrawn(client, db, outbox):
    owner, profile = _venue(db)
    booking = _book(client, profile.reservation_slug, party_size=10, lang="en").json()
    outbox.clear()
    _cancel(client, booking)
    assert "your request is withdrawn" in _to(outbox, GUEST)[0]["subject"]
    assert "forespørgsel trukket tilbage" in _to(outbox, owner.email)[0]["subject"]


# ── 3. the venue changes a booking in the app ───────────────────────────

def _status(client, owner, r, status, **extra):
    _as_owner(owner)
    return client.patch(f"/api/reservations/reservations/{r.id}/status",
                        json={"status": status, **extra})


def test_accepting_a_request_confirms_it_to_the_guest(client, db, outbox):
    owner, _ = _venue(db)
    r = _booking(db, owner, status="requested", lang="en", party=10)
    assert _status(client, owner, r, "confirmed").status_code == 200
    guest = _to(outbox, GUEST)
    assert len(guest) == 1
    assert "your request is confirmed" in guest[0]["subject"]
    assert "your table is held" in guest[0]["html"]
    assert "Cancel your booking here" in guest[0]["html"]
    assert [x.status for x in _logs(db, event_type=mail.GUEST_REQUEST_CONFIRMED)] == ["sent"]


def test_venue_cancel_is_polite_with_phone_and_book_again(client, db, outbox):
    owner, profile = _venue(db)
    r = _booking(db, owner, lang="da")
    assert _status(client, owner, r, "cancelled", cancel_reason="owner_cancelled").status_code == 200
    guest = _to(outbox, GUEST)
    assert len(guest) == 1
    assert "din reservation er aflyst" in guest[0]["subject"]
    assert 'href="tel:+4512345678"' in guest[0]["html"]
    assert "Book en anden dag" in guest[0]["html"]
    assert f"/r/{profile.reservation_slug}" in guest[0]["html"]
    assert "owner_cancelled" not in guest[0]["html"], "internal reason must not reach the guest"


def test_declining_a_request_says_so(client, db, outbox):
    owner, _ = _venue(db)
    r = _booking(db, owner, status="requested", lang="en", party=10)
    _status(client, owner, r, "cancelled")
    assert "we couldn't confirm your request" in _to(outbox, GUEST)[0]["subject"]


@pytest.mark.parametrize("prev,new", [
    ("confirmed", "confirmed"),   # nothing changed
    ("requested", "requested"),
    ("confirmed", "seated"),
    ("seated", "completed"),
    ("confirmed", "no_show"),
    ("confirmed", "completed"),
    ("seated", "cancelled"),      # the guest is in the room
])
def test_no_mail_for_changes_a_guest_need_not_hear_about(client, db, outbox, prev, new):
    owner, _ = _venue(db)
    r = _booking(db, owner, status=prev)
    assert _status(client, owner, r, new).status_code == 200
    assert _to(outbox, GUEST) == []


def test_no_mail_about_a_booking_already_in_the_past(client, db, outbox):
    owner, _ = _venue(db)
    r = _booking(db, owner, days=-2)
    _status(client, owner, r, "cancelled")
    r2 = _booking(db, owner, days=-1, status="requested", party=10)
    _status(client, owner, r2, "confirmed")
    assert outbox == []


def test_no_mail_without_a_guest_email(client, db, outbox):
    owner, _ = _venue(db)
    r = _booking(db, owner, email=None)
    _status(client, owner, r, "cancelled")
    assert outbox == []


def test_notify_guest_false_is_a_quiet_correction(client, db, outbox):
    owner, _ = _venue(db)
    r = _booking(db, owner)
    assert _status(client, owner, r, "cancelled", notify_guest=False).status_code == 200
    assert outbox == []


def _edit(client, owner, r, **body):
    _as_owner(owner)
    return client.patch(f"/api/reservations/reservations/{r.id}", json=body)


def test_a_moved_booking_tells_the_guest_new_and_old_time(client, db, outbox):
    owner, _ = _venue(db)
    r = _booking(db, owner, lang="da", hour=19)
    new = r.starts_at.replace(hour=20, minute=30)
    assert _edit(client, owner, r, starts_at=new.isoformat()).status_code == 200
    guest = _to(outbox, GUEST)
    assert len(guest) == 1
    assert "ny tid for din reservation" in guest[0]["subject"]
    assert "kl. 20:30" in guest[0]["subject"]
    assert "<s>" in guest[0]["html"] and "kl. 19:00</s>" in guest[0]["html"]
    assert "Ny tid:" in guest[0]["html"]
    assert "Aflys din reservation her" in guest[0]["html"]


def test_the_owner_app_resending_the_same_time_is_not_a_move(client, db, outbox):
    """The edit form ALWAYS sends starts_at — a phone-number fix must not
    tell the guest their booking moved."""
    owner, _ = _venue(db)
    r = _booking(db, owner)
    assert _edit(client, owner, r, starts_at=r.starts_at.isoformat(),
                 guest_phone="+45 55 55 55 55").status_code == 200
    assert _edit(client, owner, r, starts_at=r.starts_at.isoformat(),
                 party_size=6).status_code == 200
    assert outbox == []


def test_moving_into_the_past_or_quietly_sends_nothing(client, db, outbox):
    owner, _ = _venue(db)
    r = _booking(db, owner)
    past = (datetime.now() - timedelta(days=1)).replace(microsecond=0)
    assert _edit(client, owner, r, starts_at=past.isoformat()).status_code == 200
    r2 = _booking(db, owner)
    moved = r2.starts_at + timedelta(hours=1)
    assert _edit(client, owner, r2, starts_at=moved.isoformat(),
                 notify_guest=False).status_code == 200
    assert outbox == []


def test_the_host_stand_tells_the_guest_too(client, db, outbox):
    """The stand wraps the owner handlers. A cancel or a move made at the door
    is the venue's decision like any other — and the wrapper must pass the
    background tasks through, or the stand itself breaks."""
    from app.routers import stand_link as S
    from app.routers.stand_link import limiter
    limiter.reset()
    owner, _ = _venue(db)
    app.dependency_overrides[S.get_current_user] = lambda: owner
    code = client.post("/api/stand/links", json={"label": "Door iPad"}).json()["code"]
    token = client.post("/api/stand/join", json={"code": code}).json()["path"].rsplit("/", 1)[-1]

    moved = _booking(db, owner, lang="en")
    res = client.patch(f"/api/stand/{token}/reservations/{moved.id}",
                       json={"starts_at": (moved.starts_at + timedelta(hours=1)).isoformat()})
    assert res.status_code == 200, res.text
    cancelled = _booking(db, owner, lang="en", email="other.guest@example.com")
    res = client.patch(f"/api/stand/{token}/reservations/{cancelled.id}/status",
                       json={"status": "cancelled"})
    assert res.status_code == 200, res.text
    seated = _booking(db, owner, email="third.guest@example.com")
    assert client.patch(f"/api/stand/{token}/reservations/{seated.id}/status",
                        json={"status": "seated"}).status_code == 200

    assert "new time for your booking" in _to(outbox, GUEST)[0]["subject"]
    assert "your booking has been cancelled" in _to(outbox, "other.guest@example.com")[0]["subject"]
    assert _to(outbox, "third.guest@example.com") == []


def test_an_owner_editing_back_and_forth_cannot_spam_the_guest(client, db, outbox):
    owner, _ = _venue(db)
    r = _booking(db, owner, confirmation_sent=False)
    a, b = r.starts_at, r.starts_at + timedelta(hours=1)
    for i in range(7):
        assert _edit(client, owner, r, starts_at=(b if i % 2 == 0 else a).isoformat()).status_code == 200
    assert len(_to(outbox, GUEST)) == mail.GUEST_EMAILS_PER_RESERVATION_PER_DAY == 5
    capped = _logs(db, event_type=mail.GUEST_MOVED, status="failed")
    assert [x.error_message for x in capped] == ["capped", "capped"]


# ── 4. the nightly jobs ─────────────────────────────────────────────────

@pytest.fixture
def job_db(db, monkeypatch):
    import app.jobs.reservation_jobs as jobs
    monkeypatch.setattr(jobs, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    return db


def _soon(db, owner, **kw):
    start = datetime.now() + timedelta(hours=20)
    r = Reservation(user_id=owner.id, starts_at=start, ends_at=start + timedelta(minutes=90),
                    party_size=2, guest_name="Mette", guest_email=GUEST, status="confirmed", **kw)
    db.add(r); db.commit(); db.refresh(r)
    return r


@pytest.mark.parametrize("lang,country,needle", [
    ("en", "DK", "Just a friendly reminder"),
    (None, "DK", "Bare en venlig påmindelse"),
    (None, "GB", "Just a friendly reminder"),
])
def test_reminder_is_in_the_guests_language(job_db, outbox, lang, country, needle):
    from app.jobs.reservation_jobs import send_reservation_reminders
    owner, _ = _venue(job_db, country=country)
    _soon(job_db, owner, guest_lang=lang)
    assert send_reservation_reminders() == 1
    assert needle in outbox[0]["html"]
    assert [x.event_type for x in _logs(job_db, status="sent")] == [mail.GUEST_REMINDER]


def test_a_failed_reminder_is_not_marked_sent(job_db, outbox, sleeps, monkeypatch):
    from app.jobs.reservation_jobs import send_reservation_reminders
    monkeypatch.setattr(mail, "_email_configured", lambda: True)
    _fail_next(outbox, 2)
    owner, _ = _venue(job_db)
    r = _soon(job_db, owner)
    assert send_reservation_reminders() == 0
    job_db.expire_all()
    assert job_db.get(Reservation, r.id).reminder_sent_at is None
    # …so the next run tries again, and this time it lands.
    assert send_reservation_reminders() == 1


def test_request_expiry_mail_is_bilingual_and_logged(db, outbox):
    from app.jobs.reservation_request_expiry import expire_stale_requests
    owner, _ = _venue(db)
    start = datetime.now() + timedelta(hours=2)
    db.add(Reservation(user_id=owner.id, starts_at=start, ends_at=start + timedelta(hours=2),
                       party_size=12, guest_name="Sita", guest_email=GUEST,
                       guest_lang="en", status="requested"))
    db.commit()
    out = expire_stale_requests(db)
    assert out == {"requests_expired": 1, "guests_notified": 1}
    assert "we couldn't confirm your request" in outbox[0]["subject"]
    assert "a table for 12 people" in outbox[0]["html"]
    assert [x.status for x in _logs(db, event_type=mail.GUEST_REQUEST_EXPIRED)] == ["sent"]


def test_request_expiry_counts_only_delivered_mail(db, monkeypatch, sleeps):
    from app.jobs.reservation_request_expiry import expire_stale_requests
    import app.services.email_service as es
    monkeypatch.setattr(es, "send_email", lambda **k: False)
    owner, _ = _venue(db)
    start = datetime.now() + timedelta(hours=2)
    db.add(Reservation(user_id=owner.id, starts_at=start, ends_at=start + timedelta(hours=2),
                       party_size=12, guest_name="Sita", guest_email=GUEST, status="requested"))
    db.commit()
    assert expire_stale_requests(db)["guests_notified"] == 0


# ── 5. every template escapes what people typed ─────────────────────────

_EVIL_NAME = '<script>alert("x")</script>'
_EVIL = {
    "guest_name": _EVIL_NAME,
    "guest_notes": '<img src=x onerror=alert(1)>',
    "occasion": '<a href="https://evil.example/o">o</a>',
    "allergy_note": '<iframe src="https://evil.example"></iframe>',
    "guest_phone": '<svg onload=alert(2)>',
    "guest_email": 'x"><b>@example.com',
    "service_name": '<marquee>cut</marquee>',
}
_EVIL_VENUE = mail.Venue(
    name='<i>Evil & "Co"</i>', phone='<svg/onload=alert(3)> 12 34',
    address='<style>body{}</style> Vej 1', booking_url="https://www.bonbox.dk/r/x",
    reply_to="owner@example.com",
)
_RAW_TAGS = ("<script", "<img", "<iframe", "<svg", "<marquee", "<style", "<i>", "<b>",
             '<a href="https://evil')


def _evil_reservation(status="confirmed", appointment=False):
    return SimpleNamespace(
        id=uuid.uuid4(), user_id=uuid.uuid4(), status=status,
        starts_at=datetime(2026, 10, 3, 19, 0), party_size=4,
        allergen_tags=["peanuts", '<b>bad-tag</b>'], allergy_severity="severe",
        guest_lang=None, confirmation_sent_at=None,
        **{**_EVIL, "service_name": _EVIL["service_name"] if appointment else None},
    )


_RENDERS = {
    "confirmation": lambda r, l: mail.render_guest_confirmation(r, _EVIL_VENUE, l, cancel_url="https://www.bonbox.dk/r/x?booking=1&token=t"),
    "cancelled_by_guest": lambda r, l: mail.render_guest_cancelled_by_guest(r, _EVIL_VENUE, l),
    "cancelled_by_venue": lambda r, l: mail.render_guest_cancelled_by_venue(r, _EVIL_VENUE, l),
    "request_declined": lambda r, l: mail.render_guest_cancelled_by_venue(r, _EVIL_VENUE, l, was_request=True),
    "request_confirmed": lambda r, l: mail.render_guest_request_confirmed(r, _EVIL_VENUE, l, cancel_url="https://www.bonbox.dk/c"),
    "moved": lambda r, l: mail.render_guest_moved(r, _EVIL_VENUE, l, old_starts_at=datetime(2026, 10, 3, 18, 0), cancel_url="https://www.bonbox.dk/c"),
    "reminder": lambda r, l: mail.render_guest_reminder(r, _EVIL_VENUE, l, cancel_url=None),
    "request_expired": lambda r, l: mail.render_guest_request_expired(r, _EVIL_VENUE, l),
    "owner_new_booking": lambda r, l: mail.render_owner_new_booking(r, _EVIL_VENUE, l, booking_url="https://www.bonbox.dk/reservations?booking=1&date=2026-10-03"),
    "owner_guest_cancelled": lambda r, l: mail.render_owner_guest_cancelled(r, _EVIL_VENUE, l, booking_url="https://www.bonbox.dk/reservations"),
}


@pytest.mark.parametrize("appointment", [False, True])
@pytest.mark.parametrize("lang", ["da", "en"])
@pytest.mark.parametrize("which", sorted(_RENDERS))
def test_every_template_escapes_typed_text(which, lang, appointment):
    r = _evil_reservation(status="requested" if "request" in which else "confirmed",
                          appointment=appointment)
    subject, html = _RENDERS[which](r, lang)
    for raw in _RAW_TAGS:
        assert raw not in html, f"{which}/{lang}: raw {raw!r} reached the HTML"
    assert _html.escape(_EVIL_NAME) in html, f"{which}/{lang}: guest name missing/unescaped"
    if not which.startswith("owner_"):  # the owner's own mail names the venue only in the subject
        assert "&lt;i&gt;Evil &amp; &quot;Co&quot;&lt;/i&gt;" in html
    # Subjects are plain text: never HTML-escaped, never multi-line.
    assert "&amp;" not in subject and "\n" not in subject


def test_owner_template_shows_allergy_labels_and_severity_in_owner_language():
    r = _evil_reservation()
    _, da = mail.render_owner_new_booking(r, _EVIL_VENUE, "da", booking_url="u")
    _, en = mail.render_owner_new_booking(r, _EVIL_VENUE, "en", booking_url="u")
    assert "<strong>Allergi (alvorlig):</strong> Jordnødder" in da
    assert "<strong>Allergy (severe):</strong> Peanuts" in en


# ── 6. small pieces ─────────────────────────────────────────────────────

def test_dates_are_written_in_code_not_by_the_server_locale():
    now = datetime(2026, 9, 27)
    dt = datetime(2026, 9, 28, 17, 30)
    assert mail.format_when(dt, "da", now=now) == "mandag 28. september kl. 17:30"
    assert mail.format_when(dt, "en", now=now) == "Monday 28 September at 17:30"
    nxt = datetime(2027, 1, 2, 12, 0)
    assert mail.format_when(nxt, "da", now=now) == "lørdag 2. januar 2027 kl. 12:00"
    assert mail.format_when(nxt, "en", now=now) == "Saturday 2 January 2027 at 12:00"


@pytest.mark.parametrize("raw,out", [
    ("da", "da"), ("EN", "en"), ("en-US", "en"), ("da_DK", "da"),
    ("ne", None), ("", None), (None, None), (7, None),
])
def test_normalize_lang(raw, out):
    assert mail.normalize_lang(raw) == out


def test_venue_language_only_danish_on_a_real_dk_signal():
    own = SimpleNamespace(timezone="Europe/Copenhagen")
    assert venue_language(SimpleNamespace(country="DK"), own) == "da"
    assert venue_language(SimpleNamespace(country=""), own) == "da"
    assert venue_language(SimpleNamespace(country=""), SimpleNamespace(timezone="Europe/Berlin")) == "en"
    assert venue_language(SimpleNamespace(country="DE"), own) == "en"
    assert venue_language(None, SimpleNamespace(timezone="Atlantic/Faroe")) == "da"


def test_owner_link_lands_on_the_business_day():
    """A 00:30 seating belongs to last night's service — the book files it
    there, so the email's deep link must too."""
    owner = SimpleNamespace(timezone="Europe/Copenhagen")
    late = SimpleNamespace(id="abc", starts_at=datetime(2026, 10, 4, 0, 30))
    assert mail.owner_booking_url(late, owner).endswith("booking=abc&date=2026-10-03")
    evening = SimpleNamespace(id="abc", starts_at=datetime(2026, 10, 3, 19, 0))
    assert mail.owner_booking_url(evening, owner).endswith("date=2026-10-03")


def test_a_guest_email_is_never_sent_without_a_session_to_count_it():
    assert mail.deliver(None, owner_id=uuid.uuid4(), reservation_id=uuid.uuid4(),
                        event_type=mail.GUEST_CONFIRMATION, to=GUEST,
                        subject="s", html="h") is False


def test_a_list_of_addresses_is_refused(db, outbox):
    """The owner's edit form does not validate guest_email the way the public
    form does — "a@x, b@y" must not become a two-recipient send."""
    owner, _ = _venue(db)
    r = _booking(db, owner, email="a@example.com, b@example.com", status="cancelled")
    assert mail.send_guest_cancelled_by_venue(db, owner, None, r) is False
    assert outbox == []
    assert [x.error_message for x in _logs(db)] == ["bad_address"]
