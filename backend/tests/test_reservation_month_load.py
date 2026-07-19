"""GET /reservations/month-load — per-day covers + rostered headcount.

Feeds the desktop day rail. The thing most worth pinning is the business-day
bucketing: a 00:30 seating belongs to the PREVIOUS evening's service (DK 06:00
cutoff), so the rail must show it on the same day /book shows it under. If the
rail and the book ever disagree the whole feature is untrustworthy.

  cd backend && pytest tests/test_reservation_month_load.py -v
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
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services.auth import get_current_user

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


def _owner(db) -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Bistro Nørrebro",
        business_type="restaurant", currency="DKK", plan="pro",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _booking(db, user, when: datetime, party: int, status: str = "confirmed"):
    r = Reservation(
        id=uuid.uuid4(), user_id=user.id, starts_at=when,
        ends_at=when + timedelta(minutes=90),
        party_size=party, status=status, guest_name="Test",
    )
    db.add(r)
    db.commit()
    return r


def _shift(db, user, on: date, staff: StaffMember):
    db.add(Schedule(
        id=uuid.uuid4(), user_id=user.id, staff_id=staff.id, date=on,
        start_time="17:00", end_time="23:00",
    ))
    db.commit()


def _staff(db, user, name="Mette") -> StaffMember:
    m = StaffMember(id=uuid.uuid4(), user_id=user.id, name=name, role="server")
    db.add(m)
    db.commit()
    return m


def _days(payload) -> dict[str, dict]:
    return {d["date"]: d for d in payload["days"]}


# ─── Covers ──────────────────────────────────────────────────────────
def test_covers_are_summed_per_day(client, db):
    u = _owner(db)
    _booking(db, u, datetime(2026, 7, 19, 19, 0), 4)
    _booking(db, u, datetime(2026, 7, 19, 20, 30), 2)
    _booking(db, u, datetime(2026, 7, 21, 18, 0), 6)

    resp = client.get("/api/reservations/month-load?month=2026-07")
    assert resp.status_code == 200, resp.text
    days = _days(resp.json())

    assert days["2026-07-19"]["covers"] == 6
    assert days["2026-07-19"]["bookings"] == 2
    assert days["2026-07-21"]["covers"] == 6


def test_only_booked_statuses_count_as_covers(client, db):
    """Cancelled/no-show parties must not inflate the day. The rail has to
    agree with the cockpit number on the day you open."""
    u = _owner(db)
    _booking(db, u, datetime(2026, 7, 10, 19, 0), 4, status="confirmed")
    _booking(db, u, datetime(2026, 7, 10, 19, 0), 8, status="cancelled")
    _booking(db, u, datetime(2026, 7, 10, 20, 0), 5, status="no_show")

    days = _days(client.get("/api/reservations/month-load?month=2026-07").json())
    assert days["2026-07-10"]["covers"] == 4
    assert days["2026-07-10"]["bookings"] == 3  # all three still counted as rows


# ─── The business-day cutoff (the bit that's easy to get wrong) ──────
def test_after_midnight_seating_belongs_to_the_previous_service(client, db):
    """00:30 on the 20th is the 19th's late service (DK 06:00 cutoff) — the
    same bucket /book puts it in."""
    u = _owner(db)
    _booking(db, u, datetime(2026, 7, 20, 0, 30), 3)

    days = _days(client.get("/api/reservations/month-load?month=2026-07").json())
    assert days.get("2026-07-19", {}).get("covers") == 3, days
    assert "2026-07-20" not in days or days["2026-07-20"]["covers"] == 0


def test_early_morning_before_cutoff_is_previous_day_not_dropped(client, db):
    """A 05:59 booking on the 1st belongs to the LAST day of the previous
    month — it must not be silently attributed to the 1st."""
    u = _owner(db)
    _booking(db, u, datetime(2026, 7, 1, 5, 59), 2)

    days = _days(client.get("/api/reservations/month-load?month=2026-07").json())
    assert days.get("2026-07-01", {}).get("covers", 0) == 0, days


def test_six_am_starts_the_new_business_day(client, db):
    u = _owner(db)
    _booking(db, u, datetime(2026, 7, 15, 6, 0), 2)

    days = _days(client.get("/api/reservations/month-load?month=2026-07").json())
    assert days["2026-07-15"]["covers"] == 2


# ─── Rostered headcount ──────────────────────────────────────────────
def test_staff_on_counts_distinct_people(client, db):
    """A split shift is one person, not two."""
    u = _owner(db)
    mette, jonas = _staff(db, u, "Mette"), _staff(db, u, "Jonas")
    _shift(db, u, date(2026, 7, 19), mette)
    _shift(db, u, date(2026, 7, 19), mette)  # split shift, same person
    _shift(db, u, date(2026, 7, 19), jonas)

    days = _days(client.get("/api/reservations/month-load?month=2026-07").json())
    assert days["2026-07-19"]["staff_on"] == 2


def test_day_with_roster_but_no_bookings_still_appears(client, db):
    u = _owner(db)
    _shift(db, u, date(2026, 7, 8), _staff(db, u))

    days = _days(client.get("/api/reservations/month-load?month=2026-07").json())
    assert days["2026-07-08"]["staff_on"] == 1
    assert days["2026-07-08"]["covers"] == 0


# ─── Scoping ─────────────────────────────────────────────────────────
def test_month_is_bounded_and_other_months_excluded(client, db):
    u = _owner(db)
    _booking(db, u, datetime(2026, 7, 19, 19, 0), 4)
    _booking(db, u, datetime(2026, 8, 19, 19, 0), 9)

    days = _days(client.get("/api/reservations/month-load?month=2026-07").json())
    assert "2026-07-19" in days
    assert not any(k.startswith("2026-08") for k in days), days


def test_other_tenants_bookings_never_leak(client, db):
    u = _owner(db)
    other = User(
        email="other@bonbox.test", password_hash="x", business_name="Anden",
        business_type="restaurant", currency="DKK", plan="pro",
    )
    db.add(other)
    db.commit()
    _booking(db, other, datetime(2026, 7, 19, 19, 0), 50)
    _booking(db, u, datetime(2026, 7, 19, 19, 0), 4)

    days = _days(client.get("/api/reservations/month-load?month=2026-07").json())
    assert days["2026-07-19"]["covers"] == 4, "another venue's covers leaked in"


def test_deleted_bookings_excluded(client, db):
    u = _owner(db)
    r = _booking(db, u, datetime(2026, 7, 19, 19, 0), 4)
    r.is_deleted = True
    db.commit()

    days = _days(client.get("/api/reservations/month-load?month=2026-07").json())
    assert days.get("2026-07-19", {}).get("covers", 0) == 0


def test_defaults_to_current_month_and_reports_today(client, db):
    _owner(db)
    payload = client.get("/api/reservations/month-load").json()
    assert payload["month"][:4].isdigit()
    assert payload["today"]


def test_bad_month_is_refused(client, db):
    _owner(db)
    assert client.get("/api/reservations/month-load?month=2026-13").status_code == 422
    assert client.get("/api/reservations/month-load?month=nonsense").status_code == 422
