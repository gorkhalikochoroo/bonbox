"""POST /api/staff/hours/confirm-schedule — the owner's no-clock-in path.

WHAT THIS ENDPOINT IS: an owner who doesn't run a punch clock asserting that
rostered shifts were worked, so staff see hours without anyone clocking in.
That is a wanted, legitimate feature and these tests must not break it.

WHAT IT MUST NOT BE: a way to assert the FUTURE. The rows it writes are what
the staff portal reports as "hours worked" (they land in hours_logged with
entry_method="schedule", which also defeats the portal's `use_logged` guard —
the plan lands in the actuals table, so the code believes it has measurements).
Before the guard this endpoint happily wrote a 16:00-23:00 shift as worked at
08:22 that morning. That is not a rounding error; it is a claim about work that
had not happened.

These drive the REAL endpoint. The sibling replica-style test
(test_schedule_confirmation.py) re-implements router logic in the test — which
is exactly how a bug walks past a green suite.
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
from app.models.staff import HoursLogged, Schedule, StaffMember
from app.models.user import User
from app.services.auth import get_current_user

_db_ready.set()

# Freeze the owner's clock at the exact moment the real bug fired: 08:22 on
# 12 Jul 2026, when a 16:00-23:00 shift was written as "6.3 hours worked".
# Frozen, not wall-clock: the first version of these tests hedged on
# datetime.now().hour and a mutation that deleted the whole midnight-crossing
# rule still passed 7/7. A test that only fails at certain times of day is a
# test that doesn't fail.
NOW = datetime(2026, 7, 12, 8, 22, 30)
TODAY = NOW.date()


@pytest.fixture(autouse=True)
def frozen_clock(monkeypatch):
    monkeypatch.setattr("app.routers.staff.now_local", lambda _user: NOW)


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
def owner(db):
    u = User(
        id=uuid.uuid4(),
        email="owner@bonbox.dk",
        password_hash="x",
        business_name="Cafe",
        business_type="cafe",
        currency="DKK",
        timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture
def client(engine_and_session, owner):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: owner
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def _staff(db, owner, name="Aksel Olsen"):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="manager")
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _shift(db, owner, member, day, *, start="16:00", end="23:00", status="published"):
    s = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=member.id, date=day,
        start_time=start, end_time=end, break_minutes=45,
        status=status, role_on_shift="manager",
    )
    db.add(s)
    db.commit()
    return s


def _monday_of(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _confirm(client, week_start):
    return client.post(f"/api/staff/hours/confirm-schedule?week_start={week_start.isoformat()}")


# ── the feature still works (do not regress this) ─────────────────────────

def test_owner_can_log_a_finished_week_without_any_clock_in(client, db, owner):
    """The whole point: no punch clock, owner says the week happened."""
    m = _staff(db, owner)
    last_week = _monday_of(TODAY) - timedelta(days=7)
    _shift(db, owner, m, last_week)
    _shift(db, owner, m, last_week + timedelta(days=1))

    r = _confirm(client, last_week)
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 2
    assert db.query(HoursLogged).filter(HoursLogged.staff_id == m.id).count() == 2


def test_logged_rows_are_stamped_schedule_not_clock(client, db, owner):
    """Provenance must survive: these are the owner's assertion, not a punch.
    entry_method is the ONLY thing downstream can use to tell them apart."""
    m = _staff(db, owner)
    last_week = _monday_of(TODAY) - timedelta(days=7)
    _shift(db, owner, m, last_week)

    _confirm(client, last_week)
    row = db.query(HoursLogged).filter(HoursLogged.staff_id == m.id).one()
    assert row.entry_method == "schedule"
    assert row.entry_method != "clock"


def test_confirming_twice_does_not_double_count(client, db, owner):
    m = _staff(db, owner)
    last_week = _monday_of(TODAY) - timedelta(days=7)
    _shift(db, owner, m, last_week)

    assert _confirm(client, last_week).json()["created"] == 1
    second = _confirm(client, last_week)
    assert second.status_code == 200, second.text
    assert second.json()["created"] == 0
    assert db.query(HoursLogged).filter(HoursLogged.staff_id == m.id).count() == 1


# ── the guard: you cannot assert the future ───────────────────────────────

def test_a_future_week_cannot_be_marked_worked(client, db, owner):
    """THE regression. Nobody can say next week was worked."""
    m = _staff(db, owner)
    next_week = _monday_of(TODAY) + timedelta(days=7)
    _shift(db, owner, m, next_week)
    _shift(db, owner, m, next_week + timedelta(days=1))

    r = _confirm(client, next_week)
    assert r.status_code == 400
    assert "finished" in r.json()["detail"].lower()
    assert db.query(HoursLogged).count() == 0, "future shifts were written as worked hours"


def test_todays_evening_shift_is_not_worked_yet_this_morning(client, db, owner):
    """THE prod case, reproduced exactly. On 12 Jul at 08:22 the owner confirmed
    the week and a 16:00-23:00 shift became "6.3 hours worked" — eight hours
    before it started. Aksel saw it in his portal under "Hours worked"."""
    m = _staff(db, owner)
    _shift(db, owner, m, TODAY, start="16:00", end="23:00")

    r = _confirm(client, _monday_of(TODAY))
    assert r.status_code == 400, "the 08:22-for-a-16:00-shift row was written again"
    assert db.query(HoursLogged).count() == 0


def test_finished_shifts_land_and_unfinished_are_skipped_and_reported(client, db, owner):
    """A mixed week: log what has ended, skip what hasn't, and SAY how many were
    skipped — a bare created:N on a 3-shift week reads as "all done"."""
    m = _staff(db, owner)
    monday = _monday_of(TODAY)          # TODAY is Sunday 12 Jul; Monday = 6 Jul
    _shift(db, owner, m, monday)                       # ended days ago
    _shift(db, owner, m, monday + timedelta(days=1))   # ended days ago
    _shift(db, owner, m, TODAY, start="16:00", end="23:00")  # tonight — NOT yet

    r = _confirm(client, monday)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 2, "a shift that hasn't ended was logged as worked"
    assert body["skipped_not_ended"] == 1, "silently dropped a shift without saying so"
    assert db.query(HoursLogged).filter(HoursLogged.date == TODAY).count() == 0


def test_a_midnight_crossing_shift_is_judged_on_its_real_end(client, db, owner):
    """A 22:00-02:00 shift TONIGHT ends 02:00 TOMORROW — it has not happened.
    Judged on the naive end-time it would look like it ended at 02:00 today,
    i.e. already over, and get written as worked. This is the case the first
    version of this test missed: it used a shift that was finished under BOTH
    readings, so deleting the overnight rule entirely still passed 7/7."""
    m = _staff(db, owner)
    _shift(db, owner, m, TODAY, start="22:00", end="02:00")

    r = _confirm(client, _monday_of(TODAY))
    assert r.status_code == 400, "tonight's overnight shift was logged as already worked"
    assert db.query(HoursLogged).count() == 0
