"""Month by month — the booking record an owner reads as "how did September go?".

What these tests hold:
  • the definitions: cancelled bookings are not bookings; guests count only
    confirmed / seated / completed parties; no-shows and online are counted;
  • BUSINESS months: a 01:30 booking on the 1st belongs to the previous
    day's service, so to the previous month — the same rule as the calendar;
  • tenant scope: another venue's bookings never leak in;
  • bounds: months outside 1..24 is a 422, not a wide scan;
  • the calendar's month line and the Indsigt table agree, because both
    come from the same helper.

  cd backend && pytest tests/test_reservation_monthly.py -v
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.reservation import Reservation
from app.models.user import User
from app.services.auth import get_current_user
from app.services.tz_utils import business_today_local

_db_ready.set()


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
    yield TestClient(app)
    app.dependency_overrides.clear()


def _venue(db) -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Monthly Bistro", business_type="restaurant", currency="DKK", plan="starter",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _book(db, user, starts_at: datetime, *, status="confirmed", party=2, source="manual"):
    db.add(Reservation(
        user_id=user.id, starts_at=starts_at, ends_at=starts_at + timedelta(minutes=90),
        party_size=party, status=status, source=source, guest_name="G",
    ))
    db.commit()


def _months(user):
    """First day of this business month and of the previous one."""
    today = business_today_local(user)
    this_first = today.replace(day=1)
    prev_first = (this_first - timedelta(days=1)).replace(day=1)
    return this_first, prev_first


def _key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _row(payload, month_key):
    return next(m for m in payload["months"] if m["month"] == month_key)


def test_counts_follow_the_definitions(client, db):
    u = _venue(db)
    app.dependency_overrides[get_current_user] = lambda: u
    this_first, prev_first = _months(u)
    at = lambda d, h, m=0: datetime.combine(d, datetime.min.time()).replace(hour=h, minute=m)

    # This month: 4 bookings that count, 1 cancelled.
    _book(db, u, at(this_first, 12), status="completed", party=4)
    _book(db, u, at(this_first, 19), status="seated", party=2)
    _book(db, u, at(this_first, 20), status="no_show", party=6)            # booked, guests NOT counted
    _book(db, u, at(this_first, 21), status="confirmed", party=3, source="public")  # online
    _book(db, u, at(this_first, 18), status="cancelled", party=8)          # not a booking
    # Last month: one ordinary evening booking.
    _book(db, u, at(prev_first + timedelta(days=9), 19), status="completed", party=5)

    r = client.get("/api/reservations/monthly", params={"months": 3})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [m["month"] for m in body["months"]][0] == _key(this_first)   # newest first
    assert len(body["months"]) == 3

    cur = _row(body, _key(this_first))
    assert cur["current"] is True
    assert (cur["bookings"], cur["guests"], cur["no_shows"], cur["cancelled"], cur["online"]) == (4, 9, 1, 1, 1)

    prev = _row(body, _key(prev_first))
    assert (prev["bookings"], prev["guests"]) == (1, 5)
    assert prev["current"] is False


def test_a_booking_after_midnight_on_the_1st_belongs_to_last_month(client, db):
    u = _venue(db)
    app.dependency_overrides[get_current_user] = lambda: u
    this_first, prev_first = _months(u)
    # 01:30 on the 1st is still the previous day's service (06:00 cutoff).
    _book(db, u, datetime.combine(this_first, datetime.min.time()).replace(hour=1, minute=30), party=2)

    body = client.get("/api/reservations/monthly", params={"months": 2}).json()
    assert _row(body, _key(prev_first))["bookings"] == 1
    assert _row(body, _key(this_first))["bookings"] == 0


def test_another_venue_never_leaks_in(client, db):
    mine, theirs = _venue(db), _venue(db)
    this_first, _ = _months(mine)
    _book(db, theirs, datetime.combine(this_first, datetime.min.time()).replace(hour=19), party=10)
    app.dependency_overrides[get_current_user] = lambda: mine

    body = client.get("/api/reservations/monthly").json()
    assert all(m["bookings"] == 0 and m["guests"] == 0 for m in body["months"])
    assert len(body["months"]) == 12  # the default window


@pytest.mark.parametrize("months", [0, 25, -1])
def test_out_of_range_windows_are_refused(client, db, months):
    u = _venue(db)
    app.dependency_overrides[get_current_user] = lambda: u
    assert client.get("/api/reservations/monthly", params={"months": months}).status_code == 422


def test_calendar_month_line_agrees_with_the_table(client, db):
    u = _venue(db)
    app.dependency_overrides[get_current_user] = lambda: u
    this_first, _ = _months(u)
    at = lambda h: datetime.combine(this_first, datetime.min.time()).replace(hour=h)
    _book(db, u, at(12), status="completed", party=4)
    _book(db, u, at(19), status="cancelled", party=6)
    _book(db, u, at(20), status="no_show", party=2, source="public")

    table = _row(client.get("/api/reservations/monthly", params={"months": 1}).json(), _key(this_first))
    cal = client.get("/api/reservations/month-load", params={"month": _key(this_first)}).json()
    totals = cal["month_totals"]
    for k in ("bookings", "guests", "no_shows", "cancelled", "online"):
        assert totals[k] == table[k], k
    assert (totals["bookings"], totals["guests"]) == (2, 4)
