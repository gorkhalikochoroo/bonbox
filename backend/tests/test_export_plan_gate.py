"""Tests for the per-tier daily_close_export_days plan gate.

Coverage:
  • PLAN_CAPS — every tier has the new entitlement set
  • get_cap() — returns the correct number per tier
  • _resolve_range — accepts requests at the cap
  • _resolve_range — rejects requests above the cap with 402
  • _resolve_range — error detail carries the upgrade context
  • _resolve_range — Pro/Trial/Business are not capped (within ceiling)
  • _resolve_range — without a user, no plan check (backwards compat)
  • _resolve_range — hard ceiling (366d) still applies even on Pro
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from fastapi import HTTPException

from app.models.user import User
from app.routers.daily_close import _MAX_RANGE_DAYS, _resolve_range
from app.services.billing import PLAN_CAPS, get_cap


# ─── Fixtures ─────────────────────────────────────────────────────────

def _user(plan="free", trial_active=False):
    """Quick User fixture — no DB needed since billing helpers only
    read attributes."""
    u = User(
        email=f"{plan}@test.dk",
        password_hash="x",
        plan=plan,
    )
    if trial_active:
        u.trial_ends_at = datetime.utcnow() + timedelta(days=7)
    return u


# ─── PLAN_CAPS: every tier defines the entitlement ───────────────────

def test_plan_caps_includes_daily_close_export_days_for_every_tier():
    """A future tier added without this key would silently fall back
    to the free cap. Pin every tier so it has to be set explicitly.
    Three purchasable plans + the trial state — Business was dropped
    May 2026."""
    for tier in ("free", "starter", "trial", "pro"):
        assert "daily_close_export_days" in PLAN_CAPS[tier], (
            f"Tier {tier!r} missing daily_close_export_days in PLAN_CAPS"
        )


def test_plan_caps_free_tier_is_seven_days():
    """Hard pin — Free === 7 days. If we ever bump this, lots of
    docs + screenshots need to update too."""
    assert PLAN_CAPS["free"]["daily_close_export_days"] == 7


def test_plan_caps_starter_is_31_days():
    """Starter covers month-end accountant handoff."""
    assert PLAN_CAPS["starter"]["daily_close_export_days"] == 31


def test_plan_caps_pro_matches_hard_ceiling():
    """Pro / Trial get the full year (matches the _MAX_RANGE_DAYS
    ceiling so paid tiers see no soft cap)."""
    assert PLAN_CAPS["pro"]["daily_close_export_days"] == 366
    assert PLAN_CAPS["trial"]["daily_close_export_days"] == 366


# ─── get_cap() lookup ────────────────────────────────────────────────

def test_get_cap_returns_per_tier_value():
    assert get_cap(_user("free"), "daily_close_export_days") == 7
    assert get_cap(_user("starter"), "daily_close_export_days") == 31
    assert get_cap(_user("pro"), "daily_close_export_days") == 366
    # Legacy "business" plan resolves to Pro defensively.
    assert get_cap(_user("business"), "daily_close_export_days") == 366


def test_get_cap_active_trial_uses_pro_cap():
    """A user on plan='free' with an active trial gets pro entitlements
    (per effective_plan() rules) — including the export cap."""
    user = _user("free", trial_active=True)
    assert get_cap(user, "daily_close_export_days") == 366


# ─── _resolve_range with plan gate ───────────────────────────────────

def test_resolve_range_free_tier_accepts_7_day_span():
    """The exact cap is allowed — boundary case."""
    user = _user("free")
    f, t = _resolve_range(date(2026, 5, 1), date(2026, 5, 7), user=user)
    assert (t - f).days == 6  # 7 days inclusive


def test_resolve_range_free_tier_rejects_8_day_span_with_402():
    """One day over the cap → 402 with structured upgrade detail."""
    user = _user("free")
    with pytest.raises(HTTPException) as ei:
        _resolve_range(date(2026, 5, 1), date(2026, 5, 8), user=user)
    assert ei.value.status_code == 402
    assert isinstance(ei.value.detail, dict)
    assert ei.value.detail["code"] == "plan_cap_exceeded"
    assert ei.value.detail["cap_days"] == 7
    assert ei.value.detail["plan"] == "free"
    assert "Free" in ei.value.detail["message"]
    assert "Pro" in ei.value.detail["message"]


def test_resolve_range_starter_tier_rejects_60_day_span():
    """Starter caps at 31 days — 60 should be 402."""
    user = _user("starter")
    with pytest.raises(HTTPException) as ei:
        _resolve_range(date(2026, 4, 1), date(2026, 5, 31), user=user)
    assert ei.value.status_code == 402
    assert ei.value.detail["cap_days"] == 31


def test_resolve_range_starter_tier_accepts_31_day_span():
    """Boundary — exactly 31 days inclusive on Starter is allowed."""
    user = _user("starter")
    f, t = _resolve_range(date(2026, 5, 1), date(2026, 5, 31), user=user)
    assert (t - f).days == 30  # 31 days inclusive


def test_resolve_range_pro_tier_accepts_full_year():
    """Pro can export a full year — only the hard ceiling matters."""
    user = _user("pro")
    f, t = _resolve_range(date(2025, 5, 1), date(2026, 4, 30), user=user)
    assert (t - f).days >= 360


def test_resolve_range_hard_ceiling_applies_even_for_pro():
    """A 2-year request from Pro still hits the 422 hard ceiling
    (defense in depth — the per-tier cap is a softer layer above)."""
    user = _user("pro")
    with pytest.raises(HTTPException) as ei:
        _resolve_range(date(2024, 1, 1), date(2026, 5, 1), user=user)
    assert ei.value.status_code == 422


def test_resolve_range_without_user_skips_plan_check():
    """Backward compat — internal callers without a user get no
    plan gate (only the inverted-range + hard-ceiling checks). Keeps
    the old test signature working."""
    f, t = _resolve_range(date(2026, 5, 1), date(2026, 5, 31))  # no user kwarg
    assert (t - f).days == 30


def test_resolve_range_inverted_range_takes_precedence_over_plan():
    """If both inverted AND would-be-over-cap, return 422 (input
    error) before checking the plan."""
    user = _user("free")
    with pytest.raises(HTTPException) as ei:
        _resolve_range(date(2026, 5, 31), date(2026, 5, 1), user=user)
    assert ei.value.status_code == 422


def test_resolve_range_402_includes_requested_days():
    """The error detail surfaces what the user asked for, so the UI
    can render 'You asked for 30 days, you can have 7'."""
    user = _user("free")
    with pytest.raises(HTTPException) as ei:
        _resolve_range(date(2026, 5, 1), date(2026, 5, 30), user=user)
    assert ei.value.detail["requested_days"] == 30
    assert ei.value.detail["cap_days"] == 7
