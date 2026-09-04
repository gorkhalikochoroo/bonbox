"""Correcting one number on an hours row must not be a lie, and must not
destroy the legal register.

THE BUG THIS PINS. PUT /staff/hours/{id} bound HoursLogCreate, where staff_id
and date are required with no default. Its only caller — the pencil-edit on the
owner's Details tab — sends `{total_hours}` alone, so FastAPI rejected every
correction with 422 before the handler body ran. The frontend's
`catch { // silent }` swallowed it, and because setEditingId(null) ran only on
success, the editor stayed open showing the number the owner had just typed.

That is the worst shape a bug can take on a pay record: the owner types 8, sees
8, walks away, and pays 6.25. StaffHoursPage.jsx already records killing this
exact failure on the resolve path — "a failed save looked exactly like a
successful one — on a pay record" — and the edit path still had it.

THE FIX THAT WOULD HAVE BEEN WORSE. Making the client send a full body to
satisfy the old schema. update_hours full-replaces, so any field the client
omitted becomes NULL — and start_time/end_time/break_minutes are the columns
that make these rows an Arbejdstidsloven register: daily working time, kept
five years, and the evidence for 11-timers rest checks. Blanking the times to
correct a total is a bigger bug than the one being fixed. So the endpoint takes
a PARTIAL body and writes only the keys actually sent.

Run:
  cd backend && python3 -m pytest tests/test_hours_partial_edit.py -q
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
D1 = date(2026, 8, 1)


@pytest.fixture
def engine_and_session():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
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
    u = User(email=f"o{uuid.uuid4().hex[:6]}@bonbox.dk",
             password_hash=hash_password("x"), business_name="Bon",
             business_type="cafe", currency="DKK", role="owner",
             timezone="Europe/Copenhagen")
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _staff(db, owner, name="Sofie"):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(m); db.commit(); db.refresh(m)
    return m


def _row(db, owner, member, *, hours=6.25, method="clock"):
    h = HoursLogged(user_id=owner.id, staff_id=member.id, date=D1,
                    start_time="16:00", end_time="23:00", break_minutes=45,
                    total_hours=hours, entry_method=method)
    db.add(h); db.commit(); db.refresh(h)
    return h


class TestTheCorrectionActuallySaves:
    def test_sending_only_total_hours_is_accepted(self, client, db):
        """THE REGRESSION. This is byte-for-byte what the pencil-edit sends."""
        o = _owner(db); m = _staff(db, o)
        h = _row(db, o, m, hours=6.25)

        r = client.put(f"/api/staff/hours/{h.id}", json={"total_hours": 8})

        assert r.status_code == 200, (
            f"the owner's correction was rejected with {r.status_code} — the UI "
            f"showed them the number they typed and saved nothing: {r.text[:200]}"
        )
        db.expire_all()
        assert db.query(HoursLogged).get(h.id).total_hours == 8

    def test_a_rejected_edit_is_still_rejected_loudly(self, client, db):
        """The partial body must not become a licence to write anything. An
        unknown row is still a 404, not a silent no-op."""
        _owner(db)
        r = client.put(f"/api/staff/hours/{uuid.uuid4()}", json={"total_hours": 8})
        assert r.status_code == 404


class TestTheLegalRegisterSurvives:
    """These columns are the Arbejdstilsynet register. Losing them to fix a
    total would be a worse bug than the one being fixed."""

    def test_times_and_break_are_not_blanked(self, client, db):
        o = _owner(db); m = _staff(db, o)
        h = _row(db, o, m)

        client.put(f"/api/staff/hours/{h.id}", json={"total_hours": 8})

        db.expire_all()
        again = db.query(HoursLogged).get(h.id)
        assert again.start_time == "16:00", "start_time was blanked by a total-hours edit"
        assert again.end_time == "23:00", "end_time was blanked by a total-hours edit"
        assert again.break_minutes == 45, "the break was blanked by a total-hours edit"
        assert again.date == D1
        assert again.staff_id == m.id

    def test_an_omitted_note_is_left_alone(self, client, db):
        o = _owner(db); m = _staff(db, o)
        h = _row(db, o, m)
        h.notes = "kom sent"
        db.commit()

        client.put(f"/api/staff/hours/{h.id}", json={"total_hours": 8})

        db.expire_all()
        assert db.query(HoursLogged).get(h.id).notes == "kom sent"


class TestProvenanceStillHolds:
    def test_the_clock_measurement_is_captured_before_the_override(self, client, db):
        """Write-once. A disputed payslip has to keep something to appeal to.

        6.5 rather than 6.25 for historical reasons — 6.25 could not survive a
        round trip until Migration 071 widened the column; it can now, and the
        test below pins that.
        """
        o = _owner(db); m = _staff(db, o)
        h = _row(db, o, m, hours=6.5, method="clock")
        assert h.clock_hours is None

        client.put(f"/api/staff/hours/{h.id}", json={"total_hours": 8})

        db.expire_all()
        again = db.query(HoursLogged).get(h.id)
        assert float(again.clock_hours) == 6.5, "what the clock measured was lost"
        assert float(again.total_hours) == 8

    # Was an xfail: total_hours was numeric(5,1), so the venue's STANDARD shift
    # (16:00-23:00 less a 45-min break = exactly 6.25h) could not round-trip.
    # It stored 6.3, not 6.2 — Postgres rounds halves away from zero, and
    # production holds 8 rows at 6.3. So that shift was over-credited by three
    # minutes rather than shorted; either way the paid number disagreed with
    # the measured one by rounding alone. Widened to numeric(5,2) by Migration
    # 071. This runs on SQLite, so what it actually pins is the MODEL's
    # declared scale — if it fails again, the model has been narrowed.
    def test_a_quarter_hour_survives_the_round_trip(self, client, db):
        o = _owner(db); m = _staff(db, o)
        h = _row(db, o, m, hours=6.25, method="clock")

        db.expire_all()
        assert float(db.query(HoursLogged).get(h.id).total_hours) == 6.25

    def test_a_typed_row_never_grows_a_fake_measurement(self, client, db):
        """An owner-typed row never had a clock reading — backfilling one would
        make a typed number read as a measured one."""
        o = _owner(db); m = _staff(db, o)
        h = _row(db, o, m, hours=6.0, method="quick")

        client.put(f"/api/staff/hours/{h.id}", json={"total_hours": 7})

        db.expire_all()
        assert db.query(HoursLogged).get(h.id).clock_hours is None

    def test_editing_times_is_owner_resolved_never_clock(self, client, db):
        """Only the clock may claim to have measured."""
        o = _owner(db); m = _staff(db, o)
        h = _row(db, o, m, method="quick")

        r = client.put(f"/api/staff/hours/{h.id}",
                       json={"start_time": "16:00", "end_time": "22:00",
                             "break_minutes": 30})
        assert r.status_code == 200

        db.expire_all()
        again = db.query(HoursLogged).get(h.id)
        assert again.entry_method == "owner_resolved"
        assert again.total_hours == 5.5   # 6h span − 30 min

    def test_an_edit_answers_the_shift(self, client, db):
        """An owner edit IS an answer — the shift must stop asking."""
        o = _owner(db); m = _staff(db, o)
        h = _row(db, o, m)

        client.put(f"/api/staff/hours/{h.id}", json={"total_hours": 8})

        db.expire_all()
        again = db.query(HoursLogged).get(h.id)
        assert again.resolution == "adjusted"
        assert again.resolved_by == o.id
        assert again.resolved_at is not None
