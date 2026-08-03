"""
Portal "My hours" — the caller-chosen start/end window.

Staff can page back through their own history instead of being stuck on the
current pay period. Two things are being pinned here:

  1. The window is HONOURED and ECHOED. The frontend decides whether to show a
     "vs last period" comparison by checking that the response describes the
     window it asked for — a server that silently ignored the params would
     answer with the CURRENT period, the delta would compute to zero, and the
     UI would render "no change" for a fact it does not have. So the echo is
     load-bearing, not cosmetic.

  2. The window is BOUNDED. It widens only the date filter, but an unbounded
     span would let anyone holding a leaked link turn one request into a
     full-history table scan; the rate limit alone would not stop that.

Run:
  cd backend && python3 -m pytest tests/test_portal_hours_range.py -x -q
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
from app.models.staff import StaffMember, StaffLink, HoursLogged
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()


@pytest.fixture(autouse=True)
def _reset_limiter():
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    yield
    sp.limiter.reset()


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


def _owner(db, email="owner@bonbox.dk"):
    u = User(
        email=email, password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _staff(db, owner, token="tok", name="Agnes"):
    s = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(s); db.commit(); db.refresh(s)
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=s.id, token=token, active=True))
    db.commit()
    return s


def _punch(db, owner, staff, d, hours):
    db.add(HoursLogged(
        user_id=owner.id, staff_id=staff.id, date=d,
        start_time="08:00", end_time="16:00", total_hours=hours, entry_method="clock",
    ))
    db.commit()


def _get(client, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return client.get(f"/api/portal/tok/hours" + (f"?{q}" if q else ""))


# ── the window is honoured ───────────────────────────────────────────────

def test_range_selects_only_that_window(client, db):
    o = _owner(db); s = _staff(db, o)
    inside = date.today() - timedelta(days=40)
    outside = date.today() - timedelta(days=5)
    _punch(db, o, s, inside, 6.0)
    _punch(db, o, s, outside, 9.0)     # must NOT be counted

    r = _get(client, start=str(inside - timedelta(days=1)), end=str(inside + timedelta(days=1)))
    assert r.status_code == 200, r.text
    assert r.json()["total_hours"] == 6.0


def test_response_echoes_the_requested_window(client, db):
    """The frontend's fail-closed guard compares these strings — if the echo
    drifts, the comparison silently disables the feature forever."""
    o = _owner(db); _staff(db, o)
    a, b = "2026-03-15", "2026-04-14"        # a 15–14 pay cycle
    body = _get(client, start=a, end=b).json()
    assert body["period_start"] == a
    assert body["period_end"] == b


def test_window_cannot_reach_another_members_hours(client, db):
    """The range widens the DATE filter only — never the tenant/member scope."""
    o = _owner(db)
    mine = _staff(db, o, token="tok", name="Agnes")
    theirs = _staff(db, o, token="tok2", name="Bo")
    d = date.today() - timedelta(days=30)
    _punch(db, o, mine, d, 4.0)
    _punch(db, o, theirs, d, 11.0)           # a colleague's hours

    body = _get(client, start=str(d), end=str(d)).json()
    assert body["total_hours"] == 4.0        # never 15.0


def test_empty_window_is_zero_not_an_error(client, db):
    o = _owner(db); _staff(db, o)
    quiet = date.today() - timedelta(days=200)      # in range, but nothing worked
    body = _get(client, start=str(quiet), end=str(quiet + timedelta(days=20)))
    assert body.status_code == 200
    assert body.json()["total_hours"] == 0


# ── the window is bounded ────────────────────────────────────────────────

def test_half_a_range_is_rejected(client, db):
    o = _owner(db); _staff(db, o)
    assert _get(client, start="2026-01-01").status_code == 400
    assert _get(client, end="2026-01-31").status_code == 400


def test_backwards_range_is_rejected(client, db):
    o = _owner(db); _staff(db, o)
    assert _get(client, start="2026-03-31", end="2026-03-01").status_code == 400


def test_unparseable_dates_are_rejected(client, db):
    o = _owner(db); _staff(db, o)
    assert _get(client, start="not-a-date", end="2026-03-01").status_code == 400
    assert _get(client, start="01-03-2026", end="2026-03-01").status_code == 400


def test_span_wider_than_a_year_is_refused(client, db):
    """A full-history scan is the thing a leaked link would reach for."""
    o = _owner(db); _staff(db, o)
    start = date.today() - timedelta(days=400)
    assert _get(client, start=str(start), end=str(date.today())).status_code == 400


def test_a_year_wide_span_is_allowed(client, db):
    """The cap must not be so tight it refuses a legitimate 12-month lookback."""
    o = _owner(db); _staff(db, o)
    start = date.today() - timedelta(days=300)
    assert _get(client, start=str(start), end=str(date.today())).status_code == 200


def test_deep_history_is_refused(client, db):
    o = _owner(db); _staff(db, o)
    start = date.today() - timedelta(days=365 * 4)
    assert _get(client, start=str(start), end=str(start + timedelta(days=30))).status_code == 400


# ── the default path is untouched ────────────────────────────────────────

def test_no_params_still_returns_the_pay_period(client, db):
    """Every existing caller passes nothing; that path must not change."""
    o = _owner(db); s = _staff(db, o)
    _punch(db, o, s, date.today(), 7.5)
    body = _get(client).json()
    assert body["total_hours"] == 7.5
    assert body["period_start"] <= str(date.today()) <= body["period_end"]
