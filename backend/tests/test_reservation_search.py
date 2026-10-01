"""
Cross-day guest search (GET /api/reservations/search).

WHY THIS EXISTS. A caller says "I booked Saturday under Hansen" and the host's
search box filtered only the day on screen — the booking could be found only
by paging the day rail one day at a time.

Locks under test:
  • Finds a booking on another day, and says which business day it is on
    (a 00:30 seating belongs to the evening before, as the book files it).
  • Phone digits match whatever spacing the number was saved with.
  • Tenant-scoped: another owner's guest of the same name never appears.
  • What the host types is text, not a LIKE pattern ("%" matches nothing).
  • A removed drop-in was never a booking and is not offered.
  • Upcoming first, and at most 20 — a lookup, not an export.

Run: cd backend && python3 -m pytest tests/test_reservation_search.py -x -q
"""

import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.services.auth import hash_password
from app.services.tz_utils import business_today_local

_db_ready.set()


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

    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()
    app.dependency_overrides.update(prev)


def _seed(db):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name="Bon Restaurant", business_type="restaurant",
        currency="DKK", role="owner", timezone="Europe/Copenhagen", plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id)); db.commit()
    return u


def _as(user):
    from app.routers import reservations as R
    app.dependency_overrides[R.get_current_user] = lambda: user


def _res(db, user, *, name, days, hhmm="19:00", phone=None, **kw):
    """A booking `days` business days from today at hh:mm local."""
    d = business_today_local(user) + timedelta(days=days)
    h, m = map(int, hhmm.split(":"))
    start = datetime(d.year, d.month, d.day, h, m)
    if h < 6:  # after midnight = still the evening before, as the book files it
        start += timedelta(days=1)
    r = Reservation(
        user_id=user.id, guest_name=name, guest_phone=phone, party_size=4,
        starts_at=start, ends_at=start + timedelta(minutes=90), duration_min=90,
        status=kw.pop("status", "confirmed"), source="manual", **kw,
    )
    db.add(r); db.commit(); db.refresh(r)
    return r


def _search(client, q):
    res = client.get("/api/reservations/search", params={"q": q})
    assert res.status_code == 200, res.text
    return res.json()["results"]


def test_finds_a_booking_on_another_day(client, db):
    u = _seed(db); _as(u)
    r = _res(db, u, name="Mette Hansen", days=4)
    hits = _search(client, "hansen")
    assert [h["id"] for h in hits] == [str(r.id)]
    assert hits[0]["day"] == (business_today_local(u) + timedelta(days=4)).isoformat()


def test_after_midnight_is_filed_under_the_evening_before(client, db):
    u = _seed(db); _as(u)
    _res(db, u, name="Late Larsen", days=2, hhmm="00:30")
    hit = _search(client, "larsen")[0]
    assert hit["day"] == (business_today_local(u) + timedelta(days=2)).isoformat()


def test_phone_digits_match_any_spacing(client, db):
    u = _seed(db); _as(u)
    r = _res(db, u, name="Ole", days=1, phone="+45 12 34 56 78")
    assert [h["id"] for h in _search(client, "12345678")] == [str(r.id)]
    assert [h["id"] for h in _search(client, "34 56")] == [str(r.id)]


def test_another_owners_guest_never_appears(client, db):
    me, other = _seed(db), _seed(db)
    _res(db, other, name="Mette Hansen", days=1)
    _as(me)
    assert _search(client, "hansen") == []


def test_typed_wildcards_are_literal(client, db):
    u = _seed(db); _as(u)
    _res(db, u, name="Anna", days=1)
    assert _search(client, "%%") == []
    assert _search(client, "__") == []


def test_removed_drop_in_is_not_offered(client, db):
    u = _seed(db); _as(u)
    _res(db, u, name="Walk Inn", days=0, status="cancelled", cancel_reason="walk_in_removed")
    assert _search(client, "walk") == []


def test_upcoming_first_and_capped(client, db):
    u = _seed(db); _as(u)
    past = _res(db, u, name="Hansen past", days=-3)
    soon = _res(db, u, name="Hansen soon", days=2)
    for i in range(25):
        _res(db, u, name=f"Hansen {i}", days=10 + i)
    hits = _search(client, "hansen")
    assert len(hits) == 20
    assert hits[0]["id"] == str(soon.id)
    assert str(past.id) not in [h["id"] for h in hits]  # pushed out by the cap


def test_outside_the_window_is_not_searched(client, db):
    u = _seed(db); _as(u)
    _res(db, u, name="Old Hansen", days=-30)
    _res(db, u, name="Far Hansen", days=120)
    assert _search(client, "hansen") == []


def test_too_short_query_is_rejected(client, db):
    u = _seed(db); _as(u)
    assert client.get("/api/reservations/search", params={"q": "a"}).status_code == 422
