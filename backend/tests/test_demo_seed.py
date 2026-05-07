"""Tests for the demo account seeder.

Coverage:
  • seed_demo_account silently skips when demo user is absent
  • seeds when user exists and has zero closes
  • idempotency: doesn't re-seed if closes already exist
  • produces the expected row counts (30 closes, 26 inventory items)
  • seeded BusinessProfile is fully verified (CVR + DAWA + accountant)
  • seeded data has the cash-short streak day for insights demo
  • seeded data has one draft close for the Edit-flow demo
  • Pro plan upgrade applied (so demo isn't capped at 7-day exports)
  • reset_demo_account wipes + re-seeds correctly
  • realism: revenue numbers fall in the expected DK restaurant range
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.branch import Branch
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.user import User
from app.services.demo_seed import (
    _DEMO_EMAIL,
    _close_for_day,
    reset_demo_account,
    seed_demo_account,
)


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


@pytest.fixture
def demo_user(db):
    """The demo user — pre-existing in the DB before seed runs."""
    u = User(
        email=_DEMO_EMAIL,
        password_hash="x",
        business_name="(unset)",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


# ─── Skip / idempotency ──────────────────────────────────────────────

def test_seed_skips_when_demo_user_absent(db):
    """No demo@bonbox.dk in the DB → silent no-op."""
    result = seed_demo_account(db)
    assert result["skipped"] is True
    assert "does not exist" in result["reason"]


def test_seed_runs_when_demo_user_exists_with_no_closes(db, demo_user):
    """First-run path."""
    result = seed_demo_account(db)
    assert result["skipped"] is False
    assert result["closes"] > 0
    assert result["inventory"] > 0
    assert result["expenses"] > 0


def test_seed_idempotent_on_second_run(db, demo_user):
    """Re-running with closes already present skips."""
    seed_demo_account(db)
    second = seed_demo_account(db)
    assert second["skipped"] is True
    assert "already has" in second["reason"]


# ─── Row counts ──────────────────────────────────────────────────────

def test_seed_creates_30_daily_closes(db, demo_user):
    seed_demo_account(db)
    n = db.query(DailyClose).filter_by(user_id=demo_user.id).count()
    assert n == 30


def test_seed_creates_branch(db, demo_user):
    seed_demo_account(db)
    branches = db.query(Branch).filter_by(user_id=demo_user.id).all()
    assert len(branches) == 1
    assert "Mirabelle" in branches[0].name


def test_seed_creates_at_least_20_inventory_items(db, demo_user):
    seed_demo_account(db)
    n = db.query(InventoryItem).filter_by(user_id=demo_user.id).count()
    assert n >= 20  # current canonical set is 26


def test_seed_creates_expense_categories(db, demo_user):
    seed_demo_account(db)
    cats = db.query(ExpenseCategory).filter_by(user_id=demo_user.id).all()
    cat_names = {c.name for c in cats}
    # Core DK categories present
    assert "Råvarer" in cat_names
    assert "Drikkevarer" in cat_names


def test_seed_creates_expenses_in_recent_window(db, demo_user):
    seed_demo_account(db)
    expenses = db.query(Expense).filter_by(user_id=demo_user.id).all()
    assert len(expenses) >= 8
    today = date.today()
    # All expenses are within the last 14 days
    for e in expenses:
        days_ago = (today - e.date).days
        assert 0 <= days_ago <= 14


# ─── Verified profile ────────────────────────────────────────────────

def test_seeded_profile_is_fully_verified(db, demo_user):
    seed_demo_account(db)
    profile = db.query(BusinessProfile).filter_by(user_id=demo_user.id).first()
    assert profile is not None
    assert profile.company_name == "Mirabelle ApS"
    assert profile.org_number == "39842851"
    assert profile.cvr_verified_at is not None
    assert profile.cvr_verified_source == "cvrapi.dk"
    assert profile.dawa_address_id  # has a DAWA UUID
    assert profile.vat_registered is True
    assert profile.accountant_email == "anna@revisor.dk"
    assert profile.accountant_name == "Anna Hansen"


def test_seeded_profile_has_branchekode_for_restaurants(db, demo_user):
    """56.10.10 is the canonical Restauranter code — drives the
    business-type detection banner."""
    seed_demo_account(db)
    profile = db.query(BusinessProfile).filter_by(user_id=demo_user.id).first()
    assert profile.industry_code == "56.10.10"


# ─── Plan / trial setup for demo ──────────────────────────────────────

def test_seed_keeps_demo_user_on_free_plan(db, demo_user):
    """Demo plan stays as 'free' so effective_plan() resolves to
    'trial' (full Pro entitlements via PLAN_CAPS['trial']) AND the
    trial countdown chip in the sidebar has something to show.
    Earlier we bumped to 'pro' which suppressed the chip — now the
    countdown is the headline UX of the demo experience."""
    from datetime import datetime, timedelta
    assert demo_user.plan == "free"
    seed_demo_account(db)
    db.refresh(demo_user)
    assert demo_user.plan == "free"
    assert demo_user.trial_ends_at is not None
    # Trial should be ~14 days out
    delta = demo_user.trial_ends_at - datetime.utcnow()
    assert 13 <= delta.total_seconds() / 86400 <= 14.5


def test_seed_does_not_refresh_trial_when_more_than_7_days_remain(db):
    """Mid-trial restart: leave trial_ends_at alone so the user's
    chip naturally counts down day-by-day. Refresh only kicks in
    when trial would expire within 7 days."""
    from datetime import datetime, timedelta
    pinned = datetime.utcnow() + timedelta(days=10)  # 10 days out
    u = User(
        email=_DEMO_EMAIL,
        password_hash="x",
        business_name="X",
        currency="DKK",
        plan="free",
        trial_ends_at=pinned,
    )
    db.add(u); db.commit(); db.refresh(u)
    seed_demo_account(db)
    db.refresh(u)
    # Trial unchanged — still 10 days out (give or take a second)
    assert abs((u.trial_ends_at - pinned).total_seconds()) < 2


def test_seed_refreshes_trial_when_expiring_soon(db):
    """When trial would expire in ≤ 7 days, bump it back to 14 so
    the demo never falls to Free state in active walkthroughs."""
    from datetime import datetime, timedelta
    u = User(
        email=_DEMO_EMAIL,
        password_hash="x",
        business_name="X",
        currency="DKK",
        plan="free",
        trial_ends_at=datetime.utcnow() + timedelta(days=3),  # near expiry
    )
    db.add(u); db.commit(); db.refresh(u)
    seed_demo_account(db)
    db.refresh(u)
    # Trial is now ~14 days out
    delta = u.trial_ends_at - datetime.utcnow()
    assert 13 <= delta.total_seconds() / 86400 <= 14.5


def test_seed_resets_paid_plan_back_to_free(db):
    """If a previous version bumped demo to 'pro', reset to 'free'
    so the trial chip shows. Pro entitlements still apply via the
    active-trial path (effective_plan == 'trial' for free + active
    trial)."""
    from datetime import datetime, timedelta
    u = User(
        email=_DEMO_EMAIL,
        password_hash="x",
        business_name="X",
        currency="DKK",
        plan="pro",  # legacy state from earlier seed version
        trial_ends_at=None,
    )
    db.add(u); db.commit(); db.refresh(u)
    seed_demo_account(db)
    db.refresh(u)
    assert u.plan == "free"
    assert u.trial_ends_at is not None  # fresh trial set


# ─── Demo-friendly data details ──────────────────────────────────────

def test_seeded_closes_include_one_draft(db, demo_user):
    """Yesterday's close is left as a draft so the Edit/Unlock flow
    is demoable on a click."""
    seed_demo_account(db)
    drafts = db.query(DailyClose).filter_by(
        user_id=demo_user.id, status="draft",
    ).all()
    assert len(drafts) >= 1


def test_seeded_closes_include_cash_short_streak(db, demo_user):
    """A 3-day cash-short streak is intentionally seeded so the
    Insights tab shows the alert."""
    seed_demo_account(db)
    short_days = db.query(DailyClose).filter(
        DailyClose.user_id == demo_user.id,
        DailyClose.cash_difference <= -100,
    ).count()
    # Three consecutive short days
    assert short_days >= 3


def test_close_revenue_in_realistic_dk_restaurant_range():
    """Sanity — single-day revenue should be in the 8k-40k DKK range
    for a 30-seat Vesterbro restaurant. Pin so a model edit doesn't
    accidentally produce 100k spikes."""
    monday = date(2026, 5, 4)  # Monday
    saturday = date(2026, 5, 9)  # Saturday
    mon = _close_for_day(monday,   force_draft=False, with_short_cash=False)
    sat = _close_for_day(saturday, force_draft=False, with_short_cash=False)
    assert 8000 <= float(mon["revenue_total"]) <= 25000
    assert 18000 <= float(sat["revenue_total"]) <= 40000
    # Saturday should out-revenue Monday (weekend pattern)
    assert float(sat["revenue_total"]) > float(mon["revenue_total"])


def test_close_payment_total_equals_revenue_total():
    """Bookkeeping invariant — payment_total must equal revenue_total
    on every demo close so the kasserapport balances cleanly."""
    payload = _close_for_day(date(2026, 5, 9), force_draft=False,
                              with_short_cash=False)
    assert payload["payment_total"] == payload["revenue_total"]


def test_close_moms_is_25_percent_of_gross():
    """DK 25% MOMS extracted from gross — verify the math is right."""
    payload = _close_for_day(date(2026, 5, 9), force_draft=False,
                              with_short_cash=False)
    revenue = float(payload["revenue_total"])
    moms = float(payload["moms_total"])
    expected = round(revenue * 0.25 / 1.25, 2)
    assert abs(moms - expected) < 0.01


# ─── Reset path ──────────────────────────────────────────────────────

def test_reset_wipes_and_reseeds(db, demo_user):
    """First seed, then reset — counts should remain stable."""
    seed_demo_account(db)
    closes_before = db.query(DailyClose).filter_by(user_id=demo_user.id).count()

    result = reset_demo_account(db)
    assert result["reset"] is True
    assert result["seeded"]["skipped"] is False

    closes_after = db.query(DailyClose).filter_by(user_id=demo_user.id).count()
    assert closes_after == closes_before


def test_reset_skips_when_demo_user_missing(db):
    result = reset_demo_account(db)
    assert result.get("skipped") is True
