"""Tests for close_sanity — last-second anomaly guard before commit.

Multi-layer pinned:
  • Tenant boundary: baseline derived only from the user's own sales.
  • Same-weekday baseline: Friday compared to Fridays, not all days.
  • No-baseline / fresh account → always 'ok' (don't fire spurious flags).
  • LOW threshold (40% under) fires on real misreads.
  • HIGH threshold (100% over) fires on real spikes.
  • Honest quiet days within the band don't fire.
  • Tiny baselines (< MIN_BASELINE_KR) suppressed to avoid noise on
    new accounts.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.sale import Sale
from app.models.user import User
from app.services.close_sanity import (
    BASELINE_LOOKBACK_DAYS,
    HIGH_PCT,
    LOW_PCT,
    MIN_BASELINE_KR,
    check_close_anomaly,
)
from app.utils.time import utc_now


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _user(db, *, email="cafe@bonbox.test") -> User:
    u = User(
        email=email, password_hash="x",
        business_name="Café", business_type="cafe",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _seed_consistent_fridays(db, user, *, total_per_friday=10000.0):
    """Seed 4 same-weekday Fridays with total `total_per_friday` each.
    The check_close_anomaly baseline averages these."""
    today = date.today()
    # Find the most recent Friday (weekday=4) that's BEFORE today
    days_since_fri = (today.weekday() - 4) % 7
    if days_since_fri == 0:
        days_since_fri = 7
    last_friday = today - timedelta(days=days_since_fri)
    for week in range(4):
        d = last_friday - timedelta(weeks=week)
        if d >= today:
            continue
        if (today - d).days > BASELINE_LOOKBACK_DAYS:
            continue
        # Spread total across a few sales on the day
        per = total_per_friday / 5
        for i in range(5):
            db.add(Sale(
                id=uuid.uuid4(),
                user_id=user.id,
                date=d,
                amount=per,
                payment_method="card",
            ))
    db.commit()
    # Determine the next Friday (today if Friday) to call check on.
    if today.weekday() == 4:
        return today
    return today + timedelta(days=(4 - today.weekday()) % 7)


# ─── No-baseline / fresh account ──────────────────────────────────────


def test_fresh_account_returns_ok(db):
    """No prior sales → no useful baseline → don't fire spurious flags."""
    user = _user(db)
    out = check_close_anomaly(db, user=user, today=date.today(), today_total=10000.0)
    assert out["ok"] is True
    assert out["flagged"] is False
    assert out["baseline_days"] == 0


def test_tiny_baseline_suppressed(db):
    """If baseline avg < MIN_BASELINE_KR, don't fire — too noisy."""
    user = _user(db)
    # Two prior Fridays with tiny totals
    today = date.today()
    days_since_fri = (today.weekday() - 4) % 7
    if days_since_fri == 0:
        days_since_fri = 7
    last_friday = today - timedelta(days=days_since_fri)
    for week in range(2):
        d = last_friday - timedelta(weeks=week)
        db.add(Sale(
            id=uuid.uuid4(),
            user_id=user.id,
            date=d,
            amount=20.0,  # well below MIN_BASELINE_KR
            payment_method="card",
        ))
    db.commit()
    target = today + timedelta(days=(4 - today.weekday()) % 7)
    out = check_close_anomaly(db, user=user, today=target, today_total=5.0)
    # Today is 75% below avg of 20 — but baseline too tiny to flag
    assert out["flagged"] is False


# ─── LOW threshold ────────────────────────────────────────────────────


def test_low_threshold_fires_when_today_dramatically_below_baseline(db):
    """Today is 60% below baseline → flagged 'low'."""
    user = _user(db)
    target = _seed_consistent_fridays(db, user, total_per_friday=10000.0)
    # Today's pre-commit total: 4000 (60% drop from 10000)
    out = check_close_anomaly(db, user=user, today=target, today_total=4000.0)
    assert out["flagged"] is True
    assert out["reason"] == "low"
    assert "below" in out["message"].lower()
    assert out["delta_pct"] is not None and out["delta_pct"] < 0


def test_low_threshold_does_not_fire_at_30_percent_drop(db):
    """A 30% drop is within the LOW_PCT (40%) band — honest quiet day,
    no flag."""
    user = _user(db)
    target = _seed_consistent_fridays(db, user, total_per_friday=10000.0)
    # 30% under (7000)
    out = check_close_anomaly(db, user=user, today=target, today_total=7000.0)
    assert out["flagged"] is False


# ─── HIGH threshold ───────────────────────────────────────────────────


def test_high_threshold_fires_when_today_more_than_double(db):
    """Today is 150% above baseline → flagged 'high'."""
    user = _user(db)
    target = _seed_consistent_fridays(db, user, total_per_friday=10000.0)
    # 25000 = 150% above 10000
    out = check_close_anomaly(db, user=user, today=target, today_total=25000.0)
    assert out["flagged"] is True
    assert out["reason"] == "high"
    assert "above" in out["message"].lower()


def test_high_threshold_does_not_fire_at_50_percent_above(db):
    """A 50% increase is within the HIGH_PCT (100%) band — busy night,
    no flag."""
    user = _user(db)
    target = _seed_consistent_fridays(db, user, total_per_friday=10000.0)
    out = check_close_anomaly(db, user=user, today=target, today_total=15000.0)
    assert out["flagged"] is False


# ─── Tenant boundary ──────────────────────────────────────────────────


def test_tenant_boundary_other_owner_baseline_excluded(db):
    """Owner B's high-volume Fridays must NOT inflate Owner A's baseline."""
    a = _user(db, email="a@bonbox.test")
    b = _user(db, email="b@bonbox.test")
    target_b = _seed_consistent_fridays(db, b, total_per_friday=50000.0)
    # Owner A has zero history — so even a high today_total should NOT
    # be flagged against B's baseline.
    out = check_close_anomaly(db, user=a, today=target_b, today_total=200.0)
    assert out["baseline_avg"] == 0.0
    assert out["flagged"] is False


# ─── Output shape ─────────────────────────────────────────────────────


def test_response_shape_complete(db):
    """All callers depend on a stable shape — every key always present."""
    user = _user(db)
    out = check_close_anomaly(db, user=user, today=date.today(), today_total=100.0)
    for k in ("ok", "flagged", "reason", "today_total", "baseline_avg",
              "baseline_days", "delta_pct", "message"):
        assert k in out, f"missing {k}"


# ─── Plan-tier gating ─────────────────────────────────────────────────


def test_free_users_dont_get_ai_anomaly_detection(db):
    """Free tier doesn't have `ai_anomaly_detection`. The aggregate
    router gates on it; the service itself is plan-agnostic, but pin
    the entitlement mapping so a future tier reshuffle can't quietly
    flip Free into 'should be flagging' or Starter into 'shouldn't'."""
    from app.services.billing import has_feature

    free = _user(db, email="free@bonbox.test")
    free.plan = "free"
    db.commit()

    starter = _user(db, email="starter@bonbox.test")
    starter.plan = "starter"
    db.commit()

    pro = _user(db, email="pro@bonbox.test")
    pro.plan = "pro"
    db.commit()

    assert has_feature(free, "ai_anomaly_detection") is False
    assert has_feature(starter, "ai_anomaly_detection") is True
    assert has_feature(pro, "ai_anomaly_detection") is True
