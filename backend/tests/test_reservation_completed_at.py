"""
The host stand's history: "seated → left" and how long the party sat.

WHY THIS EXISTS. A finished party showed only "Afsluttet" — no time they sat
down, no time they left, no time at the table — because the book never sent
seated_at and nothing recorded the leave time at all. A host stand that keeps
a "finished" list (ordered by seated time, seated→left, duration) needs both.

Locks under test:
  • /book sends seated_at and completed_at, as UTC with an explicit "Z"
    (starts_at/ends_at stay naive business-local — two clocks, said plainly).
  • Finishing a seated party stamps completed_at; it is never before seated_at.
  • Reopening a finished table clears completed_at and keeps the real seat time.
  • A row finished before the column existed reads null — never a guess.
  • The startup migration and its SQLite mirror both carry the column.

Run: cd backend && python3 -m pytest tests/test_reservation_completed_at.py -x -q
"""

import json
import uuid
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.services.auth import get_current_user
from app.services.tz_utils import now_local

_db_ready.set()

_SETTINGS = {
    "slot_granularity_min": 15,
    "turn_time_tiers": [{"up_to": 2, "minutes": 90}, {"up_to": 8, "minutes": 120}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 50,
    "combine_enabled": False,
    "retention_days": 90,
}


@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


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

    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()
    app.dependency_overrides.update(prev)


def _venue(db):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Historik Bistro", business_type="restaurant", currency="DKK",
        plan="pro", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(
        user_id=u.id, company_name="Historik Bistro", reservations_enabled=True,
        reservation_slug=f"hist-{uuid.uuid4().hex[:6]}",
        reservation_settings_json=json.dumps(_SETTINGS),
    ))
    t = BookableResource(user_id=u.id, kind="table", label="Bord 7", capacity_seats=4, sort_order=0)
    db.add(t); db.commit(); db.refresh(t)
    app.dependency_overrides[get_current_user] = lambda: u
    return u, t


def _seated_now(client, u, t):
    now = now_local(u).replace(tzinfo=None, second=0, microsecond=0)
    res = client.post("/api/reservations/book", json={
        "guest_name": "Test Historik", "party_size": 3, "source": "walk_in",
        "status": "seated", "starts_at": now.isoformat(), "resource_id": str(t.id),
    })
    assert res.status_code in (200, 201), res.text
    return res.json()


def _row_in_book(client, rid):
    book = client.get("/api/reservations/book").json()
    return next(r for r in book["reservations"] if r["id"] == rid)


def _status(client, rid, status):
    res = client.patch(f"/api/reservations/reservations/{rid}/status", json={"status": status})
    assert res.status_code == 200, res.text
    return res.json()


def _utc(iso):
    assert iso.endswith("Z"), iso
    return datetime.fromisoformat(iso[:-1])


def test_book_sends_seat_time_as_utc_and_no_leave_time_while_seated(client, db):
    u, t = _venue(db)
    a = _seated_now(client, u, t)
    row = _row_in_book(client, a["id"])
    assert row["seated_at"] is not None
    _utc(row["seated_at"])
    assert row["completed_at"] is None


def test_finishing_stamps_the_leave_time_after_the_seat_time(client, db):
    u, t = _venue(db)
    a = _seated_now(client, u, t)
    out = _status(client, a["id"], "completed")
    assert out["completed_at"] is not None
    row = _row_in_book(client, a["id"])
    assert row["status"] == "completed"
    assert _utc(row["completed_at"]) >= _utc(row["seated_at"])


def test_reopening_clears_the_leave_time_and_keeps_the_seat_time(client, db):
    u, t = _venue(db)
    a = _seated_now(client, u, t)
    seated = _row_in_book(client, a["id"])["seated_at"]
    _status(client, a["id"], "completed")
    _status(client, a["id"], "seated")
    row = _row_in_book(client, a["id"])
    assert row["completed_at"] is None
    assert row["seated_at"] == seated


def test_a_row_finished_before_the_column_reads_null(client, db):
    u, t = _venue(db)
    a = _seated_now(client, u, t)
    _status(client, a["id"], "completed")
    db.expire_all()
    r = db.query(Reservation).filter(Reservation.id == uuid.UUID(a["id"])).one()
    r.completed_at = None
    db.commit()
    assert _row_in_book(client, a["id"])["completed_at"] is None


def test_migration_and_sqlite_mirror_carry_completed_at():
    import inspect
    import app.main as m
    src = inspect.getsource(m)
    assert "ALTER TABLE reservations ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP" in src
    assert '_add("reservations", "completed_at", "TIMESTAMP")' in src
    assert Reservation.__table__.c.completed_at.nullable is True
