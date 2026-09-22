"""/dashboard/batch must not ask the same question twice.

THE DEFECT. The batch handler computed this week's revenue TWICE, from two
variables that derive the same date:

    line ~388   _week_monday = today - timedelta(days=today.weekday())
    line ~389   week_rev      = effective_revenue_total(user, _week_monday, today)
    line ~911   this_monday   = today - timedelta(days=weekday)   # = today.weekday()
    line ~918   this_week_rev = effective_revenue_total(user, this_monday, today)

`today` is assigned exactly once in the handler, so those two calls were
provably identical — the same rows summed twice.

WHY IT MATTERS. /batch is the product's front door and it fires ~50 SEQUENTIAL
queries; it measured ~2.0-2.4s end to end. A duplicate is pure waste on the
first screen every owner opens.

A NOTE ON WHAT IS *NOT* KNOWN, so nobody repeats the mistake: an earlier
attempt to attribute that 2s to transatlantic round trips was WRONG, and the
evidence for it was invalid. /api/health/ready caches its DB probe for 15s
(_READY_PROBE_TTL_S), so paired health-vs-ready timings measured a cache, not
the database. pg_stat_statements also shows none of this app's own queries in
the top 12 by total execution time. So the remaining ~1.6s in /batch and
/tax/overview is still UNEXPLAINED and is probably not database time. The
Server-Timing middleware in main.py exists to answer that with a measurement
instead of another theory. Do not write the cause into a docstring until it
has been measured from inside the server.

WHAT THIS PINS. week_revenue and this_week_revenue answer the same question,
so they must return the same number. If someone re-introduces a second query
with a drifted date range — a Sunday-start week, an exclusive end — this fails
rather than silently showing two different "this week" figures on one screen.

The two fields are rounded differently by the handler (week_revenue raw,
this_week_revenue to 2dp), which is why the assertion rounds before comparing.
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
from app.models.user import User
from app.services.auth import hash_password, get_current_user

_db_ready.set()


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


def _owner(db):
    u = User(
        id=uuid.uuid4(), email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _sale(db, u, d, amount):
    db.add(Sale(id=uuid.uuid4(), user_id=u.id, date=d, amount=amount,
                status="completed", is_deleted=False))
    db.commit()


def test_the_two_this_week_figures_agree(client, db):
    """One question, one answer — whatever the day of the week."""
    u = _owner(db)
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    # Money inside this week, and money before it that must NOT be counted.
    _sale(db, u, monday, 1000)
    _sale(db, u, today, 250.50)
    _sale(db, u, monday - timedelta(days=1), 9999)   # last week — excluded

    r = client.get("/api/dashboard/batch")
    assert r.status_code == 200, r.text
    body = r.json()

    # Both live nested: week_revenue under "summary", this/last_week_revenue
    # under "week_comparison". Reading them from two different blocks is the
    # point — that is exactly how they drifted apart unnoticed.
    wk = (body.get("summary") or {}).get("week_revenue")
    this_wk = (body.get("week_comparison") or {}).get("this_week_revenue")
    assert wk is not None and this_wk is not None, (
        f"expected both week figures in the payload, got keys: {sorted(body)}"
    )
    assert round(float(wk), 2) == round(float(this_wk), 2), (
        f"week_revenue={wk} but this_week_revenue={this_wk} — two answers to "
        f"'what did we take this week' on one screen"
    )


def test_last_week_is_still_a_separate_question(client, db):
    """The dedup must not have collapsed last week into this week — that would
    make the week-over-week comparison compare a number with itself."""
    u = _owner(db)
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    _sale(db, u, monday, 500)
    _sale(db, u, monday - timedelta(days=3), 800)     # squarely last week

    body = client.get("/api/dashboard/batch").json()
    wc = body.get("week_comparison") or {}
    this_wk = float(wc.get("this_week_revenue") or 0)
    last_wk = float(wc.get("last_week_revenue") or 0)

    assert this_wk != last_wk, "last week collapsed into this week"
    assert last_wk > 0, "last week's takings vanished"


def test_an_empty_week_is_zero_not_an_error(client, db):
    """A venue with no sales this week still gets a number, and the two
    fields still agree — a dedup that only holds when data exists is not a
    dedup."""
    _owner(db)
    body = client.get("/api/dashboard/batch").json()
    assert round(float((body.get("summary") or {}).get("week_revenue") or 0), 2) == \
        round(float((body.get("week_comparison") or {}).get("this_week_revenue") or 0), 2)
