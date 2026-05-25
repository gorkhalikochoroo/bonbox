"""
GET /api/staff/today — dashboard "Today on shift" endpoint (Task #204 P2.6).

Coverage:
  1. Authenticated owner with shifts today → returns sorted shift list
  2. Schedules on other dates are excluded
  3. Tenant scope — owner B's shifts never appear in owner A's response
  4. Soft-deleted staff members are excluded
  5. Empty list when no shifts exist for today
  6. role_on_shift overrides the staff member's default role
  7. Anonymous request → 401 (auth gate)

Run:
  cd backend && python3 -m pytest tests/test_staff_today.py -x -q
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
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


# ─── Shared in-memory DB ──────────────────────────────────────────────


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


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """staff.py's slowapi limiter is module-level — reset between tests so
    one test's 60/min budget doesn't bleed into the next."""
    from app.routers import staff as staff_router

    staff_router._limiter.reset()
    yield
    staff_router._limiter.reset()


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


def _override_user(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


# ─── Helpers ──────────────────────────────────────────────────────────


def _owner(db, *, email_suffix: str = "") -> User:
    u = User(
        email=f"owner{email_suffix}@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name=f"Bon Bakery{email_suffix}",
        business_type="cafe",
        currency="DKK",
        plan="starter",
        role="owner",
        # `business_today_local` defaults to Europe/Copenhagen + 06:00
        # cutoff when these aren't on the user — that matches DK
        # restaurant convention.  We don't set day_cutoff_hour because
        # the column doesn't exist on User (lives on BusinessProfile).
        timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _staff(db, owner: User, *, name: str, role: str = "server", deleted: bool = False) -> StaffMember:
    s = StaffMember(
        id=uuid.uuid4(),
        user_id=owner.id,
        name=name,
        role=role,
        is_deleted=deleted,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _shift(
    db,
    *,
    owner: User,
    staff: StaffMember,
    on_date: date,
    start_time: str,
    end_time: str,
    role_on_shift: str | None = None,
    status: str = "published",
) -> Schedule:
    sh = Schedule(
        id=uuid.uuid4(),
        user_id=owner.id,
        staff_id=staff.id,
        date=on_date,
        start_time=start_time,
        end_time=end_time,
        break_minutes=0,
        role_on_shift=role_on_shift,
        status=status,
    )
    db.add(sh)
    db.commit()
    db.refresh(sh)
    return sh


def _today(owner: User) -> date:
    from app.services.tz_utils import business_today_local

    return business_today_local(owner)


# ─── 1. Happy path — shifts today are returned sorted by start_time ───


def test_today_returns_sorted_shifts(client, db):
    owner = _owner(db)
    _override_user(owner)
    today = _today(owner)

    anna = _staff(db, owner, name="Anna", role="bartender")
    bo = _staff(db, owner, name="Bo", role="barista")
    _shift(db, owner=owner, staff=bo, on_date=today, start_time="08:00", end_time="14:00")
    _shift(db, owner=owner, staff=anna, on_date=today, start_time="17:00", end_time="23:00", role_on_shift="Bartender")

    res = client.get("/api/staff/today")
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["date"] == today.isoformat()
    assert len(body["shifts"]) == 2
    # Sorted by start_time ascending → Bo (08:00) before Anna (17:00).
    assert body["shifts"][0]["name"] == "Bo"
    assert body["shifts"][0]["role"] == "barista"
    assert body["shifts"][0]["start_time"] == "08:00"
    assert body["shifts"][1]["name"] == "Anna"
    # role_on_shift overrides the staff.role default.
    assert body["shifts"][1]["role"] == "Bartender"
    assert body["shifts"][1]["end_time"] == "23:00"


# ─── 2. Shifts on other dates are excluded ─────────────────────────────


def test_today_excludes_other_dates(client, db):
    owner = _owner(db)
    _override_user(owner)
    today = _today(owner)
    yesterday = today - timedelta(days=1)
    tomorrow = today + timedelta(days=1)

    anna = _staff(db, owner, name="Anna")
    _shift(db, owner=owner, staff=anna, on_date=yesterday, start_time="10:00", end_time="14:00")
    _shift(db, owner=owner, staff=anna, on_date=tomorrow, start_time="10:00", end_time="14:00")
    _shift(db, owner=owner, staff=anna, on_date=today, start_time="09:00", end_time="13:00")

    res = client.get("/api/staff/today")
    assert res.status_code == 200
    body = res.json()
    assert len(body["shifts"]) == 1
    assert body["shifts"][0]["start_time"] == "09:00"


# ─── 3. Tenant scope — owner B's shifts never appear for owner A ──────


def test_today_is_tenant_scoped(client, db):
    owner_a = _owner(db, email_suffix="a")
    owner_b = _owner(db, email_suffix="b")
    today = _today(owner_a)

    staff_b = _staff(db, owner_b, name="Frank")
    _shift(db, owner=owner_b, staff=staff_b, on_date=today, start_time="10:00", end_time="14:00")

    # Owner A queries; the only shift in the DB belongs to owner B → empty.
    _override_user(owner_a)
    res = client.get("/api/staff/today")
    assert res.status_code == 200
    assert res.json()["shifts"] == []


# ─── 4. Soft-deleted staff members are excluded ────────────────────────


def test_today_excludes_soft_deleted_staff(client, db):
    owner = _owner(db)
    _override_user(owner)
    today = _today(owner)

    gone = _staff(db, owner, name="Mads", deleted=True)
    here = _staff(db, owner, name="Lise")
    _shift(db, owner=owner, staff=gone, on_date=today, start_time="08:00", end_time="14:00")
    _shift(db, owner=owner, staff=here, on_date=today, start_time="14:00", end_time="22:00")

    res = client.get("/api/staff/today")
    assert res.status_code == 200
    body = res.json()
    assert len(body["shifts"]) == 1
    assert body["shifts"][0]["name"] == "Lise"


# ─── 5. Empty list when no shifts scheduled ────────────────────────────


def test_today_empty_when_no_shifts(client, db):
    owner = _owner(db)
    _override_user(owner)

    res = client.get("/api/staff/today")
    assert res.status_code == 200
    assert res.json()["shifts"] == []


# ─── 6. Auth gate — anonymous request rejected ─────────────────────────


def test_today_requires_auth(client, db):
    _override_user(None)
    res = client.get("/api/staff/today")
    # Anonymous → 401 from get_current_user (cookie/JWT missing).
    assert res.status_code in (401, 403), res.text
