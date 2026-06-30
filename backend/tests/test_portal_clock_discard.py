"""
Punch-clock trust guard — a too-short (misclick/test) in→out must NOT leave a
junk 0.0h row in the owner's hours; a real punch must be kept + computed.

Run:
  cd backend && python3 -m pytest tests/test_portal_clock_discard.py -x -q
"""

import uuid
from datetime import datetime, date
from zoneinfo import ZoneInfo

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
_CPH = ZoneInfo("Europe/Copenhagen")
_FAKE_DATE = date(2026, 6, 30)
# Mutable holder so the test can advance "now" between clock-in and clock-out.
_NOW = {"dt": datetime(2026, 6, 30, 10, 0, tzinfo=_CPH)}


@pytest.fixture(autouse=True)
def _patch_clock(monkeypatch):
    from app.routers import staff_portal as sp

    monkeypatch.setattr(sp, "now_local", lambda owner: _NOW["dt"])
    monkeypatch.setattr(sp, "business_today_local", lambda owner: _FAKE_DATE)
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
    s = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server")
    db.add(s); db.commit(); db.refresh(s)
    link = StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=s.id, token="tok", active=True)
    db.add(link); db.commit()
    return u, s


def _clock_rows(db, staff_id):
    return (
        db.query(HoursLogged)
        .filter(HoursLogged.staff_id == staff_id, HoursLogged.entry_method == "clock")
        .all()
    )


def test_too_short_punch_is_discarded(client, db):
    _u, s = _seed(db)
    _NOW["dt"] = datetime(2026, 6, 30, 10, 0, tzinfo=_CPH)
    assert client.post("/api/portal/tok/clock-in").status_code == 200
    # Same minute → in→out is a misclick.
    _NOW["dt"] = datetime(2026, 6, 30, 10, 0, 40, tzinfo=_CPH)
    r = client.post("/api/portal/tok/clock-out")
    assert r.status_code == 200, r.text
    assert r.json().get("discarded") is True
    assert r.json().get("worked_hours") == 0.0
    # No junk row left behind — the owner's hours stay clean.
    assert _clock_rows(db, s.id) == []


def test_real_punch_is_kept_and_computed(client, db):
    _u, s = _seed(db)
    _NOW["dt"] = datetime(2026, 6, 30, 10, 0, tzinfo=_CPH)
    client.post("/api/portal/tok/clock-in")
    _NOW["dt"] = datetime(2026, 6, 30, 10, 30, tzinfo=_CPH)
    r = client.post("/api/portal/tok/clock-out")
    assert r.status_code == 200, r.text
    assert r.json().get("discarded") is None
    assert r.json()["worked_hours"] == 0.5
    rows = _clock_rows(db, s.id)
    assert len(rows) == 1
    assert rows[0].start_time == "10:00" and rows[0].end_time == "10:30"
    assert float(rows[0].total_hours) == 0.5
