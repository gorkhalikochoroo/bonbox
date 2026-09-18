"""
An acknowledgement that survives Fortryd.

THE REGRESSION THIS FIXES
-------------------------
HEAD's update_schedule cleared confirmed_at whenever staff_id / date /
start_time / end_time changed. Correct for a real move — and destructive for the
one interaction the owner grid performs most, because drag-to-move ships a
6-second "Fortryd" that replays the SAME PUT with the ORIGINAL values. The clear
already happened on the way out, the undo had nothing to restore, and so an
accidental drag permanently destroyed a staffer's "Jeg har set det" and the
portal re-asked them to confirm a byte-identical shift. The badge that is meant
to buy the owner calm instead taught everyone to ignore it.

THE FIX
-------
The server stamps WHAT was acknowledged (Schedule.confirmed_for — a fingerprint
of who/when) next to WHEN, and `confirmed_current` compares. A move makes them
disagree; an undo makes them agree again. Nothing is erased, so nothing has to
be restored.

WHAT IS PINNED HERE
-------------------
  • undo restores the acknowledgement (the actual regression)
  • the fingerprint is stable across equivalent time spellings ("9:00" / "09:00")
  • legacy rows (confirmed_at set, confirmed_for NULL) read as CURRENT —
    nobody moved them, so we fail toward not nagging staff
  • the portal re-asks, and does NOT re-ask after an undo
  • the owner's week summary counts current acknowledgements, not stamps

Run:
  cd backend && python3 -m pytest tests/test_schedule_confirm_fingerprint.py -x -q
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
from app.utils.schedule_fingerprint import (
    confirmation_is_current,
    fingerprint_for_shift,
    shift_fingerprint,
)

_db_ready.set()


# ═══ Pure unit: the fingerprint itself ════════════════════════════════
#
# These need no DB. They pin the normalisation promise, which is the part a
# future edit is most likely to break without any endpoint test noticing.


_SID = uuid.uuid4()


def test_fingerprint_is_deterministic():
    a = shift_fingerprint(staff_id=_SID, shift_date=date(2026, 9, 18), start_time="16:00", end_time="23:00")
    b = shift_fingerprint(staff_id=_SID, shift_date=date(2026, 9, 18), start_time="16:00", end_time="23:00")
    assert a == b
    # Not Python's salted hash() — it has to survive a worker restart.
    assert len(a) <= 64


def test_fingerprint_is_stable_across_equivalent_time_formats():
    """"9:00" and "09:00" are the same minute. An older client, a CSV import or
    a hand-written API call must not be able to retract an acknowledgement just
    by spelling the time differently."""
    padded = shift_fingerprint(staff_id=_SID, shift_date=date(2026, 9, 18), start_time="09:00", end_time="17:05")
    bare = shift_fingerprint(staff_id=_SID, shift_date=date(2026, 9, 18), start_time="9:00", end_time="17:05")
    assert padded == bare


def test_fingerprint_is_stable_across_equivalent_id_and_date_formats():
    upper = shift_fingerprint(
        staff_id=str(_SID).upper(), shift_date="2026-09-18", start_time="09:00", end_time="17:00",
    )
    native = shift_fingerprint(
        staff_id=_SID, shift_date=date(2026, 9, 18), start_time="09:00", end_time="17:00",
    )
    assert upper == native


@pytest.mark.parametrize("field,value", [
    ("staff_id", uuid.uuid4()),
    ("shift_date", date(2026, 9, 19)),
    ("start_time", "10:00"),
    ("end_time", "18:00"),
])
def test_each_material_fact_changes_the_fingerprint(field, value):
    base = dict(staff_id=_SID, shift_date=date(2026, 9, 18), start_time="09:00", end_time="17:00")
    moved = {**base, field: value}
    assert shift_fingerprint(**base) != shift_fingerprint(**moved)


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
        id=uuid.uuid4(), user_id=owner.id, name=name, role=role,
        active=True, is_deleted=False,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _link(db, owner: User, staff: StaffMember, token: str) -> StaffLink:
    lk = StaffLink(
        id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id, token=token, active=True,
    )
    db.add(lk)
    db.commit()
    db.refresh(lk)
    return lk


def _seed_shift(db, *, owner, staff, on_date, start_time, end_time) -> Schedule:
    sh = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id, date=on_date,
        start_time=start_time, end_time=end_time, break_minutes=30,
        role_on_shift="Server", status="published", notes="Opening",
    )
    db.add(sh)
    db.commit()
    db.refresh(sh)
    return sh


def _put_body(*, staff, on_date, start, end, notes="Opening"):
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


# The portal's confirm window is [Monday of this week, +20 days].
D = date.today() + timedelta(days=2)
D_MOVED = D + timedelta(days=1)


def _confirm_via_portal(client, token: str) -> int:
    res = client.post(f"/api/portal/{token}/confirm-schedule", json={})
    assert res.status_code == 200, res.text
    return res.json()["confirmed_count"]


def _portal_shift(client, token: str, shift_id) -> dict:
    """The shift exactly as the staffer's phone receives it."""
    res = client.get(f"/api/portal/{token}/schedule")
    assert res.status_code == 200, res.text
    for s in res.json()["shifts"]:
        if s["id"] == str(shift_id):
            return s
    raise AssertionError(f"shift {shift_id} not in portal payload")


def _row(db, shift_id) -> Schedule:
    db.expire_all()
    return db.query(Schedule).filter(Schedule.id == shift_id).first()


def _put(client, shift, **kw):
    res = client.put(f"/api/staff/schedules/{shift.id}", json=_put_body(**kw))
    assert res.status_code == 200, res.text
    return res.json()


# ═══ THE REGRESSION: drag → Fortryd ═══════════════════════════════════


def test_undo_restores_the_acknowledgement(client, db):
    """Drag Agnes's confirmed shift to Saturday, then hit Fortryd.

    The undo is not a special endpoint — the grid replays the SAME PUT with the
    original values. Under the clearing behaviour the stamp was already gone and
    this test could not have passed at all: an accidental drag cost a real
    acknowledgement forever. With the fingerprint there is nothing to restore,
    because nothing was destroyed.
    """
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    assert _confirm_via_portal(client, "tok-agnes") == 1
    _override_user(owner)

    moved = _put(client, shift, staff=agnes, on_date=D_MOVED, start="16:00", end="23:00")
    assert moved["confirmed_current"] is False

    # Fortryd — the original row, byte for byte.
    undone = _put(client, shift, staff=agnes, on_date=D, start="16:00", end="23:00")
    assert undone["confirmed_current"] is True
    assert _row(db, shift.id).confirmed_current is True


def test_portal_does_not_re_ask_after_an_undo(client, db):
    """The other half of the same story, from the staffer's phone. An owner's
    misdrag they immediately took back must not reach the staffer at all."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    assert _confirm_via_portal(client, "tok-agnes") == 1

    _override_user(owner)
    _put(client, shift, staff=agnes, on_date=D_MOVED, start="16:00", end="23:00")
    _put(client, shift, staff=agnes, on_date=D, start="16:00", end="23:00")
    _override_user(None)

    # Nothing pending → the confirm strip stays quiet.
    assert _confirm_via_portal(client, "tok-agnes") == 0
    portal = _portal_shift(client, "tok-agnes", shift.id)
    assert portal["confirmed_current"] is True
    assert portal["confirmed_at"] is not None


def test_portal_re_asks_after_a_real_move(client, db):
    """A move that is NOT undone has to reach the staffer — including through
    the payload the portal's own confirm list is built from. The portal filters
    on `!sh.confirmed_at`, so a stale stamp there would silently exclude the
    moved shift from the very request meant to re-acknowledge it."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    assert _confirm_via_portal(client, "tok-agnes") == 1

    _override_user(owner)
    _put(client, shift, staff=agnes, on_date=D, start="11:00", end="19:00")
    _override_user(None)

    portal = _portal_shift(client, "tok-agnes", shift.id)
    assert portal["confirmed_current"] is False
    assert portal["confirmed_at"] is None       # the button comes back
    assert _confirm_via_portal(client, "tok-agnes") == 1
    assert _portal_shift(client, "tok-agnes", shift.id)["confirmed_current"] is True


def test_reassigned_shift_is_pending_for_the_new_staffer(client, db):
    """Hand Agnes's confirmed shift to Lars. Agnes's acknowledgement is on the
    row, but it describes a shift that is no longer hers — Lars has to see it."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    lars = _staff(db, owner, name="Lars", role="bartender")
    _link(db, owner, agnes, "tok-agnes")
    _link(db, owner, lars, "tok-lars")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    assert _confirm_via_portal(client, "tok-agnes") == 1

    _override_user(owner)
    _put(client, shift, staff=lars, on_date=D, start="16:00", end="23:00")
    _override_user(None)

    assert _confirm_via_portal(client, "tok-lars") == 1
    assert _row(db, shift.id).confirmed_current is True


# ═══ Legacy rows ══════════════════════════════════════════════════════


def test_legacy_confirmation_reads_as_current(client, db):
    """confirmed_at set, confirmed_for NULL — every row acknowledged before the
    column existed. Nobody moved them, and the honest failure direction is to
    not nag staff about shifts that never changed. Deliberately no backfill: a
    computed fingerprint would ASSERT the shift is unchanged since
    acknowledgement, which is exactly what we cannot know for historical rows.
    """
    from app.utils.time import utc_now

    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")
    shift.confirmed_at = utc_now()
    shift.confirmed_for = None
    db.commit()

    assert _row(db, shift.id).confirmed_current is True
    assert _confirm_via_portal(client, "tok-agnes") == 0     # not re-asked
    assert _portal_shift(client, "tok-agnes", shift.id)["confirmed_at"] is not None


def test_unconfirmed_row_is_never_current():
    """No stamp, no acknowledgement — whatever else is on the row."""
    class _Bare:
        confirmed_at = None
        confirmed_for = "v1:whatever"

    assert confirmation_is_current(_Bare()) is False


# ═══ The owner's week summary ═════════════════════════════════════════


def test_week_summary_counts_current_acknowledgements_not_stamps(client, db):
    """The dashboard's "N of M confirmed" is the calm signal the owner plans a
    service around. Counting stamps would report Agnes as confirmed for a
    Saturday shift she only ever agreed to work on the Friday."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    monday = D - timedelta(days=D.weekday())
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    assert _confirm_via_portal(client, "tok-agnes") == 1
    _override_user(owner)

    res = client.get("/api/staff/schedule-confirmation-summary", params={"week_start": monday.isoformat()})
    assert res.status_code == 200, res.text
    assert res.json()["confirmed_staff"] == 1
    assert res.json()["all_confirmed"] is True

    # Same-week retime → the acknowledgement no longer describes the shift.
    _put(client, shift, staff=agnes, on_date=D, start="11:00", end="19:00")

    res = client.get("/api/staff/schedule-confirmation-summary", params={"week_start": monday.isoformat()})
    assert res.status_code == 200, res.text
    assert res.json()["confirmed_staff"] == 0
    assert res.json()["all_confirmed"] is False
    assert res.json()["none_confirmed"] is True


def test_confirm_stamps_the_fingerprint_of_the_row_it_confirmed(client, db):
    """The stored value is the shift's OWN fingerprint, not a constant — if the
    two ever drift apart, every acknowledgement silently reads as stale."""
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    _confirm_via_portal(client, "tok-agnes")
    row = _row(db, shift.id)
    assert row.confirmed_for == fingerprint_for_shift(row)


# ═══ The contract the owner grid is built against ════════════════════


def test_week_grid_payload_carries_confirmed_current(client, db):
    """GET /api/staff/schedules is what the Vagtplan grid renders from, and the
    frontend reads `shift.confirmed_current ?? !!shift.confirmed_at`. If the
    field ever stops being serialised the fallback quietly resurrects the bug
    this whole change exists to fix — the badge would go back to trusting a
    stamp that survives a move. So pin the field, not just the value.
    """
    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    monday = D - timedelta(days=D.weekday())
    shift = _seed_shift(db, owner=owner, staff=agnes, on_date=D, start_time="16:00", end_time="23:00")

    _override_user(owner)
    res = client.get("/api/staff/schedules", params={"week_start": monday.isoformat()})
    assert res.status_code == 200, res.text
    row = next(s for s in res.json() if s["id"] == str(shift.id))
    assert "confirmed_current" in row
    assert row["confirmed_current"] is False      # published, never acknowledged
    assert row["confirmed_at"] is None
    _override_user(None)

    _confirm_via_portal(client, "tok-agnes")

    _override_user(owner)
    res = client.get("/api/staff/schedules", params={"week_start": monday.isoformat()})
    row = next(s for s in res.json() if s["id"] == str(shift.id))
    assert row["confirmed_current"] is True
    assert row["confirmed_at"] is not None

    # …and a retime flips it in the very payload the grid re-fetches.
    _put(client, shift, staff=agnes, on_date=D, start="11:00", end="19:00")
    res = client.get("/api/staff/schedules", params={"week_start": monday.isoformat()})
    row = next(s for s in res.json() if s["id"] == str(shift.id))
    assert row["confirmed_current"] is False
    # confirmed_at goes null ON THE WIRE once the fingerprint stops matching,
    # while the row keeps the stamp (asserted below). A client that reads the
    # bare stamp — the COMMITTED ios-scheduler bundle does, and so does the web
    # bundle for the length of any deploy skew — would otherwise show "seen"
    # forever on a shift that moved after it was acknowledged. That is strictly
    # worse than the clearing behaviour this replaced, so the narrowing is the
    # thing that makes the fingerprint safe to ship ahead of any client.
    assert row["confirmed_at"] is None
    assert _row(db, shift.id).confirmed_at is not None    # nothing was erased


def test_today_card_payload_carries_confirmed_current(client, db):
    """The dashboard's "Today on shift" card makes the same claim in the same
    words, from a hand-built dict rather than ScheduleResponse — so it has its
    own way to fall out of step."""
    from app.services.tz_utils import business_today_local

    owner = _owner(db)
    agnes = _staff(db, owner, name="Agnes")
    _link(db, owner, agnes, "tok-agnes")
    # business_today_local, not date.today(): the card follows the DK 06:00
    # business-day cutoff in Europe/Copenhagen, so a suite running at 02:00 CEST
    # (or in any other machine timezone) is still on yesterday's business day.
    _seed_shift(
        db, owner=owner, staff=agnes, on_date=business_today_local(owner),
        start_time="16:00", end_time="23:00",
    )

    _override_user(owner)
    res = client.get("/api/staff/today")
    assert res.status_code == 200, res.text
    shifts = res.json()["shifts"]
    assert shifts, "expected today's shift in the payload"
    assert all("confirmed_current" in s for s in shifts)


# ═══ The column exists where the app will look for it ═════════════════


def test_migration_and_sqlite_mirror_both_carry_the_column():
    """create_all() papers over a missing mirror on a FRESH sqlite db, so no
    other test in this file can fail when the mirror is forgotten — it only
    shows up on someone's existing dev database, or on PG at deploy time."""
    import inspect

    from app.main import _migrations, _run_migrations

    assert any(
        "schedules" in s and "confirmed_for" in s for s in _migrations
    ), "canonical ALTER for schedules.confirmed_for missing from _migrations"
    src = inspect.getsource(_run_migrations)
    assert '_add("schedules", "confirmed_for"' in src, "SQLite mirror missing"
