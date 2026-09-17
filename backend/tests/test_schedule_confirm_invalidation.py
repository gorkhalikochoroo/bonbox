"""
A MATERIAL edit to a confirmed shift must retract the staffer's "Jeg har set det".

confirmed_at is the staff-side acknowledgement, and the owner's Vagtplan paints a
green CheckCircle2 on it. PUT /api/staff/schedules/{id} — which is ALSO what the
grid's drag-to-move calls — rewrote staff_id, date, start_time and end_time and
never touched confirmed_at. So an owner could hand Agnes's confirmed Friday shift
to Lars, or drag it to Saturday, or retime it 16:00→11:00, and the grid went on
asserting that the person working it had seen it. The owner then plans a service
around an acknowledgement that describes a shift which no longer exists.

WHAT COUNTS AS MATERIAL: who / which day / which hours — the four facts a staffer
would have to re-read. Notes, break_minutes and role_on_shift are the owner
annotating a shift whose WHO and WHEN are unchanged; clearing on those would fire
the badge on every keystroke of housekeeping and train everyone to ignore it.

THE LOOP CLOSES ON ITS OWN: portal confirm-schedule selects on
`confirmed_at IS NULL`, and the portal's confirm strip computes allConfirmed as
`every(confirmed_at)` — so a cleared stamp puts the shift straight back into the
staffer's pending set and re-surfaces the button. test_material_change_reopens_
portal_confirm pins that end-to-end rather than assuming it.

Run:
  cd backend && python3 -m pytest tests/test_schedule_confirm_invalidation.py -x -q
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
from app.models.staff import Schedule, StaffLink, StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


# ─── Shared in-memory DB + client (mirrors test_schedule_overlap.py) ──


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
    """Both routers carry module-level slowapi limiters — reset between tests
    so one test's budget doesn't bleed into the next."""
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


def _override_user(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


# ─── Helpers ──────────────────────────────────────────────────────────


def _owner(db) -> User:
    u = User(
        email="owner@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name="Bon Bistro",
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


def _staff(db, owner: User, *, name: str, role: str = "server") -> StaffMember:
    s = StaffMember(
        id=uuid.uuid4(),
        user_id=owner.id,
        name=name,
        role=role,
        active=True,
        is_deleted=False,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _link(db, owner: User, staff: StaffMember, token: str) -> StaffLink:
    lk = StaffLink(
        id=uuid.uuid4(),
        user_id=owner.id,
        staff_id=staff.id,
        token=token,
        active=True,
    )
    db.add(lk)
    db.commit()
    db.refresh(lk)
    return lk


def _seed_shift(db, *, owner, staff, on_date, start_time, end_time) -> Schedule:
    sh = Schedule(
        id=uuid.uuid4(),
        user_id=owner.id,
        staff_id=staff.id,
        date=on_date,
        start_time=start_time,
        end_time=end_time,
        break_minutes=30,
        role_on_shift="Server",
        status="published",
        notes="Opening",
    )
    db.add(sh)
    db.commit()
    db.refresh(sh)
    return sh


def _put_body(*, staff, on_date, start, end, notes="Opening"):
    """The full ScheduleCreate the owner grid sends on every edit — the grid
    always PUTs the whole row, which is exactly why a drag-to-move and a
    notes tweak arrive at the server looking identical apart from the values."""
    return {
        "staff_id": str(staff.id),
        "date": on_date.isoformat(),
        "start_time": start,
        "end_time": end,
        "break_minutes": 30,
        "role_on_shift": "Server",
        "status": "published",
        "notes": notes,
    }


# The portal's confirm window is [Monday of this week, +20 days], so a shift two
# days out is always inside it regardless of which day the suite runs.
D = date.today() + timedelta(days=2)
D_MOVED = D + timedelta(days=1)


def _confirm_via_portal(client, token: str) -> int:
    """Stamp confirmed_at the way a real staffer does — through the portal, not
    by writing the column. If the portal ever stops confirming, these tests
    should fail loudly rather than quietly testing nothing."""
    res = client.post(f"/api/portal/{token}/confirm-schedule", json={})
    assert res.status_code == 200, res.text
    return res.json()["confirmed_count"]


def _confirmed_at(db, shift_id) -> object:
    db.expire_all()
    return db.query(Schedule).filter(Schedule.id == shift_id).first().confirmed_at


# ═══ Material edits RETRACT the acknowledgement ═══════════════════════


def test_reassign_to_other_staff_clears_confirmed_at(client, db):
    """The shift is now someone else's. Lars has never seen it."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    lars = _staff(db, owner, name="Lars", role="bartender")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    assert _confirm_via_portal(client, "tok-agnes") == 1
    assert _confirmed_at(db, shift.id) is not None

    _override_user(owner)
    res = client.put(
        f"/api/staff/schedules/{shift.id}",
        json=_put_body(staff=lars, on_date=D, start="16:00", end="23:00"),
    )
    assert res.status_code == 200, res.text
    assert res.json()["confirmed_at"] is None
    assert _confirmed_at(db, shift.id) is None


def test_move_to_another_date_clears_confirmed_at(client, db):
    """Drag-to-move across a column is the same PUT — a different day is a
    different shift as far as the person working it is concerned."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    _confirm_via_portal(client, "tok-agnes")
    _override_user(owner)

    res = client.put(
        f"/api/staff/schedules/{shift.id}",
        json=_put_body(staff=agnes, on_date=D_MOVED, start="16:00", end="23:00"),
    )
    assert res.status_code == 200, res.text
    assert res.json()["confirmed_at"] is None


def test_retime_clears_confirmed_at(client, db):
    """16:00–23:00 → 11:00–19:00. Same person, same day, a different working
    life — the one case the owner most needs the staffer to re-read."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    _confirm_via_portal(client, "tok-agnes")
    _override_user(owner)

    res = client.put(
        f"/api/staff/schedules/{shift.id}",
        json=_put_body(staff=agnes, on_date=D, start="11:00", end="19:00"),
    )
    assert res.status_code == 200, res.text
    assert res.json()["confirmed_at"] is None


def test_end_time_only_change_clears_confirmed_at(client, db):
    """Half of a retime still counts — an hour longer is an hour unagreed."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    _confirm_via_portal(client, "tok-agnes")
    _override_user(owner)

    res = client.put(
        f"/api/staff/schedules/{shift.id}",
        json=_put_body(staff=agnes, on_date=D, start="16:00", end="00:30"),
    )
    assert res.status_code == 200, res.text
    assert res.json()["confirmed_at"] is None


# ═══ Immaterial edits KEEP it ═════════════════════════════════════════


def test_notes_only_edit_keeps_confirmed_at(client, db):
    """Owner housekeeping. Who and when are untouched, so the badge stands —
    clearing here would make the badge mean nothing within a week."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    _confirm_via_portal(client, "tok-agnes")
    stamped = _confirmed_at(db, shift.id)
    assert stamped is not None

    _override_user(owner)
    res = client.put(
        f"/api/staff/schedules/{shift.id}",
        json=_put_body(staff=agnes, on_date=D, start="16:00", end="23:00", notes="Bring the float"),
    )
    assert res.status_code == 200, res.text
    assert res.json()["confirmed_at"] is not None
    assert _confirmed_at(db, shift.id) == stamped


def test_unchanged_resave_keeps_confirmed_at(client, db):
    """The grid re-PUTs the whole row on any modal save. An identical payload
    must not quietly retract an acknowledgement."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    _confirm_via_portal(client, "tok-agnes")
    stamped = _confirmed_at(db, shift.id)

    _override_user(owner)
    res = client.put(
        f"/api/staff/schedules/{shift.id}",
        json=_put_body(staff=agnes, on_date=D, start="16:00", end="23:00"),
    )
    assert res.status_code == 200, res.text
    assert _confirmed_at(db, shift.id) == stamped


# ═══ The loop actually closes ═════════════════════════════════════════


def test_material_change_reopens_portal_confirm(client, db):
    """Retracting is only honest if the staffer can re-acknowledge. After a
    retime the portal must hand the shift back as pending — a second confirm
    returns a count of 1, which is the same signal the confirm strip reads to
    put "Jeg har set det" back on screen."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    assert _confirm_via_portal(client, "tok-agnes") == 1
    # Idempotent while nothing material changed — nothing left pending.
    assert _confirm_via_portal(client, "tok-agnes") == 0

    _override_user(owner)
    res = client.put(
        f"/api/staff/schedules/{shift.id}",
        json=_put_body(staff=agnes, on_date=D, start="11:00", end="19:00"),
    )
    assert res.status_code == 200, res.text
    _override_user(None)

    assert _confirm_via_portal(client, "tok-agnes") == 1
    assert _confirmed_at(db, shift.id) is not None
