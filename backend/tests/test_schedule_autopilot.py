"""Tests for Staff Schedule Autopilot — Pro tier killer feature (Task #50).

Coverage map:

  Tier gating
    1. Free user POST /schedules/autopilot → 402 plan_required
    2. Starter user POST /schedules/autopilot → 402 plan_required (NOT Starter)
    3. Pro user POST /schedules/autopilot → 200 + structured suggestion
    4. Trial user POST /schedules/autopilot → 200 (trial == pro entitlements)

  History + confidence
    5. Pro user with NO sales history → confidence "low" + sensible defaults
    6. Pro user with 8 full weeks → confidence "high" + per-weekday spread

  Weather correlation
    7. Rainy bucket history reduces predicted demand vs sunny bucket

  Cost minimization
    8. Cheaper staff assigned first when both have capacity

  DK labor law
    9. 6+ hour shift gets break_minutes >= 45
   10. Staff scheduled over weekly cap → compliance_warnings fired

  Apply
   11. Apply materializes draft Schedule rows + audit log
   12. Apply with foreign staff_id rejected (cross-tenant boundary)

  Cross-tenant isolation
   13. User A's history never leaks into User B's suggestion

  Misc / production-grade
   14. PLAN_FEATURES contract: schedule_autopilot key on every plan
   15. target_labor_pct out-of-bounds → clamped to safe range

Run: cd backend && pytest tests/test_schedule_autopilot.py -v
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.sale import Sale
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.models.weather import DailyWeather
from app.services import schedule_autopilot
from app.services.auth import get_current_user, hash_password


_db_ready.set()


# ─── Shared in-memory DB ───────────────────────────────────────────────


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


@pytest.fixture
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db

    # Stub the network forecast fetch so tests are deterministic + offline.
    monkeypatch.setattr(
        "app.services.schedule_autopilot._fetch_forecast",
        lambda user, week_start: {},
    )

    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


# ─── Helpers ───────────────────────────────────────────────────────────


def _owner(db, plan: str = "pro", *, email_suffix: str = "") -> User:
    u = User(
        email=f"owner{email_suffix}@bonbox.dk",
        password_hash=hash_password("pw"),
        business_name=f"Mirabelle{email_suffix}",
        business_type="restaurant",
        currency="DKK",
        plan=plan,
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _staff(
    db,
    owner: User,
    *,
    name: str,
    rate: float = 180.0,
    max_week: float | None = None,
    role: str = "server",
) -> StaffMember:
    s = StaffMember(
        id=uuid.uuid4(),
        user_id=owner.id,
        name=name,
        role=role,
        base_rate=Decimal(str(rate)),
        max_hours_week=Decimal(str(max_week)) if max_week is not None else None,
        active=True,
        is_deleted=False,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _sale(db, owner: User, d: date, amount: float) -> Sale:
    s = Sale(
        id=uuid.uuid4(),
        user_id=owner.id,
        date=d,
        amount=Decimal(str(amount)),
        payment_method="card",
    )
    db.add(s)
    db.commit()
    return s


def _weather(
    db,
    owner: User,
    d: date,
    *,
    temp: float = 18.0,
    code: int = 0,
    rain_mm: float = 0.0,
) -> DailyWeather:
    w = DailyWeather(
        id=uuid.uuid4(),
        user_id=owner.id,
        date=d,
        temp_max=Decimal(str(temp + 2)),
        temp_min=Decimal(str(temp - 2)),
        rain_mm=Decimal(str(rain_mm)),
        weather_code=code,
    )
    db.add(w)
    db.commit()
    return w


def _next_monday() -> date:
    today = date.today()
    return today + timedelta(days=(7 - today.weekday()) % 7 or 7)


def _last_monday() -> date:
    today = date.today()
    return today - timedelta(days=today.weekday())


# ─── 1. Free user blocked ──────────────────────────────────────────────


def test_free_user_blocked(client, db):
    owner = _owner(db, plan="free")
    _override_user(owner)

    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": _next_monday().isoformat()},
    )
    assert res.status_code == 402, res.text
    detail = res.json()["detail"]
    assert detail["code"] == "plan_required"
    assert detail["feature"] == "schedule_autopilot"
    assert detail["upgrade_to"] == "pro"
    assert detail["current_plan"] == "free"


# ─── 2. Starter user blocked (this is the Pro killer) ──────────────────


def test_starter_user_blocked(client, db):
    owner = _owner(db, plan="starter")
    _override_user(owner)

    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": _next_monday().isoformat()},
    )
    assert res.status_code == 402, res.text
    detail = res.json()["detail"]
    assert detail["code"] == "plan_required"
    assert detail["upgrade_to"] == "pro"
    assert detail["current_plan"] == "starter"


# ─── 3. Pro user — sensible default for empty history ──────────────────


def test_pro_user_with_no_history_returns_low_confidence(client, db):
    owner = _owner(db, plan="pro")
    _staff(db, owner, name="Marie", rate=180.0)
    _override_user(owner)

    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": _next_monday().isoformat()},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["confidence"] == "low"
    assert body["basis"]["weeks_of_data"] == 0
    assert body["basis"]["weather_used"] is False
    assert len(body["days"]) == 7
    # With no history, predicted_revenue is 0 → no shifts assigned.
    assert all(d["predicted_revenue"] == 0 for d in body["days"])
    assert all(d["shifts"] == [] for d in body["days"])
    assert body["week_total_cost"] == 0
    assert body["week_total_hours"] == 0


# ─── 4. Trial user (= Pro entitlements) ────────────────────────────────


def test_trial_user_can_use_autopilot(client, db):
    owner = _owner(db, plan="free")
    from app.utils.time import utc_now
    owner.trial_ends_at = utc_now() + timedelta(days=5)
    db.commit()
    _staff(db, owner, name="Marie", rate=180.0)
    _override_user(owner)

    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": _next_monday().isoformat()},
    )
    assert res.status_code == 200, res.text


# ─── 5. 8 weeks of history → high confidence + per-weekday spread ──────


def test_pro_user_with_full_history_returns_high_confidence(client, db):
    owner = _owner(db, plan="pro")
    _staff(db, owner, name="Marie", rate=180.0)
    _staff(db, owner, name="Jonas", rate=160.0)

    target_monday = _next_monday()
    # 8 weeks back × 7 days = 56 days of sales. Saturdays bigger than Mondays.
    for w in range(1, 9):
        for dow in range(7):
            d = target_monday - timedelta(weeks=w) + timedelta(days=dow)
            base = 5000.0 if dow == 5 else 2500.0  # Saturday vs everything else
            _sale(db, owner, d, base)

    _override_user(owner)

    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": target_monday.isoformat()},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["confidence"] == "high"
    assert body["basis"]["weeks_of_data"] >= 6

    # Saturday should have a noticeably higher predicted_revenue than Monday.
    sat = next(d for d in body["days"] if d["weekday"] == "Saturday")
    mon = next(d for d in body["days"] if d["weekday"] == "Monday")
    assert sat["predicted_revenue"] > mon["predicted_revenue"]
    assert sat["predicted_demand_hours"] > mon["predicted_demand_hours"]


# ─── 6. Weather correlation — rainy reduces demand ─────────────────────


def test_weather_rainy_reduces_predicted_revenue(client, db, monkeypatch):
    """Owner has 8 weeks of history where rainy Tuesdays earn ~half what
    sunny Tuesdays earn. Forecasting a rainy Tuesday must pull predicted
    revenue down vs forecasting a sunny one (using the same weekday)."""
    owner = _owner(db, plan="pro")
    owner.latitude = Decimal("55.6761")  # Copenhagen
    owner.longitude = Decimal("12.5683")
    db.commit()
    _staff(db, owner, name="Marie", rate=180.0)

    target_monday = _next_monday()
    # 8 Tuesdays: alternating sunny/rainy. Sunny earns 5000, rainy earns 2000.
    for w in range(1, 9):
        tues = target_monday - timedelta(weeks=w) + timedelta(days=1)
        is_sunny = (w % 2 == 0)
        amount = 5000.0 if is_sunny else 2000.0
        code = 0 if is_sunny else 63   # 0 = clear, 63 = rain
        rain = 0.0 if is_sunny else 5.0
        _sale(db, owner, tues, amount)
        _weather(db, owner, tues, temp=15.0, code=code, rain_mm=rain)

    # Stub the forecast for two scenarios. First call: rainy Tuesday.
    target_tues = target_monday + timedelta(days=1)

    def _rainy_forecast(user, ws):
        return {
            target_tues: {
                "temp_c": 12.0,
                "precipitation_mm": 5.0,
                "weather_code": 63,
                "bucket": "rainy",
                "summary": "rainy",
            }
        }

    def _sunny_forecast(user, ws):
        return {
            target_tues: {
                "temp_c": 18.0,
                "precipitation_mm": 0.0,
                "weather_code": 0,
                "bucket": "sunny",
                "summary": "sunny",
            }
        }

    _override_user(owner)

    monkeypatch.setattr(
        "app.services.schedule_autopilot._fetch_forecast", _rainy_forecast
    )
    res_rain = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": target_monday.isoformat()},
    )
    assert res_rain.status_code == 200, res_rain.text
    rainy_tues = next(d for d in res_rain.json()["days"] if d["weekday"] == "Tuesday")

    monkeypatch.setattr(
        "app.services.schedule_autopilot._fetch_forecast", _sunny_forecast
    )
    res_sun = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": target_monday.isoformat()},
    )
    assert res_sun.status_code == 200, res_sun.text
    sunny_tues = next(d for d in res_sun.json()["days"] if d["weekday"] == "Tuesday")

    # Both ran the same week. Rainy must predict less.
    assert rainy_tues["predicted_revenue"] < sunny_tues["predicted_revenue"]
    assert rainy_tues["predicted_demand_hours"] < sunny_tues["predicted_demand_hours"]


# ─── 7. Cost minimization — cheaper staff first ────────────────────────


def test_cheaper_staff_assigned_first(client, db):
    """Two staff with very different rates. Autopilot greedy-assigns the
    cheapest first so total cost is minimized."""
    owner = _owner(db, plan="pro")
    cheap = _staff(db, owner, name="Cheap", rate=100.0)
    expensive = _staff(db, owner, name="Expensive", rate=300.0)

    target_monday = _next_monday()
    # Heavy revenue history so demand_hours is substantial.
    for w in range(1, 9):
        for dow in range(7):
            d = target_monday - timedelta(weeks=w) + timedelta(days=dow)
            _sale(db, owner, d, 10000.0)

    _override_user(owner)
    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": target_monday.isoformat()},
    )
    assert res.status_code == 200, res.text
    body = res.json()

    # Find at least one day that has shifts assigned.
    days_with_shifts = [d for d in body["days"] if d["shifts"]]
    assert len(days_with_shifts) > 0

    # For each such day, the FIRST shift must be the cheap staff member.
    for d in days_with_shifts:
        first_shift = d["shifts"][0]
        assert first_shift["staff_name"] == "Cheap", (
            f"Expected Cheap first on {d['weekday']}, got {first_shift['staff_name']}"
        )


# ─── 8. DK labor law — 6+ hour shift gets >= 45 min break ──────────────


def test_dk_labor_law_break_for_long_shift():
    """The Dinner template runs 17:00-22:00 (5 hours) — no break needed.
    Lunch+Dinner combined (11:00-22:00) wouldn't happen as one row, but
    a single 11:00-18:00 shift would be 7 hours → 45 min break."""
    # Synthetic 7-hour shift
    brk = schedule_autopilot._compute_break_minutes("11:00", "18:00")
    assert brk >= 45

    # 4-hour shift gets no break
    brk_short = schedule_autopilot._compute_break_minutes("11:00", "15:00")
    assert brk_short == 0

    # 6-hour exactly — at threshold, gets break
    brk_six = schedule_autopilot._compute_break_minutes("10:00", "16:00")
    assert brk_six >= 45


# ─── 9. Weekly cap warning ─────────────────────────────────────────────


def test_compliance_warning_when_weekly_cap_exceeded(client, db):
    """Owner has only one staff member with max_hours_week=10. With heavy
    demand, autopilot tries to schedule them past 10 hours → warning
    appears (or they're capped at 10 and a shift can't be filled)."""
    owner = _owner(db, plan="pro")
    # Single staff with a tight weekly cap.
    _staff(db, owner, name="PartTime", rate=150.0, max_week=10.0)

    target_monday = _next_monday()
    # Heavy revenue → demand will exceed 10 hours / week.
    for w in range(1, 9):
        for dow in range(7):
            d = target_monday - timedelta(weeks=w) + timedelta(days=dow)
            _sale(db, owner, d, 8000.0)

    _override_user(owner)
    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": target_monday.isoformat()},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # Either:
    #   (a) total hours scheduled <= 10 + 0.01, AND there are warnings
    #       about un-fillable shifts (capped at 10), OR
    #   (b) compliance_warnings names PartTime as over cap.
    total_hours = body["week_total_hours"]
    assert total_hours <= 10.5, (
        f"PartTime over scheduled past cap without warning: {total_hours} hrs"
    )
    assert len(body["compliance_warnings"]) > 0, (
        "Heavy demand but no compliance_warnings emitted"
    )


# ─── 10. Apply materializes Schedule rows + audit log ──────────────────


def test_apply_creates_draft_schedule_rows(client, db):
    owner = _owner(db, plan="pro")
    marie = _staff(db, owner, name="Marie", rate=180.0)
    _override_user(owner)

    target_monday = _next_monday()
    body = {
        "week_start": target_monday.isoformat(),
        "shifts": [
            {
                "date": target_monday.isoformat(),
                "staff_id": str(marie.id),
                "start": "11:00",
                "end": "15:00",
                "role": "server",
            },
            {
                "date": (target_monday + timedelta(days=1)).isoformat(),
                "staff_id": str(marie.id),
                "start": "17:00",
                "end": "22:00",
                "role": "server",
            },
        ],
    }

    res = client.post("/api/staff/schedules/autopilot/apply", json=body)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["applied"] == 2

    rows = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == owner.id,
            Schedule.date >= target_monday,
            Schedule.date <= target_monday + timedelta(days=6),
        )
        .all()
    )
    assert len(rows) == 2
    for r in rows:
        assert r.status == "draft"
        assert r.staff_id == marie.id
    # Notes label autopilot for traceability
    assert all("Autopilot" in (r.notes or "") for r in rows)

    # Audit log row exists
    audits = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == owner.id,
            AuditLog.action == "schedule.autopilot_applied",
        )
        .all()
    )
    assert len(audits) == 1


# ─── 11. Cross-tenant — foreign staff_id in apply rejected ─────────────


def test_apply_rejects_foreign_staff_id(client, db):
    owner_a = _owner(db, plan="pro", email_suffix="-a")
    owner_b = _owner(db, plan="pro", email_suffix="-b")
    foreign = _staff(db, owner_b, name="OtherMarie", rate=180.0)
    _override_user(owner_a)

    target_monday = _next_monday()
    res = client.post(
        "/api/staff/schedules/autopilot/apply",
        json={
            "week_start": target_monday.isoformat(),
            "shifts": [
                {
                    "date": target_monday.isoformat(),
                    "staff_id": str(foreign.id),  # ← belongs to owner_b
                    "start": "11:00",
                    "end": "15:00",
                },
            ],
        },
    )
    assert res.status_code == 400, res.text
    # No Schedule row should have been created.
    rows = db.query(Schedule).filter(Schedule.user_id == owner_a.id).all()
    assert rows == []


# ─── 12. Cross-tenant — history does not leak ──────────────────────────


def test_cross_tenant_history_isolation(client, db):
    owner_a = _owner(db, plan="pro", email_suffix="-a")
    owner_b = _owner(db, plan="pro", email_suffix="-b")
    _staff(db, owner_a, name="MarieA", rate=180.0)

    target_monday = _next_monday()
    # owner_b gets all the big-revenue Saturdays. owner_a sees nothing.
    for w in range(1, 9):
        d = target_monday - timedelta(weeks=w) + timedelta(days=5)
        _sale(db, owner_b, d, 50_000.0)

    _override_user(owner_a)
    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": target_monday.isoformat()},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # owner_a's Saturday must remain 0 — owner_b's data MUST NOT leak.
    sat = next(d for d in body["days"] if d["weekday"] == "Saturday")
    assert sat["predicted_revenue"] == 0
    assert sat["shifts"] == []


# ─── 13. PLAN_FEATURES contract ────────────────────────────────────────


def test_plan_features_contract():
    """Every plan in PLAN_FEATURES must declare schedule_autopilot
    explicitly so a future plan addition can't silently default to
    False at the wrong tier."""
    from app.services.billing import PLAN_FEATURES

    for plan, feats in PLAN_FEATURES.items():
        assert "schedule_autopilot" in feats, f"plan {plan!r} missing key"

    assert PLAN_FEATURES["free"]["schedule_autopilot"] is False
    assert PLAN_FEATURES["starter"]["schedule_autopilot"] is False
    assert PLAN_FEATURES["pro"]["schedule_autopilot"] is True
    assert PLAN_FEATURES["trial"]["schedule_autopilot"] is True


# ─── 14. target_labor_pct out-of-bounds → clamped ──────────────────────


def test_target_labor_pct_clamped(db):
    """An owner who typed '30' (meaning 30%) MUST NOT have their schedule
    over-staffed to 30 × revenue. The service must clamp."""
    owner = _owner(db, plan="pro")
    profile = BusinessProfile(
        id=uuid.uuid4(),
        user_id=owner.id,
        company_name="X",
        country="DK",
        target_labor_pct=Decimal("30.0"),  # clearly insane value
    )
    db.add(profile)
    db.commit()

    resolved = schedule_autopilot._resolve_target_labor_pct(db, owner)
    assert resolved <= 0.50, (
        f"target_labor_pct={resolved} not clamped to MAX_TARGET_LABOR_PCT"
    )
    assert resolved >= 0.10


# ─── 15. Audit log on suggest ──────────────────────────────────────────


def test_suggest_writes_audit_log(client, db):
    owner = _owner(db, plan="pro")
    _staff(db, owner, name="Marie", rate=180.0)
    _override_user(owner)

    target_monday = _next_monday()
    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": target_monday.isoformat()},
    )
    assert res.status_code == 200, res.text

    audits = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == owner.id,
            AuditLog.action == "schedule.autopilot_suggested",
        )
        .all()
    )
    assert len(audits) == 1


# ─── 16. Input bounds — far-future week rejected ───────────────────────


def test_week_start_far_future_rejected(client, db):
    owner = _owner(db, plan="pro")
    _override_user(owner)
    far = (date.today() + timedelta(days=400)).isoformat()
    res = client.post(
        "/api/staff/schedules/autopilot",
        json={"week_start": far},
    )
    assert res.status_code == 422, res.text


# ─── 17. apply also tier-gated ─────────────────────────────────────────


def test_apply_tier_gate(client, db):
    """Free user calling /apply directly should also be blocked. Defense
    in depth — never trust that the suggest gate is the only path."""
    owner = _owner(db, plan="free")
    marie = _staff(db, owner, name="Marie", rate=180.0)
    _override_user(owner)

    res = client.post(
        "/api/staff/schedules/autopilot/apply",
        json={
            "week_start": _next_monday().isoformat(),
            "shifts": [
                {
                    "date": _next_monday().isoformat(),
                    "staff_id": str(marie.id),
                    "start": "11:00",
                    "end": "15:00",
                }
            ],
        },
    )
    assert res.status_code == 402, res.text
    assert res.json()["detail"]["upgrade_to"] == "pro"
