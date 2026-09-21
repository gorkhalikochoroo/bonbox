"""A lønseddel is a statement about settled time. An open shift is not settled.

THE BUG. A staffer clocks in and has not clocked out — or simply forgot. The
row stores total_hours = 0, because the real figure is only computed at
clock-out. Generate payroll over that period and three things happen at once:

  1. `earned = hrs * rate` re-derives 0,00 kr. from 0 hours, on a line that
     prints a start time and an hourly rate — so the document positively
     asserts the employee earned nothing for a shift they worked;
  2. that assertion lands on a Bilagsnummer'd, SHA-256-hashed, employee-SIGNED
     artifact retained five years under Bogføringsloven §10;
  3. the hours become unpayable FOREVER. Nothing auto-closes a punch (the only
     closer is the staffer's own /clock-out — no sweep, no cron, no cutoff),
     and HoursLogged carries no paid_at and no payslip_id, so payroll is a pure
     `date >= period_start` range query. Once the shift's date sits inside a
     period already issued, no later payslip will ever read it again.

Point 3 is why this refuses instead of warning. A wrong number on a payslip is
correctable; silently stranded wages are not, because nothing in the system
ever looks at that date again.

WHAT THESE PIN:
  • the run is refused while ANY shift in the period is open, and the message
    names who and when so the owner closes them in one pass;
  • a quick-log with a NULL end_time does NOT trigger it — an owner-typed row
    legitimately has no end, and blocking those would break payroll for every
    venue that does not use the punch clock;
  • closing the punch un-blocks the run;
  • the service refuses on its own, so no other caller can route around the
    router into a signed document.
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
from app.services.auth import hash_password, get_current_user
from app.services.loenseddel_pdf import (
    OpenPunchInPeriod,
    _open_punches,
    fetch_loenseddel_data,
)

_db_ready.set()

P_START, P_END = date(2026, 6, 1), date(2026, 6, 30)
WORKDAY = date(2026, 6, 10)


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
        id=uuid.uuid4(), email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _staff(db, owner, name="Agnes"):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name,
                    role="server", base_rate=145, active=True)
    db.add(m); db.commit(); db.refresh(m)
    return m


def _closed_shift(db, owner, m, d=WORKDAY, hours=7.5):
    db.add(HoursLogged(
        id=uuid.uuid4(), user_id=owner.id, staff_id=m.id, date=d,
        start_time="09:00", end_time="16:30", break_minutes=0,
        total_hours=hours, rate_applied=145, earned=round(hours * 145, 2),
        entry_method="clock",
    ))
    db.commit()


def _open_punch(db, owner, m, d=WORKDAY, start="15:22"):
    """Exactly what /clock-in writes: a start, no end, zero hours."""
    db.add(HoursLogged(
        id=uuid.uuid4(), user_id=owner.id, staff_id=m.id, date=d,
        start_time=start, end_time=None, break_minutes=0,
        total_hours=0, rate_applied=None, earned=None,
        entry_method="clock",
    ))
    db.commit()


def _quick_log_no_end(db, owner, m, d=WORKDAY, hours=6.0):
    """An owner-typed row. NULL end_time, but the hours ARE known."""
    db.add(HoursLogged(
        id=uuid.uuid4(), user_id=owner.id, staff_id=m.id, date=d,
        start_time=None, end_time=None, break_minutes=0,
        total_hours=hours, rate_applied=145, earned=round(hours * 145, 2),
        entry_method="quick",
    ))
    db.commit()


def _get(client):
    return client.get(
        "/api/staff/payroll/loenseddel",
        params={"period_start": P_START.isoformat(), "period_end": P_END.isoformat()},
    )


def test_payroll_is_refused_while_a_shift_is_still_open(client, db):
    """The one that matters."""
    o = _owner(db); m = _staff(db, o)
    _closed_shift(db, o, m)
    _open_punch(db, o, m, d=date(2026, 6, 12))

    r = _get(client)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "Agnes" in detail, "the owner must be told WHO to chase"
    assert "2026-06-12" in detail, "and WHEN"
    assert "15:22" in detail


def test_the_refusal_says_why_it_cannot_simply_be_paid_later(client, db):
    """Stranded wages are the reason this refuses instead of warning."""
    o = _owner(db); m = _staff(db, o)
    _open_punch(db, o, m)

    detail = _get(client).json()["detail"]
    assert "0" in detail
    assert "later" in detail.lower() or "permanent" in detail.lower()


def test_an_owner_typed_row_with_no_end_time_does_not_block_payroll(client, db):
    """A quick-log legitimately has a NULL end and KNOWN hours. Refusing those
    would break payroll for every venue that never touches the punch clock."""
    o = _owner(db); m = _staff(db, o)
    _quick_log_no_end(db, o, m)

    r = _get(client)
    assert r.status_code != 409, (
        "a typed row is settled time — only a clock row without an end is not"
    )


def test_closing_the_punch_unblocks_the_run(client, db):
    o = _owner(db); m = _staff(db, o)
    _open_punch(db, o, m)
    assert _get(client).status_code == 409

    row = db.query(HoursLogged).filter(HoursLogged.end_time.is_(None)).first()
    row.end_time = "16:00"
    row.total_hours = 0.63
    row.earned = 91.35
    db.commit()

    assert _get(client).status_code != 409


def test_every_open_shift_is_named_not_just_the_first(client, db):
    """One 409 per run, not a discover-one-at-a-time loop."""
    o = _owner(db)
    a, b = _staff(db, o, "Agnes"), _staff(db, o, "Bo")
    _open_punch(db, o, a, d=date(2026, 6, 11))
    _open_punch(db, o, b, d=date(2026, 6, 12))

    detail = _get(client).json()["detail"]
    assert "Agnes" in detail and "Bo" in detail
    assert detail.startswith("2 shift")


def test_the_service_refuses_on_its_own(client, db):
    """Barrier 2: no other caller can route around the router."""
    o = _owner(db); m = _staff(db, o)
    _open_punch(db, o, m)

    with pytest.raises(OpenPunchInPeriod):
        fetch_loenseddel_data(db, o, m, P_START, P_END)


def test_open_punch_predicate_needs_BOTH_conditions(db):
    """end_time IS NULL alone is not enough — that is a quick-log."""
    class _Row:
        def __init__(self, method, end):
            self.entry_method, self.end_time = method, end

    rows = [
        _Row("clock", None),   # open punch
        _Row("clock", "16:00"),  # closed
        _Row("quick", None),   # typed, settled
    ]
    assert len(_open_punches(rows)) == 1
    assert _open_punches(rows)[0].entry_method == "clock"
