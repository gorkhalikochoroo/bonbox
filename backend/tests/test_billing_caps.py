"""Tests for the PLAN_CAPS source-of-truth + cap helpers.

These tests pin the cap matrix structurally so a future tweak to the
marketing page (e.g. "now Starter gets 5 users") forces a corresponding
code change here — preventing silent drift between what we advertise
and what the gates allow.

Multi-layer defense:
  Layer 1: PLAN_CAPS dict shape pinned (every plan has every key)
  Layer 2: get_cap() returns the right number per plan × key
  Layer 3: at_cap() returns true/false on the boundary
  Layer 4: effective_plan() recognizes "starter" as paid
  Layer 5: trial gives the same caps as Pro (matches the marketing claim)
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.models.user import User
from app.services.billing import (
    PLAN_CAPS,
    at_cap,
    billing_summary,
    effective_plan,
    get_cap,
)


# ─── Fixtures: a User in each plan state ────────────────────────────────

def _user(plan: str | None = None, *, in_trial: bool = False) -> User:
    """Cheap in-memory User. We don't persist — billing helpers read fields
    only, no DB access required."""
    u = User(
        email="test@example.com",
        password_hash="x",
        business_name="Test",
        business_type="restaurant",
        currency="DKK",
    )
    if plan is not None:
        u.plan = plan
    if in_trial:
        u.trial_ends_at = datetime.utcnow() + timedelta(days=7)
    else:
        u.trial_ends_at = None
    return u


# ─── Layer 1: PLAN_CAPS shape ──────────────────────────────────────────

def test_plan_caps_has_every_known_plan():
    """Pin the exact set of plans we advertise. Adding/removing a plan must
    be a deliberate code change to this test so marketing + caps + gates
    stay in lockstep."""
    assert set(PLAN_CAPS.keys()) == {"free", "trial", "starter", "pro", "business"}


def test_plan_caps_has_every_resource_key():
    """Every plan must have an entitlement for every resource we cap on.
    Missing keys would cause silent fallback behaviour at the gate level."""
    expected_keys = {"branches", "team_users", "modules"}
    for plan_name, caps in PLAN_CAPS.items():
        assert expected_keys.issubset(caps.keys()), (
            f"Plan {plan_name!r} is missing one of {expected_keys}: got {set(caps.keys())}"
        )


def test_plan_caps_match_marketing_page():
    """These numbers MUST match the SubscriptionPage TIERS array in the
    frontend. Drift here = customer-facing claim that contradicts the
    backend gate. Pin them explicitly."""
    # Free: 1 business, 1 user, 1 vertical module
    assert PLAN_CAPS["free"]["branches"] == 1
    assert PLAN_CAPS["free"]["team_users"] == 1
    assert PLAN_CAPS["free"]["modules"] == 1
    # Starter: 1 business, 3 users, 1 vertical module
    assert PLAN_CAPS["starter"]["branches"] == 1
    assert PLAN_CAPS["starter"]["team_users"] == 3
    assert PLAN_CAPS["starter"]["modules"] == 1
    # Pro: 3 businesses, 5 users, all modules
    assert PLAN_CAPS["pro"]["branches"] == 3
    assert PLAN_CAPS["pro"]["team_users"] == 5
    assert PLAN_CAPS["pro"]["modules"] == -1  # unlimited
    # Business: effectively unlimited
    assert PLAN_CAPS["business"]["branches"] >= 999
    assert PLAN_CAPS["business"]["team_users"] >= 999


def test_trial_caps_match_pro_caps():
    """The marketing claim '14 days of full Pro' MUST be true at the cap
    level. Trial entitlement for every resource matches Pro's exactly."""
    assert PLAN_CAPS["trial"] == PLAN_CAPS["pro"]


# ─── Layer 2: get_cap() ────────────────────────────────────────────────

@pytest.mark.parametrize("plan,expected", [
    ("free",     1),
    ("starter",  1),
    ("pro",      3),
    ("business", 999),
])
def test_get_cap_branches_per_plan(plan, expected):
    u = _user(plan)
    assert get_cap(u, "branches") == expected


@pytest.mark.parametrize("plan,expected", [
    ("free",     1),
    ("starter",  3),
    ("pro",      5),
    ("business", 999),
])
def test_get_cap_team_users_per_plan(plan, expected):
    u = _user(plan)
    assert get_cap(u, "team_users") == expected


def test_get_cap_trial_user_gets_pro_caps():
    """Trial user (plan='free' but trial_ends_at in future) gets Pro caps."""
    u = _user("free", in_trial=True)
    assert get_cap(u, "branches") == 3
    assert get_cap(u, "team_users") == 5


def test_get_cap_unknown_key_falls_back_to_free():
    """Unknown resource key fails closed — returns Free's value (or 0)."""
    u = _user("pro")
    # 'imaginary_resource' isn't in any plan's caps → falls back to free
    # which also doesn't have it → 0
    assert get_cap(u, "imaginary_resource") == 0


def test_get_cap_unknown_plan_falls_back_to_free():
    """User with garbage plan value gets Free caps — fail closed."""
    u = _user("hackerman")
    assert get_cap(u, "branches") == 1  # Free's branches cap


# ─── Layer 3: at_cap() ─────────────────────────────────────────────────

def test_at_cap_returns_false_when_under():
    u = _user("free")  # cap = 1 branch
    assert at_cap(u, "branches", 0) is False


def test_at_cap_returns_true_at_boundary():
    """At the boundary: count == cap → at_cap is True (no more allowed)."""
    u = _user("free")
    assert at_cap(u, "branches", 1) is True


def test_at_cap_returns_true_over_boundary():
    """Defensive: count > cap (legacy data, manual DB inserts) still treated
    as at-cap so future creates fail."""
    u = _user("free")
    assert at_cap(u, "branches", 5) is True


def test_at_cap_unlimited_returns_false():
    """A -1 cap means unlimited — at_cap always False regardless of count."""
    u = _user("pro")
    # Pro modules cap = -1 (unlimited)
    assert at_cap(u, "modules", 0) is False
    assert at_cap(u, "modules", 100) is False
    assert at_cap(u, "modules", 999_999) is False


# ─── Layer 4: effective_plan() recognizes starter ──────────────────────

def test_effective_plan_recognizes_starter():
    """A user with plan='starter' must report as 'starter' — not silently
    fall through to 'free'. This was the bug that caused Starter
    subscribers to see Free caps."""
    u = _user("starter")
    assert effective_plan(u) == "starter"


def test_effective_plan_recognizes_all_paid_plans():
    for plan in ("starter", "pro", "business"):
        assert effective_plan(_user(plan)) == plan


def test_effective_plan_falls_through_to_free():
    u = _user("free")
    assert effective_plan(u) == "free"


def test_effective_plan_trial_overrides_free():
    u = _user("free", in_trial=True)
    assert effective_plan(u) == "trial"


def test_effective_plan_paid_plan_beats_active_trial():
    """If user upgraded mid-trial, paid plan wins over trial state."""
    u = _user("pro", in_trial=True)
    assert effective_plan(u) == "pro"


def test_effective_plan_expired_trial_drops_to_free():
    u = _user("free")
    u.trial_ends_at = datetime.utcnow() - timedelta(days=1)
    assert effective_plan(u) == "free"


# ─── Layer 5: billing_summary returns caps ─────────────────────────────

def test_billing_summary_includes_caps():
    """Frontend needs caps in the billing payload to render '1/1 used' UI
    without a second API call."""
    u = _user("starter")
    summary = billing_summary(u)
    assert "caps" in summary
    assert summary["caps"]["branches"] == 1
    assert summary["caps"]["team_users"] == 3
    assert summary["caps"]["modules"] == 1


def test_billing_summary_caps_for_trial_match_pro():
    """Trial user's summary shows Pro caps so UI can render trial as Pro."""
    u = _user("free", in_trial=True)
    summary = billing_summary(u)
    assert summary["caps"] == PLAN_CAPS["pro"]


def test_billing_summary_starter_is_paid():
    """is_paid must include 'starter' — it's a paid tier just like Pro."""
    u = _user("starter")
    summary = billing_summary(u)
    assert summary["is_paid"] is True


def test_billing_summary_caps_immutable_via_caller():
    """The returned 'caps' dict must be a copy — caller mutating it must
    not corrupt the source-of-truth PLAN_CAPS."""
    u = _user("free")
    summary = billing_summary(u)
    summary["caps"]["branches"] = 999_999  # malicious mutation
    # Original dict unchanged
    assert PLAN_CAPS["free"]["branches"] == 1
