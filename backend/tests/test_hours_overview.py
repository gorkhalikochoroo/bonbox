"""Staff-hours overview — the genuine narrative engine + the aggregate endpoint.

The narrative is the honesty spine of the redesigned /staff/hours "Oversigt":
a PURE, deterministic function of the aggregated payload. These tests lock its
contract so a future edit can't fabricate a trend, invent a labor %, or present
a typed-in estimate as measured fact. Plus one end-to-end endpoint test proving
the wiring (auth, tenant scope, cost/labor math, honest null-revenue state).

Run:
  cd backend && python3 -m pytest tests/test_hours_overview.py -x -q
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
from app.models.staff import StaffMember, HoursLogged, Schedule
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import hash_password, get_current_user
from app.services.hours_narrative import build_hours_narrative

_db_ready.set()


# ── Pure narrative engine ─────────────────────────────────────────────────────

def _codes(lines):
    return [ln["code"] for ln in lines]


def test_zero_hours_is_exclusive():
    lines, sev = build_hours_narrative({"actual_total": 0})
    assert _codes(lines) == ["zero"]
    assert sev == "info"


def test_labor_ok_watch_over_thresholds():
    base = {"actual_total": 200, "target_pct": 0.30, "revenue": 100000,
            "measured_share": 1.0}
    ok, _ = build_hours_narrative({**base, "pct_loaded": 0.28})
    watch, _ = build_hours_narrative({**base, "pct_loaded": 0.33})
    over, sev = build_hours_narrative({**base, "pct_loaded": 0.40})
    assert ok[0]["code"] == "labor_ok" and ok[0]["severity"] == "good"
    assert watch[0]["code"] == "labor_watch" and watch[0]["severity"] == "watch"
    assert over[0]["code"] == "labor_over" and over[0]["severity"] == "alert"
    assert over[0]["params"]["pct"] == 40 and over[0]["params"]["target"] == 30


def test_no_revenue_never_computes_labor_pct():
    lines, sev = build_hours_narrative({
        "actual_total": 214, "revenue": None, "loaded_est": 38900,
        "target_pct": 0.30, "measured_share": 1.0,
    })
    assert lines[0]["code"] == "labor_no_revenue"
    assert lines[0]["severity"] == "info"
    # The honest params: hours + a cost, but never a percentage.
    assert lines[0]["params"]["hours"] == 214
    assert lines[0]["params"]["cost"] == 38900
    assert all("pct" not in ln["params"] for ln in lines)


def test_over_limit_wins_and_lifts_banner():
    lines, sev = build_hours_narrative({
        "actual_total": 200, "revenue": 100000, "pct_loaded": 0.28,
        "target_pct": 0.30, "measured_share": 1.0,
        "over_limit": [{"name": "Maria", "actual": 162, "limit": 160}],
        "near_limit": [{"name": "X", "actual": 40, "limit": 40}],
    })
    codes = _codes(lines)
    assert codes[0] == "labor_ok"       # headline
    assert "limit_over" in codes         # over beats near
    assert "limit_near" not in codes
    assert sev == "alert"                # banner = max severity (limit_over)
    over = [ln for ln in lines if ln["code"] == "limit_over"][0]
    assert over["params"]["name"] == "Maria"


def test_plan_over_only_without_limit_breach():
    lines, _ = build_hours_narrative({
        "actual_total": 110, "scheduled_total": 100, "revenue": 100000,
        "pct_loaded": 0.28, "target_pct": 0.30, "measured_share": 1.0,
    })
    assert "plan_over" in _codes(lines)
    plan = [ln for ln in lines if ln["code"] == "plan_over"][0]
    assert plan["params"]["diff"] == 10


def test_trust_caveat_beats_trend_when_mostly_unclocked():
    # 60% from-schedule + 10% typed → 30% measured; the caveat discloses the FULL
    # unclocked share (70%), not just typed — from-schedule hours count too.
    lines, _ = build_hours_narrative({
        "actual_total": 100, "typed_hours": 10, "schedule_hours": 60,
        "measured_share": 0.3, "revenue": 100000, "pct_loaded": 0.28,
        "target_pct": 0.30, "comparable": True, "prev_actual": 50,
    })
    codes = _codes(lines)
    assert "trust_caveat" in codes
    assert "trend_more" not in codes  # trust caveat takes the single support slot
    caveat = [ln for ln in lines if ln["code"] == "trust_caveat"][0]
    assert caveat["params"]["unclocked"] == 70  # (1 - 0.3) * 100


def test_no_cost_basis_never_reports_green_labor_ok():
    # Hours logged + revenue present but NO wage rates (gross=0). Must NOT emit a
    # reassuring green "Labor 0% — good control"; cost/% are simply unknown.
    lines, sev = build_hours_narrative({
        "actual_total": 40, "revenue": 100000, "has_cost_basis": False,
        "loaded_est": 0, "target_pct": 0.30, "measured_share": 1.0,
    })
    assert lines[0]["code"] == "labor_no_rates"
    assert lines[0]["severity"] == "info"
    assert not any(ln["code"] == "labor_ok" for ln in lines)
    assert sev != "good"


def test_trend_more_fewer_flat():
    common = {"actual_total": 200, "revenue": 100000, "pct_loaded": 0.28,
              "target_pct": 0.30, "measured_share": 1.0, "comparable": True}
    more, _ = build_hours_narrative({**common, "prev_actual": 180})
    fewer, _ = build_hours_narrative({**common, "actual_total": 160, "prev_actual": 200})
    flat, _ = build_hours_narrative({**common, "actual_total": 182, "prev_actual": 180})
    assert [ln for ln in more if ln["code"] == "trend_more"][0]["params"]["delta"] == 20
    assert [ln for ln in fewer if ln["code"] == "trend_fewer"][0]["params"]["delta"] == 40
    assert "trend_flat" in _codes(flat)


def test_trend_omitted_when_not_comparable():
    # In-progress period → comparable False → NO trend line fabricated.
    lines, _ = build_hours_narrative({
        "actual_total": 100, "revenue": 100000, "pct_loaded": 0.28,
        "target_pct": 0.30, "measured_share": 1.0,
        "comparable": False, "prev_actual": 999,
    })
    assert not any(c.startswith("trend") for c in _codes(lines))


def test_never_more_than_three_lines():
    lines, _ = build_hours_narrative({
        "actual_total": 200, "revenue": 100000, "pct_loaded": 0.40,
        "target_pct": 0.30, "measured_share": 0.2, "typed_hours": 160,
        "over_limit": [{"name": "A", "actual": 200, "limit": 160}],
        "comparable": True, "prev_actual": 100,
    })
    assert len(lines) <= 3


# ── Endpoint wiring ───────────────────────────────────────────────────────────

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


def _seed(db, *, with_revenue: bool):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    a = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes",
                    role="server", base_rate=150, max_hours_month=160)
    db.add(a); db.commit(); db.refresh(a)
    # A clocked shift (measured) + a quick-typed one, both in-period.
    d = date(2026, 6, 10)
    db.add(HoursLogged(id=uuid.uuid4(), user_id=u.id, staff_id=a.id, date=d,
                       total_hours=8, earned=1200, entry_method="clock"))
    db.add(HoursLogged(id=uuid.uuid4(), user_id=u.id, staff_id=a.id, date=d,
                       total_hours=6, earned=900, entry_method="quick"))
    if with_revenue:
        db.add(Sale(id=uuid.uuid4(), user_id=u.id, date=d, amount=20000,
                    status="completed", is_deleted=False))
    db.commit()
    return u, a


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


def _auth_as(db, user):
    app.dependency_overrides[get_current_user] = lambda: user


def test_overview_with_revenue_computes_honest_cost_and_pct(client, db):
    u, _ = _seed(db, with_revenue=True)
    _auth_as(db, u)
    r = client.get("/api/staff/hours/overview",
                   params={"from": "2026-06-01", "to": "2026-06-30", "compare": "prev"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["has_any_hours"] is True
    assert body["hours"]["actual_total"] == 14.0      # 8 + 6
    assert body["hours"]["measured_hours"] == 8.0      # only the clocked one
    assert round(body["hours"]["measured_share"], 2) == round(8 / 14, 2)
    # Cost = Σ earned × 1.125, labelled an estimate.
    assert body["cost"]["gross"] == 2100.0
    assert body["cost"]["loaded_est"] == 2362.5
    assert body["cost"]["ferie_is_estimate"] is True
    # Labor % is present because revenue exists (2362.5 / 20000).
    assert body["labor"]["pct_loaded"] is not None
    assert body["revenue"]["effective_total"] == 20000.0
    # Raw wage rate NEVER crosses the wire.
    assert "hourly_rate" not in body["cost"] and "base_rate" not in str(body)
    assert isinstance(body["narrative"], list) and len(body["narrative"]) <= 3


def test_overview_without_revenue_is_null_never_zero_pct(client, db):
    u, _ = _seed(db, with_revenue=False)
    _auth_as(db, u)
    r = client.get("/api/staff/hours/overview",
                   params={"from": "2026-06-01", "to": "2026-06-30"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["revenue"]["effective_total"] is None
    assert body["labor"]["pct_loaded"] is None   # never 0, never guessed
    assert body["narrative"][0]["code"] == "labor_no_revenue"


def test_overview_no_rates_is_null_pct_not_green(client, db):
    # Staff with NO base_rate → logged hours earn 0 → gross=0 → cost basis unknown,
    # even though revenue is present. pct must be null (not 0), narrative not green.
    u = User(
        email="owner2@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    a = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Ny", role="server")  # no base_rate
    db.add(a); db.commit(); db.refresh(a)
    d = date(2026, 6, 10)
    db.add(HoursLogged(id=uuid.uuid4(), user_id=u.id, staff_id=a.id, date=d,
                       total_hours=8, earned=0, entry_method="quick"))
    db.add(Sale(id=uuid.uuid4(), user_id=u.id, date=d, amount=15000,
                status="completed", is_deleted=False))
    db.commit()
    _auth_as(db, u)
    r = client.get("/api/staff/hours/overview",
                   params={"from": "2026-06-01", "to": "2026-06-30"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cost"]["has_basis"] is False
    assert body["labor"]["pct_loaded"] is None      # never a green 0%
    assert body["narrative"][0]["code"] == "labor_no_rates"
    assert body["banner_severity"] != "good"


def test_overview_rejects_inverted_range(client, db):
    u, _ = _seed(db, with_revenue=False)
    _auth_as(db, u)
    r = client.get("/api/staff/hours/overview",
                   params={"from": "2026-06-30", "to": "2026-06-01"})
    assert r.status_code == 422


def test_pay_period_current_exposes_frame_fields(client, db):
    # The Hours frame picker + prev/next depend on these being present on load,
    # not just {start_date, end_date}.
    u, _ = _seed(db, with_revenue=False)
    _auth_as(db, u)
    r = client.get("/api/staff/pay-period/current")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "start_date" in body and "end_date" in body
    assert "period_type" in body and "custom_start_day" in body
