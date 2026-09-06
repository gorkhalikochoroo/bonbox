"""
Week labor% — the numerator and the denominator must name the SAME days.

THE DEFECT
----------
`GET /api/staff/schedules/week-cost` returned
`week.labor_pct_gross = week_gross / week_rev`: a whole week of rostered cost
over whatever revenue had actually landed. Wrong in both directions, and the
screen gave no hint either way:

  • Visit on a Wednesday → numerator carries 7 days, denominator carries 2.
    The headline read ~110% red on a week that was fine.
  • Open next week → denominator is 0 → null → a grey dash. The number was
    dead during the exact task it exists for.

The fix is not a bigger denominator; it is a MATCHED one. `labor_pct_*` now
covers settled days only, on both sides, and `week.settled` says which days
those were so the client can decide whether the figure needs the *forventet*
treatment. The forecast half lives in the client (frontend
utils/weekLaborPct.js) so the headline and the per-day "demand ~40h" overlay
can never come from two different forecast fetches.

EVERY TEST FREEZES "TODAY". These assertions are about the boundary between a
day that has closed and one that has not, so a suite whose result depends on
which weekday it runs would be worse than no suite: it would go green on a
Sunday and red on a Tuesday, and someone would delete it. `business_today_local`
is patched on the router module, which is also the honest thing to exercise —
the endpoint must use the VENUE's business day, not `date.today()`.

Run:
  cd backend && python3 -m pytest tests/test_week_labor_pct_settled.py -x -q
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
from app.models.sale import Sale
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.routers import staff as staff_router
from app.services.auth import get_current_user, hash_password

_db_ready.set()

RATE = 180.0            # kr/hour, base only — no evening/weekend premium
SHIFT_HOURS = 6.25      # 16:00-23:00 less a 45-min break
SHIFT_COST = SHIFT_HOURS * RATE     # 1 125,00 kr
DAY_REVENUE = 9000.0

# A Monday safely in the past, so seeded Sales are ordinary historical rows.
MONDAY = date(2026, 6, 1)
WEDNESDAY = MONDAY + timedelta(days=2)


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


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    lim = getattr(staff_router, "_limiter", None) or getattr(staff_router, "limiter", None)
    if lim is not None:
        lim.reset()
    yield
    if lim is not None:
        lim.reset()


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


@pytest.fixture
def freeze_today(monkeypatch):
    """Pin the venue's business day. Returns a setter so each test states the
    'now' its assertions depend on, in the test body where it is readable."""
    def _set(d: date):
        monkeypatch.setattr(staff_router, "business_today_local", lambda _user: d)
    return _set


def _owner(db) -> User:
    u = User(
        email="weekcost@bonbox.dk",
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


def _staff(db, owner: User) -> StaffMember:
    s = StaffMember(
        id=uuid.uuid4(), user_id=owner.id, name="Anna", role="server",
        active=True, is_deleted=False, base_rate=RATE,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _roster_whole_week(db, owner, staff, monday: date):
    for i in range(7):
        db.add(Schedule(
            id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id,
            date=monday + timedelta(days=i),
            start_time="16:00", end_time="23:00", break_minutes=45,
            role_on_shift="server", status="published",
        ))
    db.commit()


def _sale(db, owner, d: date, amount: float = DAY_REVENUE):
    db.add(Sale(user_id=owner.id, date=d, amount=amount))
    db.commit()


def _week_cost(client, owner, monday: date) -> dict:
    app.dependency_overrides[get_current_user] = lambda: owner
    try:
        r = client.get("/api/staff/schedules/week-cost",
                       params={"week_start": monday.isoformat()})
        assert r.status_code == 200, r.text
        return r.json()
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── The regression: mid-week must not divide 7 days of cost by 2 of revenue ──
def test_midweek_pct_covers_only_the_days_that_have_closed(db, client, freeze_today):
    freeze_today(WEDNESDAY)
    owner, staff = _owner(db), None
    staff = _staff(db, owner)
    _roster_whole_week(db, owner, staff, MONDAY)
    _sale(db, owner, MONDAY)
    _sale(db, owner, MONDAY + timedelta(days=1))

    week = _week_cost(client, owner, MONDAY)["week"]

    assert week["settled"]["days"] == 2
    assert week["settled"]["revenue"] == pytest.approx(2 * DAY_REVENUE)
    assert week["settled"]["cost_gross"] == pytest.approx(2 * SHIFT_COST, abs=0.01)
    assert week["labor_pct_gross"] == pytest.approx(
        2 * SHIFT_COST / (2 * DAY_REVENUE), abs=1e-4
    )
    assert week["labor_pct_gross"] == pytest.approx(0.125, abs=1e-4)

    # The number this replaces: 7 days of cost over 2 days of revenue = 43.75%,
    # 3.5x the truth. That is the red headline on a healthy week.
    old_math = week["cost_gross"] / week["revenue"]
    assert old_math == pytest.approx(0.4375, abs=1e-3)
    assert old_math > week["labor_pct_gross"] * 3


def test_a_day_still_in_progress_is_never_settled(db, client, freeze_today):
    """Today has partial revenue against a full roster. Counting it would
    inflate the pct exactly the way the whole-week version did."""
    freeze_today(WEDNESDAY)
    owner = _owner(db)
    staff = _staff(db, owner)
    _roster_whole_week(db, owner, staff, MONDAY)
    _sale(db, owner, WEDNESDAY, 500.0)          # one lunch cover so far

    body = _week_cost(client, owner, MONDAY)
    rows = {r["date"]: r for r in body["daily"]}
    assert rows[WEDNESDAY.isoformat()]["settled"] is False
    assert rows[WEDNESDAY.isoformat()]["revenue"] == pytest.approx(500.0)
    # Nothing else registered, so there is no settled day at all.
    assert body["week"]["settled"]["days"] == 0
    assert body["week"]["labor_pct_gross"] is None


def test_closed_day_with_no_revenue_is_excluded_not_guessed(db, client, freeze_today):
    """A past day with 0 revenue is ambiguous — genuinely shut, or simply not
    registered. Treating it as a real 0 denominator prints an infinite labor%;
    charging its cost to ANOTHER day's revenue inflates the week. Both sides
    drop it."""
    freeze_today(MONDAY + timedelta(days=7))    # the whole week has closed
    owner = _owner(db)
    staff = _staff(db, owner)
    _roster_whole_week(db, owner, staff, MONDAY)
    _sale(db, owner, MONDAY)                    # only Monday registered

    week = _week_cost(client, owner, MONDAY)["week"]
    assert week["settled"]["days"] == 1
    assert week["settled"]["cost_gross"] == pytest.approx(SHIFT_COST, abs=0.01)
    assert week["labor_pct_gross"] == pytest.approx(SHIFT_COST / DAY_REVENUE, abs=1e-4)


def test_fully_closed_week_is_unchanged_by_the_fix(db, client, freeze_today):
    """Non-regression: when every day settled, settled == whole week, so the
    number an owner reviews after the fact is identical to before."""
    freeze_today(MONDAY + timedelta(days=7))
    owner = _owner(db)
    staff = _staff(db, owner)
    _roster_whole_week(db, owner, staff, MONDAY)
    for i in range(7):
        _sale(db, owner, MONDAY + timedelta(days=i))

    week = _week_cost(client, owner, MONDAY)["week"]
    assert week["settled"]["days"] == 7
    assert week["settled"]["revenue"] == pytest.approx(week["revenue"])
    assert week["settled"]["cost_gross"] == pytest.approx(week["cost_gross"])
    assert week["labor_pct_gross"] == pytest.approx(
        week["cost_gross"] / week["revenue"], abs=1e-4
    )


def test_future_week_is_blank_not_zero(db, client, freeze_today):
    """An actuals figure on a week that has not happened is null. The client's
    forecast layer fills this in, labelled forventet — the server never invents
    a denominator."""
    freeze_today(MONDAY - timedelta(days=7))
    owner = _owner(db)
    staff = _staff(db, owner)
    _roster_whole_week(db, owner, staff, MONDAY)

    week = _week_cost(client, owner, MONDAY)["week"]
    assert week["labor_pct_gross"] is None
    assert week["labor_pct_loaded"] is None
    assert week["settled"]["days"] == 0
    assert week["settled"]["revenue"] is None
    # The roster cost itself is real and still reported — only the ratio is held.
    assert week["cost_gross"] == pytest.approx(7 * SHIFT_COST, abs=0.01)


def test_every_day_row_carries_a_settled_flag(db, client, freeze_today):
    """The client pairs cost with the right denominator off this flag rather
    than re-deriving 'today' from a browser clock in another timezone."""
    freeze_today(WEDNESDAY)
    owner = _owner(db)
    rows = _week_cost(client, owner, MONDAY)["daily"]
    assert len(rows) == 7
    assert [r["settled"] for r in rows] == [False] * 7   # no revenue anywhere yet
    for r in rows:
        assert isinstance(r["settled"], bool)


def test_loaded_basis_uses_the_same_settled_days(db, client, freeze_today):
    """The feriepenge basis must not quietly use a different day set."""
    freeze_today(WEDNESDAY)
    owner = _owner(db)
    staff = _staff(db, owner)
    _roster_whole_week(db, owner, staff, MONDAY)
    _sale(db, owner, MONDAY)

    week = _week_cost(client, owner, MONDAY)["week"]
    assert week["labor_pct_loaded"] == pytest.approx(
        week["settled"]["cost_loaded"] / week["settled"]["revenue"], abs=1e-4
    )
    assert week["settled"]["cost_loaded"] == pytest.approx(
        week["settled"]["cost_gross"] * 1.125, abs=0.01
    )
