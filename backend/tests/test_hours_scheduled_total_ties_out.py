"""The period card and the period TABLE must report the same scheduled hours.

THE BUG. /staff/hours/summary reports each staff member's scheduled hours
already rounded to 1dp — that is the figure their row shows and the figure
their pay is reckoned on — and the Hours table sums those rounded rows into
its Total. /staff/hours/overview accumulated every shift raw and rounded once
at the end. Shift lengths come from HH:MM strings, so they land on odd
fractions, and eight of them rounded individually drift from the same eight
rounded together.

Both answers were on screen at the same time. On a real account:

    period card :  "193,8 t planned on the schedule"
    table Total :  "193,6 t"

Twelve minutes, on the screen an owner uses to check a month of labour before
paying people, and the number is multiplied by an hourly rate downstream.

WHY THE EXISTING PARITY GUARD MISSED IT: tests/test_schedule_hours_parity.py
locks the per-SHIFT helpers to each other (portal == ledger == grid) and they
do agree — 08:00-08:00 is 0h everywhere. The disagreement is one level up, in
how shifts are TOTALLED, which no test reached.

NOT DONE HERE, deliberately: actual_total is left alone. measured_hours,
typed_hours and schedule_hours decompose ACTUAL by entry method and already
tie out to it exactly; rounding actual per-staff would fix nothing and break
that. Nothing decomposes scheduled_total, so it is safe to move.
"""
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, Schedule
from app.models.user import User
from app.services.auth import hash_password, get_current_user

_db_ready.set()

FROM, TO = "2026-06-01", "2026-06-30"

# 09:00-17:10, no break = 8h10m = 8.1666..h, which reports as 8.17 at the
# endpoints' 2 decimals. Two staff: the ROWS read 8.17 each and sum to 16.34,
# while the raw total 16.3333.. rounds to 16.33. Chosen so the drift does not
# depend on half-way rounding behaviour, and so it survives at 2dp — a
# quarter-hour roster would not, because n x 6.25 is exact at two decimals.
_START, _END = "09:00", "17:10"


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


def _seed(db, staff_count=2, status="published"):
    u = User(
        id=uuid.uuid4(), email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    for i in range(staff_count):
        m = StaffMember(id=uuid.uuid4(), user_id=u.id, name=f"Staff {i}",
                        role="server", base_rate=150)
        db.add(m); db.commit(); db.refresh(m)
        db.add(Schedule(
            id=uuid.uuid4(), user_id=u.id, staff_id=m.id, date=date(2026, 6, 10),
            start_time=_START, end_time=_END, break_minutes=0, status=status,
        ))
    db.commit()
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _both(client):
    ov = client.get("/api/staff/hours/overview",
                    params={"from": FROM, "to": TO, "compare": "prev"})
    su = client.get("/api/staff/hours/summary", params={"from": FROM, "to": TO})
    assert ov.status_code == 200, ov.text
    assert su.status_code == 200, su.text
    body = su.json()
    rows = body if isinstance(body, list) else body.get("summary", body.get("rows", []))
    return ov.json(), rows


def test_the_card_and_the_table_report_the_same_scheduled_hours(client, db):
    """The one that matters: two numbers, one quantity, one screen."""
    _seed(db, staff_count=2)
    ov, rows = _both(client)

    rows_total = round(sum(r["scheduled_hours"] for r in rows), 2)
    assert ov["hours"]["scheduled_total"] == rows_total, (
        f"period card says {ov['hours']['scheduled_total']} t, the table Total "
        f"sums its own rows to {rows_total} t"
    )


def test_it_is_the_sum_of_the_rows_the_owner_can_see(client, db):
    """Pins the DIRECTION. 16.34 is the sum of two visible 8.17s; 16.33 is the
    raw total rounded once, which matches no row on the screen."""
    _seed(db, staff_count=2)
    ov, rows = _both(client)

    assert [r["scheduled_hours"] for r in rows] == [8.17, 8.17]
    assert ov["hours"]["scheduled_total"] == 16.34, "regressed to round-once"
    assert ov["hours"]["scheduled_total"] != 16.33


def test_the_drift_grows_with_headcount(client, db):
    """Eight staff is a small café, and the error scales with the roster."""
    _seed(db, staff_count=8)
    ov, rows = _both(client)

    assert len(rows) == 8
    assert ov["hours"]["scheduled_total"] == round(sum(r["scheduled_hours"] for r in rows), 2)
    assert ov["hours"]["scheduled_total"] == 65.36     # 8 x 8.17
    assert ov["hours"]["scheduled_total"] != 65.33     # raw rounded once


def test_diff_ties_out_to_the_same_rows(client, db):
    """diff = actual - scheduled, so a scheduled total nobody can see makes
    the Diff column wrong too."""
    _seed(db, staff_count=2)
    ov, rows = _both(client)

    rows_diff = round(
        sum(r["actual_hours"] for r in rows) - sum(r["scheduled_hours"] for r in rows), 2,
    )
    assert ov["hours"]["diff"] == rows_diff


def test_the_real_world_roster_ties_out_exactly(client, db):
    """The shape this actually takes in production — and why 2dp ends it.

    Rosters are built on quarter-hours, so every staff total lands on .25 or
    .75. At ONE decimal those are half-way cases and Python rounds half-to-
    EVEN (31.25 -> 31.2 but 18.75 -> 18.8), which is how a real month summed to
    193.6 under a card that said 193.8.

    At TWO decimals — the precision total_hours is actually stored at — a
    quarter-hour total needs no rounding at all, so sum-of-rounded and
    rounded-raw are the same number by construction and there is nothing left
    to drift. Reporting the precision the data has is the fix; sum-of-rounded
    is the belt that holds for the shapes that are not exact (see the 09:00-
    17:10 cases above, which still drift and still pass).

    Reproduces the live September roster: 8 staff, 193.75 h.
    """
    u = User(
        id=uuid.uuid4(), email="real@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)

    # (name, number of 6.25h shifts) -> the live September roster's shape.
    roster = [("Agnes", 8), ("Aksel", 5), ("Alma", 4), ("Clara", 1),
              ("demo", 3), ("Frederik", 1), ("risha", 4), ("sangita", 5)]
    for name, n in roster:
        m = StaffMember(id=uuid.uuid4(), user_id=u.id, name=name,
                        role="server", base_rate=150)
        db.add(m); db.commit(); db.refresh(m)
        for i in range(n):
            db.add(Schedule(
                id=uuid.uuid4(), user_id=u.id, staff_id=m.id,
                date=date(2026, 6, 1 + i),
                start_time="09:00", end_time="15:15",   # 6.25 h
                break_minutes=0, status="published",
            ))
    db.commit()
    app.dependency_overrides[get_current_user] = lambda: u

    ov, rows = _both(client)
    by_name = {r["staff_name"]: r["scheduled_hours"] for r in rows}

    # Half-to-even, per staff, visible on their own row.
    # Exact at 2dp — no rounding happens, so nothing can be lost.
    assert by_name["Aksel"] == 31.25
    assert by_name["demo"] == 18.75
    assert by_name["Agnes"] == 50.0

    assert ov["hours"]["scheduled_total"] == round(sum(by_name.values()), 2)
    assert ov["hours"]["scheduled_total"] == 193.75
    assert ov["hours"]["scheduled_total"] != 193.8, "regressed to 1dp round-once"
    assert ov["hours"]["scheduled_total"] != 193.6, "regressed to 1dp sum-of-rounded"


def test_a_draft_roster_still_counts_for_neither(client, db):
    """Both endpoints read the COMMITTED roster only. If they ever disagree on
    which shifts count, the totals diverge for a reason no rounding fix can
    reach — so pin that they agree on zero, too."""
    _seed(db, staff_count=2, status="draft")
    ov, rows = _both(client)

    assert ov["hours"]["scheduled_total"] == 0.0
    assert sum(r["scheduled_hours"] for r in rows) == 0.0
