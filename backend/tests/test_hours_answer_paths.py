"""The answer paths the Hours hub's testers could not finish.

Three persona testers asked to "approve last week" scored it 2–3 of 7: the
period could not be approved while one shift was open, a forgotten clock-out
could not move its start or choose its pause (16:58–23:00 paid less than a
5:59 shift because 6:03 h crossed the 45-minute line), and a shift the clock
never saw had to be answered one sheet at a time.

Locks under test:
  • POST /hours/approve still refuses an open punch by default, and with
    ``skip_open`` approves every closed row, leaves the open one unanswered,
    and says how many it skipped.
  • "clock_out" accepts a corrected start and a chosen pause — validated,
    bounded, tenant-scoped and audited — and without them behaves as before.
  • "as_planned" writes the PLANNED times and break for a shift the clock never
    saw, and refuses a day that has a row, has no plan, or has not ended.
  • The summary's exception carries the plan behind it (start/end/break) and
    a planned shift that has not ended is not a question for the owner.
  • The Oversigt cost tile is Løn's "Samlet lønomkostning" to the øre.
  • The working-time register flags a forgotten clock-out instead of
    "Overholder · 0 t", and does not flag a punch still running tonight.

Run: cd backend && python3 -m pytest tests/test_hours_answer_paths.py -q
"""

import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.staff import HoursLogged, Schedule, StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()

D1 = date(2026, 8, 3)
D2 = date(2026, 8, 4)
RANGE = {"from": str(D1), "to": str(D2)}


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


def _owner(db, act=True):
    u = User(
        email=f"o{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK", role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    if act:
        app.dependency_overrides[get_current_user] = lambda: u
    return u


def _staff(db, owner, name="Aksel", **kw):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server", base_rate=150, **kw)
    db.add(m); db.commit(); db.refresh(m)
    return m


def _row(db, owner, member, day=D1, start="08:00", end="16:00", hours=8.0, brk=0, **kw):
    h = HoursLogged(user_id=owner.id, staff_id=member.id, date=day, start_time=start,
                    end_time=end, break_minutes=brk, total_hours=hours, entry_method="clock", **kw)
    db.add(h); db.commit(); db.refresh(h)
    return h


def _sched(db, owner, member, day, start="17:00", end="23:00", brk=30, status="published"):
    db.add(Schedule(id=uuid.uuid4(), user_id=owner.id, staff_id=member.id, date=day,
                    start_time=start, end_time=end, break_minutes=brk, status=status))
    db.commit()


def _audits(db, action):
    """(before, after) dicts of every audit row for ``action``, oldest first."""
    import json
    return [
        (json.loads(a.before_state) if a.before_state else None,
         json.loads(a.after_state) if a.after_state else None)
        for a in db.query(AuditLog).filter(AuditLog.action == action).order_by(AuditLog.created_at).all()
    ]


# ── Approve: "Godkend de klare nu" ───────────────────────────────────────

def test_approve_still_refuses_an_open_punch_by_default(client, db):
    o = _owner(db); a = _staff(db, o)
    _row(db, o, a, D1)
    _row(db, o, a, D2, end=None, hours=0)
    r = client.post("/api/staff/hours/approve", json=RANGE)
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "open_punches", "count": 1}
    db.expire_all()
    assert all(h.resolution is None for h in db.query(HoursLogged).all())


def test_skip_open_approves_the_clear_rows_and_leaves_the_open_one(client, db):
    o = _owner(db); a = _staff(db, o, "Aksel"); b = _staff(db, o, "Bodil")
    closed = [_row(db, o, a, D1), _row(db, o, a, D2), _row(db, o, b, D1)]
    open_row = _row(db, o, b, D2, start="17:00", end=None, hours=0)

    r = client.post("/api/staff/hours/approve", json={**RANGE, "skip_open": True})
    assert r.status_code == 200, r.text
    assert r.json() == {"approved": 3, "already": 0, "rows": 4, "skipped_open": 1}

    db.expire_all()
    assert all(db.get(HoursLogged, h.id).resolution == "confirmed" for h in closed)
    # An hours figure nobody knows is never final.
    assert db.get(HoursLogged, open_row.id).resolution is None
    _, after = _audits(db, "staff_hours.approved")[-1]
    assert after["skip_open"] is True and after["skipped_open"] == 1

    # The open shift is still the one thing left to answer.
    summary = {x["staff_name"]: x for x in client.get("/api/staff/hours/summary", params=RANGE).json()}
    assert summary["Aksel"]["approved_count"] == 2
    assert summary["Bodil"]["approved_count"] == 1 and summary["Bodil"]["entries_count"] == 2


def test_skip_open_with_nothing_open_is_a_plain_approve(client, db):
    o = _owner(db); a = _staff(db, o)
    _row(db, o, a, D1)
    r = client.post("/api/staff/hours/approve", json={**RANGE, "skip_open": True})
    assert r.json() == {"approved": 1, "already": 0, "rows": 1, "skipped_open": 0}


# ── Forgotten clock-out: start and pause are the owner's to set ──────────

def test_clock_out_takes_a_corrected_start_and_a_chosen_pause(client, db):
    o = _owner(db); a = _staff(db, o)
    h = _row(db, o, a, D1, start="16:58", end=None, hours=0)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(a.id), "date": str(D1), "action": "clock_out",
        "start_time": "17:00", "end_time": "23:00", "break_minutes": 30,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    # 6 h gross − 30 min = 5,5 t — not 6,03 − 45 min = 5,28 t.
    assert body["total_hours"] == 5.5
    assert body["start_time"] == "17:00" and body["end_time"] == "23:00" and body["break_minutes"] == 30
    db.expire_all()
    row = db.get(HoursLogged, h.id)
    assert float(row.earned) == 825.0                     # 5,5 × 150
    # What the clock measured survives the correction.
    assert "16:58" in row.resolution_note
    before, after = _audits(db, "staff_hours.clock_out_set")[-1]
    assert before["start_time"] == "16:58"
    assert after["start_time"] == "17:00" and after["measured_start"] == "16:58"
    assert after["break_minutes"] == 30


def test_clock_out_without_the_new_fields_behaves_as_before(client, db):
    o = _owner(db); a = _staff(db, o)
    _row(db, o, a, D1, start="08:00", end=None, hours=0)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(a.id), "date": str(D1), "action": "clock_out", "end_time": "16:00"})
    assert r.status_code == 200, r.text
    # 8 h less the DK suggestion (45 min), the punch clock's own rule.
    assert r.json()["total_hours"] == 7.25 and r.json()["start_time"] == "08:00"


def test_a_zero_pause_is_a_real_answer(client, db):
    o = _owner(db); a = _staff(db, o)
    _row(db, o, a, D1, start="16:58", end=None, hours=0)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(a.id), "date": str(D1), "action": "clock_out",
        "end_time": "23:00", "break_minutes": 0})
    assert r.status_code == 200, r.text
    assert r.json()["total_hours"] == 6.03 and r.json()["break_minutes"] == 0


@pytest.mark.parametrize("extra, code", [
    ({"start_time": "25:99"}, None),                         # not a clock time
    ({"start_time": "abc"}, None),
    ({"break_minutes": -5}, "bad_break"),
    ({"break_minutes": 241}, "bad_break"),
    ({"break_minutes": 240, "end_time": "18:00"}, "break_too_long"),   # eats the shift
    ({"start_time": "23:00", "end_time": "23:00"}, "zero_length"),
])
def test_clock_out_refuses_what_is_not_a_shift(client, db, extra, code):
    o = _owner(db); a = _staff(db, o)
    h = _row(db, o, a, D1, start="17:00", end=None, hours=0)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(a.id), "date": str(D1), "action": "clock_out", "end_time": "23:00", **extra})
    assert r.status_code == 400, r.text
    if code:
        assert r.json()["detail"]["code"] == code
    db.expire_all()
    assert db.get(HoursLogged, h.id).end_time is None       # nothing half-written


def test_clock_out_never_reaches_another_venue(client, db):
    other = _owner(db, act=False); theirs = _staff(db, other, "Fremmed")
    _row(db, other, theirs, D1, start="17:00", end=None, hours=0)
    _owner(db)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(theirs.id), "date": str(D1), "action": "clock_out",
        "start_time": "17:00", "end_time": "23:00", "break_minutes": 0})
    assert r.status_code == 404


# ── "Arbejdede som planlagt" ─────────────────────────────────────────────

def test_as_planned_writes_the_planned_times_and_break(client, db):
    o = _owner(db); a = _staff(db, o)
    _sched(db, o, a, D1, "17:00", "23:00", brk=30)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(a.id), "date": str(D1), "action": "as_planned"})
    assert r.status_code == 200, r.text
    assert r.json()["total_hours"] == 5.5 and r.json()["rows"] == 1
    db.expire_all()
    row = db.query(HoursLogged).filter(HoursLogged.staff_id == a.id).one()
    assert (row.start_time, row.end_time, row.break_minutes) == ("17:00", "23:00", 30)
    assert float(row.earned) == 825.0
    # The owner's answer, and the clock's zero, both on the record.
    assert row.entry_method == "owner_resolved" and float(row.clock_hours) == 0
    assert row.resolution == "adjusted"
    assert _audits(db, "staff_hours.resolved_as_planned")
    # And the shift no longer needs an answer.
    summary = client.get("/api/staff/hours/summary", params=RANGE).json()
    assert summary[0]["needs_answer_count"] == 0


def test_as_planned_refuses_a_day_that_has_a_row(client, db):
    o = _owner(db); a = _staff(db, o)
    _sched(db, o, a, D1)
    _row(db, o, a, D1, start="17:00", end="22:00", hours=5)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(a.id), "date": str(D1), "action": "as_planned"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "already_logged"


def test_as_planned_needs_a_published_plan(client, db):
    o = _owner(db); a = _staff(db, o)
    _sched(db, o, a, D1, status="draft")
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(a.id), "date": str(D1), "action": "as_planned"})
    assert r.status_code == 404 and r.json()["detail"]["code"] == "no_plan"
    assert db.query(HoursLogged).count() == 0


def test_as_planned_refuses_a_shift_that_has_not_ended(client, db):
    o = _owner(db); a = _staff(db, o)
    future = date.today() + timedelta(days=3)
    _sched(db, o, a, future)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(a.id), "date": str(future), "action": "as_planned"})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_ended"
    assert db.query(HoursLogged).count() == 0


# ── The summary hands the sheet the plan behind each question ────────────

def test_an_exception_carries_its_plan(client, db):
    o = _owner(db); a = _staff(db, o)
    _sched(db, o, a, D1, "17:00", "23:00", brk=30)            # never clocked
    _sched(db, o, a, D2, "17:00", "23:00", brk=45)
    _row(db, o, a, D2, start="16:58", end=None, hours=0)      # never clocked out
    row = client.get("/api/staff/hours/summary", params=RANGE).json()[0]
    by_state = {e["state"]: e for e in row["exceptions"]}
    assert by_state["no_clock_in"]["scheduled_start"] == "17:00"
    assert by_state["no_clock_in"]["scheduled_break_minutes"] == 30
    forgot = by_state["forgot_clock_out"]
    assert forgot["start_time"] == "16:58" and forgot["scheduled_end"] == "23:00"
    assert forgot["scheduled_break_minutes"] == 45
    # 2 decimals: 6 h − 30 min, exactly.
    assert by_state["no_clock_in"]["scheduled_hours"] == 5.5


def test_a_shift_that_has_not_ended_is_not_a_question(client, db):
    o = _owner(db); a = _staff(db, o)
    future = date.today() + timedelta(days=3)
    _sched(db, o, a, future)
    row = client.get("/api/staff/hours/summary",
                     params={"from": str(future), "to": str(future)}).json()[0]
    assert row["needs_answer_count"] == 0 and row["exceptions"] == []
    assert row["scheduled_hours"] > 0                        # still planned


def test_on_payroll_mirrors_the_payroll_query(client, db):
    o = _owner(db)
    on = _staff(db, o, "Aktiv")
    off = _staff(db, o, "Stoppet", active=False)
    _row(db, o, on, D1); _row(db, o, off, D1)
    rows = {x["staff_name"]: x for x in client.get("/api/staff/hours/summary", params=RANGE).json()}
    assert rows["Aktiv"]["on_payroll"] is True
    assert rows["Stoppet"]["on_payroll"] is False


# ── One cost number ──────────────────────────────────────────────────────

def test_the_cost_tile_is_lon_samlet_lonomkostning(client, db):
    o = _owner(db); a = _staff(db, o, "Aksel"); b = _staff(db, o, "Bodil")
    # Enough hours that ATP is not zero, and øre that must survive.
    for i in range(20):
        _row(db, o, a, date(2026, 9, 1) + timedelta(days=i), hours=7.5, earned=1031.37)
    _row(db, o, b, date(2026, 9, 2), hours=5.25, earned=721.88)
    params = {"from": "2026-09-01", "to": "2026-09-30"}
    ov = client.get("/api/staff/hours/overview", params=params).json()
    est = client.get("/api/staff/payroll/estimate",
                     params={"period_start": "2026-09-01", "period_end": "2026-09-30"}).json()
    t = est["totals"]
    assert ov["cost"]["basis"] == "payroll"
    assert ov["cost"]["loaded_est"] == round(t["employer_total_cost"], 2)
    bd = ov["cost"]["breakdown"]
    assert bd == {
        "gross": round(t["gross"], 2), "feriepenge": round(t["feriepenge"], 2),
        "atp": round(t["atp"], 2), "total": round(t["employer_total_cost"], 2),
    }
    assert bd["atp"] > 0
    # The parts add up to the whole, to the øre.
    assert round(bd["gross"] + bd["feriepenge"] + bd["atp"], 2) == bd["total"]
    # Aggregates only: no person, no rate.
    assert "per_staff" not in str(ov["cost"]) and "hourly_rate" not in str(ov["cost"])


def test_the_cost_tile_falls_back_when_nobody_is_on_the_payroll(client, db):
    o = _owner(db); gone = _staff(db, o, "Stoppet", active=False)
    _row(db, o, gone, D1, hours=8, earned=1200)
    ov = client.get("/api/staff/hours/overview", params=RANGE).json()
    # Never a confident 0 kr. for hours that were worked.
    assert ov["cost"]["basis"] == "estimate"
    assert ov["cost"]["loaded_est"] == 1350.0


# ── Tidsregistrering: a forgotten clock-out is not "Overholder" ──────────

def test_the_register_flags_a_forgotten_clock_out(db):
    from app.services import time_registration as tr
    o = _owner(db, act=False); a = _staff(db, o)
    _row(db, o, a, D1, start="08:00", end="16:00", hours=8)
    _row(db, o, a, D2, start="17:00", end=None, hours=0)
    out = tr.employee_compliance(db, o.id, a, D1, D2, now=datetime(2026, 8, 6, 12, 0))
    assert out["status"] == "open"
    assert out["open_punch_count"] == 1
    assert out["open_punches"] == [{"date": str(D2), "start": "17:00"}]
    summary = tr.venue_compliance_summary(db, o.id, [a], D1, D2, now=datetime(2026, 8, 6, 12, 0))
    assert summary["totals"]["with_open_punches"] == 1
    assert summary["totals"]["all_compliant"] is False


def test_the_register_does_not_flag_a_shift_still_running(db):
    from app.services import time_registration as tr
    o = _owner(db, act=False); a = _staff(db, o)
    _row(db, o, a, D1, start="08:00", end="16:00", hours=8)
    _row(db, o, a, D2, start="17:00", end=None, hours=0)
    # 21:00 the same evening: four hours into the shift.
    out = tr.employee_compliance(db, o.id, a, D1, D2, now=datetime(2026, 8, 4, 21, 0))
    assert out["status"] == "ok" and out["open_punch_count"] == 0


def test_an_after_midnight_opener_is_filed_under_yesterday():
    from app.services.time_registration import open_punch_is_forgotten
    # In at 01:15 on the business day of the 3rd = 01:15 on the 4th.
    assert open_punch_is_forgotten(D1, "01:15", datetime(2026, 8, 4, 9, 0), 6) is False
    assert open_punch_is_forgotten(D1, "01:15", datetime(2026, 8, 4, 18, 0), 6) is True
