"""
Feriedage "afholdt" counts only holiday that actually happened.

The Rediger profil sheet reads GET /api/portal/{token}/holiday and shows
"0,0 optjent · 5,0 afholdt". A staffer who had just ASKED for ferie 3–7 Nov
(status pending, shown as "Afventer" in Kan ikke) saw five days already taken
on 14 Oct: the count only left out cancelled rows.

Locks:
  • a pending request is not taken (the owner has not said yes);
  • an approved day later in the year is not taken yet;
  • an approved (acknowledged / covered) day up to and including today is;
  • cancelled / declined rows never count; other kinds never count.

Run:
  cd backend && python3 -m pytest tests/test_portal_holiday_taken.py -q
"""

import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.absence import StaffAbsence
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.services import danish_holiday
from app.services.auth import hash_password
from app.services.tz_utils import now_local

_db_ready.set()


@pytest.fixture(autouse=True)
def _reset_limiter():
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    yield
    sp.limiter.reset()


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def db(session_factory):
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    # Known to BonBox since well before this ferieår, so `earned` is not the point.
    m = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Mads", role="server",
                    created_at=datetime(2024, 1, 1))
    other = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Sofie", role="server",
                        created_at=datetime(2024, 1, 1))
    db.add_all([m, other]); db.commit(); db.refresh(m); db.refresh(other)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=m.id, token="tokM", active=True))
    db.commit()
    return u, m, other


def _add(db, u, staff, d, status, kind="ferie"):
    db.add(StaffAbsence(user_id=u.id, staff_id=staff.id, kind=kind, date=d, status=status))


def test_a_pending_request_in_the_future_is_not_taken(client, db):
    u, m, _ = _seed(db)
    today = now_local(u).date()
    # The finding: ferie asked for 3–7 Nov while it is 14 Oct, still pending.
    for i in range(20, 25):
        _add(db, u, m, today + timedelta(days=i), "pending")
    db.commit()
    r = client.get("/api/portal/tokM/holiday")
    assert r.status_code == 200, r.text
    assert r.json()["taken"] == 0
    # Approval alone does not make a future day "afholdt" either.
    for row in db.query(StaffAbsence).all():
        row.status = "acknowledged"
    db.commit()
    assert client.get("/api/portal/tokM/holiday").json()["taken"] == 0


def test_only_approved_days_up_to_today_count(client, db):
    u, m, other = _seed(db)
    today = now_local(u).date()
    start, _ = danish_holiday.ferieaar_bounds(today)
    past = [d for d in (today - timedelta(days=1), today - timedelta(days=2),
                        today - timedelta(days=3), today - timedelta(days=4)) if d >= start]
    expected = 1  # today, approved
    _add(db, u, m, today, "acknowledged")
    if len(past) >= 1:
        _add(db, u, m, past[0], "covered"); expected += 1
    if len(past) >= 2:
        _add(db, u, m, past[1], "cancelled")  # retracted / declined
    if len(past) >= 3:
        _add(db, u, m, past[2], "pending")  # the owner never answered
    if len(past) >= 4:
        _add(db, u, m, past[3], "acknowledged", kind="sick")  # not ferie
    _add(db, u, m, today + timedelta(days=1), "acknowledged")  # tomorrow
    _add(db, u, other, today, "acknowledged")  # a colleague's day
    _add(db, u, m, start - timedelta(days=1), "acknowledged")  # last ferieår
    db.commit()

    body = client.get("/api/portal/tokM/holiday").json()
    assert body["taken"] == expected
