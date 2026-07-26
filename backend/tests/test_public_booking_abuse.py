"""The public booking form is the one door anyone on the internet can push.

Three holes, all live before this, all exploitable from a phone:

  1. The monthly cap counted CREATION ATTEMPTS, not bookings. Twenty
     create-then-cancel round trips — about four minutes at the 6/min
     public limit — burned a Free venue's whole month. Cancelling left
     the floor plan clean, so the owner saw a dead booking page with no
     cause and nothing to show a support agent.

  2. Contact details were required by the FORM but optional in the API.
     A script could post a one-character name and nothing else, and the
     row auto-confirmed — untraceable holds the venue cannot ring to
     verify.

  3. Confirmation emails went to any address with no per-recipient
     bound, from our sending domain, reply-to the venue. That is an open
     relay, and the deliverability damage lands on every owner on the
     platform.

Run:
  cd backend && python3 -m pytest tests/test_public_booking_abuse.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta, timezone
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
from app.models.user import User

_db_ready.set()

_DAY_DATE = date.today() + timedelta(days=3)
_DAY = _DAY_DATE.isoformat()

_SETTINGS = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 90}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 8,
    "retention_days": 90,
}


@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
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
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    # The 6/min public-create limit is real and correct; these tests fire
    # more than that on purpose, so the limiter is reset per test.
    try:
        import app.routers.public_reservations as m
        m._limiter.reset()
    except Exception:  # noqa: BLE001
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _restaurant(db, *, plan="free", tables=6):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Test Bistro", business_type="restaurant",
        currency="DKK", plan=plan,
    )
    db.add(u); db.commit(); db.refresh(u)

    hours = {k: "11:00-23:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    profile = BusinessProfile(
        user_id=u.id, company_name="Test Bistro",
        reservation_slug=f"bistro-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(hours),
    )
    db.add(profile); db.commit(); db.refresh(profile)

    for i in range(tables):
        db.add(BookableResource(
            user_id=u.id, kind="table", label=f"Bord {i + 1}",
            capacity_seats=4, sort_order=i,
        ))
    db.commit()
    return u, profile


def _book(client, slug, *, time="19:00", party=2, email="sita@example.com",
          phone=None, name="Sita Sharma", **extra):
    body = {"day": _DAY, "time": time, "party_size": party, "guest_name": name}
    if email is not None:
        body["guest_email"] = email
    if phone is not None:
        body["guest_phone"] = phone
    body.update(extra)
    return client.post(f"/api/public/reservations/{slug}", json=body)


# ── 1. the cap must count bookings, not attempts ─────────────────────

def test_cancelled_bookings_do_not_burn_the_monthly_cap(client, db):
    """THE EXPLOIT. Free is 20 reservations/month. Book and cancel
    repeatedly and the venue used to go dark for the rest of the month
    with an empty floor plan and no explanation.

    Seeded directly at 20 cancelled rows: the point is the COUNTING rule,
    and routing 20 bookings through HTTP would really be testing table
    assignment.
    """
    owner, profile = _restaurant(db, plan="free", tables=40)
    for i in range(20):
        db.add(Reservation(
            user_id=owner.id,
            starts_at=datetime.now() + timedelta(days=9),
            ends_at=datetime.now() + timedelta(days=9, minutes=90),
            party_size=2, guest_name="Troll", status="cancelled",
            cancelled_at=datetime.now(timezone.utc),
        ))
    db.commit()

    r = _book(client, profile.reservation_slug)
    assert r.status_code == 200, (
        "cancelled bookings consumed the venue's quota — the page is dark "
        "for the rest of the month with a clean floor plan"
    )


def test_live_bookings_still_count_toward_the_cap(client, db):
    """The cap must remain a real cap — this is a tier boundary, not a
    formality."""
    owner, profile = _restaurant(db, plan="free", tables=40)
    slug = profile.reservation_slug

    # Free = 20/month. Seed 20 live rows directly (fast, and the point is
    # the counting rule, not the HTTP path).
    for i in range(20):
        db.add(Reservation(
            user_id=owner.id,
            starts_at=datetime.now() + timedelta(days=9),
            ends_at=datetime.now() + timedelta(days=9, minutes=90),
            party_size=2, guest_name="X", status="confirmed",
        ))
    db.commit()

    r = _book(client, slug)
    assert r.status_code == 409, "a genuinely full month must still refuse"
    assert r.json()["detail"]["error"] == "not_accepting"


@pytest.mark.parametrize("status", ["completed", "no_show"])
def test_a_held_table_counts_even_after_the_night(client, db, status):
    """completed and no_show both mean the table WAS held — the cover was
    real, so the quota was genuinely spent. Only a cancellation gives
    capacity back."""
    owner, profile = _restaurant(db, plan="free", tables=40)
    for i in range(20):
        db.add(Reservation(
            user_id=owner.id,
            starts_at=datetime.now() + timedelta(days=9),
            ends_at=datetime.now() + timedelta(days=9, minutes=90),
            party_size=2, guest_name="X", status=status,
        ))
    db.commit()
    assert _book(client, profile.reservation_slug).status_code == 409


# ── 2. contact is required by the SERVER, not just the form ──────────

def test_a_booking_with_no_way_to_reach_the_guest_is_refused(client, db):
    """The form always demanded this. The API did not — so a script
    posted a name and nothing else, and it auto-confirmed."""
    _, profile = _restaurant(db)
    r = _book(client, profile.reservation_slug, email=None, phone=None)
    assert r.status_code == 422, r.text
    assert db.query(Reservation).count() == 0


def test_either_contact_alone_is_enough(client, db):
    """A guest with no email must still be able to book by phone."""
    _, profile = _restaurant(db)
    assert _book(client, profile.reservation_slug,
                 email=None, phone="+45 31 41 59 26").status_code == 200
    assert _book(client, profile.reservation_slug, time="20:00",
                 email="a@b.dk", phone=None).status_code == 200


@pytest.mark.parametrize("email,phone", [
    ("not-an-email", None),
    ("a@b", None),
    (None, "abc"),
    (None, "12"),
    ("   ", "  "),          # whitespace is not a contact
])
def test_unusable_contact_details_are_refused(client, db, email, phone):
    _, profile = _restaurant(db)
    r = _book(client, profile.reservation_slug, email=email, phone=phone)
    assert r.status_code == 422, f"{email!r}/{phone!r} was accepted"


def test_a_foreign_number_still_works(client, db):
    """Copenhagen has tourists. The check is a typo guard, not a border."""
    _, profile = _restaurant(db)
    assert _book(client, profile.reservation_slug,
                 email=None, phone="+44 20 7946 0958").status_code == 200


# ── 3. confirmations are not a relay ─────────────────────────────────
#
# Exercised against _send_confirmation directly rather than through HTTP:
# for table bookings the confirmation is sent from a BackgroundTask that
# opens its OWN SessionLocal, so it never sees this test's in-memory DB.
# Driving it through the endpoint would assert on a send that structurally
# cannot happen here — a green test proving nothing.

def _res(db, owner, email, *, sent_at=None):
    r = Reservation(
        user_id=owner.id,
        starts_at=datetime.now() + timedelta(days=9),
        ends_at=datetime.now() + timedelta(days=9, minutes=90),
        party_size=2, guest_name="Sita", guest_email=email,
        status="confirmed", confirmation_sent_at=sent_at,
    )
    db.add(r); db.commit(); db.refresh(r)
    return r


def test_one_address_cannot_be_mailed_without_bound(client, db, monkeypatch):
    """Booking repeatedly with a stranger's address must not make us mail
    them indefinitely from our own sending domain."""
    import app.routers.public_reservations as m
    import app.services.email_service as es
    sent = []
    monkeypatch.setattr(es, "send_email", lambda **k: (sent.append(k.get("to")), True)[1])

    owner, profile = _restaurant(db)
    for _ in range(6):
        m._send_confirmation(owner, profile, _res(db, owner, "victim@example.com"), db)

    assert len(sent) == m._CONFIRMATIONS_PER_ADDRESS_PER_DAY, (
        f"sent {len(sent)} mails to one address — the booking form is a relay"
    )


def test_the_cap_is_case_and_whitespace_insensitive(client, db, monkeypatch):
    """Otherwise ' Victim@Example.com ' is a fresh quota every time."""
    import app.routers.public_reservations as m
    import app.services.email_service as es
    sent = []
    monkeypatch.setattr(es, "send_email", lambda **k: (sent.append(k.get("to")), True)[1])

    owner, profile = _restaurant(db)
    for addr in ("victim@example.com", "Victim@Example.com", " VICTIM@example.com ",
                 "victim@example.com", "victim@EXAMPLE.com"):
        m._send_confirmation(owner, profile, _res(db, owner, addr), db)

    assert len(sent) == m._CONFIRMATIONS_PER_ADDRESS_PER_DAY


def test_different_addresses_are_not_throttled_by_each_other(client, db, monkeypatch):
    """A busy Friday is many guests, one venue. The bound is per address."""
    import app.routers.public_reservations as m
    import app.services.email_service as es
    sent = []
    monkeypatch.setattr(es, "send_email", lambda **k: (sent.append(k.get("to")), True)[1])

    owner, profile = _restaurant(db)
    for i in range(5):
        m._send_confirmation(owner, profile, _res(db, owner, f"guest{i}@example.com"), db)

    assert len(sent) == 5, "real guests were throttled by each other"


def test_one_venues_flood_does_not_silence_another(client, db, monkeypatch):
    """The quota is per (venue, address) — a troll hitting one restaurant
    must not stop a different restaurant confirming the same guest."""
    import app.routers.public_reservations as m
    import app.services.email_service as es
    sent = []
    monkeypatch.setattr(es, "send_email", lambda **k: (sent.append(k.get("to")), True)[1])

    a_owner, a_profile = _restaurant(db)
    b_owner, b_profile = _restaurant(db)
    for _ in range(4):
        m._send_confirmation(a_owner, a_profile, _res(db, a_owner, "guest@example.com"), db)
    before = len(sent)
    m._send_confirmation(b_owner, b_profile, _res(db, b_owner, "guest@example.com"), db)
    assert len(sent) == before + 1


def test_a_booking_still_succeeds_when_its_confirmation_is_suppressed(client, db, monkeypatch):
    """Suppressing a confirmation must never fail the BOOKING. A real
    guest would otherwise be turned away because someone abused the form."""
    import app.routers.public_reservations as m
    monkeypatch.setattr(m, "_confirmation_quota_left", lambda *a, **k: False)
    _, profile = _restaurant(db)
    r = _book(client, profile.reservation_slug)
    assert r.status_code == 200, r.text
    assert db.query(Reservation).count() == 1
