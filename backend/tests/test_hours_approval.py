"""Approving a period's hours — "these hours are final".

WHY THIS EXISTS. The Hours hub promised that the owner "godkender timer", and
there was no way to do it: exports used every logged hour, and nothing said
which hours the owner had looked at. Approval reuses the per-row tick the
double tick already writes, so a shift answered on its own and a period
approved in one go mean the same thing.

Locks under test:
  • Approve ticks every unanswered row in the range (one person or everyone)
    and leaves rows the owner already answered alone.
  • A shift still open (no clock-out) blocks approval — an hours figure nobody
    knows cannot be final.
  • Approved rows refuse edits and deletes until the approval is undone.
  • Undo takes back only what "Godkend" ticked, never a shift answered alone.
  • The summary says, per person, how many rows are approved.
  • Another venue's staff member is never reachable.

Run: cd backend && python3 -m pytest tests/test_hours_approval.py -x -q
"""

import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, HoursLogged
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()
D1 = date(2026, 8, 3)
D2 = date(2026, 8, 4)


@pytest.fixture
def engine_and_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
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
def client(engine_and_session, db):
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


def _owner(db):
    u = User(
        email=f"o{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK", role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _staff(db, owner, name="Aksel"):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server", base_rate=150)
    db.add(m); db.commit(); db.refresh(m)
    return m


def _row(db, owner, member, day=D1, start="08:00", end="16:00", hours=8.0, **kw):
    h = HoursLogged(user_id=owner.id, staff_id=member.id, date=day, start_time=start,
                    end_time=end, break_minutes=0, total_hours=hours, entry_method="clock", **kw)
    db.add(h); db.commit(); db.refresh(h)
    return h


RANGE = {"from": str(D1), "to": str(D2)}


def test_approve_ticks_the_period_and_leaves_answers_alone(client, db):
    o = _owner(db); a = _staff(db, o, "Aksel"); b = _staff(db, o, "Bodil")
    _row(db, o, a, D1); _row(db, o, a, D2); _row(db, o, b, D1)
    answered = _row(db, o, b, D2, resolution="adjusted", resolution_note="Glemte at stemple ud")

    r = client.post("/api/staff/hours/approve", json=RANGE)
    assert r.status_code == 200, r.text
    assert r.json() == {"approved": 3, "already": 1, "rows": 4}

    db.expire_all()
    kept = db.get(HoursLogged, answered.id)
    assert kept.resolution == "adjusted" and kept.resolution_note == "Glemte at stemple ud"

    summary = {row["staff_name"]: row for row in client.get("/api/staff/hours/summary", params=RANGE).json()}
    assert summary["Aksel"]["entries_count"] == 2 and summary["Aksel"]["approved_count"] == 2
    assert summary["Bodil"]["approved_count"] == 2 and summary["Bodil"]["period_approved_count"] == 1


def test_one_person_only(client, db):
    o = _owner(db); a = _staff(db, o, "Aksel"); b = _staff(db, o, "Bodil")
    _row(db, o, a, D1); other = _row(db, o, b, D1)
    r = client.post("/api/staff/hours/approve", json={**RANGE, "staff_id": str(a.id)})
    assert r.json()["approved"] == 1
    db.expire_all()
    assert db.get(HoursLogged, other.id).resolution is None


def test_an_open_shift_blocks_approval(client, db):
    o = _owner(db); a = _staff(db, o)
    _row(db, o, a, D1)
    _row(db, o, a, D2, end=None, hours=0)
    r = client.post("/api/staff/hours/approve", json=RANGE)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "open_punches", "count": 1}


def test_approved_hours_refuse_edits_until_undone(client, db):
    o = _owner(db); a = _staff(db, o)
    h = _row(db, o, a, D1)
    client.post("/api/staff/hours/approve", json=RANGE)

    edit = client.put(f"/api/staff/hours/{h.id}", json={"total_hours": 9})
    assert edit.status_code == 409 and edit.json()["detail"]["code"] == "approved"
    gone = client.delete(f"/api/staff/hours/{h.id}")
    assert gone.status_code == 409

    undo = client.post("/api/staff/hours/unapprove", json=RANGE)
    assert undo.json() == {"unapproved": 1}
    assert client.put(f"/api/staff/hours/{h.id}", json={"total_hours": 9}).status_code == 200


def test_undo_never_takes_back_a_shift_answered_on_its_own(client, db):
    o = _owner(db); a = _staff(db, o)
    _row(db, o, a, D1)
    answered = _row(db, o, a, D2, resolution="confirmed", resolution_note="Set og godkendt enkeltvis")
    client.post("/api/staff/hours/approve", json=RANGE)
    client.post("/api/staff/hours/unapprove", json=RANGE)
    db.expire_all()
    assert db.get(HoursLogged, answered.id).resolution == "confirmed"


def test_another_venues_staff_is_not_reachable(client, db):
    o = _owner(db); a = _staff(db, o)
    _row(db, o, a, D1)
    other_owner = User(email=f"x{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
                       business_name="X", business_type="cafe", currency="DKK", role="owner")
    db.add(other_owner); db.commit()
    foreign = StaffMember(id=uuid.uuid4(), user_id=other_owner.id, name="Fremmed", role="server")
    db.add(foreign); db.commit()
    r = client.post("/api/staff/hours/approve", json={**RANGE, "staff_id": str(foreign.id)})
    assert r.status_code == 404


def test_a_bad_range_is_refused(client, db):
    _owner(db)
    assert client.post("/api/staff/hours/approve", json={"from": str(D2), "to": str(D1)}).status_code == 400
