"""Live pauses — "Start pause" / "Slut pause" (Migration 086).

Owner opt-in (clock settings → breaks_live). What this pins, payroll first:

  1. Hours math. Setting ON + recorded pauses: net = clock span − recorded
     minutes, and that number replaces the DK suggestion on break_minutes, so
     the hours list, register CSV and payroll CSV all show it. ON with nothing
     recorded, or OFF (even with pauses recorded earlier): the DK suggestion,
     exactly as before. (The no-change proof for venues that never turn it on
     is tests/test_breaks_live_off_parity.py, against a pre-feature golden.)
  2. Clocking out mid-pause ends the pause AT the clock-out.
  3. The endpoints: off → 403, not clocked in → 409, double start is
     idempotent, end without start → 409, a racing second start cannot open a
     second pause (database index), PIN-protected links need the proof.
  4. Server time only — nothing the phone sends is read.
  5. The owner's forgotten-clock-out fix, delete, live strip and settings.
  6. Migration 086 on SQLite (create_all + the mirror), and the PG statements.

Run:
  cd backend && python -m pytest tests/test_portal_live_breaks.py -q
"""

import json
import uuid
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect as sa_inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.staff import HoursBreak, HoursLogged, StaffLink, StaffMember
from app.models.user import User
from app.routers.staff_portal import pwd_context
from app.services.auth import get_current_user, hash_password

_db_ready.set()
_CPH = ZoneInfo("Europe/Copenhagen")
TUE = date(2026, 6, 30)
_NOW = {"dt": datetime(2026, 6, 30, 9, 0, tzinfo=_CPH), "bday": TUE}


@pytest.fixture(autouse=True)
def _patch_clock(monkeypatch):
    from app.routers import staff_portal as sp
    from app.routers import staff as st
    from app.services import billing

    monkeypatch.setattr(sp, "now_local", lambda owner: _NOW["dt"])
    monkeypatch.setattr(sp, "business_today_local", lambda owner: _NOW["bday"])
    monkeypatch.setattr(st, "now_local", lambda owner: _NOW["dt"])
    monkeypatch.setattr(billing, "has_feature", lambda user, feature: True)
    sp.limiter.reset()
    yield
    sp.limiter.reset()
    app.dependency_overrides.pop(get_current_user, None)


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


def _at(h, m, s=0, d=TUE):
    return datetime(d.year, d.month, d.day, h, m, s, tzinfo=_CPH)


def _seed(db, *, live=True, pin=None, token="tok"):
    u = User(
        email=f"o{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    db.add(BusinessProfile(
        user_id=u.id,
        clock_settings_json=json.dumps({"breaks_live": True}) if live else None,
    ))
    m = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server", base_rate=150)
    db.add(m); db.commit(); db.refresh(m)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=m.id, token=token, active=True,
                     pin_hash=pwd_context.hash(pin) if pin else None))
    db.commit()
    return u, m


def _set_live(client, on: bool):
    r = client.post("/api/staff/clock-geofence", json={"breaks_live": on})
    assert r.status_code == 200, r.text
    assert r.json()["breaks_live"] is on


def _post(client, path, at, token="tok", **kw):
    _NOW["dt"] = at
    return client.post(f"/api/portal/{token}/{path}", **kw)


def _row(db, m):
    rows = db.query(HoursLogged).filter(HoursLogged.staff_id == m.id).all()
    assert len(rows) == 1, rows
    db.refresh(rows[0])
    return rows[0]


def _breaks(db, m):
    db.expire_all()
    return db.query(HoursBreak).filter(HoursBreak.staff_id == m.id).order_by(HoursBreak.started_at).all()


def _shift(client, at_in, pauses, at_out, token="tok"):
    """Clock in, take each (start, end) pause, clock out → clock-out JSON."""
    assert _post(client, "clock-in", at_in, token).status_code == 200
    for s, e in pauses:
        assert _post(client, "clock/break/start", s, token).status_code == 200
        if e is not None:
            assert _post(client, "clock/break/end", e, token).status_code == 200
    r = _post(client, "clock-out", at_out, token)
    assert r.status_code == 200, r.text
    return r.json()


# ── 1. hours math ─────────────────────────────────────────────────────────

def test_recorded_pause_replaces_the_dk_suggestion(client, db):
    _u, m = _seed(db)
    out = _shift(client, _at(9, 0), [(_at(12, 0, 20), _at(12, 30, 5))], _at(17, 0))
    row = _row(db, m)
    # 8 h span − 30 recorded (not the DK 45) = 7.5 h, paid at 150.
    assert row.break_minutes == 30
    assert float(row.total_hours) == 7.5
    assert float(row.earned) == 1125.0
    assert out["worked_hours"] == 7.5
    assert out["break_source"] == "recorded" and out["recorded_break_minutes"] == 30
    (b,) = _breaks(db, m)
    assert (b.start_time, b.end_time, b.minutes, b.ended_by, b.applied) == ("12:00", "12:30", 30, "staff", True)


def test_several_pauses_add_up(client, db):
    _u, m = _seed(db)
    _shift(client, _at(9, 0),
           [(_at(10, 0), _at(10, 15)), (_at(13, 0), _at(13, 20))], _at(17, 0))
    row = _row(db, m)
    assert row.break_minutes == 35
    assert float(row.total_hours) == round(8 - 35 / 60, 2)   # 7.42


def test_recorded_pause_counts_on_a_short_shift_too(client, db):
    """Under 6 h the DK rule deducts nothing; a pause the staffer actually
    took is still a pause."""
    _u, m = _seed(db)
    _shift(client, _at(9, 0), [(_at(11, 0), _at(11, 10))], _at(13, 0))
    row = _row(db, m)
    assert (row.break_minutes, float(row.total_hours)) == (10, round(4 - 10 / 60, 2))


def test_on_but_nothing_recorded_keeps_the_dk_rule_exactly(client, db):
    _u, m = _seed(db)
    out = _shift(client, _at(9, 0), [], _at(17, 0))
    row = _row(db, m)
    assert (row.break_minutes, float(row.total_hours)) == (45, 7.25)
    assert out["break_source"] is None and out["recorded_break_minutes"] is None


def test_switched_off_before_clock_out_keeps_the_dk_rule(client, db):
    _u, m = _seed(db)
    assert _post(client, "clock-in", _at(9, 0)).status_code == 200
    assert _post(client, "clock/break/start", _at(12, 0)).status_code == 200
    assert _post(client, "clock/break/end", _at(12, 20)).status_code == 200
    _set_live(client, False)
    out = _post(client, "clock-out", _at(17, 0)).json()
    row = _row(db, m)
    assert (row.break_minutes, float(row.total_hours)) == (45, 7.25)   # DK, not 20
    assert out["break_source"] is None
    (b,) = _breaks(db, m)
    assert b.minutes == 20 and b.applied is False                   # kept as evidence, not counted
    # The owner sees the pause, and is NOT told the paid break is "recorded".
    h = client.get("/api/staff/hours?from=2026-06-30&to=2026-06-30").json()[0]
    assert h["breaks"][0]["minutes"] == 20 and h["breaks"][0]["counted"] is False
    assert h["recorded_break_minutes"] == 20 and h["break_source"] is None


def test_overnight_shift_with_a_pause_after_midnight(client, db):
    _u, m = _seed(db)
    nxt = date(2026, 7, 1)
    _shift(client, _at(22, 0), [(_at(1, 0, d=nxt), _at(1, 30, d=nxt))], _at(4, 0, d=nxt))
    row = _row(db, m)
    assert (row.start_time, row.end_time) == ("22:00", "04:00")
    assert (row.break_minutes, float(row.total_hours)) == (30, 5.5)


def test_minutes_are_the_stamps_the_owner_reads(client, db):
    """12:00:59 → 12:30:00 reads "12:00–12:30" and counts 30, never 29."""
    _u, m = _seed(db)
    _shift(client, _at(9, 0), [(_at(12, 0, 59), _at(12, 30, 0))], _at(17, 0))
    (b,) = _breaks(db, m)
    assert (b.start_time, b.end_time, b.minutes) == ("12:00", "12:30", 30)


# ── 2. clock-out during a pause ───────────────────────────────────────────

def test_clock_out_mid_pause_ends_the_pause_at_clock_out(client, db):
    _u, m = _seed(db)
    out = _shift(client, _at(9, 0), [(_at(16, 0), None)], _at(17, 0))
    (b,) = _breaks(db, m)
    assert (b.end_time, b.minutes, b.ended_by) == ("17:00", 60, "clock_out")
    row = _row(db, m)
    assert (row.break_minutes, float(row.total_hours)) == (60, 7.0)
    assert out["on_break"] is False and out["clocked_in"] is False


def test_clock_out_mid_pause_with_setting_off_still_ends_it_but_pays_dk(client, db):
    _u, m = _seed(db)
    assert _post(client, "clock-in", _at(9, 0)).status_code == 200
    assert _post(client, "clock/break/start", _at(16, 0)).status_code == 200
    _set_live(client, False)
    _post(client, "clock-out", _at(17, 0))
    (b,) = _breaks(db, m)
    assert b.ended_at is not None and b.ended_by == "clock_out" and b.applied is False
    assert _row(db, m).break_minutes == 45


def test_misclick_clock_out_discards_the_punch_and_its_pause(client, db):
    _u, m = _seed(db)
    assert _post(client, "clock-in", _at(9, 0)).status_code == 200
    assert _post(client, "clock/break/start", _at(9, 0, 20)).status_code == 200
    r = _post(client, "clock-out", _at(9, 0, 50))
    assert r.json()["discarded"] is True
    assert db.query(HoursLogged).count() == 0
    assert _breaks(db, m) == []


# ── 3. the endpoints ──────────────────────────────────────────────────────

def test_off_refuses_both(client, db):
    _u, m = _seed(db, live=False)
    assert _post(client, "clock-in", _at(9, 0)).status_code == 200
    r = _post(client, "clock/break/start", _at(12, 0))
    assert r.status_code == 403 and r.json()["detail"]["error"] == "breaks_off"
    r = _post(client, "clock/break/end", _at(12, 30))
    assert r.status_code == 403 and r.json()["detail"]["error"] == "breaks_off"
    assert _breaks(db, m) == []
    c = client.get("/api/portal/tok/clock").json()
    assert c["breaks_live"] is False and c["on_break"] is False


def test_not_clocked_in(client, db):
    _seed(db)
    r = _post(client, "clock/break/start", _at(12, 0))
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_clocked_in"
    r = _post(client, "clock/break/end", _at(12, 0))
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_clocked_in"
    c = client.get("/api/portal/tok/clock").json()
    assert c["breaks_live"] is True and c["on_break"] is False and c["break_minutes_so_far"] == 0


def test_double_start_is_idempotent(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    a = _post(client, "clock/break/start", _at(12, 0)).json()
    b = _post(client, "clock/break/start", _at(12, 3))
    assert b.status_code == 200
    assert b.json()["on_break"] is True
    assert b.json()["break_started_at"] == a["break_started_at"]
    assert len(_breaks(db, m)) == 1


def test_end_without_start_and_double_end(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    r = _post(client, "clock/break/end", _at(12, 0))
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_on_break"
    _post(client, "clock/break/start", _at(12, 0))
    first = _post(client, "clock/break/end", _at(12, 25))
    assert first.status_code == 200
    assert first.json()["break_ended"] is True and first.json()["break_minutes"] == 25
    again = _post(client, "clock/break/end", _at(12, 26))
    assert again.status_code == 409 and again.json()["detail"]["error"] == "not_on_break"
    (b,) = _breaks(db, m)
    assert b.minutes == 25 and b.end_time == "12:25"   # the second tap changed nothing


def test_racing_second_start_cannot_open_a_second_pause(client, db, monkeypatch):
    """Both taps' "already on a pause?" checks miss each other, exactly as in a
    race — the unique index refuses the second, and it still answers 200."""
    from app.services import live_breaks as lb

    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    assert _post(client, "clock/break/start", _at(12, 0)).status_code == 200
    monkeypatch.setattr(lb, "open_break", lambda db, hours_id, for_update=False: None)
    r = _post(client, "clock/break/start", _at(12, 1))
    assert r.status_code == 200, r.text
    monkeypatch.undo()
    assert len(_breaks(db, m)) == 1


def test_a_running_pause_can_be_ended_after_the_owner_switched_off(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock/break/start", _at(12, 0))
    _set_live(client, False)
    c = client.get("/api/portal/tok/clock").json()
    assert c["breaks_live"] is False and c["on_break"] is True   # visible, so it can be ended
    r = _post(client, "clock/break/end", _at(12, 30))
    assert r.status_code == 200 and r.json()["break_minutes"] == 30
    # …but a new one cannot start.
    r = _post(client, "clock/break/start", _at(13, 0))
    assert r.status_code == 403


def test_misclick_pause_is_discarded(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock/break/start", _at(12, 0, 10))
    r = _post(client, "clock/break/end", _at(12, 0, 40)).json()
    assert r["break_discarded"] is True and r["break_minutes"] == 0
    assert _breaks(db, m) == []
    _post(client, "clock-out", _at(17, 0))
    assert _row(db, m).break_minutes == 45   # nothing recorded → DK rule


def test_clock_state_while_on_a_pause(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock/break/start", _at(10, 0))
    _post(client, "clock/break/end", _at(10, 10))
    _post(client, "clock/break/start", _at(12, 0, 0))
    _NOW["dt"] = _at(12, 7, 30)
    c = client.get("/api/portal/tok/clock").json()
    assert c["clocked_in"] is True and c["breaks_live"] is True and c["on_break"] is True
    assert c["break_since"] == "12:00"
    assert c["break_started_at"] == "2026-06-30T10:00:00Z"   # 12:00 CEST in UTC
    assert c["break_elapsed_sec"] == 450
    assert c["break_minutes_so_far"] == 10 + 7


def test_pin_protected_link_needs_the_proof(client, db, monkeypatch):
    from app.routers import staff_portal as sp

    monkeypatch.setenv("PORTAL_PIN_ENFORCE", "1")
    sp.limiter.enabled = False
    try:
        _u, m = _seed(db, pin="4821", token="tokP")
        r = client.post("/api/portal/tokP/verify-pin", json={"pin": "4821"})
        assert r.status_code == 200, r.text
        proof = {"X-BonBox-Pin": r.json()["pin_proof"]}
        assert _post(client, "clock-in", _at(9, 0), "tokP", headers=proof).status_code == 200
        assert _post(client, "clock/break/start", _at(12, 0), "tokP").status_code == 401
        assert _post(client, "clock/break/start", _at(12, 0), "tokP",
                     headers={"X-BonBox-Pin": "forged"}).status_code == 401
        assert _breaks(db, m) == []
        assert _post(client, "clock/break/start", _at(12, 0), "tokP", headers=proof).status_code == 200
        assert _post(client, "clock/break/end", _at(12, 30), "tokP").status_code == 401
        assert _post(client, "clock/break/end", _at(12, 30), "tokP", headers=proof).status_code == 200
    finally:
        sp.limiter.enabled = True


def test_unknown_or_revoked_token_is_404(client, db):
    _u, m = _seed(db)
    assert _post(client, "clock/break/start", _at(12, 0), "nope").status_code == 404
    link = db.query(StaffLink).filter(StaffLink.staff_id == m.id).first()
    link.active = False
    db.commit()
    assert _post(client, "clock/break/start", _at(12, 0)).status_code == 404


def test_server_time_only(client, db):
    """The endpoints take no body; whatever the phone sends is ignored."""
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock/break/start", _at(12, 0),
          json={"started_at": "2026-06-30T08:00:00Z", "start_time": "08:00", "minutes": 300})
    _post(client, "clock/break/end", _at(12, 15), json={"end_time": "18:00", "minutes": 1})
    (b,) = _breaks(db, m)
    assert (b.start_time, b.end_time, b.minutes) == ("12:00", "12:15", 15)


def test_pause_is_scoped_to_the_staffer(client, db):
    """One staffer's pause never shows on, or is ended by, another's link."""
    u, a = _seed(db)
    b = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Bo", role="server")
    db.add(b); db.commit()
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=b.id, token="tokB", active=True))
    db.commit()
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock-in", _at(9, 0), "tokB")
    _post(client, "clock/break/start", _at(12, 0))
    assert client.get("/api/portal/tokB/clock").json()["on_break"] is False
    r = _post(client, "clock/break/end", _at(12, 30), "tokB")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_on_break"
    assert client.get("/api/portal/tok/clock").json()["on_break"] is True


def test_break_audit_trail(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock/break/start", _at(12, 0))
    _post(client, "clock/break/end", _at(12, 30))
    actions = {a.action for a in db.query(AuditLog).all()}
    assert {"staff.portal.break_start", "staff.portal.break_end"} <= actions


# ── 5. owner side ─────────────────────────────────────────────────────────

def test_owner_views_and_exports_show_the_recorded_pause(client, db):
    _u, m = _seed(db)
    _shift(client, _at(9, 0), [(_at(12, 0), _at(12, 30))], _at(17, 0))
    h = client.get("/api/staff/hours?from=2026-06-30&to=2026-06-30").json()
    assert len(h) == 1
    assert h[0]["break_minutes"] == 30 and h[0]["total_hours"] == 7.5
    assert h[0]["breaks"] == [{"start": "12:00", "end": "12:30", "minutes": 30,
                               "ended_by": "staff", "counted": True}]
    assert h[0]["recorded_break_minutes"] == 30 and h[0]["break_source"] == "recorded"

    csv = client.get("/api/staff/time-registration/export.csv?from=2026-06-30&to=2026-06-30")
    assert csv.status_code == 200
    lines = csv.content.decode("utf-8-sig").splitlines()
    assert lines[1] == "Agnes;2026-06-30;09:00;17:00;30;7,50;Stempelur"

    pay = client.get("/api/staff/payroll/csv?period_start=2026-06-30&period_end=2026-06-30")
    assert pay.status_code == 200
    row = pay.content.decode("utf-8-sig").splitlines()[1].split(";")
    assert row[3] == "7,50" and row[4] == "1125,00"


def test_owner_edit_of_the_break_is_no_longer_called_recorded(client, db):
    _u, m = _seed(db)
    _shift(client, _at(9, 0), [(_at(12, 0), _at(12, 30))], _at(17, 0))
    rid = _row(db, m).id
    # (A break-only PUT does not recompute total_hours — existing behaviour,
    # not this feature's; the owner's edit sends the times with it.)
    r = client.put(f"/api/staff/hours/{rid}",
                   json={"start_time": "09:00", "end_time": "17:00", "break_minutes": 45})
    assert r.status_code == 200, r.text
    # The PUT response itself still carries the pauses (a client swaps it in).
    assert r.json()["breaks"][0]["minutes"] == 30 and r.json()["break_source"] is None
    h = client.get("/api/staff/hours?from=2026-06-30&to=2026-06-30").json()[0]
    assert h["break_minutes"] == 45 and h["total_hours"] == 7.25
    assert h["recorded_break_minutes"] == 30 and h["break_source"] is None


def test_owner_forgotten_clock_out_uses_ended_recorded_pauses(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock/break/start", _at(12, 0))
    _post(client, "clock/break/end", _at(12, 20))
    _NOW["dt"] = _at(20, 0)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(m.id), "date": str(TUE), "action": "clock_out", "end_time": "17:00"})
    assert r.status_code == 200, r.text
    assert r.json()["break_minutes"] == 20 and r.json()["total_hours"] == round(8 - 20 / 60, 2)
    assert _breaks(db, m)[0].applied is True


def test_owner_forgotten_clock_out_with_a_pause_still_running_keeps_dk(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock/break/start", _at(12, 0))
    _NOW["dt"] = _at(20, 0)
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(m.id), "date": str(TUE), "action": "clock_out", "end_time": "17:00"})
    assert r.status_code == 200, r.text
    assert r.json()["break_minutes"] == 45                 # end unknown → no guess
    (b,) = _breaks(db, m)
    assert b.ended_at is None                               # shown to the owner as open
    h = client.get("/api/staff/hours?from=2026-06-30&to=2026-06-30").json()[0]
    assert h["breaks"][0]["end"] is None and h["recorded_break_minutes"] is None


def test_owner_forgotten_clock_out_owner_break_wins(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock/break/start", _at(12, 0))
    _post(client, "clock/break/end", _at(12, 20))
    r = client.post("/api/staff/hours/resolve", json={
        "staff_id": str(m.id), "date": str(TUE), "action": "clock_out",
        "end_time": "17:00", "break_minutes": 30})
    assert r.json()["break_minutes"] == 30


def test_owner_delete_takes_the_pauses(client, db):
    _u, m = _seed(db)
    _shift(client, _at(9, 0), [(_at(12, 0), _at(12, 30))], _at(17, 0))
    rid = _row(db, m).id
    assert client.delete(f"/api/staff/hours/{rid}").status_code == 204
    assert _breaks(db, m) == []


def test_owner_live_strip_shows_who_is_on_a_pause(client, db):
    _u, m = _seed(db)
    _post(client, "clock-in", _at(9, 0))
    _post(client, "clock/break/start", _at(12, 0))
    _NOW["dt"] = _at(12, 5)
    s = client.get("/api/staff/clocked-in").json()["clocked_in"][0]
    assert s["on_break"] is True and s["break_since"] == "12:00"
    _post(client, "clock/break/end", _at(12, 10))
    s = client.get("/api/staff/clocked-in").json()["clocked_in"][0]
    assert s["on_break"] is False and s["break_since"] is None


def test_setting_round_trip_survives_other_saves_and_is_audited(client, db):
    _u, m = _seed(db, live=False)
    assert client.get("/api/staff/clock-geofence").json()["breaks_live"] is False
    _set_live(client, True)
    assert client.get("/api/portal/tok/clock").json()["breaks_live"] is True
    # The existing panel saves without the field: it must not switch it off.
    r = client.post("/api/staff/clock-geofence", json={"window_enabled": True, "window_minutes": 15})
    assert r.status_code == 200 and r.json()["breaks_live"] is True
    assert client.get("/api/staff/clock-geofence").json()["breaks_live"] is True
    _set_live(client, False)
    trail = [a for a in db.query(AuditLog).all() if a.action == "staff.clock_settings.breaks_live"]
    assert len(trail) == 2


def test_garbage_settings_blob_fails_closed(client, db):
    from app.services.live_breaks import breaks_live_from_settings as f

    for raw in (None, "", "{not json", "[1, 2]", "true", json.dumps({"breaks_live": 0}),
                json.dumps({"breaks_live": None}), json.dumps({"enabled": True})):
        assert f(raw) is False, raw
    assert f(json.dumps({"breaks_live": True})) is True
    # End to end. (A JSON list is left out here: the pre-existing geofence
    # reader on clock-in does not survive one either — not this feature's.)
    u, m = _seed(db, live=False)
    p = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first()
    for raw in ("{not json", json.dumps({"breaks_live": 0}), ""):
        p.clock_settings_json = raw
        db.commit()
        _post(client, "clock-in", _at(9, 0))
        assert _post(client, "clock/break/start", _at(12, 0)).status_code == 403
        _post(client, "clock-out", _at(17, 0))
        db.query(HoursLogged).delete(); db.commit()


# ── 6. migration 086 ──────────────────────────────────────────────────────

def test_migration_086_on_sqlite_dev_db(tmp_path, monkeypatch):
    """An existing dev db from before the feature: boot builds the table and
    the indexes, twice is harmless, the running-pause index holds, and the
    drift guard finds nothing."""
    import app.main as main

    eng = create_engine(f"sqlite:///{tmp_path / 'dev.db'}")
    old = [t for t in Base.metadata.sorted_tables if t.name != "hours_breaks"]
    Base.metadata.create_all(eng, tables=old)
    assert "hours_breaks" not in sa_inspect(eng).get_table_names()

    monkeypatch.setattr(main, "engine", eng)
    for _ in range(2):                       # boot twice — idempotent
        Base.metadata.create_all(bind=eng)
        main._run_migrations()

    insp = sa_inspect(eng)
    cols = {c["name"] for c in insp.get_columns("hours_breaks")}
    assert cols == {"id", "user_id", "staff_id", "hours_id", "started_at", "ended_at",
                    "start_time", "end_time", "minutes", "ended_by", "applied", "created_at"}
    idx = {i["name"]: i for i in insp.get_indexes("hours_breaks")}
    assert {"ix_hours_breaks_hours", "ix_hours_breaks_user_staff", "ux_hours_breaks_open"} <= set(idx)
    assert idx["ux_hours_breaks_open"]["unique"]

    with eng.begin() as c:
        sql = c.execute(text(
            "SELECT sql FROM sqlite_master WHERE name = 'ux_hours_breaks_open'")).scalar()
    assert "WHERE ended_at IS NULL" in sql

    def _ins(c, ended):
        c.execute(text(
            "INSERT INTO hours_breaks (id, user_id, staff_id, hours_id, started_at, ended_at, "
            "start_time, applied, created_at) "
            "VALUES (:id, 'u', 's', 'h1', '2026-06-30 10:00:00', :e, '12:00', 0, '2026-06-30 10:00:00')"),
            {"id": uuid.uuid4().hex, "e": ended})

    with eng.begin() as c:
        _ins(c, "2026-06-30 10:30:00")       # an ended pause
        _ins(c, None)                         # one running pause
    with pytest.raises(IntegrityError):
        with eng.begin() as c:
            _ins(c, None)                     # a second running pause on the same punch

    with eng.connect() as c:
        main._verify_schema_no_drift(c, strict=True)   # raises on drift


def test_migration_086_pg_statements():
    """The Postgres net: create_all-bypassed restore builds the same table,
    the partial unique index, and the runner skips them once present."""
    import app.main as main

    stmts = [" ".join(s.split()) for s in main._migrations]
    create = next(s for s in stmts if s.startswith("CREATE TABLE IF NOT EXISTS hours_breaks"))
    for frag in ("hours_id VARCHAR(36) NOT NULL REFERENCES hours_logged(id) ON DELETE CASCADE",
                 "user_id VARCHAR(36) NOT NULL REFERENCES users(id)",
                 "applied BOOLEAN NOT NULL DEFAULT FALSE"):
        assert frag in create
    # Nullability matches what create_all builds from the model, column by
    # column, so a restore through this net is the same schema.
    for col in HoursBreak.__table__.columns:
        decl = next(p.strip() for p in create.split("(", 1)[1].split(",")
                    if p.strip().startswith(col.name + " "))
        assert ("NOT NULL" in decl or "PRIMARY KEY" in decl) == (not col.nullable), (col.name, decl)
    assert ("CREATE UNIQUE INDEX IF NOT EXISTS ux_hours_breaks_open ON hours_breaks (hours_id) "
            "WHERE ended_at IS NULL") in stmts
    present = {"rels": {"hours_breaks", "ux_hours_breaks_open", "ix_hours_breaks_hours",
                        "ix_hours_breaks_user_staff"}, "cols": set(), "cons": set()}
    for s in stmts:
        if "hours_breaks" in s:
            assert main._migration_already_applied(s, present), s
    # And the model declares the same partial index, so create_all emits it.
    ix = {i.name: i for i in HoursBreak.__table__.indexes}
    assert ix["ux_hours_breaks_open"].unique
    fk = next(iter(HoursBreak.__table__.c.hours_id.foreign_keys))
    assert fk.ondelete == "CASCADE"
