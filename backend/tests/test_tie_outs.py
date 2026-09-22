"""COMPOSITION TIE-OUTS — the numbers that must agree with each other.

WHY THIS FILE EXISTS. Every correctness bug found in the 2026-09-21 audit was
a seam between two correct parts, not a broken part:

  • per-SHIFT hours parity was tested (portal == ledger == grid) and passed;
    the AGGREGATE was not, and /hours/overview said 193,8 t directly above a
    table whose Total said 193,6 t;
  • the expenses DataTable filtered by personal/business; the total beneath it
    did not, so a business-only view carried a total including personal spend;
  • total_hours stores 2 decimals; the summary re-rounded to 1, so a row read
    "0,6 h x 145 kr./h" next to "83 kr." — arithmetic no owner can reproduce.

Unit tests cannot catch these. Each side is individually right. The defect is
that two independent code paths answer the same question and nobody compares
the answers.

HOW TO USE THIS FILE. Add a row to TIE_OUTS. That is the whole ceremony:

    ("name", lambda ctx: <expression A>, lambda ctx: <expression B>, "why")

The scenario below is shared and deliberately AWKWARD — quarter-hour shifts,
mixed entry methods, someone rostered who never turned up. Clean data (whole
hours, one staff member) hides rounding drift, which is exactly how the
193,8/193,6 defect survived its own parity suite.

WHEN ONE FAILS, the fix is almost never "loosen the assertion". It is either a
real drift, or the two expressions genuinely measure different things — in
which case say so in `why` and pick the pair that a USER sees side by side.
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
from app.models.staff import StaffMember, HoursLogged, Schedule
from app.models.user import User
from app.services.auth import hash_password, get_current_user

_db_ready.set()

FROM, TO = "2026-06-01", "2026-06-30"
D = date(2026, 6, 10)

# 09:00-15:20 is 6h20m = 6.3333... h — a length that does NOT land exactly on
# the 2 decimals these endpoints report.
#
# The shift COUNTS and the shift LENGTH are both load-bearing. 1/3/4 at 6h20m
# is chosen so sum-of-rounded and rounded-sum actually disagree:
#
#     per staff : 6.33   19.0   25.33   = 50.66
#     raw total : 50.6666...                 -> 50.67
#
# TWO earlier drafts went vacuous here and the guard below caught both:
#   • 5/3/1 quarter-hour shifts, where the two coincided at 56.2;
#   • 9/5/1 quarter-hour shifts, which drifted at 1dp but stopped drifting the
#     moment the endpoints moved to 2dp — because n x 6.25 is EXACT at two
#     decimals, so there was nothing left to lose.
# A quarter-hour roster can no longer test this. Do not "tidy" these numbers
# back to round ones.
SHIFT_HOURS = 380 / 60
SHIFT_START, SHIFT_END = "09:00", "15:20"
ROSTER = [("Agnes", 4), ("Bo", 3), ("Cara", 1)]


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
def ctx(engine_and_session):
    """Seed the awkward scenario, return a client that can query every surface."""
    _, SessionLocal = engine_and_session
    db = SessionLocal()

    u = User(
        id=uuid.uuid4(), email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)

    members = {}
    for name, n_shifts in ROSTER:
        m = StaffMember(id=uuid.uuid4(), user_id=u.id, name=name,
                        role="server", base_rate=145, active=True)
        db.add(m); db.commit(); db.refresh(m)
        members[name] = m
        for i in range(n_shifts):
            db.add(Schedule(
                id=uuid.uuid4(), user_id=u.id, staff_id=m.id,
                date=date(2026, 6, 1 + i), start_time=SHIFT_START, end_time=SHIFT_END,
                break_minutes=0, status="published",
            ))
    db.commit()

    # Worked time, deliberately mixed — and none of it matching the roster.
    #   Agnes: a clocked shift with a 2dp figure the 1dp display cannot show
    #   Bo:    an owner-typed row (entry_method quick, no end time)
    #   Cara:  rostered and never turned up — contributes 0 actual
    db.add(HoursLogged(
        id=uuid.uuid4(), user_id=u.id, staff_id=members["Agnes"].id, date=D,
        start_time="15:22", end_time="15:56", break_minutes=0,
        total_hours=0.57, rate_applied=145, earned=82.65, entry_method="clock",
    ))
    db.add(HoursLogged(
        id=uuid.uuid4(), user_id=u.id, staff_id=members["Bo"].id, date=D,
        start_time=None, end_time=None, break_minutes=0,
        total_hours=6.25, rate_applied=145, earned=906.25, entry_method="quick",
    ))
    db.commit()
    # Deliberately NOT closed until teardown: get_current_user hands the router
    # this very instance, and a closed session detaches it.

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: u
    client = TestClient(app)

    cache = {}

    def api(path, **params):
        key = (path, tuple(sorted(params.items())))
        if key not in cache:
            r = client.get(path, params={"from": FROM, "to": TO, **params})
            assert r.status_code == 200, f"{path} -> {r.status_code}: {r.text}"
            cache[key] = r.json()
        return cache[key]

    yield type("Ctx", (), {
        "api": staticmethod(api),
        "overview": staticmethod(lambda: api("/api/staff/hours/overview", compare="prev")),
        "summary": staticmethod(lambda: _rows(api("/api/staff/hours/summary"))),
    })
    app.dependency_overrides.clear()
    db.close()


def _rows(body):
    return body if isinstance(body, list) else body.get("summary", body.get("rows", []))


def _sum(rows, key):
    return round(sum(float(r.get(key) or 0) for r in rows), 2)


# ── THE REGISTRY ──────────────────────────────────────────────────────────────
# (name, expression A, expression B, why a user sees these together)

TIE_OUTS = [
    (
        "scheduled hours: period card vs summary table",
        lambda c: c.overview()["hours"]["scheduled_total"],
        lambda c: round(_sum(c.summary(), "scheduled_hours"), 2),
        "both render on /staff/hours simultaneously — the card above the table",
    ),
    (
        "actual hours: period card vs summary table",
        lambda c: c.overview()["hours"]["actual_total"],
        lambda c: round(_sum(c.summary(), "actual_hours"), 2),
        "the HOURS tile sits directly above the ACTUAL column it summarises",
    ),
    (
        "actual hours: total vs its own entry-method split",
        lambda c: c.overview()["hours"]["actual_total"],
        lambda c: round(
            c.overview()["hours"]["measured_hours"]
            + c.overview()["hours"]["typed_hours"]
            + c.overview()["hours"]["schedule_hours"], 2),
        "measured/typed/schedule partition actual_total; the tile shows both",
    ),
    (
        "diff: period card vs summary table",
        lambda c: c.overview()["hours"]["diff"],
        lambda c: round(
            round(_sum(c.summary(), "actual_hours"), 2)
            - round(_sum(c.summary(), "scheduled_hours"), 2), 2),
        "the DIFF column and the card's diff describe the same shortfall",
    ),
    (
        "labour cost: overview gross vs summary earned",
        lambda c: c.overview()["cost"]["gross"],
        lambda c: _sum(c.summary(), "earned"),
        "the LABOR COST tile is the sum of the EARNED column beneath it",
    ),
]


@pytest.mark.parametrize("name,a,b,why", TIE_OUTS, ids=[t[0] for t in TIE_OUTS])
def test_tie_out(ctx, name, a, b, why):
    va, vb = a(ctx), b(ctx)
    assert va == vb, (
        f"\n  TIE-OUT BROKEN: {name}\n"
        f"    side A = {va}\n"
        f"    side B = {vb}\n"
        f"    drift  = {round(abs(va - vb), 4)}\n"
        f"    why it matters: {why}\n"
        f"  Two code paths answer one question and disagree. Do not loosen this\n"
        f"  assertion — find which side the user is reading and make the other\n"
        f"  one agree with it."
    )


def test_the_scenario_is_actually_awkward(ctx):
    """A tie-out suite over clean data proves nothing.

    Pins that the fixture still produces values where round-then-sum and
    sum-then-round diverge — if someone 'tidies' the roster to whole hours,
    every assertion above would pass vacuously.
    """
    rounded_sum = round(sum(n * SHIFT_HOURS for _, n in ROSTER), 2)
    sum_of_rounded = round(sum(round(n * SHIFT_HOURS, 2) for _, n in ROSTER), 2)
    assert rounded_sum != sum_of_rounded, (
        f"The seeded roster no longer drifts under rounding "
        f"(rounded-sum {rounded_sum} == sum-of-rounded {sum_of_rounded}), so "
        f"every tie-out above would pass even against the round-once bug they "
        f"exist to catch. Restore shift counts where the two disagree — "
        f"1/3/4 at {SHIFT_HOURS:.4f} h gives 50.67 vs 50.66."
    )
    # And the API really is serving those drifting figures, not a tidy fixture.
    assert sorted(round(r["scheduled_hours"], 2) for r in ctx.summary()) == \
        sorted(round(n * SHIFT_HOURS, 2) for _, n in ROSTER)
