"""
GET /api/admin/activation — the Vagtplan loop, counted once instead of by hand.

Every activation figure in the 2026-09-06 readiness review came from ad-hoc SQL
against production. These tests pin the parts of that endpoint that would
flatter the number if they broke quietly:

  • founder/test accounts must be OUT of the cohort (the exclusion list is
    shared with the thesis export, so a drift here also mis-reports the study)
  • steps must be counted independently, not forced monotonic
  • completed_loop is an intersection, not "the last funnel row"
  • a venue that rosters but never publishes must not appear as published

Run:
  cd backend && python3 -m pytest tests/test_admin_activation.py -x -q
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
from app.models.audit_log import AuditLog
from app.models.staff import HoursLogged, Schedule, StaffLink, StaffMember
from app.models.user import User
from app.services.admin_security import require_super_admin
from app.services.auth import hash_password
from app.services.internal_accounts import EXCLUDED_ACCOUNTS
from app.utils.time import utc_now

_db_ready.set()

# A real id from the shared exclusion list — Manoj's founder account. Using a
# live entry (not a made-up uuid) is the point: if someone empties or renames
# EXCLUDED_ACCOUNTS, this test goes red instead of silently counting founders.
FOUNDER_ID = "3436a646-b458-4321-96fc-49ac108bd2f3"


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
    # The guard itself is covered by the admin-security suite; here we are
    # testing the arithmetic behind it.
    app.dependency_overrides[require_super_admin] = lambda: None
    yield TestClient(app)
    app.dependency_overrides.clear()


def _venue(db, *, uid: str | None = None, name: str = "Venue") -> User:
    u = User(
        id=uid or str(uuid.uuid4()),
        email=f"{uuid.uuid4().hex[:10]}@bonbox.dk",
        password_hash=hash_password("pw123456"),
        business_name=name, business_type="cafe", currency="DKK",
        plan="free", role="owner", created_at=utc_now(),
    )
    db.add(u)
    db.commit()
    return u


def _shift(db, owner, *, status="draft"):
    db.add(Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=uuid.uuid4(),
        date=date.today(), start_time="16:00", end_time="23:00",
        break_minutes=45, role_on_shift="server", status=status,
    ))
    db.commit()


def _opened_link(db, owner):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Anna",
                    role="server", active=True, is_deleted=False)
    db.add(m)
    db.commit()
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=m.id,
                     token=uuid.uuid4().hex, active=True,
                     last_accessed=utc_now()))
    db.commit()


def _clock_in(db, owner):
    db.add(HoursLogged(user_id=owner.id, staff_id=uuid.uuid4(),
                       date=date.today(), total_hours=6.25,
                       entry_method="clock"))
    db.commit()


def _exported(db, owner):
    db.add(AuditLog(user_id=owner.id, action="staff.payroll_csv_exported",
                    entity_type="payroll_export"))
    db.commit()


def _get(client, **params) -> dict:
    r = client.get("/api/admin/activation", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _step(body, key) -> dict:
    return next(s for s in body["steps"] if s["key"] == key)


def test_the_exclusion_list_is_the_shared_one(db, client):
    """A founder account with the full loop must not appear anywhere."""
    assert FOUNDER_ID in EXCLUDED_ACCOUNTS, (
        "the shared exclusion list no longer holds the founder account — the "
        "funnel and the thesis cohort are about to disagree"
    )
    founder = _venue(db, uid=FOUNDER_ID, name="BonBox")
    _shift(db, founder, status="published")
    _opened_link(db, founder)
    _clock_in(db, founder)
    _exported(db, founder)

    body = _get(client)
    assert body["cohort_size"] == 0
    for k in ("rostered", "published", "link_opened", "clocked_in", "exported"):
        assert _step(body, k)["venues"] == 0
    assert body["completed_loop"] == 0


def test_counts_each_step_for_real_venues(db, client):
    full = _venue(db, name="Full loop")
    _shift(db, full, status="published")
    _opened_link(db, full)
    _clock_in(db, full)
    _exported(db, full)

    stalled = _venue(db, name="Rostered only")
    _shift(db, stalled, status="draft")

    _venue(db, name="Signed up, did nothing")

    body = _get(client)
    assert body["cohort_size"] == 3
    assert _step(body, "rostered")["venues"] == 2
    assert _step(body, "published")["venues"] == 1
    assert _step(body, "link_opened")["venues"] == 1
    assert _step(body, "clocked_in")["venues"] == 1
    assert _step(body, "exported")["venues"] == 1
    assert body["completed_loop"] == 1
    assert _step(body, "rostered")["pct"] == pytest.approx(66.7, abs=0.1)


def test_a_draft_shift_is_not_published(db, client):
    """The whole point of step 2: a roster staff never saw is not an outcome."""
    v = _venue(db)
    _shift(db, v, status="draft")
    body = _get(client)
    assert _step(body, "rostered")["venues"] == 1
    assert _step(body, "published")["venues"] == 0
    assert body["completed_loop"] == 0


def test_steps_are_independent_not_monotonic(db, client):
    """A venue can clock in without ever publishing (quick-add hours). Forcing
    a monotonic funnel would hide exactly the odd path worth seeing."""
    v = _venue(db)
    _clock_in(db, v)
    body = _get(client)
    assert _step(body, "published")["venues"] == 0
    assert _step(body, "clocked_in")["venues"] == 1   # > published, on purpose
    assert body["completed_loop"] == 0                # intersection, still 0


def test_completed_loop_needs_every_step_not_the_last_one(db, client):
    """Reading the loop off the final row would call this venue finished."""
    v = _venue(db)
    _shift(db, v, status="published")
    _clock_in(db, v)          # but no staffer ever opened the link
    body = _get(client)
    assert _step(body, "clocked_in")["venues"] == 1
    assert body["completed_loop"] == 0


def test_exported_is_flagged_as_not_retroactive(db, client):
    """Steps 1-4 read durable rows and describe all time; step 5 only counts
    from the deploy that started logging it. The payload must say which."""
    body = _get(client)
    assert _step(body, "exported")["retroactive"] is False
    for k in ("rostered", "published", "link_opened", "clocked_in"):
        assert _step(body, k)["retroactive"] is True


def test_days_window_restricts_the_cohort(db, client):
    old = _venue(db, name="Old")
    old.created_at = utc_now() - timedelta(days=120)
    db.commit()
    _shift(db, old, status="published")
    _venue(db, name="New")

    all_time = _get(client)
    assert all_time["cohort_size"] == 2
    assert all_time["cohort_days"] is None

    recent = _get(client, days=30)
    assert recent["cohort_size"] == 1
    assert recent["cohort_days"] == 30
    assert _step(recent, "published")["venues"] == 0


def test_empty_cohort_returns_zeroes_not_a_division_error(db, client):
    body = _get(client, days=1)
    assert body["cohort_size"] == 0
    assert all(s["venues"] == 0 and s["pct"] == 0.0 for s in body["steps"])
