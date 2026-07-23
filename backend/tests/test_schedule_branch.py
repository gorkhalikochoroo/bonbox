"""Shift location (multi-location S3) — branch on Schedule.

One roster with a location lens, never separate rosters:
  • create/update stores branch_id ONLY when it's one of the owner's active
    branches (foreign/bogus id degrades to None — a stale picker must never
    block shift creation)
  • the branch filter INCLUDES unassigned shifts (they belong everywhere;
    switching location must never make a shift silently vanish)
  • the staff portal serializer carries branch_name/address so the shift
    card can answer "which restaurant am I at today?"
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
from app.main import app, _db_ready
from app.models.branch import Branch
from app.models.staff import Schedule, StaffLink, StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()

MONDAY = date.today() + timedelta(days=(7 - date.today().weekday()))

# The day GET /api/staff/today is pinned to by the `business_today` fixture.
# Deliberately NOT `date.today()` (it's 1–7 days out) so an endpoint that
# regressed to the calendar date can't accidentally match it.
BUSINESS_TODAY = MONDAY


@pytest.fixture
def business_today(monkeypatch):
    """Freeze what `/api/staff/today` considers "today".

    That endpoint filters on `business_today_local(user)` — Europe/Copenhagen
    with the 06:00 DK cutoff — so between midnight and 06:00 local its "today"
    is the PREVIOUS calendar date. Seeding on `date.today()` therefore passed
    in the afternoon and failed after midnight; at one instant (00:28 CEST)
    the same test passed under TZ=UTC and failed under TZ=Europe/Copenhagen.

    Pinning the helper makes the day a constant on both sides, so the test
    asserts branch_name propagation and never the wall clock. It still holds
    the endpoint to the convention: the frozen day is never `date.today()`, so
    an endpoint that dropped the business-day helper would find no shift.

    Patched on the router (which did `from ... import business_today_local`,
    so it holds its own reference) AND on the tz_utils source, per the pattern
    in tests/test_reservation_insights.py.
    """
    import app.routers.staff as staff_router
    import app.services.tz_utils as tz_utils

    def _frozen(_user):  # signature matches business_today_local(user)
        return BUSINESS_TODAY

    monkeypatch.setattr(tz_utils, "business_today_local", _frozen)
    monkeypatch.setattr(staff_router, "business_today_local", _frozen)
    return BUSINESS_TODAY


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


def _owner(db, suffix=""):
    u = User(email=f"loc{suffix}@bonbox.dk", password_hash=hash_password("pw123456"),
             business_name="Loc Bistro", business_type="cafe", currency="DKK",
             role="owner", plan="pro")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _branch(db, owner, name, active=True):
    b = Branch(user_id=owner.id, name=name, address=f"{name}gade 1, København",
               is_active=active)
    db.add(b); db.commit(); db.refresh(b)
    return b


def _staff(db, owner, name="Mette"):
    s = StaffMember(user_id=owner.id, name=name, role="server", active=True)
    db.add(s); db.commit(); db.refresh(s)
    return s


def _post_shift(client, user, staff, branch_id=None, day=MONDAY):
    app.dependency_overrides[get_current_user] = lambda: user
    body = {
        "staff_id": str(staff.id), "date": day.isoformat(),
        "start_time": "10:00", "end_time": "16:00",
    }
    if branch_id is not None:
        body["branch_id"] = str(branch_id)
    r = client.post("/api/staff/schedules", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_create_stores_own_active_branch(db, client):
    owner = _owner(db)
    b = _branch(db, owner, "Vesterbro")
    staff = _staff(db, owner)
    created = _post_shift(client, owner, staff, branch_id=b.id)
    assert created["branch_id"] == str(b.id)


def test_foreign_or_inactive_branch_degrades_to_none(db, client):
    owner = _owner(db, "f")
    other = _owner(db, "o")
    foreign = _branch(db, other, "OtherOwners")
    inactive = _branch(db, owner, "Closed", active=False)
    staff = _staff(db, owner)

    assert _post_shift(client, owner, staff, branch_id=foreign.id)["branch_id"] is None
    assert _post_shift(client, owner, staff, branch_id=inactive.id,
                       day=MONDAY + timedelta(days=1))["branch_id"] is None
    assert _post_shift(client, owner, staff, branch_id=uuid.uuid4(),
                       day=MONDAY + timedelta(days=2))["branch_id"] is None


def test_filter_includes_unassigned(db, client):
    owner = _owner(db, "flt")
    vest = _branch(db, owner, "Vesterbro")
    norre = _branch(db, owner, "Nørrebro")
    staff = _staff(db, owner)
    _post_shift(client, owner, staff, branch_id=vest.id)                      # Vesterbro
    _post_shift(client, owner, staff, branch_id=norre.id, day=MONDAY + timedelta(days=1))  # Nørrebro
    _post_shift(client, owner, staff, day=MONDAY + timedelta(days=2))         # unassigned

    app.dependency_overrides[get_current_user] = lambda: owner
    r = client.get("/api/staff/schedules",
                   params={"week_start": MONDAY.isoformat(), "branch_id": str(vest.id)})
    got = {s["branch_id"] for s in r.json()}
    # Vesterbro + unassigned — the other location's shift is filtered out.
    assert got == {str(vest.id), None}

    r_all = client.get("/api/staff/schedules", params={"week_start": MONDAY.isoformat()})
    assert len(r_all.json()) == 3


def test_portal_shift_carries_branch(db, client):
    owner = _owner(db, "p")
    b = _branch(db, owner, "Amager")
    staff = _staff(db, owner)
    app.dependency_overrides[get_current_user] = lambda: owner
    client.post("/api/staff/schedules", json={
        "staff_id": str(staff.id), "date": MONDAY.isoformat(),
        "start_time": "10:00", "end_time": "16:00",
        "status": "published", "branch_id": str(b.id),
    })
    link = StaffLink(staff_id=staff.id, user_id=owner.id,
                     token="tok-branch-test-123456789012", active=True)
    db.add(link); db.commit()

    r = client.get(f"/api/portal/{link.token}/schedule")
    assert r.status_code == 200, r.text
    sh = r.json()["shifts"][0]
    assert sh["branch_name"] == "Amager"
    assert "Amagergade" in (sh["branch_address"] or "")


def test_team_schedule_carries_branch_name(db, client):
    owner = _owner(db, "ts")
    b = _branch(db, owner, "Valby")
    mette = _staff(db, owner, "Mette")
    jonas = _staff(db, owner, "Jonas")
    app.dependency_overrides[get_current_user] = lambda: owner
    for staff, branch in ((mette, b.id), (jonas, None)):
        body = {"staff_id": str(staff.id), "date": MONDAY.isoformat(),
                "start_time": "10:00", "end_time": "16:00", "status": "published"}
        if branch:
            body["branch_id"] = str(branch)
        client.post("/api/staff/schedules", json=body)
    link = StaffLink(staff_id=mette.id, user_id=owner.id,
                     token="tok-team-branch-1234567890ab", active=True)
    db.add(link); db.commit()

    r = client.get(f"/api/portal/{link.token}/team-schedule")
    assert r.status_code == 200, r.text
    by_staff = {row["staff_name"]: row["branch_name"] for row in r.json()}
    assert by_staff["Mette"] == "Valby"
    assert by_staff["Jonas"] is None


def test_today_endpoint_carries_branch_name(db, client, business_today):
    owner = _owner(db, "today")
    b = _branch(db, owner, "Østerbro")
    staff = _staff(db, owner, "Anna")
    app.dependency_overrides[get_current_user] = lambda: owner
    # Seed on the BUSINESS day the endpoint queries, not the calendar day.
    cr = client.post("/api/staff/schedules", json={
        "staff_id": str(staff.id), "date": business_today.isoformat(),
        "start_time": "10:00", "end_time": "16:00", "status": "published",
        "branch_id": str(b.id),
    })
    assert cr.status_code == 200, cr.text  # else the empty list below lies
    r = client.get("/api/staff/today")
    assert r.status_code == 200, r.text
    assert r.json()["date"] == business_today.isoformat()
    rows = r.json()["shifts"]
    assert rows and rows[0]["branch_name"] == "Østerbro"


def test_open_shift_branch_flows_to_portal_and_claim(db, client):
    """S5: the open shift carries WHERE the hole is; the portal shows it;
    the claim materializes a Schedule that INHERITS the branch."""
    owner = _owner(db, "os")
    b = _branch(db, owner, "Frederiksberg")
    staff = _staff(db, owner, "Clara")
    app.dependency_overrides[get_current_user] = lambda: owner

    r = client.post("/api/staff/open-shifts", json={
        "date": MONDAY.isoformat(), "start_time": "17:00", "end_time": "22:00",
        "branch_id": str(b.id),
    })
    assert r.status_code == 200, r.text
    os_id = r.json()["id"]
    assert r.json()["branch_id"] == str(b.id)

    link = StaffLink(staff_id=staff.id, user_id=owner.id,
                     token="tok-openshift-br-123456789012", active=True)
    db.add(link); db.commit()

    pool = client.get(f"/api/portal/{link.token}/open-shifts").json()
    assert pool and pool[0]["branch_name"] == "Frederiksberg"

    rc = client.post(f"/api/portal/{link.token}/open-shifts/{os_id}/claim")
    assert rc.status_code == 200, rc.text
    sched = db.query(Schedule).filter(
        Schedule.id == rc.json()["schedule_id"]).first()
    assert str(sched.branch_id) == str(b.id)  # inherited


def test_giveaway_pool_row_carries_branch_name(db, client):
    owner = _owner(db, "gab")
    b = _branch(db, owner, "Kastrup")
    mette = _staff(db, owner, "Mette")
    jonas = _staff(db, owner, "Jonas")
    app.dependency_overrides[get_current_user] = lambda: owner
    sr = client.post("/api/staff/schedules", json={
        "staff_id": str(mette.id), "date": MONDAY.isoformat(),
        "start_time": "10:00", "end_time": "16:00",
        "status": "published", "branch_id": str(b.id),
    })
    for s, tok in ((mette, "tok-ga-branch-m-123456789012"),
                   (jonas, "tok-ga-branch-j-123456789012")):
        db.add(StaffLink(staff_id=s.id, user_id=owner.id, token=tok, active=True))
    db.commit()

    ro = client.post("/api/portal/tok-ga-branch-m-123456789012/give-aways",
                     json={"shift_id": sr.json()["id"]})
    assert ro.status_code == 200, ro.text
    assert ro.json()["from_branch_name"] == "Kastrup"

    pool = client.get("/api/portal/tok-ga-branch-j-123456789012/give-aways").json()
    assert pool and pool[0]["from_branch_name"] == "Kastrup"
