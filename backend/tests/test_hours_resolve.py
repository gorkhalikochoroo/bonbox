"""Owner resolution of hours — the "seen and accepted" tick.

What this protects, in order of how much it would hurt to get wrong:

  1. **clock_hours is write-once.** The moment an owner overrides a measurement,
     what the clock actually measured is captured and never touched again. Lose
     it and an override becomes indistinguishable from a measurement — which is
     precisely the failure the whole design exists to prevent. These hours pay
     wages and sit in an Arbejdstidsloven register kept five years; if an
     employee disputes their pay, "the clock said 0, I said 8" has to still be
     readable.

  2. **Nothing resolves itself.** There is no auto-confirm, no nightly job, no
     "helpful" default. An unresolved shift stays unresolved until a human
     answers it.

  3. **An absent measurement stays absent.** An owner-typed row never had a
     clock reading, so clock_hours stays NULL rather than being backfilled from
     total_hours — otherwise a typed number would later read as a measured one.

Run:
  cd backend && python3 -m pytest tests/test_hours_resolve.py -x -q
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
from app.models.staff import StaffMember, Schedule, HoursLogged
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()
D1 = date(2026, 8, 1)


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


def _owner(db, email=None):
    u = User(
        email=email or f"o{uuid.uuid4().hex[:6]}@bonbox.dk",
        password_hash=hash_password("x"), business_name="Bon", business_type="cafe",
        currency="DKK", role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _staff(db, owner, name="Aksel"):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(m); db.commit(); db.refresh(m)
    return m


def _worked(db, owner, member, hours, method="clock", day=D1):
    h = HoursLogged(user_id=owner.id, staff_id=member.id, date=day,
                    start_time="08:00", end_time="16:00", break_minutes=0,
                    total_hours=hours, entry_method=method)
    db.add(h); db.commit(); db.refresh(h)
    return h


def _resolve(client, member, action, hours=None, note=None, day=D1):
    body = {"staff_id": str(member.id), "date": str(day), "action": action}
    if hours is not None:
        body["total_hours"] = hours
    if note:
        body["note"] = note
    return client.post("/api/staff/hours/resolve", json=body)


# ── 1. the measured value survives, always ───────────────────────────────

def test_adjusting_preserves_what_the_clock_measured(client, db):
    o = _owner(db); m = _staff(db, o)
    _worked(db, o, m, 6.5)                       # clock said 6.5

    r = _resolve(client, m, "adjust", hours=8.0) # owner says 8.0
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total_hours"] == 8.0
    assert body["clock_hours"] == 6.5            # the measurement is still there
    assert body["resolution"] == "adjusted"


def test_clock_hours_is_write_once(client, db):
    """A second override must not overwrite the original measurement — otherwise
    the register slowly converges on whatever the owner last typed."""
    o = _owner(db); m = _staff(db, o)
    _worked(db, o, m, 6.5)

    _resolve(client, m, "adjust", hours=8.0)
    second = _resolve(client, m, "adjust", hours=9.0)
    assert second.json()["total_hours"] == 9.0
    assert second.json()["clock_hours"] == 6.5   # NOT 8.0


def test_resolving_a_missing_punch_records_that_the_clock_measured_zero(client, db):
    """The ambiguous case has no row at all. Creating one must not erase the
    fact that nothing was measured."""
    o = _owner(db); m = _staff(db, o)
    db.add(Schedule(id=uuid.uuid4(), user_id=o.id, staff_id=m.id, date=D1,
                    start_time="08:00", end_time="16:00", status="published"))
    db.commit()
    assert db.query(HoursLogged).count() == 0

    body = _resolve(client, m, "adjust", hours=8.0).json()
    assert body["total_hours"] == 8.0
    assert body["clock_hours"] == 0              # measured nothing, and says so
    assert body["entry_method"] == "owner_resolved"   # never "clock"


def test_an_owner_typed_row_never_gains_a_fake_measurement(client, db):
    """entry_method='quick' means nobody ever punched. clock_hours must stay
    NULL — an absence of measurement has to read as an absence."""
    o = _owner(db); m = _staff(db, o)
    _worked(db, o, m, 8.0, method="quick")
    body = _resolve(client, m, "confirm").json()
    assert body["clock_hours"] is None


# ── 2. the three things an owner can say ─────────────────────────────────

def test_confirm_accepts_the_record_as_it_stands(client, db):
    o = _owner(db); m = _staff(db, o)
    _worked(db, o, m, 6.5)
    body = _resolve(client, m, "confirm").json()
    assert body["resolution"] == "confirmed"
    assert body["total_hours"] == 6.5            # unchanged
    assert body["resolved_at"] is not None


def test_absent_records_a_real_zero(client, db):
    """Different from the absence of a record: this is the owner stating it."""
    o = _owner(db); m = _staff(db, o)
    body = _resolve(client, m, "absent").json()
    assert body["total_hours"] == 0.0
    assert body["resolution"] == "confirmed"
    assert body["clock_hours"] == 0


def test_a_note_is_kept(client, db):
    o = _owner(db); m = _staff(db, o)
    _worked(db, o, m, 6.5)
    _resolve(client, m, "confirm", note="Sendt hjem tidligt, roligt")
    db.expire_all()
    assert db.query(HoursLogged).one().resolution_note == "Sendt hjem tidligt, roligt"


# ── 3. nothing resolves itself, and nothing crosses a tenant ─────────────

def test_an_untouched_shift_stays_unresolved(client, db):
    o = _owner(db); m = _staff(db, o)
    _worked(db, o, m, 6.5)
    client.get(f"/api/staff/hours/summary?from={D1}&to={D1}")   # merely reading
    db.expire_all()
    row = db.query(HoursLogged).one()
    assert row.resolution is None
    assert row.resolved_at is None


def test_cannot_resolve_another_businesss_staff(client, db):
    o1 = _owner(db, "a@bonbox.dk")
    stranger = _staff(db, o1, "Theirs")
    o2 = _owner(db, "b@bonbox.dk")          # override now points at o2
    assert _resolve(client, stranger, "confirm").status_code == 404


def test_the_resolution_is_attributed(client, db):
    """'Seen by' is the point — an unattributed tick proves nothing later."""
    o = _owner(db); m = _staff(db, o)
    _worked(db, o, m, 6.5)
    _resolve(client, m, "confirm")
    db.expire_all()
    assert db.query(HoursLogged).one().resolved_by == o.id


# ── 4. input guards ──────────────────────────────────────────────────────

def test_adjust_without_hours_is_rejected(client, db):
    o = _owner(db); m = _staff(db, o)
    assert _resolve(client, m, "adjust").status_code == 400


def test_an_impossible_day_is_rejected(client, db):
    o = _owner(db); m = _staff(db, o)
    assert _resolve(client, m, "adjust", hours=30).status_code == 400
    assert _resolve(client, m, "adjust", hours=-1).status_code == 400


def test_an_unknown_action_is_rejected(client, db):
    o = _owner(db); m = _staff(db, o)
    assert _resolve(client, m, "approve_everything").status_code == 400
