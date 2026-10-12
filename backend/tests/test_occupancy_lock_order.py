"""
Two devices seating the same two tables never deadlock into a 500.

WHY THIS EXISTS. A party across joined tables holds one occupancy row per
table, and Postgres vets each row against the exclusion constraint as it is
inserted — waiting, on a competing row not yet committed, for that other
transaction. The stand sends joined tables in label order, the booking engine
in (capacity, id) order. Two inserts of A, B and B, A each waited on the other;
Postgres killed one with "deadlock detected" (40P01), which nothing caught: a
500 (review on Postgres 16: 1 in 40 truly simultaneous pairs).

Locks under test:
  • the hold rows are written in one order — the tables' ids — whatever order
    the caller names them in (so the second writer waits, then loses cleanly);
  • that order is the WRITE order only: the reservation's primary table and
    combined_resource_ids ("6 + 7" on the book) stay in the order sent;
  • a deadlock that still reaches the insert is a lost race: rolled back,
    then 409 slot_unavailable (or a re-pick, where the caller re-picks) —
    and any other OperationalError is NOT swallowed as a 409.

The real two-connection race runs against Postgres in the review harness
(pg_race.py); SQLite has no exclusion constraint, so the deadlock is
simulated here.

Run: cd backend && python3 -m pytest tests/test_occupancy_lock_order.py -q
"""

import json
import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.user import User
from app.services import reservation_occupancy_service as occ
from app.services.auth import get_current_user
from app.services.tz_utils import now_local

_db_ready.set()

_SETTINGS = {
    "turn_time_tiers": [{"up_to": 2, "minutes": 90}, {"up_to": 8, "minutes": 120}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 50,
    "combine_enabled": True,
    "max_combo_size": 3,
    "retention_days": 90,
}

# Ids chosen so the order sent (high, low) is the reverse of the id order.
_HIGH = uuid.UUID("f0000000-0000-4000-8000-000000000001")
_LOW = uuid.UUID("10000000-0000-4000-8000-000000000002")
_MID = uuid.UUID("80000000-0000-4000-8000-000000000003")


@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


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

    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()
    app.dependency_overrides.update(prev)


def _venue(db, act_as=True):
    """Three joinable tables with fixed ids: H (4), L (4), M (2)."""
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Havnen", business_type="restaurant", currency="DKK",
        plan="pro", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    hours = {k: "00:00-23:59" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    profile = BusinessProfile(
        user_id=u.id, company_name="Havnen", reservations_enabled=True,
        reservation_slug=f"hav-{uuid.uuid4().hex[:6]}",
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(hours),
    )
    db.add(profile)
    for i, (rid, label, seats) in enumerate(((_HIGH, "H", 4), (_LOW, "L", 4), (_MID, "M", 2))):
        db.add(BookableResource(id=rid, user_id=u.id, kind="table", label=label, capacity_seats=seats,
                                zone="Sal", combinable=True, sort_order=i))
    db.commit()
    db.refresh(profile)
    if act_as:
        app.dependency_overrides[get_current_user] = lambda: u
    return u, profile


def _start(user):
    return now_local(user).replace(tzinfo=None, second=0, microsecond=0)


def _reservation(user, start, party=6):
    return Reservation(
        user_id=user.id, guest_name="Drop-in", party_size=party,
        starts_at=start, ends_at=start + timedelta(minutes=120), duration_min=120,
        status="seated", source="walk_in",
    )


class _InsertLog:
    """The resource ids of reservation_occupancy INSERTs, in the order the
    rows reach the database cursor (an executemany batch row by row)."""

    def __init__(self, engine):
        self.engine = engine
        self.ids: list[uuid.UUID] = []

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._seen)
        return self

    def __exit__(self, *exc):
        event.remove(self.engine, "before_cursor_execute", self._seen)

    def _seen(self, conn, cursor, statement, parameters, context, executemany):
        if not statement.lstrip().upper().startswith("INSERT INTO RESERVATION_OCCUPANCY"):
            return
        cols = [c.strip() for c in statement.split("(", 1)[1].split(")", 1)[0].split(",")]
        at = cols.index("resource_id")
        if executemany:
            rows = list(parameters)
        else:  # one statement, possibly several VALUES groups, flat parameters
            flat = list(parameters)
            rows = [flat[i:i + len(cols)] for i in range(0, len(flat), len(cols))]
        for p in rows:
            self.ids.append(uuid.UUID(str(p[at])))


def _deadlock(orig=None):
    """What SQLAlchemy raises when Postgres aborts the insert to break a
    deadlock: an OperationalError wrapping psycopg2's DeadlockDetected."""
    if orig is None:
        class _PgDeadlock(Exception):
            pgcode = "40P01"
        orig = _PgDeadlock("deadlock detected")
    return OperationalError("INSERT INTO reservation_occupancy ...", {}, orig)


# ── the write order ──────────────────────────────────────────────────

def test_rows_are_staged_in_table_id_order_whatever_order_they_are_named(db):
    u, _ = _venue(db)
    r = _reservation(u, _start(u))
    db.add(r); db.flush()
    # Mixed spellings as the callers pass them: str, UUID, upper-case str.
    rows = occ.add_occupancy_rows(db, r, [str(_HIGH), _MID, None, str(_LOW).upper()])
    assert [uuid.UUID(str(o.resource_id)) for o in rows] == [_LOW, _MID, _HIGH]
    db.rollback()


def test_the_inserts_reach_the_database_in_id_order_and_the_book_keeps_the_order_sent(db, engine_and_session):
    """The service path every create goes through. Sent H then L: the rows
    hit the cursor L, H — and the booking still reads H + L, H its primary
    table, exactly as the stand named them."""
    engine, _ = engine_and_session
    u, profile = _venue(db)
    start = _start(u)
    r = _reservation(u, start)
    with _InsertLog(engine) as log:
        occ.create_reservation_with_occupancy(
            db, profile=profile, reservation=r, initial_resource_ids=[_HIGH, _LOW],
            party_size=6, start=start, duration_min=120, now=None, reassign=False,
        )
    assert log.ids == [_LOW, _HIGH]
    db.expire_all()
    row = db.query(Reservation).filter(Reservation.id == r.id).one()
    assert uuid.UUID(str(row.resource_id)) == _HIGH
    assert row.combined_resource_ids == [str(_HIGH), str(_LOW)]


def test_a_drop_in_across_joined_tables_answers_in_the_order_sent(client, db, engine_and_session):
    """Through POST /book, as the stand sends it (label order)."""
    engine, _ = engine_and_session
    u, _ = _venue(db)
    with _InsertLog(engine) as log:
        res = client.post("/api/reservations/book", json={
            "guest_name": "Drop-in", "party_size": 9, "starts_at": _start(u).isoformat(),
            "status": "seated", "source": "walk_in",
            "resource_ids": [str(_HIGH), str(_MID), str(_LOW)],
        })
    assert res.status_code in (200, 201), res.text
    body = res.json()
    assert body["resource_id"] == str(_HIGH)
    assert body["combined_resource_ids"] == [str(_HIGH), str(_MID), str(_LOW)]
    assert log.ids == [_LOW, _MID, _HIGH]


# ── a deadlock is a lost race, never a 500 ───────────────────────────

def test_deadlock_detection_reads_the_sqlstate():
    assert occ.is_deadlock(_deadlock())
    psycopg2_errors = pytest.importorskip("psycopg2.errors")
    assert occ.is_deadlock(_deadlock(psycopg2_errors.DeadlockDetected("deadlock detected")))

    class _ConnectionLost(Exception):
        pgcode = "08006"
    assert not occ.is_deadlock(OperationalError("SELECT 1", {}, _ConnectionLost("gone")))
    assert not occ.is_deadlock(OperationalError("SELECT 1", {}, Exception("no code")))


def test_a_deadlock_on_named_tables_is_slot_unavailable_and_rolled_back(db):
    u, profile = _venue(db)
    start = _start(u)
    real_commit = db.commit
    calls = {"n": 0}

    def deadlocked_commit():
        calls["n"] += 1
        raise _deadlock()

    db.commit = deadlocked_commit  # type: ignore[method-assign]
    try:
        with pytest.raises(occ.SlotUnavailable):
            occ.create_reservation_with_occupancy(
                db, profile=profile, reservation=_reservation(u, start),
                initial_resource_ids=[_HIGH, _LOW], party_size=6, start=start,
                duration_min=120, now=None, reassign=False,
            )
    finally:
        db.commit = real_commit  # type: ignore[method-assign]
    assert calls["n"] == 1, "a named table must not be re-picked after a deadlock"
    # Rolled back: nothing of the losing insert survives, and the session works.
    assert db.query(Reservation).count() == 0
    assert db.query(ReservationOccupancy).count() == 0


def test_a_deadlock_where_the_engine_picks_is_retried_like_any_lost_race(db):
    u, profile = _venue(db)
    start = _start(u)
    real_commit = db.commit
    calls = {"n": 0}

    def deadlock_once():
        calls["n"] += 1
        if calls["n"] == 1:
            raise _deadlock()
        return real_commit()

    db.commit = deadlock_once  # type: ignore[method-assign]
    try:
        r = occ.create_reservation_with_occupancy(
            db, profile=profile, reservation=_reservation(u, start, party=2),
            initial_resource_ids=[_MID], party_size=2, start=start,
            duration_min=90, now=None, reassign=True,
        )
    finally:
        db.commit = real_commit  # type: ignore[method-assign]
    assert calls["n"] == 2
    db.expire_all()
    assert db.query(Reservation).filter(Reservation.id == r.id).count() == 1
    assert db.query(ReservationOccupancy).filter(ReservationOccupancy.active.is_(True)).count() == 1


def test_any_other_operational_error_is_not_turned_into_a_409(db):
    u, profile = _venue(db)
    start = _start(u)

    class _ConnectionLost(Exception):
        pgcode = "08006"

    def lost():
        raise OperationalError("COMMIT", {}, _ConnectionLost("server closed the connection"))

    real_commit = db.commit
    db.commit = lost  # type: ignore[method-assign]
    try:
        with pytest.raises(OperationalError):
            occ.create_reservation_with_occupancy(
                db, profile=profile, reservation=_reservation(u, start),
                initial_resource_ids=[_HIGH, _LOW], party_size=6, start=start,
                duration_min=120, now=None, reassign=False,
            )
    finally:
        db.commit = real_commit  # type: ignore[method-assign]
        db.rollback()


def test_the_stand_gets_a_409_not_a_500_when_its_insert_deadlocks(client, db, monkeypatch):
    """The review's failure, end to end: the second of two simultaneous
    drop-ins on the same joined tables. Postgres aborts its insert; the stand
    must get the clash answer it already handles, and nothing is written."""
    u, _ = _venue(db)
    real_add = occ.add_occupancy_rows

    def deadlocking_add(*args, **kwargs):
        real_add(*args, **kwargs)
        raise _deadlock()

    monkeypatch.setattr(occ, "add_occupancy_rows", deadlocking_add)
    res = client.post("/api/reservations/book", json={
        "guest_name": "Drop-in", "party_size": 6, "starts_at": _start(u).isoformat(),
        "status": "seated", "source": "walk_in", "resource_ids": [str(_HIGH), str(_LOW)],
    })
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == {"error": "slot_unavailable"}
    db.expire_all()
    assert db.query(Reservation).count() == 0
    assert db.query(ReservationOccupancy).count() == 0
