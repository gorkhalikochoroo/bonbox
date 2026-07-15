"""
Staff-card covers — GET /api/portal/{token}/covers.

The one number that lets a waiter walk in knowing the night ("I aften · 38
gæster booket"). BonBox is the only system holding BOTH the reservation book
and the roster, so this is the differentiated half of the feature.

This endpoint is COUNT-ONLY by deliberate design, and these tests are the lock
on that. What they pin:
  • the payload is an aggregate integer — NO guest names / phone / email /
    notes / occasion, and NO ALLERGY DATA IN ANY FORM (GDPR Art.9 special-
    category health data; the owner's own host stand already refuses to show
    it, and this surface is strictly weaker — token-in-URL, PIN opt-in).
  • scope-binding: covers come back ONLY for days this staffer has a PUBLISHED
    shift. Otherwise any token holder is a covers-enumeration oracle.
  • tenant isolation: another owner's bookings never reach this staffer.
  • business-day bucketing (DK 06:00 cutoff) driven by the shift's START
    INSTANT, so a pre-cutoff early shift reads the right night.
  • null (no reservations venue) is NOT 0 (empty book).

Run:
  cd backend && python3 -m pytest tests/test_portal_covers.py -x -q
"""

import json
import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.staff import StaffMember, StaffLink, Schedule
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()


@pytest.fixture(autouse=True)
def _reset_limiter():
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    yield
    sp.limiter.reset()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
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
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, *, reservations_enabled=True, cutoff=6, email=None):
    u = User(
        email=email or f"owner-{uuid.uuid4().hex[:6]}@bonbox.dk",
        password_hash=hash_password("x"), business_name="Bon",
        business_type="restaurant", currency="DKK", role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    p = BusinessProfile(
        user_id=u.id, company_name="Bon",
        reservation_slug=f"bon-{uuid.uuid4().hex[:6]}",
        reservations_enabled=reservations_enabled,
        day_cutoff_hour=cutoff,
    )
    db.add(p); db.commit()
    return u


def _staff(db, owner, token, name="Agnes"):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(m); db.commit(); db.refresh(m)
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id, token=token, active=True))
    db.commit()
    return m


def _shift(db, owner, member, day, *, start="17:00", status="published"):
    s = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=member.id, date=day,
        start_time=start, end_time="23:00", status=status, role_on_shift="server",
    )
    db.add(s); db.commit()
    return s


def _booking(db, owner, when: datetime, party, status="confirmed"):
    r = Reservation(
        id=uuid.uuid4(), user_id=owner.id, guest_name="Kunde",
        guest_phone="+4512345678", guest_email="guest@example.com",
        party_size=party, starts_at=when, ends_at=when + timedelta(minutes=90),
        duration_min=90, status=status, source="public",
    )
    db.add(r); db.commit()
    return r


def _tomorrow(owner_cutoff=6):
    # A safely-future day so business_today_local can't drift the window.
    return date.today() + timedelta(days=2)


# ── the payload ───────────────────────────────────────────────────────────

def test_covers_returns_count_for_a_published_shift_day(client, db):
    o = _owner(db)
    m = _staff(db, o, "tokA")
    day = _tomorrow()
    _shift(db, o, m, day)
    _booking(db, o, datetime.combine(day, datetime.min.time().replace(hour=19)), 4)
    _booking(db, o, datetime.combine(day, datetime.min.time().replace(hour=20)), 2)

    r = client.get("/api/portal/tokA/covers")
    assert r.status_code == 200
    body = r.json()
    got = {d["business_date"]: d["covers"] for d in body["days"]}
    assert got[day.isoformat()] == 6


def test_covers_payload_carries_NO_guest_data_at_all(client, db):
    """The lock. If this ever fails, guest PII/Art.9 data reached a phone."""
    o = _owner(db)
    m = _staff(db, o, "tokA")
    day = _tomorrow()
    _shift(db, o, m, day)
    r = _booking(db, o, datetime.combine(day, datetime.min.time().replace(hour=19)), 4)
    # Load the booking up with everything that must NEVER leave.
    r.guest_notes = "birthday, table by window"
    r.occasion = "birthday"
    for field, val in (("allergen_tags", json.dumps(["nuts"])),
                       ("allergy_note", "severe peanut allergy"),
                       ("allergy_severity", "severe")):
        if hasattr(r, field):
            setattr(r, field, val)
    db.commit()

    raw = client.get("/api/portal/tokA/covers").text.lower()
    for forbidden in ["kunde", "4512345678", "guest@example.com", "birthday",
                      "nuts", "peanut", "severe", "allerg", "occasion", "note"]:
        assert forbidden not in raw, f"{forbidden!r} leaked to the staff surface"
    # And structurally: only the two allowed keys per day.
    for d in client.get("/api/portal/tokA/covers").json()["days"]:
        assert set(d.keys()) == {"business_date", "covers"}


# ── scope-binding + isolation ─────────────────────────────────────────────

def test_no_shift_means_no_covers(client, db):
    """A staffer who isn't rostered gets nothing — not the venue's numbers."""
    o = _owner(db)
    _staff(db, o, "tokA")
    day = _tomorrow()
    _booking(db, o, datetime.combine(day, datetime.min.time().replace(hour=19)), 40)

    assert client.get("/api/portal/tokA/covers").json()["days"] == []


def test_draft_shift_does_not_expose_covers(client, db):
    """Unpublished days are not the staffer's business, and must not become
    queryable dates."""
    o = _owner(db)
    m = _staff(db, o, "tokA")
    day = _tomorrow()
    _shift(db, o, m, day, status="draft")
    _booking(db, o, datetime.combine(day, datetime.min.time().replace(hour=19)), 40)

    assert client.get("/api/portal/tokA/covers").json()["days"] == []


def test_covers_are_tenant_scoped(client, db):
    """Owner B's guests never reach owner A's staffer."""
    a = _owner(db, email="a@bonbox.dk")
    b = _owner(db, email="b@bonbox.dk")
    ma = _staff(db, a, "tokA")
    day = _tomorrow()
    _shift(db, a, ma, day)
    _booking(db, a, datetime.combine(day, datetime.min.time().replace(hour=19)), 4)
    _booking(db, b, datetime.combine(day, datetime.min.time().replace(hour=19)), 99)

    got = {d["business_date"]: d["covers"] for d in client.get("/api/portal/tokA/covers").json()["days"]}
    assert got[day.isoformat()] == 4, "another tenant's covers leaked"


def test_peer_staff_cannot_read_via_another_token(client, db):
    """Identity is re-derived from the token — Bo isn't rostered, so Bo sees
    nothing even though Agnes is."""
    o = _owner(db)
    a = _staff(db, o, "tokA", name="Agnes")
    _staff(db, o, "tokB", name="Bo")
    day = _tomorrow()
    _shift(db, o, a, day)
    _booking(db, o, datetime.combine(day, datetime.min.time().replace(hour=19)), 8)

    assert client.get("/api/portal/tokB/covers").json()["days"] == []
    assert client.get("/api/portal/tokA/covers").json()["days"][0]["covers"] == 8


def test_dead_token_is_rejected(client, db):
    o = _owner(db)
    _staff(db, o, "tokA")
    assert client.get("/api/portal/nope/covers").status_code == 404


# ── honesty ───────────────────────────────────────────────────────────────

def test_not_a_reservations_venue_is_not_zero(client, db):
    """reservations OFF -> flag false + no days, so the client renders NOTHING.
    A bakery must never be told it has '0 booket'."""
    o = _owner(db, reservations_enabled=False)
    m = _staff(db, o, "tokA")
    _shift(db, o, m, _tomorrow())

    body = client.get("/api/portal/tokA/covers").json()
    assert body.get("reservations_enabled") is False
    assert body["days"] == []


def test_enabled_but_empty_book_is_zero_not_absent(client, db):
    """Reservations ON, nobody booked -> an honest 0 for the rostered day."""
    o = _owner(db)
    m = _staff(db, o, "tokA")
    day = _tomorrow()
    _shift(db, o, m, day)

    body = client.get("/api/portal/tokA/covers").json()
    assert body.get("reservations_enabled") is True
    got = {d["business_date"]: d["covers"] for d in body["days"]}
    assert got[day.isoformat()] == 0


def test_cancelled_and_noshow_contribute_no_covers(client, db):
    o = _owner(db)
    m = _staff(db, o, "tokA")
    day = _tomorrow()
    _shift(db, o, m, day)
    at19 = datetime.combine(day, datetime.min.time().replace(hour=19))
    _booking(db, o, at19, 4)
    _booking(db, o, at19, 6, status="cancelled")
    _booking(db, o, at19, 7, status="no_show")
    _booking(db, o, at19, 5, status="requested")  # un-approved hold

    got = {d["business_date"]: d["covers"] for d in client.get("/api/portal/tokA/covers").json()["days"]}
    assert got[day.isoformat()] == 4


# ── business day ──────────────────────────────────────────────────────────

def test_post_midnight_booking_counts_toward_the_evening_shift(client, db):
    """A 17:00-01:00 Friday shift + a 00:30 Saturday booking = Friday's night.
    The waiter is still on the floor; the number must not jump to tomorrow."""
    o = _owner(db)
    m = _staff(db, o, "tokA")
    friday = _tomorrow()
    saturday = friday + timedelta(days=1)
    _shift(db, o, m, friday, start="17:00")
    _booking(db, o, datetime.combine(friday, datetime.min.time().replace(hour=20)), 4)
    _booking(db, o, datetime.combine(saturday, datetime.min.time().replace(hour=0, minute=30)), 2)

    got = {d["business_date"]: d["covers"] for d in client.get("/api/portal/tokA/covers").json()["days"]}
    assert got[friday.isoformat()] == 6, "the 00:30 booking belongs to Friday's service"


def test_pre_cutoff_early_shift_reads_the_previous_business_day(client, db):
    """A bakery on a 04:00 cutoff: a 05:00 Saturday shift is SATURDAY's service
    (05:00 >= 04:00). With the wrong 06:00 default it would read Friday's."""
    o = _owner(db, cutoff=4)
    m = _staff(db, o, "tokA")
    saturday = _tomorrow()
    _shift(db, o, m, saturday, start="05:00")
    _booking(db, o, datetime.combine(saturday, datetime.min.time().replace(hour=6)), 8)

    got = {d["business_date"]: d["covers"] for d in client.get("/api/portal/tokA/covers").json()["days"]}
    assert got.get(saturday.isoformat()) == 8
