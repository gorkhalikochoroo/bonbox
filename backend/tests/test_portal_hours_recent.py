"""
Portal "My hours" — the period-independent `recent_clocked` list.

Bug it fixes: a shift clocked after midnight is business-day-dated to the
PREVIOUS day and can land in the PREVIOUS pay period, so a worker who just
clocked out saw "0 worked hours this period". `recent_clocked` surfaces the
last completed clock punches regardless of period, so a just-finished shift is
never invisible. It is display-only — never summed into any period total.

Run:
  cd backend && python3 -m pytest tests/test_portal_hours_recent.py -x -q
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
from app.models.staff import StaffMember, StaffLink, HoursLogged
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()
_RECENT = date.today() - timedelta(days=2)   # well inside the 14-day window
_OLD = date.today() - timedelta(days=20)     # well outside it


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


def _punch(db, owner, staff, *, d=_RECENT, start="08:00", end="16:00", hours=7.5,
           method="clock"):
    db.add(HoursLogged(
        user_id=owner.id, staff_id=staff.id, date=d,
        start_time=start, end_time=end, total_hours=hours, entry_method=method,
    ))
    db.commit()


def _recent(client, token="tok"):
    r = client.get(f"/api/portal/{token}/hours")
    assert r.status_code == 200, r.text
    return r.json().get("recent_clocked", [])


def test_recent_completed_clock_punch_is_surfaced(client, db):
    o = _owner(db); s = _staff(db, o)
    _punch(db, o, s)  # completed clock punch, 2 days ago
    rc = _recent(client)
    assert len(rc) == 1
    assert rc[0]["total_hours"] == 7.5 and rc[0]["end_time"] == "16:00"


def test_open_punch_is_never_shown_as_finished(client, db):
    o = _owner(db); s = _staff(db, o)
    # Open punch (clocked in now): end_time NULL, total_hours 0 — must NOT show.
    db.add(HoursLogged(
        user_id=o.id, staff_id=s.id, date=date.today(),
        start_time="09:00", end_time=None, total_hours=0, entry_method="clock",
    ))
    db.commit()
    assert _recent(client) == []


def test_only_clock_method_rows_are_recent(client, db):
    o = _owner(db); s = _staff(db, o)
    _punch(db, o, s, method="quick")   # owner-entered, not a self-clock
    _punch(db, o, s, start="17:00", end="22:00", hours=5.0, method="clock")
    rc = _recent(client)
    assert len(rc) == 1 and rc[0]["start_time"] == "17:00"


def test_recent_is_tenant_scoped(client, db):
    o1 = _owner(db); s1 = _staff(db, o1, token="tok")
    o2 = _owner(db, email="other@bonbox.dk"); s2 = _staff(db, o2, token="tok2", name="Bob")
    _punch(db, o2, s2)  # other tenant's punch
    assert _recent(client, "tok") == []      # o1's token sees nothing
    assert len(_recent(client, "tok2")) == 1  # o2's token sees its own


def test_punch_outside_14_day_window_is_excluded(client, db):
    o = _owner(db); s = _staff(db, o)
    _punch(db, o, s, d=_OLD)  # 20 days ago
    assert _recent(client) == []


def test_recent_is_capped_at_eight(client, db):
    o = _owner(db); s = _staff(db, o)
    for i in range(10):  # 10 distinct recent days, all within the window
        _punch(db, o, s, d=date.today() - timedelta(days=i + 1),
               start="08:00", end="12:00", hours=4.0)
    assert len(_recent(client)) == 8


def test_no_clock_rows_yields_empty_recent(client, db):
    o = _owner(db); _staff(db, o)
    assert _recent(client) == []
