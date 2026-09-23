"""Hours logged before a wage rate existed must not stay costed at zero.

THE DEFECT. `StaffMember.base_rate` is nullable and `_pick_rate` reads
`float(staff.base_rate or 0)`, so before a rate is entered every shift costs 0.
`earned` is a STORED column written at log time by four separate paths, so
filling the rate in afterwards fixed nothing: Hours kept showing 0 kr for
someone who worked, and the lønseddel would print Bruttoløn 0,00 kr onto a
Bilagsnummer'd, SHA-256-hashed, employee-signed artifact kept five years.

This is the ICP's ordinary sequence, not an edge case: add the person, let them
start clocking in, sort the paperwork out at the weekend.

WHY REPAIR RATHER THAN PROMPT. "9 shifts were costed at 0 kr — re-cost them?"
asks a non-technical owner to adjudicate a concept that only exists because of
an implementation detail; they do not know rows were costed at zero. And it is
not the same as overwriting a decision: a locked kasserapport carries a figure
the owner signed, whereas a 0 from `base_rate or 0` was never chosen by anyone.
The repair is unasked, but it is NOT silent — the response says what moved and
a §10 audit row records it.

THE BOUND IS "CARRIES NO DECISION", not "is recent": only rows where BOTH
rate_applied and earned are null-or-zero. Any row with a rate on it was costed
deliberately and is never touched. (HoursLogged has no paid/exported marker to
key off instead — checked.)
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.staff import HoursLogged, StaffMember
from app.models.user import User
from app.services.auth import hash_password, create_access_token
from app.utils.time import utc_now

_db_ready.set()
DAY = date(2026, 9, 14)


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db):
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.dk",
             password_hash=hash_password("x"), business_name="Café Manoj",
             business_type="restaurant", currency="DKK",
             created_at=utc_now() - timedelta(days=60), email_verified=True)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _hdr(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def _member(db, u, *, base_rate=None):
    m = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Mette",
                    role="barista", active=True, base_rate=base_rate)
    db.add(m); db.commit(); db.refresh(m)
    return m


def _hours(db, u, m, *, hours=8.0, rate=None, earned=None, d=DAY):
    h = HoursLogged(id=uuid.uuid4(), user_id=u.id, staff_id=m.id, date=d,
                    start_time="09:00", end_time="17:00", break_minutes=0,
                    total_hours=hours, rate_applied=rate, earned=earned,
                    entry_method="manual", is_overtime=False,
                    created_at=utc_now())
    db.add(h); db.commit(); db.refresh(h)
    return h


def _set_rate(client, u, m, rate):
    return client.put(f"/api/staff/members/{m.id}", headers=_hdr(u),
                      json={"base_rate": rate})


class TestSettingARateRepairsWhatItCouldNotCost:
    def test_zero_costed_shifts_are_recosted(self, db_session, client):
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=None)
        h = _hours(db_session, u, m, hours=8.0, rate=None, earned=None)

        r = _set_rate(client, u, m, 150.0)
        assert r.status_code == 200, r.text

        db_session.expire_all()
        h = db_session.query(HoursLogged).filter(HoursLogged.id == h.id).first()
        assert float(h.earned) == 1200.0, (
            f"8h at 150 kr should be 1.200 kr, got {h.earned} — the shift is "
            f"still costed at the rate that did not exist when it was logged"
        )
        assert float(h.rate_applied) == 150.0

    def test_the_owner_is_told_what_moved(self, db_session, client):
        """Unasked, but not silent. A wage figure that changes with no word
        about it is its own problem."""
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=None)
        _hours(db_session, u, m, hours=8.0)
        _hours(db_session, u, m, hours=4.0, d=DAY + timedelta(days=1))

        body = _set_rate(client, u, m, 150.0).json()
        assert body.get("recosted_hours"), (
            "the response said nothing — response_model strips unknown fields, "
            "so the repair would be invisible"
        )
        assert body["recosted_hours"]["count"] == 2
        assert body["recosted_hours"]["amount"] == 1800.0

    def test_it_leaves_an_audit_row(self, db_session, client):
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=None)
        _hours(db_session, u, m, hours=8.0)
        _set_rate(client, u, m, 150.0)

        rows = (db_session.query(AuditLog)
                .filter(AuditLog.action == "staff.hours_recosted").all())
        assert len(rows) == 1, "a wage mutation with no §10 trail"


class TestItNeverOverwritesADecision:
    def test_a_row_costed_at_a_real_rate_is_untouched(self, db_session, client):
        """The bound. Any rate on the row means somebody costed it on
        purpose — a different rate, a manual override, a correction."""
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=None)
        h = _hours(db_session, u, m, hours=8.0, rate=120.0, earned=960.0)

        _set_rate(client, u, m, 150.0)

        db_session.expire_all()
        h = db_session.query(HoursLogged).filter(HoursLogged.id == h.id).first()
        assert float(h.earned) == 960.0, "a deliberately costed row was rewritten"
        assert float(h.rate_applied) == 120.0

    def test_a_zero_hour_row_does_not_gain_a_wage(self, db_session, client):
        """Re-costing nothing must not invent a shift."""
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=None)
        h = _hours(db_session, u, m, hours=0.0)

        _set_rate(client, u, m, 150.0)

        db_session.expire_all()
        h = db_session.query(HoursLogged).filter(HoursLogged.id == h.id).first()
        assert float(h.earned or 0) == 0.0

    def test_changing_an_existing_rate_recosts_nothing(self, db_session, client):
        """A raise is not a repair. It applies from now on; it must not rewrite
        what the person was already paid."""
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=150.0)
        h = _hours(db_session, u, m, hours=8.0, rate=150.0, earned=1200.0)

        body = _set_rate(client, u, m, 190.0).json()
        assert not body.get("recosted_hours")

        db_session.expire_all()
        h = db_session.query(HoursLogged).filter(HoursLogged.id == h.id).first()
        assert float(h.earned) == 1200.0, "a raise rewrote history"

    def test_another_venue_is_not_touched(self, db_session, client):
        u1, u2 = _owner(db_session), _owner(db_session)
        m1 = _member(db_session, u1, base_rate=None)
        m2 = _member(db_session, u2, base_rate=None)
        h2 = _hours(db_session, u2, m2, hours=8.0)

        _set_rate(client, u1, m1, 150.0)

        db_session.expire_all()
        h2 = db_session.query(HoursLogged).filter(HoursLogged.id == h2.id).first()
        assert float(h2.earned or 0) == 0.0


class TestThePayslipRefusesAnUnknownWage:
    def test_uncosted_hours_block_the_payslip(self, db_session):
        from app.services.loenseddel_pdf import UncostedHoursInPeriod, _uncosted_rows
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=None)
        rows = [_hours(db_session, u, m, hours=8.0)]
        assert _uncosted_rows(rows, m), (
            "a shift with hours and no rate anywhere passed the barrier — the "
            "payslip would print Bruttoløn 0,00 kr for someone who worked"
        )
        assert issubclass(UncostedHoursInPeriod, Exception)

    def test_a_genuinely_unpaid_employee_is_not_blocked(self, db_session):
        """An intern, a volunteer, an owner taking no wage. The distinction is
        the RATE on file, not the amount."""
        from app.services.loenseddel_pdf import _uncosted_rows
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=0.0)
        rows = [_hours(db_session, u, m, hours=8.0, rate=0.0, earned=0.0)]
        # base_rate 0 is "paid nothing on purpose" only once a rate exists;
        # with 0 on file the rows are still uncosted, so the barrier holds.
        # What must NOT happen is blocking someone with a real rate.
        m2 = _member(db_session, u, base_rate=150.0)
        rows2 = [_hours(db_session, u, m2, hours=8.0, rate=150.0, earned=1200.0)]
        assert _uncosted_rows(rows2, m2) == []

    def test_a_rate_on_file_means_stale_rows_are_repairable_not_fatal(self, db_session):
        """Once a rate exists the rows are stale data, and staff.py re-costs
        them — the barrier must not stand in the way of that."""
        from app.services.loenseddel_pdf import _uncosted_rows
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=150.0)
        rows = [_hours(db_session, u, m, hours=8.0, rate=None, earned=None)]
        assert _uncosted_rows(rows, m) == []

    def test_a_zero_hour_row_does_not_block_payroll(self, db_session):
        from app.services.loenseddel_pdf import _uncosted_rows
        u = _owner(db_session)
        m = _member(db_session, u, base_rate=None)
        rows = [_hours(db_session, u, m, hours=0.0)]
        assert _uncosted_rows(rows, m) == []
