"""labor_cost ÷ total_hours is a rate, in the router nobody audited.

/api/staffing appears in neither _MEMBER_READ_DENY_PREFIXES nor
_SHARED_DEVICE_DENY_PREFIXES, and GET /api/staffing/logs returns labor_cost,
total_hours and staff_count per day with no role check at all. On any day
logged with staff_count == 1, labor_cost ÷ total_hours IS that one person's
exact hourly rate — and /api/staff/schedules, deliberately open to a manager,
names who worked it. /api/staffing/insights reads the same rows and carries the
figure through into avg_labor_cost, labor_pct and a "High labor cost on
<weekday>" alert that restates it in prose.

REDACTED, NOT DENIED. The head-count, the hours and the forecast are
operational, and /staffing/forecast carries no money at all — denying the
prefix would take a working planning surface to close one field. Revenue
deliberately STAYS: /api/sales is open to a delegated seat by decision, so
venue takings are not the owner-only half here. The per-person wage is.

Run: cd backend && python3 -m pytest tests/test_staffing_wage_privacy.py -q
"""
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.staffing import DailyStaffing
from app.models.user import User
from app.routers.staffing import list_staff_logs, staffing_insights


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def owner(db) -> User:
    u = User(
        email="owner@bonbox.dk", password_hash="x", business_name="Bon Café",
        business_type="restaurant", currency="DKK", plan="pro",
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _one_person_day(db, owner: User, days_ago: int = 1) -> DailyStaffing:
    """ONE person, 8 hours, 1480 kr. The whole point: 1480 ÷ 8 = 185 kr/h, and
    there is exactly one name it can belong to."""
    row = DailyStaffing(
        id=uuid.uuid4(), user_id=owner.id,
        date=date.today() - timedelta(days=days_ago),
        staff_count=1, total_hours=8.0, labor_cost=1480.0, notes=None,
    )
    db.add(row)
    db.commit()
    return row


def test_the_owner_sees_the_labour_cost(db, owner):
    """POSITIVE CONTROL FIRST — a /logs that returned nothing would satisfy
    every negative below."""
    _one_person_day(db, owner)

    rows = list_staff_logs(days=30, db=db, user=owner)

    assert len(rows) == 1
    assert rows[0]["labor_cost"] == 1480.0


@pytest.mark.parametrize("flag", ["_is_member_view", "_shared_device_locked"])
def test_a_restricted_seat_gets_no_labour_cost(db, owner, flag):
    _one_person_day(db, owner)
    setattr(owner, flag, True)

    rows = list_staff_logs(days=30, db=db, user=owner)

    assert rows[0]["labor_cost"] is None, rows[0]
    # Head-count and hours survive — that is why this is a redaction and not a
    # prefix deny. On their own they divide to nothing.
    assert rows[0]["staff_count"] == 1
    assert rows[0]["total_hours"] == 8.0


def test_the_owner_sees_the_labour_figures_in_the_insights(db, owner):
    """POSITIVE CONTROL for the redaction below. Asserting "is None" on rows
    that were always None is the classic vacuous privacy test — this pins that
    the figure is really there to lose."""
    for i in range(1, 21):
        _one_person_day(db, owner, days_ago=i)

    out = staffing_insights(db=db, user=owner)

    with_cost = [
        r for r in (out.get("weekday_analysis") or [])
        if r.get("avg_labor_cost") is not None
    ]
    assert with_cost, out.get("weekday_analysis")
    assert with_cost[0]["avg_labor_cost"] == 1480.0


@pytest.mark.parametrize("flag", ["_is_member_view", "_shared_device_locked"])
def test_the_insights_weekday_rows_lose_the_labour_figures(db, owner, flag):
    """The service divides avg_labor_cost by avg_staff itself
    (staffing_intelligence.py) — the same rate, one aggregation up."""
    for i in range(1, 21):
        _one_person_day(db, owner, days_ago=i)
    setattr(owner, flag, True)

    out = staffing_insights(db=db, user=owner)

    for row in out.get("weekday_analysis") or []:
        assert row.get("avg_labor_cost") is None, row
        assert row.get("labor_pct") is None, row
    assert out.get("overall_labor_pct") is None
    # And the prose restatement goes with it — an alert reading "High labor
    # cost on Tuesday (41%)" leaks the same figure in a sentence.
    assert not [
        a for a in (out.get("alerts") or []) if a.get("type") == "labor_cost"
    ], out.get("alerts")
