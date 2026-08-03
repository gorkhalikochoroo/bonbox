"""Confirming a schedule must only stamp the shifts the staffer actually saw.

The portal grew a department switcher, so the on-screen list can be a SUBSET of
the server's 3-week window. An unscoped confirm stamped confirmed_at on shifts
at branches the staffer had filtered out and never read — and then reported a
count that disagreed with the screen. The owner reads that record back as
"they've seen their schedule", so a wrong one is a trust defect, not cosmetic.

The id list NARROWS. It is layered on top of the existing staff/tenant/window/
status guards and can never widen them — the peer test below is the one that
matters most.

Run:
  cd backend && python3 -m pytest tests/test_portal_confirm_scope.py -x -q
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
from app.models.staff import StaffMember, StaffLink, Schedule
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


def _owner(db):
    u = User(
        email=f"o{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _staff(db, owner, token):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server")
    db.add(m); db.commit(); db.refresh(m)
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id, token=token, active=True))
    db.commit()
    return m


def _shift(db, owner, member, days_ahead=1):
    sh = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=member.id,
        date=date.today() + timedelta(days=days_ahead),
        start_time="16:00", end_time="23:00", status="published",
    )
    db.add(sh); db.commit(); db.refresh(sh)
    return sh


def _confirm(client, token="tok", **body):
    return client.post(f"/api/portal/{token}/confirm-schedule", json=body)


def test_ids_narrow_to_what_was_shown(db, client):
    """The department case: two shifts exist, only one was on screen."""
    o = _owner(db); m = _staff(db, o, "tok")
    seen = _shift(db, o, m, 1)
    hidden = _shift(db, o, m, 2)

    r = _confirm(client, shift_ids=[str(seen.id)])
    assert r.status_code == 200, r.text
    assert r.json()["confirmed_count"] == 1        # not 2 — the count must match the screen

    db.expire_all()
    assert db.query(Schedule).filter(Schedule.id == seen.id).one().confirmed_at is not None
    assert db.query(Schedule).filter(Schedule.id == hidden.id).one().confirmed_at is None


def test_no_ids_still_confirms_the_whole_window(db, client):
    """An older cached bundle posts `{}` — that path must keep working."""
    o = _owner(db); m = _staff(db, o, "tok")
    _shift(db, o, m, 1); _shift(db, o, m, 2)
    assert _confirm(client).json()["confirmed_count"] == 2


def test_ids_can_never_widen_past_the_staff_gate(db, client):
    """The load-bearing one. Passing a COLLEAGUE's shift id must not confirm it."""
    o = _owner(db)
    mine = _staff(db, o, "tok")
    theirs = StaffMember(id=uuid.uuid4(), user_id=o.id, name="Bo", role="server")
    db.add(theirs); db.commit(); db.refresh(theirs)
    not_mine = _shift(db, o, theirs, 1)

    r = _confirm(client, shift_ids=[str(not_mine.id)])
    assert r.status_code == 200
    assert r.json()["confirmed_count"] == 0
    db.expire_all()
    assert db.query(Schedule).filter(Schedule.id == not_mine.id).one().confirmed_at is None


def test_unparseable_id_strings_are_skipped_not_fatal(db, client):
    """A string that is not a UUID is dropped; the valid ones still confirm."""
    o = _owner(db); m = _staff(db, o, "tok")
    seen = _shift(db, o, m, 1)
    r = _confirm(client, shift_ids=[str(seen.id), "not-a-uuid"])
    assert r.status_code == 200
    assert r.json()["confirmed_count"] == 1


def test_a_non_string_in_the_list_is_rejected_outright(db, client):
    """Pydantic refuses it before the handler runs, and that is correct — no
    real client sends null, so accepting it would only be accepting garbage."""
    o = _owner(db); m = _staff(db, o, "tok")
    _shift(db, o, m, 1)
    assert _confirm(client, shift_ids=["not-a-uuid", None]).status_code == 422


def test_empty_id_list_falls_back_to_the_window(db, client):
    """`[]` means "the client sent no selection", not "confirm nothing" — the
    frontend omits already-confirmed ids, so an empty list is the all-done case."""
    o = _owner(db); m = _staff(db, o, "tok")
    _shift(db, o, m, 1)
    assert _confirm(client, shift_ids=[]).json()["confirmed_count"] == 1
