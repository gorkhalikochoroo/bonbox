"""
GET /api/today — the owner's "I dag" page (routers/today.py), plus the
ex-moms revenue resolver behind its lønprocent.

Coverage:
  1. parse_day_hours / day_state_for — before opening, open, after close,
     after-midnight service, closed today, unknown hours
  2. trend_word — a WORD only, and none on a thin baseline
  3. labor_pct_ex_moms — settled days only, unknown is contagious
  4. effective_revenue_ex_moms_by_date — close ex-moms precedence + Sale ÷ 1.25
  5. endpoint — owner payload, trend only like-for-like, bookings + covers,
     tenant scope, member view refused, anonymous refused, badges part

Run:
  cd backend && python3 -m pytest tests/test_today.py -x -q
"""

import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.daily_close import DailyClose
from app.models.reservation import Reservation
from app.models.sale import Sale
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.routers.today import (
    day_state_for,
    labor_pct_ex_moms,
    parse_day_hours,
    trend_word,
)
from app.services.auth import get_current_user, hash_password
from app.services.revenue_resolver import effective_revenue_ex_moms_by_date

_db_ready.set()


# ─── fixtures ─────────────────────────────────────────────────────────


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
def _reset_rate_limiter():
    from app.routers import today as today_router

    today_router._limiter.reset()
    yield
    today_router._limiter.reset()


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


def _as(user):
    app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, suffix="") -> User:
    u = User(
        email=f"today{suffix}@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name=f"Bistro{suffix}",
        business_type="restaurant",
        currency="DKK",
        plan="starter",
        role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _today(user) -> date:
    from app.services.tz_utils import business_today_local

    return business_today_local(user)


def _close(db, user, d, revenue, *, status="confirmed", moms=None, ex=None):
    c = DailyClose(
        id=uuid.uuid4(), user_id=user.id, date=d, revenue_total=revenue,
        payment_total=revenue, moms_total=moms, revenue_ex_moms=ex, status=status,
    )
    db.add(c)
    db.commit()
    return c


def _sale(db, user, d, amount):
    s = Sale(user_id=user.id, date=d, amount=amount, payment_method="card", status="completed")
    db.add(s)
    db.commit()
    return s


# ─── 1. opening hours + day state ─────────────────────────────────────


def test_parse_day_hours_shapes():
    assert parse_day_hours("11:00-23:00") == {"open": "11:00", "close": "23:00"}
    assert parse_day_hours("11:00-14:00, 17:00-22:00") == {"open": "11:00", "close": "22:00"}
    assert parse_day_hours("closed") == {"closed": True}
    assert parse_day_hours(None) is None
    assert parse_day_hours("") is None
    assert parse_day_hours("whenever") is None


def test_day_state_before_open_and_open_and_after_close():
    h = {"open": "11:00", "close": "23:00"}
    assert day_state_for(h, 8 * 60 + 15, 6, False) == "before_open"
    assert day_state_for(h, 14 * 60 + 32, 6, False) == "open"
    assert day_state_for(h, 23 * 60 + 30, 6, False) == "after_close"
    # A sale before the doors officially open means the day has started.
    assert day_state_for(h, 8 * 60, 6, True) == "open"


def test_day_state_after_midnight_service_is_still_open():
    h = {"open": "17:00", "close": "02:00"}
    assert day_state_for(h, 1 * 60 + 30, 6, False) == "open"       # 01:30, tonight's service
    assert day_state_for(h, 3 * 60, 6, False) == "after_close"      # 03:00, still before the cutoff
    assert day_state_for(h, 16 * 60, 6, False) == "before_open"


def test_day_state_closed_and_unknown_never_guess():
    assert day_state_for({"closed": True}, 12 * 60, 6, False) == "closed_today"
    assert day_state_for(None, 12 * 60, 6, False) == "unknown"
    assert day_state_for(None, 12 * 60, 6, True) == "open"


# ─── 2. trend is a word, never a % ────────────────────────────────────


def test_trend_word_directions_and_thin_baseline():
    assert trend_word(18000, 16000) == "higher"
    assert trend_word(14000, 16000) == "lower"
    assert trend_word(16200, 16000) == "same"
    assert trend_word(5000, 900) is None     # too thin to call
    assert trend_word(5000, None) is None
    for v in (trend_word(18000, 16000), trend_word(14000, 16000)):
        assert "%" not in v


# ─── 3. lønprocent over settled days only ─────────────────────────────


def _d(i):
    return (date(2026, 11, 9) + timedelta(days=i)).isoformat()


def test_labor_pct_ex_moms_uses_settled_days_only():
    daily = [
        {"date": _d(0), "cost_gross": 2000.0, "settled": True},
        {"date": _d(1), "cost_gross": 3000.0, "settled": True},
        {"date": _d(2), "cost_gross": 9999.0, "settled": False},  # today / future
    ]
    ex = {date(2026, 11, 9): 8000.0, date(2026, 11, 10): 12000.0, date(2026, 11, 11): 100.0}
    assert labor_pct_ex_moms(daily, ex) == round(5000 / 20000, 4)


def test_labor_pct_ex_moms_unknown_is_contagious_and_empty_is_none():
    daily = [
        {"date": _d(0), "cost_gross": 2000.0, "settled": True},
        {"date": _d(1), "cost_gross": None, "settled": True},
    ]
    assert labor_pct_ex_moms(daily, {date(2026, 11, 9): 8000.0}) is None
    assert labor_pct_ex_moms([{"date": _d(0), "cost_gross": 1.0, "settled": False}], {}) is None
    assert labor_pct_ex_moms([{"date": _d(0), "cost_gross": 1.0, "settled": True}], {}) is None


# ─── 4. ex-moms resolver ──────────────────────────────────────────────


def test_ex_moms_resolver_close_precedence_and_sale_fallback(db):
    u = _owner(db, "-res")
    d1, d2, d3, d4 = date(2026, 11, 2), date(2026, 11, 3), date(2026, 11, 4), date(2026, 11, 5)
    _close(db, u, d1, 12500, ex=10000)              # stored ex-moms wins
    _close(db, u, d2, 12500, moms=2500)             # total − keyed moms
    _close(db, u, d3, 12500)                        # gross ÷ 1.25
    _sale(db, u, d3, 999)                           # same day as a close → skipped
    _sale(db, u, d4, 1250)                          # Sale fallback ÷ 1.25
    _close(db, u, d4 + timedelta(days=1), 5000, status="draft")  # drafts never count
    got = effective_revenue_ex_moms_by_date(db, u.id, d1, d4 + timedelta(days=1), 0.25, True)
    assert got[d1] == pytest.approx(10000)
    assert got[d2] == pytest.approx(10000)
    assert got[d3] == pytest.approx(10000)
    assert got[d4] == pytest.approx(1000)
    assert (d4 + timedelta(days=1)) not in got
    # Net-priced (B2B) owner: Sale amounts are already ex moms; a close total
    # is still the till's GROSS figure.
    net = effective_revenue_ex_moms_by_date(db, u.id, d3, d4, 0.25, False)
    assert net[d4] == pytest.approx(1250)
    assert net[d3] == pytest.approx(10000)


# ─── 5. endpoint ──────────────────────────────────────────────────────


def test_anonymous_is_refused(client):
    app.dependency_overrides.pop(get_current_user, None)
    assert client.get("/api/today").status_code == 401


def test_member_view_is_refused(client, db):
    u = _owner(db, "-member")
    u._is_member_view = True
    _as(u)
    assert client.get("/api/today").status_code == 403


def test_owner_payload_and_like_for_like_trend(client, db):
    u = _owner(db, "-a")
    day = _today(u)
    _as(u)
    # Mid-day: Sale rows today, last week closed → a measured last-week figure,
    # but NO trend word (part day vs whole day).
    _sale(db, u, day, 4000)
    _close(db, u, day - timedelta(days=7), 16000)
    body = client.get("/api/today").json()
    assert body["business_day"] == day.isoformat()
    assert body["sales"]["today"] == pytest.approx(4000)
    assert body["sales"]["last_week_same_day"] == pytest.approx(16000)
    assert body["sales"]["trend"] is None
    for key in ("reservations", "staff", "close", "schedule", "labor", "badges", "revisor"):
        assert key in body

    # Both days locked → the word appears.
    _close(db, u, day, 19000)
    body = client.get("/api/today").json()
    assert body["sales"]["today"] == pytest.approx(19000)   # the close wins over the Sale row
    assert body["sales"]["trend"] == "higher"
    assert body["close"]["today"]["status"] == "confirmed"
    assert body["close"]["today"]["steps"]["locked"] is True
    assert len(body["close"]["days"]) == 22 + day.weekday()   # Monday-aligned, up to today


def test_bookings_covers_requested_and_tenant_scope(client, db):
    a = _owner(db, "-b1")
    b = _owner(db, "-b2")
    day = _today(a)
    t1 = BookableResource(id=uuid.uuid4(), user_id=a.id, kind="table", label="T4", capacity_seats=4)
    t2 = BookableResource(id=uuid.uuid4(), user_id=a.id, kind="table", label="T7", capacity_seats=2)
    db.add_all([t1, t2])
    db.commit()
    at = lambda h, m=0: datetime.combine(day, datetime.min.time()) + timedelta(hours=h, minutes=m)
    rows = [
        Reservation(user_id=a.id, resource_id=t1.id, guest_name="Larsen", party_size=4,
                    starts_at=at(18), ends_at=at(19, 30), status="confirmed"),
        Reservation(user_id=a.id, resource_id=t2.id, guest_name="Holm", party_size=2,
                    starts_at=at(18, 30), ends_at=at(20), status="requested"),
        Reservation(user_id=a.id, guest_name="Gone", party_size=6,
                    starts_at=at(19), ends_at=at(20), status="cancelled"),
        Reservation(user_id=b.id, guest_name="Other tenant", party_size=8,
                    starts_at=at(19), ends_at=at(20), status="confirmed"),
    ]
    db.add_all(rows)
    db.commit()
    _as(a)
    body = client.get("/api/today").json()
    r = body["reservations"]
    names = [i["name"] for i in r["items"]]
    assert names == ["Larsen", "Holm"]
    assert r["covers"] == 4          # confirmed only; requested waits for the owner
    assert r["requested"] == 1
    assert r["seats"] == 6
    assert r["items"][0]["tables"] == ["T4"]
    assert r["peak"]["covers"] == 4 and r["peak"]["full"] is False
    assert "Other tenant" not in names


def test_badges_part_counts_only_actionable(client, db):
    u = _owner(db, "-c")
    day = _today(u)
    staff = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Sofie", role="server")
    db.add(staff)
    db.commit()
    monday = day - timedelta(days=day.weekday())
    db.add_all([
        Schedule(id=uuid.uuid4(), user_id=u.id, staff_id=staff.id, date=monday,
                 start_time="10:00", end_time="16:00", break_minutes=0, status="draft"),
        Schedule(id=uuid.uuid4(), user_id=u.id, staff_id=staff.id, date=monday + timedelta(days=1),
                 start_time="10:00", end_time="16:00", break_minutes=0, status="published"),
    ])
    db.commit()
    _as(u)
    body = client.get("/api/today", params={"part": "badges"}).json()
    assert body["badges"]["schedule"] == 1
    assert body["badges"]["reservations"] == 0
    assert set(body.keys()) == {"business_day", "badges"}


def test_clocked_in_now_counts_people_and_skips_forgotten_clock_outs(client, db):
    """"På vagt nu": a punch left open since yesterday morning is a forgotten
    clock-out, not someone on shift now (time_registration rule)."""
    from app.models.staff import HoursLogged
    from app.services.tz_utils import now_local

    u = _owner(db, "-d")
    day = _today(u)
    anna = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Anna", role="server")
    bo = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Bo", role="server")
    db.add_all([anna, bo])
    db.commit()
    now = now_local(u)
    db.add_all([
        # Anna clocked in just now — on shift.
        HoursLogged(id=uuid.uuid4(), user_id=u.id, staff_id=anna.id, date=day,
                    start_time=f"{now.hour:02d}:{now.minute:02d}", end_time=None,
                    total_hours=0, entry_method="clock"),
        # Bo never clocked out yesterday — forgotten, not "on shift now".
        HoursLogged(id=uuid.uuid4(), user_id=u.id, staff_id=bo.id, date=day - timedelta(days=1),
                    start_time="07:00", end_time=None, total_hours=0, entry_method="clock"),
    ])
    db.commit()
    _as(u)
    staff = client.get("/api/today").json()["staff"]
    assert staff["uses_clock"] is True
    assert staff["clocked_in_now"] == 1


def test_close_badge_respects_dismissal_and_a_closed_day(client, db):
    """The rail's Kasserapport badge agrees with the page: not for a day the
    owner dismissed, not for a day the venue's own hours say it was shut."""
    import json
    from app.models.business_profile import BusinessProfile

    u = _owner(db, "-e")
    day = _today(u)
    yesterday = day - timedelta(days=1)
    for back in (2, 3, 4):  # closes regularly
        _close(db, u, day - timedelta(days=back), 9000)
    _as(u)
    badges = client.get("/api/today", params={"part": "badges"}).json()["badges"]
    assert badges["daily_close"] == 1

    skip = f"close_missing:{yesterday.isoformat()}"
    badges = client.get("/api/today", params={"part": "badges", "skip": skip}).json()["badges"]
    assert badges["daily_close"] == 0

    keys = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
    hours = {k: "11:00-22:00" for k in keys}
    hours[keys[yesterday.weekday()]] = "closed"
    db.add(BusinessProfile(id=uuid.uuid4(), user_id=u.id, operating_hours_json=json.dumps(hours)))
    db.commit()
    badges = client.get("/api/today", params={"part": "badges"}).json()["badges"]
    assert badges["daily_close"] == 0
