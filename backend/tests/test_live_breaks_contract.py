"""Live pauses — the wire contract the staff app is tested against.

The staff app's pause tests (frontend/src/__tests__/
StaffPortalPage.liveBreaksContract.test.jsx) feed the page the bodies in ONE
shared file, frontend/src/__tests__/fixtures/liveBreaksContract.json. A stub
written by hand can assert a fiction — an error code the server never sends, a
field it never fills — and still pass. So the bodies in that file are not
hand-written: this test WRITES them by running the real endpoints, and on every
normal run replays the same scenario and requires every status and every body
to come back identical. Rename a field, change an error code or a path, and
this goes red until the file is regenerated — and then the app's test runs
against the new shape.

What the file pins, end to end:
  • the paths (no request body — server time only),
  • every clock state the pause button reads (breaks_live, on_break,
    break_since, break_started_at, break_elapsed_sec, break_minutes_so_far),
  • the end answer (break_ended, break_minutes, break_discarded),
  • the error bodies (403 breaks_off, 409 not_clocked_in, 409 not_on_break),
  • clock-out with recorded pauses (break_source, recorded_break_minutes),
  • the owner switch (POST /staff/clock-geofence with the body the app sends),
  • the PIN proof header name.

Volatile: elapsed_sec counts from the row's real created_at, so its value is
written as the pinned scenario's seconds and only its type is compared.

Regenerate (after a deliberate contract change, then re-run the app tests):
  cd backend && LIVE_BREAKS_CONTRACT_WRITE=1 python -m pytest tests/test_live_breaks_contract.py -q
"""

import json
import os
import uuid
from datetime import datetime
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
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.routers.staff_portal import pwd_context
from app.services.auth import get_current_user, hash_password

_db_ready.set()
_CPH = ZoneInfo("Europe/Copenhagen")
_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "frontend" / "src" / "__tests__" / "fixtures" / "liveBreaksContract.json"
)
_WRITE = os.getenv("LIVE_BREAKS_CONTRACT_WRITE") == "1"
_DATE = "2026-06-30"
_TOKEN = "tokcontract"
_VOLATILE = ("elapsed_sec",)
_NOW = {"dt": None}

# The app's own paths, relative to its /api base (services/portalApi.js).
_PATHS = {
    "clock": "/portal/{token}/clock",
    "clock_in": "/portal/{token}/clock-in",
    "clock_out": "/portal/{token}/clock-out",
    "break_start": "/portal/{token}/clock/break/start",
    "break_end": "/portal/{token}/clock/break/end",
    "verify_pin": "/portal/{token}/verify-pin",
    "owner_clock_settings": "/staff/clock-geofence",
    # The owner's two reads of the pauses (StaffSchedulePage ClockedInStrip,
    # StaffHoursPage rows). /staff/hours is read with ?from=&to= the day.
    "owner_clocked_in": "/staff/clocked-in",
    "owner_hours": "/staff/hours",
}

# Owner-read bodies carry ids and wall-clock stamps that differ every run; the
# file keeps exactly the fields the owner's screens read.
_OWNER_HOURS_FIELDS = ("date", "start_time", "end_time", "break_minutes", "total_hours",
                       "entry_method", "breaks", "recorded_break_minutes", "break_source")
_OWNER_STRIP_FIELDS = ("name", "since", "elapsed_min", "stale", "on_break", "break_since")

# The scenario: (name, "HH:MM:SS", method, path key, owner JSON body or None).
# Portal calls send NO body, as the app does. Owner saves send exactly what
# StaffSchedulePage's ClockGeofenceSettings sends: {enabled, breaks_live}.
_STEPS = [
    ("clock_before", "08:55:00", "GET", "clock", None),
    ("break_start_not_clocked_in", "08:56:00", "POST", "break_start", None),
    ("clock_in", "09:00:00", "POST", "clock_in", None),
    ("clock_live", "12:00:00", "GET", "clock", None),
    ("break_end_not_on_break", "12:00:05", "POST", "break_end", None),
    ("break_start", "12:00:20", "POST", "break_start", None),
    ("break_start_again", "12:03:00", "POST", "break_start", None),
    ("clock_on_break", "12:07:30", "GET", "clock", None),
    ("break_end", "12:30:05", "POST", "break_end", None),
    ("break_end_again", "12:31:00", "POST", "break_end", None),
    ("clock_after_break", "12:32:00", "GET", "clock", None),
    ("misclick_start", "14:00:10", "POST", "break_start", None),
    ("break_end_discarded", "14:00:40", "POST", "break_end", None),
    ("owner_breaks_off", "15:00:00", "POST", "owner_clock_settings", {"enabled": False, "breaks_live": False}),
    ("break_start_off", "15:00:10", "POST", "break_start", None),
    ("break_end_off", "15:00:20", "POST", "break_end", None),
    ("clock_live_off", "15:00:30", "GET", "clock", None),
    ("owner_breaks_on", "15:59:00", "POST", "owner_clock_settings", {"enabled": False, "breaks_live": True}),
    ("pause_running", "16:00:00", "POST", "break_start", None),
    ("owner_clocked_in_on_break", "16:02:00", "GET", "owner_clocked_in", None),
    ("owner_breaks_off_mid_pause", "16:05:00", "POST", "owner_clock_settings", {"enabled": False, "breaks_live": False}),
    ("clock_on_break_off", "16:10:00", "GET", "clock", None),
    ("break_end_after_off", "16:20:00", "POST", "break_end", None),
    ("owner_breaks_on_again", "16:30:00", "POST", "owner_clock_settings", {"enabled": False, "breaks_live": True}),
    # A pause never ended: clock-out ends it, and it is NOT paid against.
    ("pause_forgotten", "16:45:00", "POST", "break_start", None),
    ("clock_on_forgotten_pause", "16:50:00", "GET", "clock", None),
    ("clock_out", "17:00:00", "POST", "clock_out", None),
    ("break_start_after_out", "17:01:00", "POST", "break_start", None),
    ("clock_after_out", "17:02:00", "GET", "clock", None),
    ("owner_get", "17:03:00", "GET", "owner_clock_settings", None),
    ("owner_hours_after_out", "17:04:00", "GET", "owner_hours", None),
]


@pytest.fixture(autouse=True)
def _patch_clock(monkeypatch):
    from app.routers import staff_portal as sp
    from app.routers import staff as st
    from app.services import billing

    monkeypatch.setattr(sp, "now_local", lambda owner: _NOW["dt"])
    monkeypatch.setattr(sp, "business_today_local", lambda owner: _NOW["dt"].date())
    monkeypatch.setattr(st, "now_local", lambda owner: _NOW["dt"])
    monkeypatch.setattr(billing, "has_feature", lambda user, feature: True)
    sp.limiter.reset()
    sp.limiter.enabled = False
    yield
    sp.limiter.enabled = True
    sp.limiter.reset()
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def client_db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    s = SessionLocal()
    try:
        yield TestClient(app), s
    finally:
        s.close()
        app.dependency_overrides.clear()


def _at(hms: str) -> datetime:
    h, m, s = (int(x) for x in hms.split(":"))
    y, mo, d = (int(x) for x in _DATE.split("-"))
    return datetime(y, mo, d, h, m, s, tzinfo=_CPH)


def _seed(db, *, pin=None, token=_TOKEN):
    u = User(
        email=f"o{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    db.add(BusinessProfile(user_id=u.id, clock_settings_json=json.dumps({"breaks_live": True})))
    m = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server", base_rate=150)
    db.add(m); db.commit(); db.refresh(m)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=m.id, token=token, active=True,
                     pin_hash=pwd_context.hash(pin) if pin else None))
    db.commit()
    return u, m


def _call(client, method, key, body=None, headers=None, token=_TOKEN):
    url = "/api" + _PATHS[key].format(token=token)
    if key == "owner_hours":
        return client.get(url, params={"from": _DATE, "to": _DATE}, headers=headers or {})
    if method == "GET":
        return client.get(url, headers=headers or {})
    return client.post(url, json=body, headers=headers or {}) if body is not None \
        else client.post(url, headers=headers or {})


def _run_scenario(client):
    """Replay _STEPS against the real app → [{name, at, method, path, request, status, body}]."""
    out, clock_in_at = [], None
    for name, hms, method, key, body in _STEPS:
        _NOW["dt"] = _at(hms)
        r = _call(client, method, key, body)
        data = r.json()
        if key == "clock_in" and r.status_code == 200:
            clock_in_at = _NOW["dt"]
        # elapsed_sec counts from the row's real created_at (wall clock), so it
        # is written as the PINNED scenario's seconds; compared by type only.
        if isinstance(data, dict) and data.get("elapsed_sec") is not None and clock_in_at:
            data["elapsed_sec"] = int((_NOW["dt"] - clock_in_at).total_seconds())
        if key == "owner_hours" and isinstance(data, list):
            data = [{k: row.get(k) for k in _OWNER_HOURS_FIELDS} for row in data]
        if key == "owner_clocked_in" and isinstance(data, dict):
            data = {**data, "clocked_in": [{k: row.get(k) for k in _OWNER_STRIP_FIELDS}
                                           for row in data.get("clocked_in") or []]}
        out.append({
            "name": name, "at": f"{_DATE}T{hms}", "method": method, "path_key": key,
            "path": _PATHS[key], "request": body, "status": r.status_code, "body": data,
        })
    return out


def _fixture():
    return json.loads(_FIXTURE.read_text())


def test_the_shared_file_is_what_the_real_endpoints_answer(client_db):
    client, db = client_db
    _seed(db)
    steps = _run_scenario(client)
    if _WRITE:
        _FIXTURE.write_text(json.dumps({
            "about": (
                "Live pauses (Start pause / Slut pause): real request/response pairs WRITTEN by "
                "backend/tests/test_live_breaks_contract.py from the real endpoints (pinned clock, "
                "Europe/Copenhagen, owner setting breaks_live on at the start). That test re-runs the "
                "scenario on every run and fails on any difference; "
                "src/__tests__/StaffPortalPage.liveBreaksContract.test.jsx feeds these bodies to the "
                "staff app. Do not edit by hand — regenerate with LIVE_BREAKS_CONTRACT_WRITE=1."
            ),
            "timezone": "Europe/Copenhagen",
            "token": _TOKEN,
            "pin_header": "X-BonBox-Pin",
            "volatile": list(_VOLATILE),
            "paths": _PATHS,
            "steps": steps,
        }, indent=2, ensure_ascii=False) + "\n")
        pytest.skip("contract file written — re-run without LIVE_BREAKS_CONTRACT_WRITE")

    fx = _fixture()
    assert fx["paths"] == _PATHS, "a path moved — regenerate the contract and re-run the app tests"
    assert [s["name"] for s in fx["steps"]] == [s["name"] for s in steps]
    for want, got in zip(fx["steps"], steps):
        ctx = want["name"]
        assert got["status"] == want["status"], (ctx, got["status"], got["body"])
        assert got["request"] == want["request"], ctx
        w, g = want["body"], got["body"]
        if isinstance(w, dict) and isinstance(g, dict):
            w, g = dict(w), dict(g)
            for k in fx["volatile"]:
                if k in w or k in g:
                    assert (w.get(k) is None) == (g.get(k) is None), (ctx, k)
                    assert g.get(k) is None or isinstance(g.get(k), int), (ctx, k)
                    w.pop(k, None); g.pop(k, None)
        assert g == w, ctx


def test_the_file_says_what_the_app_relies_on(client_db):
    """Spelled out, so a regenerated file that silently drops a case the app's
    test depends on fails HERE, with a name, not as a puzzling UI test."""
    fx = _fixture()
    s = {x["name"]: x for x in fx["steps"]}
    assert fx["paths"]["break_start"] == "/portal/{token}/clock/break/start"
    assert fx["paths"]["break_end"] == "/portal/{token}/clock/break/end"
    # Portal pause calls carry no body.
    assert all(x["request"] is None for x in fx["steps"] if x["path_key"].startswith("break_"))
    # Error bodies: FastAPI's {"detail": {"error": code}}.
    assert (s["break_start_not_clocked_in"]["status"], s["break_start_not_clocked_in"]["body"]) == \
        (409, {"detail": {"error": "not_clocked_in"}})
    assert (s["break_end_not_on_break"]["status"], s["break_end_not_on_break"]["body"]) == \
        (409, {"detail": {"error": "not_on_break"}})
    assert (s["break_end_again"]["status"], s["break_end_again"]["body"]) == \
        (409, {"detail": {"error": "not_on_break"}})
    assert (s["break_start_off"]["status"], s["break_start_off"]["body"]) == \
        (403, {"detail": {"error": "breaks_off"}})
    assert (s["break_end_off"]["status"], s["break_end_off"]["body"]) == \
        (403, {"detail": {"error": "breaks_off"}})
    assert (s["break_start_after_out"]["status"], s["break_start_after_out"]["body"]) == \
        (409, {"detail": {"error": "not_clocked_in"}})
    # States.
    assert s["clock_live"]["body"]["breaks_live"] is True and s["clock_live"]["body"]["on_break"] is False
    b = s["break_start"]["body"]
    assert b["clocked_in"] is True and b["on_break"] is True and b["break_since"] == "12:00"
    assert s["break_start_again"]["status"] == 200 and s["break_start_again"]["body"]["on_break"] is True
    assert s["clock_on_break"]["body"]["break_elapsed_sec"] == 7 * 60 + 10
    e = s["break_end"]["body"]
    assert e["break_ended"] is True and e["break_minutes"] == 30 and e["on_break"] is False
    assert "break_discarded" not in e
    d = s["break_end_discarded"]["body"]
    assert d["break_ended"] is True and d["break_discarded"] is True and d["break_minutes"] == 0
    assert s["clock_live_off"]["body"]["breaks_live"] is False
    o = s["clock_on_break_off"]["body"]
    assert o["breaks_live"] is False and o["on_break"] is True
    assert s["break_end_after_off"]["status"] == 200
    co = s["clock_out"]["body"]
    assert co["clocked_in"] is False and co["break_source"] == "recorded"
    # 30 + 20 ended by the staffer; the 16:45 pause clock-out ended is not paid.
    assert co["recorded_break_minutes"] == 50 and co["worked_hours"] == round(8 - 50 / 60, 2)
    f = s["clock_on_forgotten_pause"]["body"]
    assert f["on_break"] is True and f["break_since"] == "16:45" and f["break_elapsed_sec"] == 5 * 60
    # The owner's reads.
    (strip,) = s["owner_clocked_in_on_break"]["body"]["clocked_in"]
    assert strip["on_break"] is True and strip["break_since"] == "16:00"
    (row,) = s["owner_hours_after_out"]["body"]
    assert row["break_minutes"] == 50 and row["break_source"] == "recorded"
    assert row["recorded_break_minutes"] == 50
    assert [(b["start"], b["end"], b["ended_by"], b["counted"]) for b in row["breaks"]] == [
        ("12:00", "12:30", "staff", True), ("16:00", "16:20", "staff", True),
        ("16:45", "17:00", "clock_out", False)]
    assert s["owner_get"]["body"]["breaks_live"] is True
    assert fx["pin_header"] == "X-BonBox-Pin"


def test_the_pin_header_the_app_sends_is_the_one_the_server_reads(client_db, monkeypatch):
    client, db = client_db
    monkeypatch.setenv("PORTAL_PIN_ENFORCE", "1")
    fx = _fixture()
    tok = "tokcontractpin"
    _seed(db, pin="4821", token=tok)
    _NOW["dt"] = _at("09:00:00")
    r = client.post("/api" + fx["paths"]["verify_pin"].format(token=tok), json={"pin": "4821"})
    assert r.status_code == 200, r.text
    proof = {fx["pin_header"]: r.json()["pin_proof"]}
    assert _call(client, "POST", "clock_in", headers=proof, token=tok).status_code == 200
    _NOW["dt"] = _at("12:00:00")
    assert _call(client, "POST", "break_start", token=tok).status_code == 401
    assert _call(client, "POST", "break_start", headers=proof, token=tok).status_code == 200
    _NOW["dt"] = _at("12:20:00")
    assert _call(client, "POST", "break_end", token=tok).status_code == 401
    r = _call(client, "POST", "break_end", headers=proof, token=tok)
    assert r.status_code == 200 and r.json()["break_minutes"] == 20
