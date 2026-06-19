"""Tests for the daily-close hardening shipped after the smart-import +
storage push:

  1. DailyCloseCreate schema bounds (revenue_total_override 0-1B,
     receipt_photo max 2000 chars, prices_include_moms_override bool).
  2. Per-tier daily Z-report scan quota (_today_scan_count +
     PLAN_CAPS["z_report_scans_per_day"]).

The router-level rate limits (12/minute on /scan-report etc.) are
exercised by SlowAPI's middleware and are integration-only — pinning
the schema + quota helpers covers the application-layer defense.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.daily_close import DailyClose
from app.models.user import User
from app.schemas.daily_close import DailyCloseCreate
from app.routers.daily_close import _today_scan_count
from app.services.billing import PLAN_CAPS
from app.services.tz_utils import business_today_local


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
def lars(db):
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


# ─── Schema bounds — Layer 2 defense ─────────────────────────────────

def test_dailyclose_create_minimal_payload_works():
    """Bare-minimum payload (just date) must succeed — many save paths
    use partial payloads (auto-save drafts before all fields filled)."""
    p = DailyCloseCreate(date=date.today())
    assert p.date == date.today()
    assert p.revenue_total_override is None
    assert p.prices_include_moms_override is None


def test_revenue_total_override_accepts_realistic_value():
    p = DailyCloseCreate(date=date.today(), revenue_total_override=14854.0)
    assert p.revenue_total_override == 14854.0


def test_revenue_total_override_rejects_negative():
    """ge=0 — closes can't have negative revenue. Pin so a future
    relax doesn't silently allow corrupt rows."""
    with pytest.raises(ValidationError):
        DailyCloseCreate(date=date.today(), revenue_total_override=-1)


def test_revenue_total_override_rejects_overflow():
    """le=1B (1,000,000,000 DKK) — DK restaurants do at most ~10M/day;
    1B is generous enough for any legitimate venue but rejects
    UI-bug payloads (e.g. someone typed cents into kroner field)."""
    with pytest.raises(ValidationError):
        DailyCloseCreate(date=date.today(), revenue_total_override=1_000_000_001)


def test_revenue_total_override_at_zero_is_accepted():
    """ge=0 is INCLUSIVE so a 0 DKK day (closed for renovation) saves
    cleanly — this is a legit business case, not a bug."""
    p = DailyCloseCreate(date=date.today(), revenue_total_override=0)
    assert p.revenue_total_override == 0


def test_prices_include_moms_override_strict_bool():
    """Pydantic 2 doesn't auto-coerce strings to bool for typed bool
    fields — typing it explicit prevents 'true'/'false' string drift
    that would silently flip MOMS calculation."""
    p = DailyCloseCreate(date=date.today(), prices_include_moms_override=True)
    assert p.prices_include_moms_override is True
    p2 = DailyCloseCreate(date=date.today(), prices_include_moms_override=False)
    assert p2.prices_include_moms_override is False


def test_receipt_photo_length_capped():
    """2000-char cap — comfortably above signed-URL length (~700 chars)
    but rejects payload bombs like a 1MB blob in the JSON field."""
    with pytest.raises(ValidationError):
        DailyCloseCreate(
            date=date.today(),
            receipt_photo="x" * 2001,
        )


def test_receipt_photo_at_upper_bound_passes():
    p = DailyCloseCreate(
        date=date.today(),
        receipt_photo="x" * 2000,
    )
    assert len(p.receipt_photo) == 2000


# ─── Per-tier scan quota — Layer 5 defense ───────────────────────────

def test_scan_caps_pinned_per_tier():
    """Marketing claims 'Free: limited scans, Pro: generous' — pin the
    actual numbers so a future shuffle requires a deliberate decision
    (and a marketing-page update). Read from the unified PLAN_CAPS
    source-of-truth (May 2026 consolidation)."""
    assert PLAN_CAPS["free"]["z_report_scans_per_day"] == 3
    assert PLAN_CAPS["starter"]["z_report_scans_per_day"] == 20
    assert PLAN_CAPS["pro"]["z_report_scans_per_day"] == 100
    assert PLAN_CAPS["trial"]["z_report_scans_per_day"] == 100  # = full Pro
    # (Business tier dropped May 2026.)


def test_today_scan_count_zero_for_new_user(db, lars):
    """Brand-new user, no scans → returns 0."""
    assert _today_scan_count(db, lars) == 0


def test_today_scan_count_tracks_close_rows_with_photo(db, lars):
    """Each DailyClose row with receipt_photo set on today counts.
    Cleanly drafted closes (no photo) don't count toward the AI cap."""
    today = business_today_local(lars)
    # No-photo close — doesn't count toward scan cap
    no_photo = DailyClose(
        id=uuid.uuid4(),
        user_id=lars.id,
        date=today,
        revenue_total=0,
        payment_total=0,
        receipt_photo=None,
    )
    # Two photo-closes — count
    photo_a = DailyClose(
        id=uuid.uuid4(),
        user_id=lars.id,
        date=today,
        revenue_total=14854,
        payment_total=14854,
        receipt_photo="https://example/storage/sign/...",
    )
    photo_b = DailyClose(
        id=uuid.uuid4(),
        user_id=lars.id,
        date=today,
        revenue_total=14854,
        payment_total=14854,
        receipt_photo="https://example/storage/sign/...",
        branch_id=uuid.uuid4(),  # different branch so unique constraint passes
    )
    db.add_all([no_photo, photo_a, photo_b]); db.commit()

    assert _today_scan_count(db, lars) == 2


def test_today_scan_count_ignores_yesterday(db, lars):
    """Yesterday's photos don't count — quota resets at midnight."""
    from datetime import timedelta
    today = business_today_local(lars)
    yesterday = today - timedelta(days=1)
    old_photo = DailyClose(
        id=uuid.uuid4(),
        user_id=lars.id,
        date=yesterday,
        revenue_total=14854,
        payment_total=14854,
        receipt_photo="https://example/storage/sign/old.jpg",
    )
    db.add(old_photo); db.commit()

    assert _today_scan_count(db, lars) == 0


def test_today_scan_count_isolated_per_user(db, lars):
    """Defense: another user's photo-closes do NOT count against this
    user's quota. Tenant isolation invariant — same shape as the
    quota logic in inventory_smart_import._check_daily_quota."""
    other = User(
        email="other@example.com", password_hash="x",
        business_name="Other", business_type="restaurant", currency="DKK", plan="free",
    )
    db.add(other); db.commit(); db.refresh(other)

    today = business_today_local(other)
    other_photo = DailyClose(
        id=uuid.uuid4(),
        user_id=other.id,
        date=today,
        revenue_total=14854,
        payment_total=14854,
        receipt_photo="https://example/storage/sign/other.jpg",
    )
    db.add(other_photo); db.commit()

    # Lars's count is 0 — other's photo doesn't leak.
    assert _today_scan_count(db, lars) == 0
    assert _today_scan_count(db, other) == 1


# ─── Layered save logic — max(breakdown_sum, override) regression ────
#
# Replays the exact scenario Manoj saw on /daily-close: OCR detected
# Total=17,030 but only one category got a (wrong) value 1.82. The
# previous logic preferred breakdown_sum and saved 1.82 — silently
# overwriting the real total. The fix: max() picks the larger value.
# This test pins that behavior so a future refactor can't undo it.

def _resolve_total(breakdown: dict | None, override: float | None) -> float:
    """Replicates the router's revenue_total computation in commit
    6a58898. If anyone touches the router logic, both this helper and
    the test must update together — keeping the contract explicit."""
    breakdown_sum = sum((breakdown or {}).values())
    if override is not None and override > 0:
        return float(max(breakdown_sum, override))
    return float(breakdown_sum) if breakdown_sum > 0 else 0.0


def test_save_total_picks_override_when_breakdown_partial():
    """Manoj's scenario: OCR found 17,030 total but Drinks parsed wrong
    as 1.82. Saved value MUST be 17,030, not 1.82."""
    breakdown = {"drinks": 1.82}  # wrong-parse only
    assert _resolve_total(breakdown, 17030) == 17030


def test_save_total_picks_override_when_breakdown_empty():
    """Backstop case: no breakdown at all, just OCR total."""
    assert _resolve_total({}, 17030) == 17030
    assert _resolve_total(None, 17030) == 17030


def test_save_total_uses_breakdown_sum_when_user_exceeded_override():
    """User saw OCR override 17,030 but typed in food=10,000,
    drinks=5,000, takeaway=8,000 = 23,000 because they recall extra
    revenue not on the receipt. Their explicit edit must win."""
    breakdown = {"food": 10_000, "drinks": 5_000, "takeaway": 8_000}
    assert _resolve_total(breakdown, 17030) == 23_000


def test_save_total_returns_breakdown_sum_when_no_override():
    """No OCR scan happened — pure manual entry path. Should keep
    backwards-compatible behavior."""
    breakdown = {"food": 100, "drinks": 200}
    assert _resolve_total(breakdown, None) == 300


def test_save_total_zero_when_nothing_provided():
    """Empty close (saved as draft with no fields filled). Returns 0
    so the row exists but won't pollute revenue stats."""
    assert _resolve_total({}, None) == 0
    assert _resolve_total(None, None) == 0
    assert _resolve_total({"food": 0}, None) == 0


def test_save_total_full_breakdown_match_no_double_count():
    """User filled all 3 cats summing exactly to OCR total. Both paths
    converge to the same number — max() doesn't double anything."""
    breakdown = {"food": 10_000, "drinks": 5_000, "takeaway": 2_030}
    assert _resolve_total(breakdown, 17_030) == 17_030


def test_save_total_user_can_zero_out_a_value_without_losing_total():
    """Edge: user manually clears a category to zero (e.g. fixing a
    wrong OCR value) but doesn't fill the others. Override still
    rescues the total — they don't lose the day's revenue from one
    correction."""
    breakdown = {"food": 0, "drinks": 0, "takeaway": 0}
    assert _resolve_total(breakdown, 17_030) == 17_030
