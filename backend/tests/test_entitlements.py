"""Tests for the unified entitlements layer (services/billing.py + the
/api/billing/entitlements endpoint).

Three purchasable tiers (Free / Starter / Pro) + the internal "trial"
state. "Business" was dropped May 2026; tests pin that decision so a
re-introduction is a deliberate change, not a silent drift.

Coverage:
  • PLAN_CAPS / PLAN_FEATURES shape invariants — every plan has every key
  • Starter-tier leak guard — every numeric cap MUST exist for "starter"
    (the old leaks where Starter fell through to Free's cap are
    permanently sealed)
  • effective_plan() resolution: free vs trial vs paid vs expired-trial
  • Legacy plan="business" → "pro" defensive mapping
  • get_cap() / has_feature() round-trip for every (plan, key)
  • min_plan_for_feature() / min_plan_for_cap() upsell hints
  • cap_exceeded_detail / feature_locked_detail payload shape
  • enforce_cap / enforce_feature raise 402 with structured detail
  • billing_summary() includes both caps + features
  • entitlements_payload() shape (and includes plans/min_plan_by_feature)
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from app.models.user import User
from app.services.billing import (
    PLAN_CAPS,
    PLAN_FEATURES,
    PLAN_ORDER,
    at_cap,
    billing_summary,
    cap_exceeded_detail,
    effective_plan,
    enforce_cap,
    enforce_feature,
    entitlements_payload,
    feature_locked_detail,
    get_cap,
    has_feature,
    min_plan_for_cap,
    min_plan_for_feature,
)
from app.utils.time import utc_now


def _u(plan: str | None = None, trial_days: int | None = None) -> User:
    """Build a User with the given plan + optional active trial. Uses
    in-memory only — no DB needed since the billing helpers only read
    User.plan + User.trial_ends_at."""
    u = User(
        email=f"x+{plan}@bonbox.test",
        password_hash="x",
        business_name="Test",
        currency="DKK",
        plan=plan or "free",
    )
    if trial_days is not None:
        u.trial_ends_at = utc_now() + timedelta(days=trial_days)
    return u


# ─── Shape invariants — these would have caught the original leak ─────


def test_plan_caps_three_tier_plus_trial():
    """Three purchasable plans (Free/Starter/Pro) + the internal trial
    state. Business was dropped May 2026; this test pins that decision."""
    expected = {"free", "starter", "trial", "pro"}
    assert set(PLAN_CAPS.keys()) == expected


def test_plan_features_three_tier_plus_trial():
    expected = {"free", "starter", "trial", "pro"}
    assert set(PLAN_FEATURES.keys()) == expected


def test_plan_order_is_purchasable_only_no_trial_no_business():
    """PLAN_ORDER drives min_plan_for_feature/cap upsell hints. It MUST
    contain only purchasable plans in ascending order — trial is not
    purchasable, business is gone."""
    assert PLAN_ORDER == ["free", "starter", "pro"]


def test_every_plan_has_every_cap_key():
    """The Starter-tier leak fix lives here: if a plan is missing a key,
    .get(plan, default) used to silently fall through to Free's cap.
    Now every plan must define every key explicitly — anyone adding a
    new cap to PLAN_CAPS["free"] gets a test failure until they add it
    to every other plan too."""
    free_keys = set(PLAN_CAPS["free"].keys())
    for plan, caps in PLAN_CAPS.items():
        assert set(caps.keys()) == free_keys, (
            f"Plan '{plan}' is missing cap keys — would silently fall "
            f"back to Free's cap. Missing: {free_keys - set(caps.keys())}"
        )


def test_every_plan_has_every_feature_key():
    free_keys = set(PLAN_FEATURES["free"].keys())
    for plan, feats in PLAN_FEATURES.items():
        assert set(feats.keys()) == free_keys, (
            f"Plan '{plan}' is missing feature keys: "
            f"{free_keys - set(feats.keys())}"
        )


def test_starter_caps_at_or_above_free_for_every_key():
    """A Starter user paid money — they must NEVER have a smaller cap
    than a Free user on any dimension. -1 (unlimited) trumps any
    positive value. Catches future tier-shuffles that accidentally
    regress Starter."""
    for key, free_val in PLAN_CAPS["free"].items():
        starter_val = PLAN_CAPS["starter"][key]
        if starter_val == -1:
            continue  # unlimited beats any positive value
        if free_val == -1:
            pytest.fail(f"Free has unlimited {key} but Starter has finite cap — bug")
        assert starter_val >= free_val, (
            f"Starter's {key}={starter_val} < Free's {free_val} — Starter regressed"
        )


def test_pro_caps_at_or_above_starter_for_every_key():
    for key, starter_val in PLAN_CAPS["starter"].items():
        pro_val = PLAN_CAPS["pro"][key]
        if pro_val == -1:
            continue
        if starter_val == -1:
            pytest.fail(f"Starter has unlimited {key} but Pro has finite cap — bug")
        assert pro_val >= starter_val, (
            f"Pro's {key}={pro_val} < Starter's {starter_val}"
        )


def test_trial_matches_pro_for_every_cap():
    """Marketing claim: '14 days of full Pro'. Verify by exact match —
    any drift means the marketing copy is wrong OR the trial silently
    became less generous than promised."""
    assert PLAN_CAPS["trial"] == PLAN_CAPS["pro"]


def test_trial_matches_pro_for_every_feature():
    """Same '14 days of full Pro' guarantee — feature flags edition."""
    assert PLAN_FEATURES["trial"] == PLAN_FEATURES["pro"]


# (Business tier removed May 2026 — no Business >= Pro test needed.)


# ─── effective_plan ───────────────────────────────────────────────────


def test_effective_plan_paid_trumps_trial():
    """A paid user with an active trial still resolves to their paid plan."""
    u = _u("pro", trial_days=10)
    assert effective_plan(u) == "pro"


def test_effective_plan_active_trial_returns_trial():
    u = _u("free", trial_days=5)
    assert effective_plan(u) == "trial"


def test_effective_plan_expired_trial_returns_free():
    u = _u("free", trial_days=-1)  # ended yesterday
    assert effective_plan(u) == "free"


def test_effective_plan_no_plan_no_trial_returns_free():
    u = _u()
    u.plan = None
    assert effective_plan(u) == "free"


# ─── get_cap / has_feature round-trips ────────────────────────────────


@pytest.mark.parametrize("plan", ["free", "starter", "pro"])
def test_get_cap_returns_plan_caps_value_for_every_key(plan):
    u = _u(plan)
    for key, expected in PLAN_CAPS[plan].items():
        assert get_cap(u, key) == expected, f"{plan}.{key} mismatch"


@pytest.mark.parametrize("plan", ["free", "starter", "pro"])
def test_has_feature_returns_plan_features_value_for_every_key(plan):
    u = _u(plan)
    for key, expected in PLAN_FEATURES[plan].items():
        assert has_feature(u, key) is expected, f"{plan}.{key} mismatch"


def test_get_cap_unknown_key_falls_back_to_free():
    u = _u("pro")
    # "made_up_cap" doesn't exist anywhere → returns Free's value (which
    # is also missing → 0). Never raises.
    assert get_cap(u, "made_up_cap") == 0


def test_has_feature_unknown_feature_returns_false():
    """Unknown features fail closed (False) — protects against typos
    silently granting access."""
    u = _u("pro")  # top tier
    assert has_feature(u, "made_up_feature") is False


# ─── at_cap ───────────────────────────────────────────────────────────


def test_at_cap_unlimited_never_at_cap():
    u = _u("pro")
    # modules is -1 (unlimited) on Pro
    assert at_cap(u, "modules", 99999) is False


# ─── Legacy "business" plan defensive mapping ─────────────────────────


def test_legacy_business_plan_resolves_to_pro():
    """No production users have plan="business" today, but a stale dev
    DB or test fixture might. effective_plan() must NOT return "business"
    (which is no longer in PLAN_CAPS) and must NOT downgrade the user
    to Free. It maps to "pro" — the top current tier — so the user keeps
    paid entitlements until Stripe sync corrects the column."""
    u = _u("business")
    assert effective_plan(u) == "pro"
    # And they get full Pro entitlements, not Free's
    assert get_cap(u, "branches") == 3
    assert has_feature(u, "ai_anomaly_detection") is True
    assert has_feature(u, "multi_branch_dashboard") is True


def test_legacy_business_plan_billing_summary_is_paid():
    """billing_summary().is_paid must be True for legacy business — so
    the user doesn't see "you're on Free" UI while their Stripe sub is
    still active."""
    u = _u("business")
    summary = billing_summary(u)
    # plan field shows the resolved tier (Pro), not the raw "business"
    assert summary["plan"] == "pro"
    assert summary["is_paid"] is True


# ─── api_access feature is gone ───────────────────────────────────────


def test_api_access_feature_removed():
    """api_access was Business-only. With Business gone and no public
    API shipped, the feature flag is removed entirely. has_feature()
    must fail closed (False) for any plan rather than 'silently True'
    on Pro."""
    for plan in ["free", "starter", "pro"]:
        u = _u(plan)
        assert has_feature(u, "api_access") is False


def test_at_cap_below_cap_returns_false():
    u = _u("free")
    # branches is 1 on Free
    assert at_cap(u, "branches", 0) is False


def test_at_cap_at_cap_returns_true():
    u = _u("free")
    assert at_cap(u, "branches", 1) is True


def test_at_cap_above_cap_returns_true():
    u = _u("free")
    assert at_cap(u, "branches", 5) is True


# ─── min_plan_for_feature / min_plan_for_cap ──────────────────────────


def test_min_plan_for_feature_finds_lowest_unlocking_plan():
    # ai_anomaly_detection unlocks at Starter
    assert min_plan_for_feature("ai_anomaly_detection") == "starter"


def test_min_plan_for_feature_pro_only_returns_pro():
    # multi_branch_dashboard is Pro-only (Starter has 1 branch only)
    assert min_plan_for_feature("multi_branch_dashboard") == "pro"


def test_min_plan_for_feature_unknown_returns_none():
    assert min_plan_for_feature("nonexistent") is None


def test_min_plan_for_feature_excludes_trial():
    """trial is not purchasable — upsell should never recommend it."""
    for feature in PLAN_FEATURES["free"].keys():
        result = min_plan_for_feature(feature)
        assert result != "trial"


def test_min_plan_for_cap_exact_value():
    # Starter has 31 daily_close_export_days. Asking for 14 → starter.
    assert min_plan_for_cap("daily_close_export_days", 14) == "starter"


def test_min_plan_for_cap_needs_pro():
    # Need 200 days export → Starter (31) too small → Pro (366)
    assert min_plan_for_cap("daily_close_export_days", 200) == "pro"


def test_min_plan_for_cap_unlimited_satisfies_anything():
    # modules is -1 (unlimited) on Pro+ — needing 999 should pick Pro
    assert min_plan_for_cap("modules", 999) == "pro"


def test_min_plan_for_cap_already_in_free_returns_free():
    # Free has 1 branch — needing 1 → free already satisfies.
    assert min_plan_for_cap("branches", 1) == "free"


# ─── cap_exceeded_detail / feature_locked_detail ───────────────────────


def test_cap_exceeded_detail_shape():
    u = _u("free")
    detail = cap_exceeded_detail(u, "branches", current=1)
    assert detail["error"] == "cap_exceeded"
    assert detail["cap"] == "branches"
    assert detail["current"] == 1
    assert detail["limit"] == 1
    assert detail["plan"] == "free"
    # Free has 1 branch, current=1 → need 2 → Pro is the lowest with 3
    assert detail["upgrade_to"] == "pro"


def test_feature_locked_detail_shape():
    u = _u("free")
    detail = feature_locked_detail(u, "ai_anomaly_detection")
    assert detail["error"] == "feature_locked"
    assert detail["feature"] == "ai_anomaly_detection"
    assert detail["plan"] == "free"
    assert detail["upgrade_to"] == "starter"


# ─── enforce_cap / enforce_feature ─────────────────────────────────────


def test_enforce_cap_no_op_when_below_cap():
    u = _u("pro")
    enforce_cap(u, "branches", 0)  # under cap — should not raise


def test_enforce_cap_raises_402_when_at_cap():
    u = _u("free")
    with pytest.raises(HTTPException) as exc:
        enforce_cap(u, "branches", 1)
    assert exc.value.status_code == 402
    assert exc.value.detail["error"] == "cap_exceeded"


def test_enforce_feature_no_op_when_unlocked():
    u = _u("pro")
    enforce_feature(u, "ai_anomaly_detection")  # unlocked — should not raise


def test_enforce_feature_raises_402_when_locked():
    u = _u("free")
    with pytest.raises(HTTPException) as exc:
        enforce_feature(u, "ai_anomaly_detection")
    assert exc.value.status_code == 402
    assert exc.value.detail["error"] == "feature_locked"
    assert exc.value.detail["upgrade_to"] == "starter"


# ─── billing_summary ──────────────────────────────────────────────────


def test_billing_summary_includes_caps_and_features():
    u = _u("starter")
    summary = billing_summary(u)
    assert summary["plan"] == "starter"
    assert summary["is_paid"] is True
    assert summary["trial_active"] is False
    assert summary["caps"] == PLAN_CAPS["starter"]
    assert summary["features"] == PLAN_FEATURES["starter"]


def test_billing_summary_caps_are_a_copy_not_a_reference():
    """Mutating the returned dict must not corrupt the source-of-truth."""
    u = _u("free")
    summary = billing_summary(u)
    summary["caps"]["branches"] = 9999
    # Re-read; underlying source-of-truth is intact
    assert PLAN_CAPS["free"]["branches"] == 1


# ─── entitlements_payload ─────────────────────────────────────────────


def test_entitlements_payload_includes_min_plan_by_feature():
    u = _u("free")
    payload = entitlements_payload(u)
    assert "min_plan_by_feature" in payload
    assert payload["min_plan_by_feature"]["ai_anomaly_detection"] == "starter"
    assert payload["min_plan_by_feature"]["multi_branch_dashboard"] == "pro"


def test_entitlements_payload_includes_purchasable_plans_only():
    u = _u("free")
    payload = entitlements_payload(u)
    # Three purchasable plans only (Free / Starter / Pro). Trial is
    # excluded (internal state, not purchasable). Business is gone.
    assert set(payload["plans"].keys()) == {"free", "starter", "pro"}
    for plan in payload["plans"].keys():
        assert "caps" in payload["plans"][plan]
        assert "features" in payload["plans"][plan]


def test_entitlements_payload_in_trial_flag():
    u = _u("free", trial_days=7)
    payload = entitlements_payload(u)
    assert payload["plan"] == "trial"
    assert payload["in_trial"] is True
    assert payload["is_paid"] is False
    assert 6 <= payload["trial_days_remaining"] <= 7


def test_entitlements_payload_paid_user():
    u = _u("pro")
    payload = entitlements_payload(u)
    assert payload["plan"] == "pro"
    assert payload["is_paid"] is True
    assert payload["in_trial"] is False
    assert payload["features"]["ai_anomaly_detection"] is True


# ─── Real-world Starter-leak regression coverage ──────────────────────


def test_starter_user_gets_starter_sale_parse_cap_not_free():
    """The bug we just fixed: _SALE_PARSE_CAP_BY_PLAN had no "starter"
    key, so Starter users got Free's cap (15) despite paying. Now must
    return Starter's value (50)."""
    u = _u("starter")
    assert get_cap(u, "sale_parse_per_day") == 50


def test_starter_user_gets_starter_kasse_cap_not_free():
    """Same regression for kasserapport extraction — Starter previously
    fell through to Free's 5/day. Now correct value (30/day)."""
    u = _u("starter")
    assert get_cap(u, "kasse_extracts_per_day") == 30


def test_starter_user_gets_starter_brief_refresh_cap_not_zero():
    """Worst of the leaks — REFRESH_CAP_BY_PLAN.get(plan, 0) returned 0
    for Starter. Now Starter gets 3/day."""
    u = _u("starter")
    assert get_cap(u, "ai_brief_refreshes_per_day") == 3
