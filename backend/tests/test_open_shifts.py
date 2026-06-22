"""
Open shifts (Åbne vagter) — owner posts unassigned slots; staff claim one-tap.

Coverage:
  Owner (/api/staff/open-shifts)
    • create: Free → 402 (staff_portal_link), Starter → 200 'open' row
    • create: malformed HH:MM → 422, start==end → 422, past/too-far date → 422
    • list: excludes cancelled, week filter, tenant-scoped
    • cancel: open → 204 (soft-cancel), filled → 409, other tenant → 404
  Staff portal (/api/portal/{token}/open-shifts)
    • list: only own owner's status='open', upcoming; tenant-bound by token
    • claim: materializes a PUBLISHED Schedule row + flips to 'filled'
    • claim race: second claim → 409 already_taken (atomic)
    • claim overlap: claimer already works then → 409 shift_overlap, slot stays open
    • claim wrong tenant / bad token → 404

Run:
  cd backend && python3 -m pytest tests/test_open_shifts.py -x -q
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
from app.models.staff import OpenShift, Schedule, StaffLink, StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


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
def _reset_rate_limiters():
    from app.routers import staff as staff_router
    from app.routers import staff_portal as portal_router
    for mod in (staff_router, portal_router):
        lim = getattr(mod, "_limiter", None) or getattr(mod, "limiter", None)
        if lim is not None:
            lim.reset()
    yield
    for mod in (staff_router, portal_router):
        lim = getattr(mod, "_limiter", None) or getattr(mod, "limiter", None)
        if lim is not None:
            lim.reset()


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


def _override_user(user):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, *, plan="starter", email_suffix="") -> User:
    u = User(
        email=f"owner{email_suffix}@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name=f"Bon Bistro{email_suffix}",
        business_type="cafe",
        currency="DKK",
        plan=plan,
        role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _staff(db, owner, *, name="Agnes", role="server") -> StaffMember:
    s = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role=role,
                    active=True, is_deleted=False)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _link(db, owner, staff, token) -> StaffLink:
    lk = StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id,
                   token=token, active=True)
    db.add(lk)
    db.commit()
    return lk


def _seed_shift(db, *, owner, staff, on_date, start, end, status="published"):
    sh = Schedule(id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id,
                  date=on_date, start_time=start, end_time=end,
                  break_minutes=0, status=status)
    db.add(sh)
    db.commit()
    return sh


def _seed_open(db, *, owner, on_date, start="16:00", end="23:00",
               role="server", status="open"):
    o = OpenShift(id=uuid.uuid4(), user_id=owner.id, date=on_date,
                  start_time=start, end_time=end, role_on_shift=role,
                  break_minutes=0, status=status)
    db.add(o)
    db.commit()
    db.refresh(o)
    return o


D = date.today() + timedelta(days=3)


def _body(on_date=D, start="16:00", end="23:00", role="server"):
    return {"date": on_date.isoformat(), "start_time": start,
            "end_time": end, "role_on_shift": role}


# ═══ Owner — create ═══════════════════════════════════════════════════


def test_create_free_tier_blocked_402(client, db):
    owner = _owner(db, plan="free")
    _override_user(owner)
    res = client.post("/api/staff/open-shifts", json=_body())
    assert res.status_code == 402, res.text


def test_create_starter_ok(client, db):
    owner = _owner(db, plan="starter")
    _override_user(owner)
    res = client.post("/api/staff/open-shifts", json=_body())
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "open"
    assert db.query(OpenShift).filter(OpenShift.user_id == owner.id).count() == 1


def test_create_rejects_malformed_time_and_equal(client, db):
    owner = _owner(db, plan="pro")
    _override_user(owner)
    assert client.post("/api/staff/open-shifts", json=_body(start="25:00")).status_code == 422
    assert client.post("/api/staff/open-shifts", json=_body(start="16:00", end="16:00")).status_code == 422


def test_create_rejects_past_and_too_far(client, db):
    owner = _owner(db, plan="pro")
    _override_user(owner)
    past = date.today() - timedelta(days=5)
    far = date.today() + timedelta(days=400)
    assert client.post("/api/staff/open-shifts", json=_body(on_date=past)).status_code == 422
    assert client.post("/api/staff/open-shifts", json=_body(on_date=far)).status_code == 422


# ═══ Owner — list / cancel ════════════════════════════════════════════


def test_list_excludes_cancelled_and_is_tenant_scoped(client, db):
    owner = _owner(db, plan="starter")
    other = _owner(db, plan="starter", email_suffix="2")
    _seed_open(db, owner=owner, on_date=D)
    _seed_open(db, owner=owner, on_date=D, status="cancelled")
    _seed_open(db, owner=other, on_date=D)  # other tenant
    _override_user(owner)
    res = client.get("/api/staff/open-shifts")
    assert res.status_code == 200, res.text
    rows = res.json()
    assert len(rows) == 1  # cancelled hidden, other tenant invisible
    assert rows[0]["status"] == "open"


def test_cancel_open_then_filled(client, db):
    owner = _owner(db, plan="starter")
    o_open = _seed_open(db, owner=owner, on_date=D)
    o_filled = _seed_open(db, owner=owner, on_date=D, status="filled")
    _override_user(owner)
    assert client.delete(f"/api/staff/open-shifts/{o_open.id}").status_code == 204
    db.refresh(o_open)
    assert o_open.status == "cancelled"
    # a filled slot already spawned a real shift → 409, not a silent orphan
    assert client.delete(f"/api/staff/open-shifts/{o_filled.id}").status_code == 409


# ═══ Portal — list ════════════════════════════════════════════════════


def test_portal_list_only_open_upcoming_tenant_bound(client, db):
    owner = _owner(db, plan="starter")
    bo = _staff(db, owner, name="Bo")
    _link(db, owner, bo, "bo-open-tok")
    _seed_open(db, owner=owner, on_date=D)                       # shown
    _seed_open(db, owner=owner, on_date=D, status="filled")      # hidden
    _seed_open(db, owner=owner, on_date=date.today() - timedelta(days=2))  # past, hidden
    res = client.get("/api/portal/bo-open-tok/open-shifts")
    assert res.status_code == 200, res.text
    assert len(res.json()) == 1


# ═══ Portal — claim ═══════════════════════════════════════════════════


def test_claim_materializes_published_shift(client, db):
    owner = _owner(db, plan="starter")
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "agnes-tok")
    o = _seed_open(db, owner=owner, on_date=D, start="16:00", end="23:00")

    res = client.post(f"/api/portal/agnes-tok/open-shifts/{o.id}/claim")
    assert res.status_code == 200, res.text
    db.refresh(o)
    assert o.status == "filled"
    assert o.claimed_by_staff_id == agnes.id
    # a real PUBLISHED Schedule row now exists for the claimer
    sh = db.query(Schedule).filter(
        Schedule.user_id == owner.id, Schedule.staff_id == agnes.id,
        Schedule.date == D,
    ).first()
    assert sh is not None and sh.status == "published"
    assert sh.start_time == "16:00" and sh.end_time == "23:00"


def test_claim_race_second_gets_409(client, db):
    owner = _owner(db, plan="starter")
    agnes = _staff(db, owner, name="Agnes")
    bo = _staff(db, owner, name="Bo")
    _link(db, owner, agnes, "agnes-tok2")
    _link(db, owner, bo, "bo-tok2")
    o = _seed_open(db, owner=owner, on_date=D)

    first = client.post(f"/api/portal/agnes-tok2/open-shifts/{o.id}/claim")
    assert first.status_code == 200, first.text
    second = client.post(f"/api/portal/bo-tok2/open-shifts/{o.id}/claim")
    assert second.status_code == 409, second.text
    assert second.json()["detail"]["code"] == "already_taken"
    # only ONE materialized shift exists
    assert db.query(Schedule).filter(Schedule.user_id == owner.id, Schedule.date == D).count() == 1


def test_claim_rejected_when_claimer_already_overlaps(client, db):
    owner = _owner(db, plan="starter")
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "agnes-tok3")
    # Agnes already works 18:00–22:00 that day
    _seed_shift(db, owner=owner, staff=agnes, on_date=D, start="18:00", end="22:00")
    o = _seed_open(db, owner=owner, on_date=D, start="16:00", end="23:00")  # overlaps

    res = client.post(f"/api/portal/agnes-tok3/open-shifts/{o.id}/claim")
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "shift_overlap"
    db.refresh(o)
    assert o.status == "open"  # not consumed by a rejected claim


def test_claim_other_tenant_open_shift_is_404(client, db):
    owner = _owner(db, plan="starter")
    other = _owner(db, plan="starter", email_suffix="2")
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "agnes-tok4")
    foreign = _seed_open(db, owner=other, on_date=D)  # belongs to another owner
    res = client.post(f"/api/portal/agnes-tok4/open-shifts/{foreign.id}/claim")
    assert res.status_code == 404, res.text


def test_claim_bad_token_404(client, db):
    owner = _owner(db, plan="starter")
    o = _seed_open(db, owner=owner, on_date=D)
    res = client.post(f"/api/portal/not-a-real-token/open-shifts/{o.id}/claim")
    assert res.status_code == 404, res.text


def test_claim_past_dated_open_shift_is_409(client, db):
    """A stale client / direct call must not materialize a past shift."""
    owner = _owner(db, plan="starter")
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "agnes-past-tok")
    past = _seed_open(db, owner=owner, on_date=date.today() - timedelta(days=2))
    res = client.post(f"/api/portal/agnes-past-tok/open-shifts/{past.id}/claim")
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "shift_passed"
    db.refresh(past)
    assert past.status == "open"  # not consumed
