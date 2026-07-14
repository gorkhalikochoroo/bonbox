"""
Clock-in TIME window (owner-configurable "Låst → Klar → Stemplet").

The window must be correct across the DK 06:00 business-day cutoff — the exact
seam where an earlier version wrongly locked out overnight / early-morning
workers by stamping shift times onto *now's* calendar date instead of the
shift's own date. These tests freeze `now_local` at pre-cutoff times and assert:

  • a worker mid-overnight-shift at 01:30 is NOT locked (regression),
  • an early-morning opener's window IS effective (no silent fail-open),
  • within-window / disabled / no-shift all behave,
  • the server rejects an early punch with 403 too_early (the real gate).

Run:
  cd backend && python3 -m pytest tests/test_portal_clock_window.py -x -q
"""

import json
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
from app.routers import staff_portal as sp
from app.models.staff import StaffMember, StaffLink, Schedule
from app.models.user import User
from app.models.business_profile import BusinessProfile
from app.services.auth import hash_password

_db_ready.set()
_CPH = ZoneInfo("Europe/Copenhagen")
# Mutable "now" the tests set per-scenario; patched over now_local below.
_NOW = {"dt": datetime(2026, 7, 1, 10, 0, tzinfo=_CPH)}


@pytest.fixture(autouse=True)
def _patch_now(monkeypatch):
    monkeypatch.setattr(sp, "now_local", lambda owner: _NOW["dt"])
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


def _seed(db, *, window_minutes=0, window_enabled=False):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(
        user_id=u.id,
        clock_settings_json=json.dumps({
            "enabled": False, "lat": None, "lng": None, "radius_m": 150,
            "window_enabled": window_enabled, "window_minutes": window_minutes,
        }),
    ))
    db.commit()
    s = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server")
    db.add(s); db.commit(); db.refresh(s)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=s.id, token="tok", active=True))
    db.commit()
    return u, s


def _shift(db, u, s, on, start, end):
    db.add(Schedule(
        id=uuid.uuid4(), user_id=u.id, staff_id=s.id, date=on,
        start_time=start, end_time=end, break_minutes=0, status="published",
    ))
    db.commit()


def test_overnight_worker_not_locked_after_midnight_pre_cutoff(db):
    """REGRESSION: overnight 18:00–02:00 dated the 30th, evaluated at 01:30 on
    the 1st (pre-06:00 cutoff → business day is the 30th). The mid-shift worker
    must NOT be locked (previously stamped onto the 1st → locked until 17:45)."""
    u, s = _seed(db, window_minutes=30, window_enabled=True)
    _shift(db, u, s, date(2026, 6, 30), "18:00", "02:00")
    _NOW["dt"] = datetime(2026, 7, 1, 1, 30, tzinfo=_CPH)
    st = sp._clock_window_status(db, s, u)
    assert st["locked"] is False, st


def test_early_opener_window_is_effective_pre_cutoff(db):
    """REGRESSION: opener 05:00–13:00 dated the 1st, evaluated at 04:40 (pre-
    cutoff). The window must lock until 04:45 — not silently fail open."""
    u, s = _seed(db, window_minutes=15, window_enabled=True)
    _shift(db, u, s, date(2026, 7, 1), "05:00", "13:00")
    _NOW["dt"] = datetime(2026, 7, 1, 4, 40, tzinfo=_CPH)
    st = sp._clock_window_status(db, s, u)
    assert st["locked"] is True
    assert st["opens_at"] == "04:45"
    assert st["shift_start"] == "05:00"


def test_within_window_unlocks(db):
    u, s = _seed(db, window_minutes=15, window_enabled=True)
    _shift(db, u, s, date(2026, 7, 1), "05:00", "13:00")
    _NOW["dt"] = datetime(2026, 7, 1, 4, 50, tzinfo=_CPH)
    st = sp._clock_window_status(db, s, u)
    assert st["locked"] is False


def test_disabled_window_never_locks(db):
    u, s = _seed(db, window_minutes=30, window_enabled=False)
    _shift(db, u, s, date(2026, 7, 1), "18:00", "23:00")
    _NOW["dt"] = datetime(2026, 7, 1, 9, 0, tzinfo=_CPH)
    st = sp._clock_window_status(db, s, u)
    assert st["locked"] is False


def test_no_shift_never_locks(db):
    u, s = _seed(db, window_minutes=30, window_enabled=True)
    _NOW["dt"] = datetime(2026, 7, 1, 9, 0, tzinfo=_CPH)
    st = sp._clock_window_status(db, s, u)
    assert st["locked"] is False


def test_server_rejects_early_punch_403(client, db):
    """The window gate is server-authoritative: an early punch is a 403 too_early,
    nothing written."""
    u, s = _seed(db, window_minutes=30, window_enabled=True)
    _shift(db, u, s, date(2026, 7, 1), "18:00", "23:00")
    _NOW["dt"] = datetime(2026, 7, 1, 9, 0, tzinfo=_CPH)  # long before 17:30
    r = client.post("/api/portal/tok/clock-in")
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["error"] == "too_early"
    assert r.json()["detail"]["opens_at"] == "17:30"
