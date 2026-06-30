"""
Clock-in geofence + live counter guards.

  • elapsed_sec is present and ≈0 the instant a worker clocks in (live counter
    seed — the staff hero ticks from this, so it starts at "0s").
  • The location lock is honest AND never wrongly locks out a present worker:
      - at the venue            → allowed
      - just past the radius but within the device's own GPS error → allowed
        (benefit of the fix's stated uncertainty)
      - genuinely far, precise fix → 403 too_far (the real gate)
      - far but a garbage-accuracy fix (>200 m) → allowed-but-flagged, never a
        hard lockout and never a blanket spoof-bypass.

Run:
  cd backend && python3 -m pytest tests/test_portal_clock_geofence.py -x -q
"""

import json
import uuid
from datetime import datetime, date
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink, HoursLogged
from app.models.user import User
from app.models.business_profile import BusinessProfile
from app.services.auth import hash_password

_db_ready.set()
_CPH = ZoneInfo("Europe/Copenhagen")
_FAKE_DATE = date(2026, 6, 30)
_NOW = {"dt": datetime(2026, 6, 30, 10, 0, tzinfo=_CPH)}

# Venue anchor (central Copenhagen) + a point ~250 m due north of it.
_VENUE = (55.67610, 12.56830)
_NEAR = (55.67700, 12.56830)   # ~100 m north → inside the 150 m fence
_FAR = (55.67835, 12.56830)    # ~250 m north → outside the 150 m fence


@pytest.fixture(autouse=True)
def _patch_clock(monkeypatch):
    from app.routers import staff_portal as sp

    monkeypatch.setattr(sp, "now_local", lambda owner: _NOW["dt"])
    monkeypatch.setattr(sp, "business_today_local", lambda owner: _FAKE_DATE)
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


def _seed(db, *, geofence=False, radius_m=150):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    if geofence:
        db.add(BusinessProfile(
            user_id=u.id,
            clock_settings_json=json.dumps({
                "enabled": True, "lat": _VENUE[0], "lng": _VENUE[1], "radius_m": radius_m,
            }),
        ))
        db.commit()
    s = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server")
    db.add(s); db.commit(); db.refresh(s)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=s.id, token="tok", active=True))
    db.commit()
    return u, s


def _open_rows(db, staff_id):
    return (
        db.query(HoursLogged)
        .filter(HoursLogged.staff_id == staff_id, HoursLogged.entry_method == "clock")
        .all()
    )


# ── Live counter ──────────────────────────────────────────────────────────

def test_elapsed_sec_present_and_near_zero_on_clock_in(client, db):
    _u, _s = _seed(db)
    r = client.post("/api/portal/tok/clock-in")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["clocked_in"] is True
    # The live-counter seed: present, an int, and ~0 right after clock-in.
    assert body["elapsed_sec"] is not None
    assert 0 <= body["elapsed_sec"] < 5
    # Not-clocked-in state still carries the key (always present).
    out = client.post("/api/portal/tok/clock-out")  # too short → discarded
    assert out.json().get("elapsed_sec") is None


# ── Geofence: honest gate, no false lockout ───────────────────────────────

def test_at_venue_is_allowed(client, db):
    _u, s = _seed(db, geofence=True)
    r = client.post("/api/portal/tok/clock-in", json={"lat": _VENUE[0], "lng": _VENUE[1], "accuracy": 12})
    assert r.status_code == 200, r.text
    assert r.json()["clocked_in"] is True
    assert _open_rows(db, s.id)[0].notes is None  # verified — no flag


def test_far_with_precise_fix_is_blocked(client, db):
    _u, s = _seed(db, geofence=True)
    r = client.post("/api/portal/tok/clock-in", json={"lat": _FAR[0], "lng": _FAR[1], "accuracy": 10})
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "too_far"
    assert detail["distance_m"] > detail["radius_m"]
    assert _open_rows(db, s.id) == []  # nothing written on a real block


def test_just_past_radius_within_accuracy_grace_is_allowed(client, db):
    # ~250 m out but the phone reports ±150 m: dist - grace = ~100 <= 150 → in.
    _u, s = _seed(db, geofence=True)
    r = client.post("/api/portal/tok/clock-in", json={"lat": _FAR[0], "lng": _FAR[1], "accuracy": 150})
    assert r.status_code == 200, r.text
    assert r.json()["clocked_in"] is True


def test_garbage_accuracy_is_flagged_not_blocked(client, db):
    # accuracy 9999 m can't be trusted → allow but flag (never a hard lockout,
    # never a blanket spoof-bypass of the fence).
    _u, s = _seed(db, geofence=True)
    r = client.post("/api/portal/tok/clock-in", json={"lat": _FAR[0], "lng": _FAR[1], "accuracy": 9999})
    assert r.status_code == 200, r.text
    assert r.json()["clocked_in"] is True
    assert _open_rows(db, s.id)[0].notes == "Location unverified"


def test_geofence_on_but_no_gps_is_flagged_not_blocked(client, db):
    _u, s = _seed(db, geofence=True)
    r = client.post("/api/portal/tok/clock-in")  # no coords at all
    assert r.status_code == 200, r.text
    assert _open_rows(db, s.id)[0].notes == "Location unverified"


_JSON = {"Content-Type": "application/json"}


def test_nan_accuracy_cannot_silently_bypass_the_fence(client, db):
    # Spoof: real far coords + accuracy=NaN. NaN is sent as a RAW body literal
    # (the real attack — std JSON encoders reject it, but Starlette's json.loads
    # accepts it). If not neutralised it makes every comparison False → a clean
    # unflagged punch from home. Must STILL block (acc→None → strict distance).
    _u, s = _seed(db, geofence=True)
    body = ('{"lat": %r, "lng": %r, "accuracy": NaN}' % (_FAR[0], _FAR[1])).encode()
    r = client.post("/api/portal/tok/clock-in", content=body, headers=_JSON)
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["error"] == "too_far"
    assert _open_rows(db, s.id) == []


def test_nan_coords_are_flagged_never_a_clean_punch(client, db):
    # Spoof: NaN coordinates (raw body). Must be treated as "no usable fix" →
    # allowed but flagged 'Location unverified', never a clean remote punch.
    _u, s = _seed(db, geofence=True)
    body = b'{"lat": NaN, "lng": NaN, "accuracy": 5}'
    r = client.post("/api/portal/tok/clock-in", content=body, headers=_JSON)
    assert r.status_code == 200, r.text
    rows = _open_rows(db, s.id)
    assert len(rows) == 1 and rows[0].notes == "Location unverified"


def test_negative_accuracy_does_not_widen_the_fence(client, db):
    # accuracy=-99999 must not become a huge grace radius; clamp to 0 → far
    # worker is still blocked.
    _u, s = _seed(db, geofence=True)
    r = client.post(
        "/api/portal/tok/clock-in",
        json={"lat": _FAR[0], "lng": _FAR[1], "accuracy": -99999},
    )
    assert r.status_code == 403, r.text
    assert _open_rows(db, s.id) == []
