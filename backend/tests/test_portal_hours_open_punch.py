"""
Portal "Timer" — an OPEN clock punch is a state, never "0 timer".

The bug: get_portal_hours counted every HoursLogged row in the period,
including a clock-in still waiting for its clock-out (entry_method "clock",
end_time NULL, total_hours 0). One clock-in therefore flipped the headline
from the rostered plan to "0 worked hours", replaced the roster rows with a
single "0 timer" row and counted it as a shift. A forgotten clock-out looked
like a finished zero-hour shift forever.

Now open punches are kept out of every total, the hours_source decision and
`entries`, and reported in `open_punches` with a state the row can say:
"live" (clocked in now) or "forgotten" (open longer than any shift — the same
time_registration.open_punch_is_forgotten rule the owner's Timer uses).

Run:
  cd backend && python3 -m pytest tests/test_portal_hours_open_punch.py -x -q
"""

import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink, HoursLogged, Schedule
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()

TODAY = date.today()
# A custom window around today, so the test never straddles a month boundary
# (the default period is the calendar month).
WIN = f"?start={(TODAY - timedelta(days=5)).isoformat()}&end={(TODAY + timedelta(days=5)).isoformat()}"


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


def _setup(db):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    s = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Ali", role="kitchen")
    db.add(s); db.commit(); db.refresh(s)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=s.id, token="tok", active=True))
    # Two published shifts in the window: 8 + 6 = 14 rostered hours.
    for d, st, en in ((TODAY - timedelta(days=1), "10:00", "18:00"),
                      (TODAY + timedelta(days=2), "16:00", "22:00")):
        db.add(Schedule(id=uuid.uuid4(), user_id=u.id, staff_id=s.id, date=d,
                        start_time=st, end_time=en, status="published"))
    db.commit()
    return u, s


def _open(db, u, s, d, start):
    db.add(HoursLogged(user_id=u.id, staff_id=s.id, date=d, start_time=start,
                       end_time=None, total_hours=0, entry_method="clock"))
    db.commit()


def _hours(client):
    r = client.get(f"/api/portal/tok/hours{WIN}")
    assert r.status_code == 200, r.text
    return r.json()


def test_open_clock_in_does_not_flip_headline_to_zero(client, db):
    u, s = _setup(db)
    # Clocked in a few minutes ago — the staffer's FIRST punch of the period.
    _open(db, u, s, TODAY, (datetime.now() - timedelta(minutes=5)).strftime("%H:%M"))
    body = _hours(client)
    # Headline stays the rostered plan, never "0 worked".
    assert body["hours_source"] == "schedule"
    assert body["total_hours"] == pytest.approx(14.0)
    # No entry is the open punch dressed up as a 0-hour shift.
    assert all(e["end_time"] for e in body["entries"])
    assert len(body["entries"]) == 2
    # …it is reported as what it is.
    assert len(body["open_punches"]) == 1
    op = body["open_punches"][0]
    assert op["date"] == TODAY.isoformat()
    assert op["state"] == "live"


def test_forgotten_clock_out_is_flagged_and_excluded_from_totals(client, db):
    u, s = _setup(db)
    # One finished punch (counts) and one punch left open three days ago.
    db.add(HoursLogged(user_id=u.id, staff_id=s.id, date=TODAY - timedelta(days=1),
                       start_time="10:00", end_time="17:30", total_hours=7.5,
                       entry_method="clock"))
    db.commit()
    _open(db, u, s, TODAY - timedelta(days=3), "16:58")
    body = _hours(client)
    assert body["hours_source"] == "logged"
    assert body["total_hours"] == pytest.approx(7.5)       # the open punch adds nothing
    assert len(body["entries"]) == 1                         # …and is not a "shift"
    assert body["entries"][0]["total_hours"] == pytest.approx(7.5)
    assert body["open_punches"] == [{
        "date": (TODAY - timedelta(days=3)).isoformat(),
        "start_time": "16:58",
        "state": "forgotten",
    }]


def test_quick_entry_without_end_time_still_counts(client, db):
    # Scoped to CLOCK rows: an owner's quick entry can carry hours with no
    # times at all, and it is a recorded amount, not an open punch.
    u, s = _setup(db)
    db.add(HoursLogged(user_id=u.id, staff_id=s.id, date=TODAY - timedelta(days=1),
                       start_time=None, end_time=None, total_hours=6,
                       entry_method="quick"))
    db.commit()
    body = _hours(client)
    assert body["hours_source"] == "logged"
    assert body["total_hours"] == pytest.approx(6.0)
    assert body["open_punches"] == []


def test_no_open_punch_means_empty_list(client, db):
    _setup(db)
    body = _hours(client)
    assert body["open_punches"] == []
    assert body["hours_source"] == "schedule"
