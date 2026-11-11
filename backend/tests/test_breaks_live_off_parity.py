"""Live breaks OFF = not one number moves.

"Start pause / Slut pause" (Migration 086) is an owner opt-in. A venue that
never turns it on — every venue today — must get exactly the hours, breaks,
pay and exports it got before the feature existed.

How this proves it. The golden file next to this test was WRITTEN BY THIS SAME
SCENARIO RUNNING ON THE CODE BEFORE THE FEATURE (commit c349af2a, before any
break code existed): real portal clock-ins/outs of every shape the DK break
rule cares about (under 6 h, exactly 6 h, evening, overnight, weekend, a
misclick, a forgotten clock-out the owner closes, an owner-typed row), then
every owner and staff surface that shows those hours — the hours list, the
summary, the payroll estimate and CSV, the working-time register CSV, the
portal's own hours and clock state, and the raw database rows.

Now the scenario runs again on the current code, twice: once with no clock
settings saved at all (every existing venue), once with the setting saved
explicitly OFF. Every value in the golden must come back identical. New keys
are allowed only from the short list of fields this feature adds; any other
difference — a changed number, a lost key, an extra key — fails.

Regenerate (only ever from a tree WITHOUT the feature):
  BREAKS_GOLDEN_WRITE=1 python -m pytest tests/test_breaks_live_off_parity.py -q
"""

import json
import os
import uuid
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.staff import HoursLogged, StaffLink, StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()
_CPH = ZoneInfo("Europe/Copenhagen")
_GOLDEN = Path(__file__).parent / "golden" / "breaks_live_off_parity.json"

# Fields the live-break feature ADDS to existing responses. Anything else that
# differs from the golden is a regression.
_NEW_KEYS = {
    "breaks_live", "on_break", "break_started_at", "break_minutes_so_far",
    "break_since", "break_elapsed_sec",
    "break_source", "breaks", "recorded_break_minutes",
}
# Values that change run to run (row ids, wall-clock insert stamps, the live
# seconds counter seeded from the real clock) — never part of the comparison.
_VOLATILE = {"id", "staff_id", "user_id", "created_at", "resolved_at",
             "resolved_by", "elapsed_sec", "hours_id"}

_NOW = {"dt": datetime(2026, 6, 30, 10, 0, tzinfo=_CPH), "bday": date(2026, 6, 30)}


@pytest.fixture(autouse=True)
def _patch_clock(monkeypatch):
    from app.routers import staff_portal as sp
    from app.routers import staff as st
    from app.services import billing

    monkeypatch.setattr(sp, "now_local", lambda owner: _NOW["dt"])
    monkeypatch.setattr(sp, "business_today_local", lambda owner: _NOW["bday"])
    monkeypatch.setattr(st, "now_local", lambda owner: datetime(2026, 7, 6, 12, 0, tzinfo=_CPH))
    # The register CSV and payroll exports are plan-gated; the gate is not
    # what this test is about.
    monkeypatch.setattr(billing, "has_feature", lambda user, feature: True)
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


def _norm(v):
    """Drop volatile keys, recurse, and order lists of dicts stably."""
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in sorted(v.items()) if k not in _VOLATILE}
    if isinstance(v, list):
        return [_norm(x) for x in v]
    return v


def _at(y, mo, d, h, mi, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=_CPH)


def _run_scenario(client, db, settings_saved_off: bool):
    """Every punch shape, then every surface. Returns a JSON-able dict."""
    owner = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(owner); db.commit(); db.refresh(owner)
    app.dependency_overrides[get_current_user] = lambda: owner
    db.add(BusinessProfile(user_id=owner.id)); db.commit()

    out: dict = {}
    if settings_saved_off:
        # An owner who opened the clock panel and saved with breaks off.
        r = client.post("/api/staff/clock-geofence",
                        json={"window_enabled": False, "breaks_live": False})
        assert r.status_code == 200, r.text

    names = ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10"]
    members = {}
    for i, n in enumerate(names, start=1):
        m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=n, role="server",
                        base_rate=150, evening_rate=175, weekend_rate=200)
        db.add(m); db.commit(); db.refresh(m)
        db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id,
                         token=f"tok{i:02d}", active=True))
        db.commit()
        members[n] = (m, f"tok{i:02d}")

    def punch(name, t_in, t_out, bday):
        _m, tok = members[name]
        _NOW["bday"] = bday
        _NOW["dt"] = t_in
        r_in = client.post(f"/api/portal/{tok}/clock-in")
        assert r_in.status_code == 200, r_in.text
        r_mid = client.get(f"/api/portal/{tok}/clock")
        assert r_mid.status_code == 200, r_mid.text
        _NOW["dt"] = t_out
        r_out = client.post(f"/api/portal/{tok}/clock-out")
        assert r_out.status_code == 200, r_out.text
        r_after = client.get(f"/api/portal/{tok}/clock")
        out[f"{name}.in"] = _norm(r_in.json())
        out[f"{name}.mid"] = _norm(r_mid.json())
        out[f"{name}.out"] = _norm(r_out.json())
        out[f"{name}.after"] = _norm(r_after.json())

    tue = date(2026, 6, 30)
    sat = date(2026, 7, 4)
    punch("S01", _at(2026, 6, 30, 10, 0), _at(2026, 6, 30, 10, 30), tue)      # 0.5 h
    punch("S02", _at(2026, 6, 30, 9, 0), _at(2026, 6, 30, 14, 59), tue)       # just under 6 h
    punch("S03", _at(2026, 6, 30, 9, 0), _at(2026, 6, 30, 15, 0), tue)        # exactly 6 h
    punch("S04", _at(2026, 6, 30, 16, 0), _at(2026, 6, 30, 23, 0), tue)       # evening 7 h
    punch("S05", _at(2026, 6, 30, 22, 0), _at(2026, 7, 1, 3, 30), tue)        # overnight
    punch("S06", _at(2026, 6, 30, 10, 0), _at(2026, 6, 30, 10, 0, 40), tue)   # misclick
    punch("S09", _at(2026, 7, 4, 10, 0), _at(2026, 7, 4, 18, 15), sat)        # weekend

    # S07 / S08: forgotten clock-outs the owner closes.
    for name, brk in (("S07", None), ("S08", 30)):
        _m, tok = members[name]
        _NOW["bday"] = tue
        _NOW["dt"] = _at(2026, 6, 30, 11, 0)
        assert client.post(f"/api/portal/{tok}/clock-in").status_code == 200
        body = {"staff_id": str(_m.id), "date": str(tue), "action": "clock_out",
                "end_time": "18:30"}
        if brk is not None:
            body["break_minutes"] = brk
        r = client.post("/api/staff/hours/resolve", json=body)
        assert r.status_code == 200, r.text
        out[f"{name}.resolve"] = _norm(r.json())

    # S10: an owner-typed row.
    r = client.post("/api/staff/hours", json={
        "staff_id": str(members["S10"][0].id), "date": str(tue),
        "start_time": "08:00", "end_time": "16:30", "break_minutes": 30,
        "total_hours": 8.0, "entry_method": "quick",
    })
    assert r.status_code in (200, 201), r.text
    out["S10.create"] = _norm(r.json())

    frm, to = "2026-06-29", "2026-07-05"
    by_id = {str(m.id): n for n, (m, _t) in members.items()}

    def _named(rows):
        return sorted(
            ({"who": by_id.get(str(x.get("staff_id")), "?"), **_norm(x)} for x in rows),
            key=lambda x: (x["who"], x.get("date") or "", x.get("start_time") or ""),
        )

    r = client.get(f"/api/staff/hours?from={frm}&to={to}")
    assert r.status_code == 200, r.text
    out["owner.hours"] = _named(r.json())

    r = client.get(f"/api/staff/hours/summary?from={frm}&to={to}")
    assert r.status_code == 200, r.text
    summ = r.json()
    if isinstance(summ, list):
        summ = _named(summ)
    out["owner.summary"] = _norm(summ)

    r = client.get(f"/api/staff/payroll/estimate?period_start={frm}&period_end={to}")
    out["owner.payroll_estimate.status"] = r.status_code
    if r.status_code == 200:
        est = r.json()
        out["owner.payroll_estimate"] = _norm(est)

    r = client.get(f"/api/staff/payroll/csv?period_start={frm}&period_end={to}")
    out["owner.payroll_csv.status"] = r.status_code
    if r.status_code == 200:
        out["owner.payroll_csv"] = r.content.decode("utf-8-sig").splitlines()

    r = client.get(f"/api/staff/time-registration/export.csv?from={frm}&to={to}")
    out["owner.register_csv.status"] = r.status_code
    if r.status_code == 200:
        out["owner.register_csv"] = r.content.decode("utf-8-sig").splitlines()

    for name in ("S03", "S05", "S07"):
        _m, tok = members[name]
        r = client.get(f"/api/portal/{tok}/hours?from={frm}&to={to}")
        out[f"{name}.portal_hours.status"] = r.status_code
        if r.status_code == 200:
            out[f"{name}.portal_hours"] = _norm(r.json())

    rows = db.query(HoursLogged).all()
    db_rows = []
    for h in rows:
        db.refresh(h)
        db_rows.append({
            "who": by_id[str(h.staff_id)], "date": h.date.isoformat(),
            "start_time": h.start_time, "end_time": h.end_time,
            "break_minutes": h.break_minutes,
            "total_hours": float(h.total_hours) if h.total_hours is not None else None,
            "rate_applied": float(h.rate_applied) if h.rate_applied is not None else None,
            "earned": float(h.earned) if h.earned is not None else None,
            "clock_hours": float(h.clock_hours) if h.clock_hours is not None else None,
            "entry_method": h.entry_method, "notes": h.notes,
            "resolution": h.resolution, "resolution_note": h.resolution_note,
        })
    out["db.hours_logged"] = sorted(db_rows, key=lambda x: (x["who"], x["date"], x["start_time"] or ""))
    return out


def _diff(golden, current, path="$"):
    """Every place `current` departs from `golden`, except allowed new keys."""
    problems = []
    if isinstance(golden, dict) and isinstance(current, dict):
        for k, gv in golden.items():
            if k not in current:
                problems.append(f"{path}.{k}: missing")
            else:
                problems += _diff(gv, current[k], f"{path}.{k}")
        for k in current:
            if k not in golden and k not in _NEW_KEYS:
                problems.append(f"{path}.{k}: unexpected new key")
        return problems
    if isinstance(golden, list) and isinstance(current, list):
        if len(golden) != len(current):
            return [f"{path}: length {len(golden)} -> {len(current)}"]
        for i, (g, c) in enumerate(zip(golden, current)):
            problems += _diff(g, c, f"{path}[{i}]")
        return problems
    if golden != current:
        return [f"{path}: {golden!r} -> {current!r}"]
    return []


def _new_key_values(current, acc=None):
    """Collect the values of the feature's new keys wherever they appear."""
    acc = {} if acc is None else acc
    if isinstance(current, dict):
        for k, v in current.items():
            if k in _NEW_KEYS:
                acc.setdefault(k, []).append(v)
            _new_key_values(v, acc)
    elif isinstance(current, list):
        for x in current:
            _new_key_values(x, acc)
    return acc


@pytest.mark.parametrize("settings_saved_off", [False, True], ids=["never-set", "saved-off"])
def test_breaks_off_changes_no_number(client, db, settings_saved_off):
    current = _run_scenario(client, db, settings_saved_off)
    if os.getenv("BREAKS_GOLDEN_WRITE") == "1":
        _GOLDEN.parent.mkdir(exist_ok=True)
        if not settings_saved_off:
            _GOLDEN.write_text(json.dumps(current, indent=1, sort_keys=True, ensure_ascii=False))
        else:
            # Pre-feature, an explicit "breaks_live": false is an unknown key
            # the settings save ignores — so both runs must already agree.
            assert _diff(json.loads(_GOLDEN.read_text()), current) == []
        return
    golden = json.loads(_GOLDEN.read_text())
    problems = _diff(golden, current)
    assert problems == [], "\n".join(problems[:40])
    # And where the new keys do appear, they say "off / nothing recorded".
    seen = _new_key_values(current)
    assert all(v is False for v in seen.get("breaks_live", [])), seen.get("breaks_live")
    assert all(v is False for v in seen.get("on_break", [])), seen.get("on_break")
    assert all(v is None for v in seen.get("break_started_at", []))
    assert all(v is None for v in seen.get("break_since", []))
    assert all(v is None for v in seen.get("break_elapsed_sec", []))
    assert all(v in (None, 0) for v in seen.get("break_minutes_so_far", []))
    assert all(v in (None, 0) for v in seen.get("recorded_break_minutes", []))
    assert all(v in (None, []) for v in seen.get("breaks", []))
    assert all(v is None for v in seen.get("break_source", []))


def test_golden_covers_the_shapes_that_matter():
    """Guard the guard: the golden must actually contain the DK break cases,
    or a regenerated empty file would make the parity test vacuous."""
    g = json.loads(_GOLDEN.read_text())
    rows = {r["who"]: r for r in g["db.hours_logged"]}
    assert rows["S02"]["break_minutes"] == 0          # 5:59 → no pause
    assert rows["S03"]["break_minutes"] == 45         # 6:00 → DK pause
    assert rows["S03"]["total_hours"] == 5.25
    assert rows["S04"]["total_hours"] == 6.25         # evening 7 h − 45
    assert rows["S05"]["end_time"] == "03:30"         # overnight kept
    assert "S06" not in rows                          # misclick discarded
    assert rows["S07"]["entry_method"] == "owner_resolved"
    assert rows["S08"]["break_minutes"] == 30
    assert rows["S09"]["rate_applied"] == 200.0       # weekend rate
    assert g["owner.register_csv.status"] == 200
    assert g["owner.payroll_csv.status"] == 200
