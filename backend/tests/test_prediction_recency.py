"""Tests for the prediction service's recency gate.

Locks in the fix where get_sales_patterns / forecast_next_days return
None when there's no recent activity — even if the user has historical
data within the 90-day lookback window. The dashboard summary cards
correctly show 0 for an inactive user; the forecast widget should
match by hiding rather than fabricating numbers from stale history.

The bug this protects against: an account with 1,155 demo sales from
3 weeks ago previously made the forecast widget show
"Next 7 Days: 34,134 DKK" while the dashboard summary showed
"Today: 0, Yesterday: 0, Week Avg: 0" — credibility-breaking
inconsistency for the demo path.
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
from app.services.prediction import (
    forecast_next_days,
    get_sales_patterns,
    has_recent_activity,
)
from app.utils.time import utc_now


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def owner(db):
    u = User(
        email="lars@mirabelle.dk",
        password_hash="x",
        business_name="Mirabelle",
        business_type="restaurant",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _sale(db, owner, sale_date, amount=10000):
    s = Sale(
        id=uuid.uuid4(),
        user_id=owner.id,
        date=sale_date,
        amount=amount,
        payment_method="cash",
        status="completed",
        is_deleted=False,
        created_at=utc_now(),
    )
    db.add(s); db.commit()
    return s


# ─── has_recent_activity ───────────────────────────────────────────────

def test_has_recent_activity_false_when_no_sales(db, owner):
    assert has_recent_activity(db, owner.id, within_days=14) is False


def test_has_recent_activity_true_when_sale_today(db, owner):
    _sale(db, owner, date.today())
    assert has_recent_activity(db, owner.id, within_days=14) is True


def test_has_recent_activity_true_when_sale_yesterday(db, owner):
    _sale(db, owner, date.today() - timedelta(days=1))
    assert has_recent_activity(db, owner.id, within_days=14) is True


def test_has_recent_activity_false_when_only_old_sale(db, owner):
    """Sale from 21 days ago — outside the 14-day recency window."""
    _sale(db, owner, date.today() - timedelta(days=21))
    assert has_recent_activity(db, owner.id, within_days=14) is False


def test_has_recent_activity_ignores_deleted_sales(db, owner):
    s = _sale(db, owner, date.today())
    s.is_deleted = True
    db.commit()
    assert has_recent_activity(db, owner.id, within_days=14) is False


# ─── get_sales_patterns ────────────────────────────────────────────────

def test_patterns_none_when_no_recent_data_even_with_old_history(db, owner):
    """Critical regression test: user has 1,155 demo sales from 3 weeks
    ago. Patterns should return None, not fabricate forecast input.
    """
    old_date = date.today() - timedelta(days=21)
    for _ in range(50):  # plenty of historical data
        _sale(db, owner, old_date)
    assert get_sales_patterns(db, owner.id) is None


def test_patterns_returned_when_data_is_recent(db, owner):
    """User with at least one recent sale gets a real patterns response."""
    _sale(db, owner, date.today() - timedelta(days=1))
    _sale(db, owner, date.today() - timedelta(days=3))
    result = get_sales_patterns(db, owner.id)
    assert result is not None
    assert "day_of_week" in result
    assert "monthly" in result


def test_patterns_none_for_completely_empty_account(db, owner):
    assert get_sales_patterns(db, owner.id) is None


# ─── forecast_next_days ────────────────────────────────────────────────

def test_forecast_empty_when_no_recent_activity(db, owner):
    """Forecast widget should hide when stale data only."""
    for d in range(20, 25):  # all >14 days old
        _sale(db, owner, date.today() - timedelta(days=d))
    assert forecast_next_days(db, owner.id, days=7) == []


def test_forecast_returns_predictions_when_recent(db, owner):
    _sale(db, owner, date.today() - timedelta(days=1), amount=8000)
    _sale(db, owner, date.today() - timedelta(days=2), amount=12000)
    forecasts = forecast_next_days(db, owner.id, days=7)
    assert len(forecasts) == 7
    for f in forecasts:
        assert "predicted_revenue" in f
        assert "day" in f
        assert "date" in f


def test_forecast_empty_for_completely_empty_account(db, owner):
    assert forecast_next_days(db, owner.id, days=7) == []
