"""The staffer can see what the owner decided about their hours.

THE GAP THIS CLOSES. The owner has had a real approval flow for a long
time: POST /hours/resolve takes confirm, adjust or absent, keeps whatever
the clock measured in clock_hours forever, stamps resolved_by/resolved_at,
and refuses to auto-resolve — "a correction that is not visibly an owner
decision is falsification".

None of it reached the person it is about. `resolution` appeared nowhere in
staff_portal.py, so an owner could ADJUST the hours that feed someone's pay
and the only person with a real stake in that correction was the only one
who could not see it happen.

WHAT THESE PIN:
  • an ADJUSTED shift sends BOTH figures — what the clock measured and what
    was recorded — so a reduction reads as a difference the staffer can ask
    about, not a number that quietly changed;
  • clock_hours is OMITTED when it agrees with the recorded figure, because
    a second identical number on every ordinary shift is noise: the point is
    to make a change visible, not to narrate agreement;
  • an unanswered shift reports resolution None — a real third state,
    meaning nobody has looked yet, not "fine";
  • none of it leaks across tenants.
"""
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.user import User
from app.models.staff import StaffMember, StaffLink, HoursLogged
from app.services.auth import hash_password
from app.utils.time import utc_now

_DAY = date.today() - timedelta(days=2)

# The readiness gate 503s every API route until startup finishes; these tests
# never run startup, so open it the way the sibling portal suites do.
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

    def _override():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _override
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)


def _owner(db, email="owner@bonbox.dk"):
    u = User(
        email=email, password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _staff(db, owner, token="tok", name="Agnes"):
    s = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(s); db.commit(); db.refresh(s)
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=s.id, token=token, active=True))
    db.commit()
    return s


def _logged(db, owner, staff, *, total, clock=None, resolution=None, d=_DAY):
    db.add(HoursLogged(
        user_id=owner.id, staff_id=staff.id, date=d,
        start_time="08:00", end_time="16:00",
        total_hours=total, clock_hours=clock, entry_method="clock",
        resolution=resolution,
        resolved_at=utc_now() if resolution else None,
    ))
    db.commit()


def _entries(client, token="tok"):
    r = client.get(f"/api/portal/{token}/hours")
    assert r.status_code == 200, r.text
    return r.json()["entries"]


def test_an_adjusted_shift_shows_both_figures(client, db):
    """The one that matters: the owner cut 7,5 to 7,0 and the staffer can see it."""
    o = _owner(db); s = _staff(db, o)
    _logged(db, o, s, total=7.0, clock=7.5, resolution="adjusted")

    e = _entries(client)[0]
    assert e["resolution"] == "adjusted"
    assert e["total_hours"] == 7.0, "what the owner recorded — what they are paid for"
    assert e["clock_hours"] == 7.5, (
        "what the clock measured. Without this the reduction is invisible to "
        "the only person with a stake in it."
    )
    assert e["resolved_at"] is not None


def test_an_ordinary_shift_does_not_repeat_its_own_number(client, db):
    """clock_hours is omitted when it agrees — noise, not information."""
    o = _owner(db); s = _staff(db, o)
    _logged(db, o, s, total=7.5, clock=7.5, resolution="confirmed")

    e = _entries(client)[0]
    assert e["resolution"] == "confirmed"
    assert e["clock_hours"] is None, "identical figures must not render twice"


def test_a_shift_nobody_has_answered_says_so(client, db):
    """None is a real third state: not reviewed, which is not the same as fine."""
    o = _owner(db); s = _staff(db, o)
    _logged(db, o, s, total=7.5, clock=7.5)

    e = _entries(client)[0]
    assert e["resolution"] is None
    assert e["resolved_at"] is None


def test_absent_is_a_recorded_zero_not_a_missing_row(client, db):
    o = _owner(db); s = _staff(db, o)
    _logged(db, o, s, total=0.0, clock=6.0, resolution="absent")

    e = _entries(client)[0]
    assert e["resolution"] == "absent"
    assert e["total_hours"] == 0.0
    # The clock DID measure something; the owner said it was not worked. Both
    # facts travel, so the staffer can question the second one.
    assert e["clock_hours"] == 6.0


def test_a_tiny_rounding_difference_is_not_dressed_up_as_an_adjustment(client, db):
    """0.004 of an hour is not a correction anyone should be shown."""
    o = _owner(db); s = _staff(db, o)
    _logged(db, o, s, total=7.5, clock=7.504, resolution="confirmed")

    e = _entries(client)[0]
    assert e["clock_hours"] is None


def test_resolution_does_not_leak_across_tenants(client, db):
    o1 = _owner(db); s1 = _staff(db, o1, token="tok")
    o2 = _owner(db, email="other@bonbox.dk"); s2 = _staff(db, o2, token="tok2", name="Bo")
    _logged(db, o1, s1, total=7.0, clock=7.5, resolution="adjusted")
    _logged(db, o2, s2, total=3.0, clock=9.0, resolution="adjusted")

    mine = _entries(client, "tok")
    assert len(mine) == 1
    assert mine[0]["total_hours"] == 7.0 and mine[0]["clock_hours"] == 7.5
