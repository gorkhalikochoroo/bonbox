"""Hours summary — per-SHIFT state, not period arithmetic.

The bug this exists to prevent was found on the running app, not in review:

    Aksel is scheduled 8h Saturday and never clocks in. On Sunday he covers a
    double — scheduled 8h, works 16h. The period totals are 16 scheduled and 16
    actual, so the diff is ZERO, and the table renders the same em-dash it uses
    for "worked exactly as scheduled". A no-show and eight hours of unplanned
    overtime cancel each other out and the row reports a perfect week.

No colour fixes a number that is genuinely zero. State has to be computed per
day and the row has to inherit its worst shift. That is what these tests pin.

The second thing pinned here is a refusal: a shift that was scheduled with no
clock-in is reported as `no_clock_in` — "the clock measured nothing" — and never
as "did not show up". Which of those it was is not knowable from the data, and
only the owner may say. See test_the_state_never_claims_a_person_did_not_show.

Run:
  cd backend && python3 -m pytest tests/test_hours_shift_state.py -x -q
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
from app.models.staff import StaffMember, Schedule, HoursLogged
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()

D1 = date(2026, 8, 1)
D2 = date(2026, 8, 2)


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


def _owner(db):
    u = User(
        email=f"o{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _staff(db, owner, name="Aksel"):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(m); db.commit(); db.refresh(m)
    return m


def _sched(db, owner, member, day, start="08:00", end="16:00"):
    db.add(Schedule(id=uuid.uuid4(), user_id=owner.id, staff_id=member.id, date=day,
                    start_time=start, end_time=end, status="published"))
    db.commit()


def _worked(db, owner, member, day, hours, start="08:00", end="16:00"):
    db.add(HoursLogged(user_id=owner.id, staff_id=member.id, date=day,
                       start_time=start, end_time=end, break_minutes=0,
                       total_hours=hours, entry_method="clock"))
    db.commit()


def _row(client, member, frm=D1, to=date(2026, 8, 31)):
    r = client.get(f"/api/staff/hours/summary?from={frm}&to={to}")
    assert r.status_code == 200, r.text
    return next((x for x in r.json() if x["staff_id"] == str(member.id)), None)


# ── the bug that started this ────────────────────────────────────────────

def test_a_no_show_is_not_cancelled_out_by_later_overtime(client, db):
    """THE regression test. Period diff is zero; the row must still say a shift
    needs answering."""
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1)                       # 8h scheduled, never clocked in
    _sched(db, o, m, D2)                       # 8h scheduled...
    _worked(db, o, m, D2, 16.0, end="00:00")   # ...worked 16h

    row = _row(client, m)
    assert row["scheduled_hours"] == 16.0
    assert row["actual_hours"] == 16.0
    assert row["actual_hours"] - row["scheduled_hours"] == 0.0   # the trap
    assert row["worst_state"] == "no_clock_in"                   # not "matched"
    assert row["needs_answer_count"] == 1


def test_the_exception_list_names_the_day(client, db):
    """A count alone is not actionable — the owner has to know WHICH shift."""
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1)
    _sched(db, o, m, D2); _worked(db, o, m, D2, 16.0, end="00:00")

    ex = _row(client, m)["exceptions"]
    by_state = {e["state"]: e for e in ex}
    assert by_state["no_clock_in"]["date"] == "2026-08-01"
    assert by_state["no_clock_in"]["scheduled_hours"] == 8.0
    assert by_state["no_clock_in"]["actual_hours"] == 0.0
    assert by_state["over"]["date"] == "2026-08-02"


# ── each state on its own ────────────────────────────────────────────────

def test_worked_as_scheduled_is_quiet(client, db):
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1); _worked(db, o, m, D1, 8.0)
    row = _row(client, m)
    assert row["worst_state"] == "matched"
    assert row["needs_answer_count"] == 0
    assert row["exceptions"] == []


def test_a_few_minutes_either_side_is_not_an_event(client, db):
    """Clocking in at 08:02 must not light the page up every single day."""
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1); _worked(db, o, m, D1, 7.9)
    assert _row(client, m)["worst_state"] == "matched"


def test_left_early_is_its_own_state(client, db):
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1); _worked(db, o, m, D1, 6.5)
    row = _row(client, m)
    assert row["worst_state"] == "short"
    assert row["needs_answer_count"] == 0          # measured — nothing to answer


def test_never_clocked_in_needs_an_answer(client, db):
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1)
    row = _row(client, m)
    assert row["worst_state"] == "no_clock_in"
    assert row["needs_answer_count"] == 1


def test_worked_without_being_scheduled(client, db):
    o = _owner(db); m = _staff(db, o)
    _worked(db, o, m, D1, 5.0)
    assert _row(client, m)["worst_state"] == "unplanned"


def test_still_on_the_clock_is_not_an_exception(client, db):
    """An open punch mid-shift is normal, not a problem to resolve."""
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1)
    db.add(HoursLogged(user_id=o.id, staff_id=m.id, date=D1, start_time="08:00",
                       end_time=None, break_minutes=0, total_hours=0,
                       entry_method="clock"))
    db.commit()
    row = _row(client, m)
    assert row["worst_state"] == "running"
    assert row["needs_answer_count"] == 0
    assert row["exceptions"] == []


# ── precedence ───────────────────────────────────────────────────────────

def test_needs_answer_outranks_a_measured_deviation(client, db):
    """A missing punch outranks a short day: only one of them needs a human."""
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1)                        # no clock-in
    _sched(db, o, m, D2); _worked(db, o, m, D2, 6.5)   # short
    assert _row(client, m)["worst_state"] == "no_clock_in"


def test_one_bad_shift_does_not_leak_onto_another_staffer(client, db):
    o = _owner(db)
    mine = _staff(db, o, "Aksel"); theirs = _staff(db, o, "Agnes")
    _sched(db, o, mine, D1)                                  # no-show
    _sched(db, o, theirs, D1); _worked(db, o, theirs, D1, 8.0)
    assert _row(client, mine)["worst_state"] == "no_clock_in"
    assert _row(client, theirs)["worst_state"] == "matched"


# ── the refusal ──────────────────────────────────────────────────────────

def test_the_state_never_claims_a_person_did_not_show(client, db):
    """The clock can only report that it measured nothing. "Did not show up" is
    a judgement about a person and only the owner may make it — so no state the
    server emits may assert it."""
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1)
    row = _row(client, m)
    blob = str(row).lower()
    assert "no_clock_in" in blob
    for forbidden in ("no_show", "noshow", "absent", "skipped", "missed"):
        assert forbidden not in blob


def test_period_totals_are_unchanged(client, db):
    """Existing callers read these keys; adding state must not move them."""
    o = _owner(db); m = _staff(db, o)
    _sched(db, o, m, D1); _worked(db, o, m, D1, 6.5)
    row = _row(client, m)
    assert row["scheduled_hours"] == 8.0
    assert row["actual_hours"] == 6.5
    assert row["total_hours"] == 6.5           # legacy key
