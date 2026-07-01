"""
Staff-side availability ("kan ikke arbejde") — the Planday-style standing
unavailability a staffer sets from their portal. Locks:
  • create (recurring weekday + one-off date) + list + delete round-trip
  • validation: exactly one of weekday/date; sane weekday; both-or-neither
    times; end strictly after start
  • tenant/peer isolation: staffer B can never see or delete staffer A's rows
    (identity is re-derived from the magic-link token, never the body)

Run:
  cd backend && python3 -m pytest tests/test_portal_availability.py -x -q
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink, StaffAvailability
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


def _seed(db):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    a = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server")
    b = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Bo", role="server")
    db.add_all([a, b]); db.commit(); db.refresh(a); db.refresh(b)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=a.id, token="tokA", active=True))
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=b.id, token="tokB", active=True))
    db.commit()
    return u, a, b


def test_create_list_delete_roundtrip(client, db):
    _u, _a, _b = _seed(db)
    # Recurring "never Mondays" (all day).
    r = client.post("/api/portal/tokA/availability", json={"weekday": 0, "note": "undervisning"})
    assert r.status_code == 200, r.text
    row_id = r.json()["id"]
    assert r.json()["weekday"] == 0 and r.json()["date"] is None

    # One-off date with a time window.
    r2 = client.post("/api/portal/tokA/availability",
                     json={"date": "2026-07-06", "start_time": "08:00", "end_time": "12:00"})
    assert r2.status_code == 200, r2.text
    assert r2.json()["date"] == "2026-07-06" and r2.json()["start_time"] == "08:00"

    listed = client.get("/api/portal/tokA/availability")
    assert listed.status_code == 200
    assert len(listed.json()["availability"]) == 2

    d = client.delete(f"/api/portal/tokA/availability/{row_id}")
    assert d.status_code == 200 and d.json()["deleted"] is True
    assert len(client.get("/api/portal/tokA/availability").json()["availability"]) == 1


def test_validation_rules(client, db):
    _seed(db)
    # Neither weekday nor date.
    assert client.post("/api/portal/tokA/availability", json={}).status_code == 422
    # Both weekday AND date.
    assert client.post("/api/portal/tokA/availability",
                       json={"weekday": 1, "date": "2026-07-06"}).status_code == 422
    # Weekday out of range.
    assert client.post("/api/portal/tokA/availability", json={"weekday": 7}).status_code == 422
    # Only one time set.
    assert client.post("/api/portal/tokA/availability",
                       json={"weekday": 2, "start_time": "09:00"}).status_code == 422
    # end == start (zero-length window).
    assert client.post("/api/portal/tokA/availability",
                       json={"weekday": 2, "start_time": "09:00", "end_time": "09:00"}).status_code == 422
    # Garbage time.
    assert client.post("/api/portal/tokA/availability",
                       json={"weekday": 2, "start_time": "25:00", "end_time": "26:00"}).status_code == 422


def test_peer_cannot_see_or_delete_others(client, db):
    _seed(db)
    made = client.post("/api/portal/tokA/availability", json={"weekday": 3})
    assert made.status_code == 200
    a_row = made.json()["id"]
    # B's list never includes A's row.
    assert client.get("/api/portal/tokB/availability").json()["availability"] == []
    # B cannot delete A's row — 404, not a cross-tenant delete.
    assert client.delete(f"/api/portal/tokB/availability/{a_row}").status_code == 404
    # A's row still there.
    assert len(client.get("/api/portal/tokA/availability").json()["availability"]) == 1


def test_bad_uuid_delete_is_404_not_500(client, db):
    _seed(db)
    assert client.delete("/api/portal/tokA/availability/not-a-uuid").status_code == 404
