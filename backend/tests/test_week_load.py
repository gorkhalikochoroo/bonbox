"""Vagtplan Shield — GET /api/staff/schedules/week-load.

Pins the surfacing signals for the manual scheduling path:
  • weekly hours per staff (draft + published both count — owner is planning)
  • contract cap (max_hours_week) → over_cap
  • DK 48h weekly ceiling → over_dk48
  • 11-timers reglen: consecutive shifts with <11h rest, INCLUDING across the
    week boundary (±1 day margin), overnight shifts handled
  • signals only — nothing here blocks publish
"""

import pytest
from datetime import date, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()

MONDAY = date(2026, 7, 20)  # a Monday


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, suffix="") -> User:
    u = User(
        email=f"shield{suffix}@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name="Shield Bistro",
        business_type="cafe",
        currency="DKK",
        plan="pro",
        role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _staff(db, owner, name, max_hours_week=None) -> StaffMember:
    s = StaffMember(user_id=owner.id, name=name, role="server",
                    max_hours_week=max_hours_week)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _shift(db, owner, staff, d, start, end, break_min=0, status="draft"):
    row = Schedule(user_id=owner.id, staff_id=staff.id, date=d,
                   start_time=start, end_time=end,
                   break_minutes=break_min, status=status)
    db.add(row)
    db.commit()
    return row


def _load(client, user, week_start=MONDAY):
    app.dependency_overrides[get_current_user] = lambda: user
    r = client.get("/api/staff/schedules/week-load",
                   params={"week_start": week_start.isoformat()})
    assert r.status_code == 200, r.text
    return r.json()


def _entry(body, staff):
    matches = [e for e in body["staff"] if e["staff_id"] == str(staff.id)]
    assert matches, f"no entry for {staff.name}"
    return matches[0]


def test_hours_and_contract_cap(db, client):
    owner = _owner(db)
    parttimer = _staff(db, owner, "Mette", max_hours_week=25)
    fulltimer = _staff(db, owner, "Jonas")  # no contract cap

    # Mette: 3 × 10h = 30h > her 25h cap (draft + published both count).
    for i, st in enumerate(["draft", "published", "draft"]):
        _shift(db, owner, parttimer, MONDAY + timedelta(days=i),
               "08:00", "18:00", status=st)
    # Jonas: 2 × 8h = 16h, no cap.
    for i in range(2):
        _shift(db, owner, fulltimer, MONDAY + timedelta(days=i), "08:00", "16:00")

    body = _load(client, owner)
    m = _entry(body, parttimer)
    assert m["hours"] == 30.0
    assert m["cap"] == 25.0
    assert m["over_cap"] is True
    assert m["over_dk48"] is False

    j = _entry(body, fulltimer)
    assert j["hours"] == 16.0
    assert j["cap"] is None
    assert j["over_cap"] is False


def test_dk48_ceiling(db, client):
    owner = _owner(db, "48")
    s = _staff(db, owner, "Grinder")
    # 5 × 10h = 50h > 48h ceiling.
    for i in range(5):
        _shift(db, owner, s, MONDAY + timedelta(days=i), "08:00", "18:00")
    e = _entry(_load(client, owner), s)
    assert e["over_dk48"] is True


def test_rest_violation_11h(db, client):
    owner = _owner(db, "rest")
    s = _staff(db, owner, "Sara")
    # Ends 23:30, starts 08:00 next day → 8.5h rest < 11h.
    _shift(db, owner, s, MONDAY, "15:00", "23:30")
    _shift(db, owner, s, MONDAY + timedelta(days=1), "08:00", "16:00")
    e = _entry(_load(client, owner), s)
    assert len(e["rest_warnings"]) == 1
    assert e["rest_warnings"][0]["gap_hours"] == 8.5


def test_rest_ok_at_11h_or_more(db, client):
    owner = _owner(db, "ok")
    s = _staff(db, owner, "Lars")
    _shift(db, owner, s, MONDAY, "08:00", "16:00")
    _shift(db, owner, s, MONDAY + timedelta(days=1), "08:00", "16:00")  # 16h gap
    e = _entry(_load(client, owner), s)
    assert e["rest_warnings"] == []


def test_rest_across_week_boundary_and_overnight(db, client):
    owner = _owner(db, "edge")
    s = _staff(db, owner, "Nat")
    # Sunday BEFORE the week: overnight 18:00→01:00 (ends Monday 01:00).
    _shift(db, owner, s, MONDAY - timedelta(days=1), "18:00", "01:00")
    # Monday (week start) 09:00 → only 8h after the overnight end.
    _shift(db, owner, s, MONDAY, "09:00", "17:00")
    e = _entry(_load(client, owner), s)
    assert len(e["rest_warnings"]) == 1
    assert e["rest_warnings"][0]["gap_hours"] == 8.0
    # The margin-day shift itself must NOT count toward the week's hours.
    assert e["hours"] == 8.0


def test_tenant_scoped(db, client):
    owner_a = _owner(db, "a")
    owner_b = _owner(db, "b")
    sb = _staff(db, owner_b, "OtherTenant")
    _shift(db, owner_b, sb, MONDAY, "08:00", "18:00")

    body = _load(client, owner_a)
    assert body["staff"] == []


# ── Monthly limits + toggle (S1.5) ─────────────────────────────────────

def _staff2(db, owner, name, contract_type="full", max_hours_month=None,
            hour_limit_warn=True):
    s = StaffMember(user_id=owner.id, name=name, role="server",
                    contract_type=contract_type,
                    max_hours_month=max_hours_month,
                    hour_limit_warn=hour_limit_warn)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def test_parttimer_defaults_to_90_month_limit(db, client):
    owner = _owner(db, "m90")
    s = _staff2(db, owner, "Student", contract_type="student")
    # 10 × 10h across July (same month as MONDAY) = 100h > 90 default.
    for i in range(10):
        _shift(db, owner, s, MONDAY - timedelta(days=i), "08:00", "18:00")
    e = _entry(_load(client, owner), s)
    assert e["month_cap"] == 90.0
    assert e["month_cap_source"] == "default90"
    assert e["month_hours"] == 100.0
    assert e["over_month"] is True


def test_fulltimer_has_no_default_month_limit(db, client):
    owner = _owner(db, "mfull")
    s = _staff2(db, owner, "Fuldtid", contract_type="full")
    for i in range(10):
        _shift(db, owner, s, MONDAY - timedelta(days=i), "08:00", "18:00")
    e = _entry(_load(client, owner), s)
    assert e["month_cap"] is None
    assert e["over_month"] is False


def test_explicit_month_cap_beats_default(db, client):
    owner = _owner(db, "mexp")
    s = _staff2(db, owner, "Egen", contract_type="part", max_hours_month=60)
    for i in range(7):
        _shift(db, owner, s, MONDAY - timedelta(days=i), "08:00", "18:00")  # 70h
    e = _entry(_load(client, owner), s)
    assert e["month_cap"] == 60.0
    assert e["month_cap_source"] == "explicit"
    assert e["over_month"] is True


def test_toggle_off_silences_limits_but_not_rest(db, client):
    owner = _owner(db, "moff")
    s = _staff2(db, owner, "Fravalgt", contract_type="student",
                hour_limit_warn=False)
    # Over the 90h month default AND an 8.5h rest gap.
    for i in range(2, 12):
        _shift(db, owner, s, MONDAY - timedelta(days=i), "08:00", "18:00")
    _shift(db, owner, s, MONDAY, "15:00", "23:30")
    _shift(db, owner, s, MONDAY + timedelta(days=1), "08:00", "16:00")
    e = _entry(_load(client, owner), s)
    assert e["warn_enabled"] is False
    # Hour-limit warnings silenced…
    assert e["over_month"] is False
    assert e["over_cap"] is False
    assert e["over_dk48"] is False
    # …but hviletid is safety law — never silenced.
    assert len(e["rest_warnings"]) == 1
