"""
Schedule overlap guard + team-schedule draft-leak filter.

Two server-side barriers behind the Vagtplanen redesign:

  A. POST /api/staff/schedules + PUT /api/staff/schedules/{id} reject a shift
     that time-overlaps another shift the SAME staffer already has that day
     (409 shift_overlap). The grid disables occupied cells client-side; this is
     the barrier against a stale grid / race / direct API call that would
     double-book one person and silently inflate labor cost + payroll.

     CRITICAL non-regressions (the guard must NOT be a naive UNIQUE(staff,date)):
       • Split shifts allowed     — 11:00–15:00 lunch + 18:00–23:00 dinner
       • Back-to-back allowed     — 11:00–15:00 + 15:00–23:00 (touching ends)
       • Overnight handled        — 16:00–23:00 vs 18:00–02:00 DO overlap

  B. GET /api/portal/{token}/team-schedule returns ONLY published/confirmed
     shifts. Draft shifts the owner is still planning must never leak into a
     teammate's who's-on strip or the swap-target picker (task #294 fixed the
     own-schedule tab; this is the transparency endpoint that was missed).

Run:
  cd backend && python3 -m pytest tests/test_schedule_overlap.py -x -q
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


# ─── Shared in-memory DB + client (mirrors test_staff_today.py) ───────


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


def _owner(db, *, email_suffix: str = "") -> User:
    u = User(
        email=f"owner{email_suffix}@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name=f"Bon Bistro{email_suffix}",
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


def _seed_shift(
    db,
    *,
    owner: User,
    staff: StaffMember,
    on_date: date,
    start_time: str,
    end_time: str,
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
        role_on_shift=None,
        status=status,
    )
    db.add(sh)
    db.commit()
    db.refresh(sh)
    return sh


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


def _create_body(staff, on_date, start, end, status="draft"):
    return {
        "staff_id": str(staff.id),
        "date": on_date.isoformat(),
        "start_time": start,
        "end_time": end,
        "break_minutes": 0,
        "status": status,
    }


D = date.today() + timedelta(days=2)  # any non-window-restricted date for create


# ═══ A. Overlap guard — CREATE ════════════════════════════════════════


def test_create_rejects_overlapping_shift(client, db):
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")
    _override_user(owner)

    res = client.post("/api/staff/schedules", json=_create_body(agnes, D, "18:00", "22:00"))
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "shift_overlap"


def test_create_allows_split_shift(client, db):
    """Lunch + dinner same day for the same person is legitimate — NOT a UNIQUE."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="11:00", end_time="15:00")
    _override_user(owner)

    res = client.post("/api/staff/schedules", json=_create_body(agnes, D, "18:00", "23:00"))
    assert res.status_code == 200, res.text


def test_create_allows_back_to_back(client, db):
    """Touching ends (15:00 end + 15:00 start) do NOT overlap — half-open."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="11:00", end_time="15:00")
    _override_user(owner)

    res = client.post("/api/staff/schedules", json=_create_body(agnes, D, "15:00", "23:00"))
    assert res.status_code == 200, res.text


def test_create_allows_overnight_non_overlap(client, db):
    """An early shift and a late overnight bar shift that don't touch are fine."""
    owner = _owner(db)
    lars = _staff(db, owner, name="Lars", role="bartender")
    _seed_shift(db, owner=owner, staff=lars, on_date=D, start_time="06:00", end_time="10:00")
    _override_user(owner)

    res = client.post("/api/staff/schedules", json=_create_body(lars, D, "22:00", "02:00"))
    assert res.status_code == 200, res.text


def test_create_rejects_overnight_overlap(client, db):
    """16:00–23:00 vs 18:00–02:00 overlap once the overnight span rolls +24h."""
    owner = _owner(db)
    lars = _staff(db, owner, name="Lars", role="bartender")
    _seed_shift(db, owner=owner, staff=lars, on_date=D, start_time="16:00", end_time="23:00")
    _override_user(owner)

    res = client.post("/api/staff/schedules", json=_create_body(lars, D, "18:00", "02:00"))
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "shift_overlap"


def test_create_overlap_scoped_to_same_staff(client, db):
    """A shift for Agnes must not block an overlapping shift for a DIFFERENT
    staffer the same day — two people work the same hours all the time."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    bo = _staff(db, owner, name="Bo")
    _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")
    _override_user(owner)

    res = client.post("/api/staff/schedules", json=_create_body(bo, D, "16:00", "23:00"))
    assert res.status_code == 200, res.text


def test_create_overlap_is_tenant_scoped(client, db):
    """Owner B creating a shift can never be blocked by owner A's rows — the
    guard query is filtered by user_id."""
    owner_a = _owner(db, email_suffix="a")
    owner_b = _owner(db, email_suffix="b")
    a_staff = _staff(db, owner_a, name="A-Agnes")
    b_staff = _staff(db, owner_b, name="B-Bo")
    _seed_shift(db, owner=owner_a, staff=a_staff, on_date=D, start_time="16:00", end_time="23:00")
    _override_user(owner_b)

    res = client.post("/api/staff/schedules", json=_create_body(b_staff, D, "16:00", "23:00"))
    assert res.status_code == 200, res.text


# ═══ A. Overlap guard — UPDATE / move ═════════════════════════════════


def test_update_rejects_move_onto_overlap(client, db):
    """Drag-to-move PUTs the shift to a new (staff, date). Landing it on top of
    an existing overlapping shift the same staffer has must 409."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    # Agnes already works Tuesday evening.
    _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")
    # A movable shift on the day before.
    mover = _seed_shift(
        db, owner=owner, staff=agnes, on_date=D - timedelta(days=1),
        start_time="18:00", end_time="22:00", status="draft",
    )
    _override_user(owner)

    res = client.put(
        f"/api/staff/schedules/{mover.id}",
        json=_create_body(agnes, D, "18:00", "22:00"),  # move onto the busy day
    )
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == "shift_overlap"


def test_update_unchanged_shift_does_not_self_conflict(client, db):
    """Re-saving a shift unchanged must not see ITSELF as an overlap
    (exclude_id). A naive guard would 409 every edit."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    sh = _seed_shift(
        db, owner=owner, staff=agnes, on_date=D,
        start_time="16:00", end_time="23:00", status="draft",
    )
    _override_user(owner)

    res = client.put(
        f"/api/staff/schedules/{sh.id}",
        json=_create_body(agnes, D, "16:00", "23:00"),
    )
    assert res.status_code == 200, res.text


def test_move_to_empty_day_succeeds(client, db):
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    sh = _seed_shift(
        db, owner=owner, staff=agnes, on_date=D,
        start_time="16:00", end_time="23:00", status="draft",
    )
    _override_user(owner)

    res = client.put(
        f"/api/staff/schedules/{sh.id}",
        json=_create_body(agnes, D + timedelta(days=1), "16:00", "23:00"),
    )
    assert res.status_code == 200, res.text


# ═══ B. team-schedule draft-leak filter ═══════════════════════════════


def _team_schedule(client, token):
    return client.get(f"/api/portal/{token}/team-schedule")


def test_team_schedule_excludes_draft_shifts(client, db):
    """A draft shift the owner is still planning must NOT appear in a
    teammate's who's-on view."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    bo = _staff(db, owner, name="Bo")
    _link(db, owner, bo, token="bo-token-aaaa")

    when = date.today() + timedelta(days=1)
    _seed_shift(db, owner=owner, staff=agnes, on_date=when,
                start_time="16:00", end_time="23:00", status="draft")

    res = _team_schedule(client, "bo-token-aaaa")
    assert res.status_code == 200, res.text
    assert res.json() == [], "draft shift leaked into team-schedule"


def test_team_schedule_includes_published_and_confirmed(client, db):
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    cilla = _staff(db, owner, name="Cilla")
    bo = _staff(db, owner, name="Bo")
    _link(db, owner, bo, token="bo-token-bbbb")

    when = date.today() + timedelta(days=1)
    _seed_shift(db, owner=owner, staff=agnes, on_date=when,
                start_time="16:00", end_time="23:00", status="published")
    _seed_shift(db, owner=owner, staff=cilla, on_date=when,
                start_time="10:00", end_time="15:00", status="confirmed")

    res = _team_schedule(client, "bo-token-bbbb")
    assert res.status_code == 200, res.text
    names = {row["staff_name"] for row in res.json()}
    assert names == {"Agnes", "Cilla"}, res.json()


# ═══ C. Zero-length + malformed-time validators (post-audit hardening) ═══

from app.routers.staff import _shifts_overlap, _calc_shift_hours  # noqa: E402


def test_zero_length_shift_is_rejected_422(client, db):
    """The audit's blocking defect: a 16:00–16:00 fat-finger must not be stored
    (it would shadow the whole day in the overlap guard + log 24h in payroll)."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _override_user(owner)
    res = client.post("/api/staff/schedules", json=_create_body(agnes, D, "16:00", "16:00"))
    assert res.status_code == 422, res.text


def test_zero_length_never_blocks_a_later_shift(client, db):
    """The legit afternoon shift the zero-length row would have blocked is
    accepted (the zero-length one can't be created in the first place)."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _override_user(owner)
    client.post("/api/staff/schedules", json=_create_body(agnes, D, "16:00", "16:00"))  # 422, no row
    res = client.post("/api/staff/schedules", json=_create_body(agnes, D, "16:00", "20:00"))
    assert res.status_code == 200, res.text


def test_malformed_time_is_422_not_500(client, db):
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _override_user(owner)
    for bad in ("", "25:00", "16:60", "8", "abc"):
        res = client.post("/api/staff/schedules", json=_create_body(agnes, D, bad, "23:00"))
        assert res.status_code == 422, f"{bad!r} -> {res.status_code}: {res.text}"


def test_overlap_helper_zero_length_point_overlaps_nothing():
    # A zero-length [16:00,16:00) interval intersects no other interval.
    assert _shifts_overlap("16:00", "16:00", "18:00", "22:00") is False
    assert _shifts_overlap("18:00", "22:00", "16:00", "16:00") is False


def test_calc_shift_hours_zero_length_is_zero_not_24():
    assert _calc_shift_hours("16:00", "16:00", 0) == 0.0


def test_calc_shift_hours_overnight_still_correct():
    # Strict-< must NOT break a real midnight-crossing shift: 22:00–02:00 = 4.0h.
    assert _calc_shift_hours("22:00", "02:00", 0) == 4.0
