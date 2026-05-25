"""Tier-doctrine regression test (2026-05-25).

Manoj's locked rule: **Starter and Pro share features, only Free is gated.**
The Intelligence + Staff audits found 5 features illegally locked to
Pro-only. This test asserts they are now open to Starter+ at the
PLAN_FEATURES level AND the has_feature() resolution path — which is
the single chokepoint every backend enforce_feature() call routes
through.

If a future PLAN_FEATURES refactor flips any of these back to Pro-only,
this test fails loudly. Free stays gated on the same 5 features (we
specifically did NOT open them to Free — the rule is "Starter+Pro share,
Free is gated").

The 5 features moved Pro-only → Starter+:
  • bulk_staff_email          — email schedule to team (staff.py:1111)
  • inventory_autopilot       — auto-reorder stock (billing.py:424)
  • customer_outreach         — loyalty campaigns (billing.py:442)
  • growth_intelligence       — GrowthLever card (billing.py:591)
  • ai_predictive_staffing    — staffing forecast (billing.py:595)
"""
from __future__ import annotations

import pytest

from app.models.user import User
from app.services.billing import PLAN_FEATURES, has_feature


_FEATURES_OPENED_TO_STARTER = (
    "bulk_staff_email",
    "inventory_autopilot",
    "customer_outreach",
    "growth_intelligence",
    "ai_predictive_staffing",
)


def _user(plan: str) -> User:
    """Build an in-memory User; the billing helpers only read User.plan."""
    return User(
        email=f"tier-doctrine+{plan}@bonbox.test",
        password_hash="x",
        business_name="Test",
        currency="DKK",
        plan=plan,
    )


# ─── PLAN_FEATURES table assertions ────────────────────────────────────


@pytest.mark.parametrize("feature", _FEATURES_OPENED_TO_STARTER)
def test_starter_has_feature_in_plan_features_table(feature: str):
    """The PLAN_FEATURES["starter"] dict must have the feature flipped
    to True. This is the source-of-truth assertion — every gate goes
    through this dict."""
    assert PLAN_FEATURES["starter"].get(feature) is True, (
        f"Starter must have {feature}=True (tier-doctrine: Starter+Pro share)"
    )


@pytest.mark.parametrize("feature", _FEATURES_OPENED_TO_STARTER)
def test_pro_still_has_feature_in_plan_features_table(feature: str):
    """Pro never lost these features; the flip only opened them downward."""
    assert PLAN_FEATURES["pro"].get(feature) is True
    # Trial mirrors Pro — must also remain True.
    assert PLAN_FEATURES["trial"].get(feature) is True


@pytest.mark.parametrize("feature", _FEATURES_OPENED_TO_STARTER)
def test_free_still_gated_on_feature_in_plan_features_table(feature: str):
    """Free MUST stay gated on these features. The doctrine is
    'Starter+Pro share, Free is gated' — not 'open to everyone'."""
    assert PLAN_FEATURES["free"].get(feature) is False, (
        f"Free must have {feature}=False (tier-doctrine: Free stays gated)"
    )


# ─── has_feature() resolution — the choke point routers actually call ─


@pytest.mark.parametrize("feature", _FEATURES_OPENED_TO_STARTER)
def test_has_feature_returns_true_for_starter_user(feature: str):
    """has_feature() is what enforce_feature() consults. Every backend
    402 for these features traces back to this function returning False.
    After the doctrine fix, every Starter user MUST return True."""
    starter = _user("starter")
    assert has_feature(starter, feature) is True, (
        f"Starter user must pass has_feature({feature!r}) gate"
    )


@pytest.mark.parametrize("feature", _FEATURES_OPENED_TO_STARTER)
def test_has_feature_returns_false_for_free_user(feature: str):
    """Free users still see 402 on the same 5 features — the rule didn't
    open them to Free, only to Starter."""
    free = _user("free")
    assert has_feature(free, feature) is False, (
        f"Free user must still be gated on has_feature({feature!r})"
    )


@pytest.mark.parametrize("feature", _FEATURES_OPENED_TO_STARTER)
def test_has_feature_returns_true_for_pro_user(feature: str):
    """Pro keeps all 5 features (nothing regressed)."""
    pro = _user("pro")
    assert has_feature(pro, feature) is True
