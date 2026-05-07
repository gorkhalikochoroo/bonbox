"""
Trial + plan helpers — single source of truth for what tier a user is on
and how many trial days remain. Also home of PLAN_CAPS, the canonical
mapping from plan to numeric entitlements (branches, team users, modules,
daily caps) AND boolean feature flags (anomaly detection, white-label PDF,
priority support, etc.).

Source-of-truth rules:
  1. plan column trumps everything when set to "starter", "pro", or
     "business" (paid).
  2. Otherwise, if trial_ends_at is in the future → user is on "trial"
     (functionally same as Pro for entitlements, but auto-downgrades to
     Free on expiry).
  3. Otherwise → "free".

The trial NEVER auto-charges. Payment is a separate explicit user action.
This keeps us out of the "dark pattern" zone — no surprise bills.

Activated at signup: trial_ends_at = now + 14 days, plan = "free".
On day 14 the front-end nudges the user to choose Pro or stay Free.

────────────────────────────────────────────────────────────────────────
ARCHITECTURAL NOTE — multi-layer entitlements (May 2026 consolidation):
────────────────────────────────────────────────────────────────────────
Before this consolidation, four separate cap dicts lived in routers:
  • _SALE_PARSE_CAP_BY_PLAN  (ai.py)
  • _SCAN_CAP_BY_PLAN        (daily_close.py)
  • _KASSE_CAP_BY_PLAN       (kasserapport.py)
  • REFRESH_CAP_BY_PLAN      (daily_brief.py)

Each had its own subset of plans → each had its own Starter-tier leak
(Starter users falling through to Free's cap because "starter" was
missing from the dict). Consolidating into PLAN_CAPS means:
  • One place to read ALL caps from.
  • Adding a new plan adds it everywhere automatically.
  • Tests can iterate every (plan, cap_key) combo and assert no leaks.

Boolean feature flags (FEATURES) sit alongside numeric caps so the
/billing/me payload + /entitlements endpoint can answer "does this user
have access to X?" without scattering string checks across the code.
"""

from datetime import datetime, timedelta
from typing import Any

from app.models.user import User


TRIAL_DAYS = 14


# ─── PLAN_CAPS — single source of truth for tier entitlements ─────────
#
# Read by every cap-enforcement gate (branch.create, team.invite,
# modules.enable, ai.parse_sale, daily_close.scan_z, etc.) and by the
# /billing/me + /entitlements endpoints so the frontend can render
# "X/Y used" UI consistently.
#
# Trial entitlements match Pro (per the marketing claim "14 days of full
# Pro" — verified true by tests). Adding a new field here propagates to
# every gate that reads via get_cap(). Adding a new plan requires adding
# every existing key to keep the contract complete (test enforces).
#
# Tier philosophy (Manoj, May 2026):
#   Free      — meaningful taste of every AI feature. No card needed,
#               supports a single owner-operator running 1 branch.
#   Starter   — first paid tier. Owner-operator + 2 staff, monthly-close
#               accountant handoff (31-day export window).
#   Trial     — full Pro for 14 days, no card.
#   Pro       — multi-branch operator (3 sites), full year export, all
#               vertical modules, AI anomaly detection, priority support.
#   Business  — custom-quoted; effectively unlimited (999/999).
#
# Numeric caps (-1 = unlimited):
#   branches                     # active branches user can create
#   team_users                   # invited team members per account
#   modules                      # vertical add-ons (Bar Pour, Workshop…)
#   smart_imports_per_day        # AI inventory imports / 24h rolling
#   daily_close_export_days      # span of accountant PDF/CSV export
#   sale_parse_per_day           # Smart Sale (AI sale parsing) / day
#   z_report_scans_per_day       # Z-report OCR scans / day
#   kasse_extracts_per_day       # Kasserapport extraction / day
#   ai_brief_refreshes_per_day   # manual daily-brief refreshes / day
#   ai_chat_messages_per_day     # BonBox AI chat turns / day
PLAN_CAPS: dict[str, dict[str, int]] = {
    "free": {
        "branches": 1,
        "team_users": 1,
        "modules": 1,
        "smart_imports_per_day": 3,
        "daily_close_export_days": 7,
        "sale_parse_per_day": 15,
        "z_report_scans_per_day": 5,
        "kasse_extracts_per_day": 5,
        "ai_brief_refreshes_per_day": 1,
        "ai_chat_messages_per_day": 10,
    },
    "starter": {
        "branches": 1,
        "team_users": 3,
        "modules": 1,
        "smart_imports_per_day": 15,
        "daily_close_export_days": 31,
        "sale_parse_per_day": 50,
        "z_report_scans_per_day": 15,
        "kasse_extracts_per_day": 30,
        "ai_brief_refreshes_per_day": 3,
        "ai_chat_messages_per_day": 50,
    },
    "trial": {  # = full Pro for 14 days
        "branches": 3,
        "team_users": 5,
        "modules": -1,
        "smart_imports_per_day": 50,
        "daily_close_export_days": 366,
        "sale_parse_per_day": 100,
        "z_report_scans_per_day": 50,
        "kasse_extracts_per_day": 100,
        "ai_brief_refreshes_per_day": 5,
        "ai_chat_messages_per_day": 200,
    },
    "pro": {
        "branches": 3,
        "team_users": 5,
        "modules": -1,
        "smart_imports_per_day": 50,
        "daily_close_export_days": 366,
        "sale_parse_per_day": 100,
        "z_report_scans_per_day": 50,
        "kasse_extracts_per_day": 100,
        "ai_brief_refreshes_per_day": 5,
        "ai_chat_messages_per_day": 200,
    },
    "business": {
        "branches": 999,
        "team_users": 999,
        "modules": -1,
        "smart_imports_per_day": 500,
        "daily_close_export_days": 366,
        "sale_parse_per_day": 250,
        "z_report_scans_per_day": 500,
        "kasse_extracts_per_day": 500,
        "ai_brief_refreshes_per_day": 10,
        "ai_chat_messages_per_day": 1000,
    },
}


# ─── PLAN_FEATURES — boolean feature entitlements ─────────────────────
#
# Numeric caps live in PLAN_CAPS. Boolean "do you have access at all"
# entitlements live here. Both are merged into the /entitlements payload.
#
# Feature philosophy:
#   • If a feature is "use it or don't" (no degradation possible), it's
#     a boolean here.
#   • If a feature has a meaningful "limited usage" mode for free users
#     (e.g. AI chat with 10 messages/day), it's a NUMERIC cap with a
#     non-zero free value — boolean would lock free users out entirely.
#
# Free tier philosophy: every AI feature is at least *tasteable* on Free.
# We never put a feature behind a hard boolean wall on Free if Free can
# meaningfully use it at any scale — that's a quota's job.
#
# Hard-walled (boolean) features:
#   ai_anomaly_detection      — full anomaly scan with cross-day patterns
#   ai_predictive_staffing    — staffing recommendations from history
#   white_label_pdf           — remove BonBox branding from accountant PDFs
#   priority_support          — front-of-queue email/chat support
#   custom_export_templates   — user-defined CSV column maps
#   advanced_benchmarks       — peer benchmarks beyond same-vertical avg
#   multi_branch_dashboard    — cross-branch consolidated view
#   api_access                — programmatic access (future)
PLAN_FEATURES: dict[str, dict[str, bool]] = {
    "free": {
        "ai_anomaly_detection": False,
        "ai_predictive_staffing": False,
        "white_label_pdf": False,
        "priority_support": False,
        "custom_export_templates": False,
        "advanced_benchmarks": False,
        "multi_branch_dashboard": False,
        "api_access": False,
    },
    "starter": {
        "ai_anomaly_detection": True,
        "ai_predictive_staffing": False,
        "white_label_pdf": False,
        "priority_support": False,
        "custom_export_templates": True,
        "advanced_benchmarks": True,
        "multi_branch_dashboard": False,  # 1 branch only on Starter
        "api_access": False,
    },
    "trial": {  # = full Pro
        "ai_anomaly_detection": True,
        "ai_predictive_staffing": True,
        "white_label_pdf": True,
        "priority_support": True,
        "custom_export_templates": True,
        "advanced_benchmarks": True,
        "multi_branch_dashboard": True,
        "api_access": False,  # API access remains Business-only
    },
    "pro": {
        "ai_anomaly_detection": True,
        "ai_predictive_staffing": True,
        "white_label_pdf": True,
        "priority_support": True,
        "custom_export_templates": True,
        "advanced_benchmarks": True,
        "multi_branch_dashboard": True,
        "api_access": False,
    },
    "business": {
        "ai_anomaly_detection": True,
        "ai_predictive_staffing": True,
        "white_label_pdf": True,
        "priority_support": True,
        "custom_export_templates": True,
        "advanced_benchmarks": True,
        "multi_branch_dashboard": True,
        "api_access": True,  # only Business gets the API
    },
}


# ─── Plan ordering — for "minimum tier needed" calculations ───────────
#
# When a feature is locked, the upgrade prompt needs to know the LOWEST
# plan that unlocks it. min_plan_for_feature() walks this order and
# returns the first plan whose entitlements include the feature.
PLAN_ORDER: list[str] = ["free", "starter", "pro", "business"]


def effective_plan(user: User) -> str:
    """
    Returns the plan the UI should treat the user as having.
    'free' | 'trial' | 'starter' | 'pro' | 'business'
    """
    plan = (getattr(user, "plan", None) or "free").lower()
    if plan in ("starter", "pro", "business"):
        return plan
    # Plan is "free" or unset — but a live trial overrides
    if getattr(user, "trial_ends_at", None) and user.trial_ends_at > datetime.utcnow():
        return "trial"
    return "free"


def get_cap(user: User, key: str) -> int:
    """How many of `key` is this user entitled to? Returns -1 to signal
    "unlimited" (caller treats < 0 as no cap). Never raises — unknown
    plan/key falls back to free's cap.

    Multi-barrier: the gate, the schema/UI, and the test suite all call
    this same function so they can never disagree about the cap.
    """
    plan = effective_plan(user)
    plan_caps = PLAN_CAPS.get(plan) or PLAN_CAPS["free"]
    cap = plan_caps.get(key)
    if cap is None:
        # Unknown key — fail closed at free's cap, log via caller.
        cap = PLAN_CAPS["free"].get(key, 0)
    return int(cap)


def at_cap(user: User, key: str, current_count: int) -> bool:
    """True iff the user has reached or exceeded their entitlement for
    `key`. -1 cap means unlimited → never at cap. Used by gates as the
    single yes/no decision: `if at_cap(user, "branches", n): raise 403`.
    """
    cap = get_cap(user, key)
    if cap < 0:
        return False  # unlimited
    return current_count >= cap


def has_feature(user: User, feature: str) -> bool:
    """True iff the user's effective plan has the boolean feature flag
    `feature`. Unknown features fail closed (return False). This is the
    canonical gate for "is this premium feature available?" — every
    feature-flagged code path should call this rather than checking
    plan strings directly.

    Example: if not has_feature(user, "ai_anomaly_detection"):
                raise upgrade_required("ai_anomaly_detection", user)
    """
    plan = effective_plan(user)
    plan_features = PLAN_FEATURES.get(plan) or PLAN_FEATURES["free"]
    return bool(plan_features.get(feature, False))


def min_plan_for_feature(feature: str) -> str | None:
    """The lowest plan in PLAN_ORDER that grants `feature`. Used by the
    /entitlements endpoint to tell the frontend WHICH plan to upsell to
    when a feature is locked. Returns None if no plan has it (defensive —
    shouldn't happen for valid feature keys).

    Note: 'trial' is intentionally excluded from PLAN_ORDER because it's
    not a purchasable tier — users can't "upgrade to trial".
    """
    for plan in PLAN_ORDER:
        plan_features = PLAN_FEATURES.get(plan) or {}
        if plan_features.get(feature, False):
            return plan
    return None


def min_plan_for_cap(cap_key: str, needed: int) -> str | None:
    """The lowest plan whose `cap_key` entitlement is >= `needed`
    (or unlimited). Used to upsell when a user hits a numeric cap
    ("you need at least Starter for monthly export"). Returns None
    if no plan satisfies the request — caller can fall back to
    Business.
    """
    for plan in PLAN_ORDER:
        plan_caps = PLAN_CAPS.get(plan) or {}
        cap = plan_caps.get(cap_key)
        if cap is None:
            continue
        if cap < 0 or cap >= needed:
            return plan
    return None


def trial_days_remaining(user: User) -> int | None:
    """Whole days left in the trial, or None if no active trial."""
    end = getattr(user, "trial_ends_at", None)
    if not end:
        return None
    delta = end - datetime.utcnow()
    if delta.total_seconds() <= 0:
        return 0
    return int(delta.total_seconds() // 86400) + (
        1 if delta.total_seconds() % 86400 else 0
    )


def start_trial(user: User) -> None:
    """Set trial_ends_at to TRIAL_DAYS from now. Idempotent — won't re-start."""
    if getattr(user, "trial_ends_at", None):
        return  # Already had a trial; don't reset
    user.trial_ends_at = datetime.utcnow() + timedelta(days=TRIAL_DAYS)


def billing_summary(user: User) -> dict:
    """Compact dict for the /billing/me endpoint. Includes per-key caps
    AND boolean feature flags so frontend can render
    "1/1 used — Upgrade for 3" + lock icons without a second round-trip.
    """
    plan = effective_plan(user)
    days_left = trial_days_remaining(user)
    plan_caps = PLAN_CAPS.get(plan) or PLAN_CAPS["free"]
    plan_features = PLAN_FEATURES.get(plan) or PLAN_FEATURES["free"]
    return {
        "plan": plan,
        "trial_ends_at": user.trial_ends_at.isoformat() if getattr(user, "trial_ends_at", None) else None,
        "trial_days_remaining": days_left,
        "trial_active": plan == "trial",
        "is_paid": plan in ("starter", "pro", "business"),
        "raw_plan": (getattr(user, "plan", None) or "free").lower(),
        "caps": dict(plan_caps),  # copy so caller can't mutate the source-of-truth
        "features": dict(plan_features),
    }


def entitlements_payload(user: User) -> dict[str, Any]:
    """The full /api/entitlements response. Same data as billing_summary
    plus precomputed upsell hints so the frontend can render upgrade
    prompts without knowing the cap structure.

    Shape:
      {
        "plan": "free",
        "is_paid": false,
        "in_trial": false,
        "trial_ends_at": null,
        "trial_days_remaining": null,
        "caps": {...numeric...},
        "features": {...boolean...},
        # Precomputed upsell hints — frontend just renders these.
        "min_plan_by_feature": {"ai_anomaly_detection": "starter", ...},
        # All available plans + their summarised entitlements, so the
        # upgrade modal can show "Starter unlocks X, Pro unlocks Y".
        "plans": {
          "free":     {"caps": {...}, "features": {...}},
          "starter":  {...},
          "pro":      {...},
          "business": {...},
        },
      }
    """
    summary = billing_summary(user)
    # Precompute "what plan unlocks each feature" so the frontend doesn't
    # have to know the PLAN_ORDER or do its own walk.
    min_plan_by_feature = {
        feature: min_plan_for_feature(feature)
        for plan_features in PLAN_FEATURES.values()
        for feature in plan_features.keys()
    }
    plans_summary = {
        plan: {
            "caps": dict(PLAN_CAPS.get(plan, {})),
            "features": dict(PLAN_FEATURES.get(plan, {})),
        }
        for plan in PLAN_ORDER  # excludes trial since it's not purchasable
    }
    return {
        "plan": summary["plan"],
        "raw_plan": summary["raw_plan"],
        "is_paid": summary["is_paid"],
        "in_trial": summary["trial_active"],
        "trial_ends_at": summary["trial_ends_at"],
        "trial_days_remaining": summary["trial_days_remaining"],
        "caps": summary["caps"],
        "features": summary["features"],
        "min_plan_by_feature": min_plan_by_feature,
        "plans": plans_summary,
    }


# ─── Structured 402 helper for routers ────────────────────────────────
#
# When a router gates on a cap or feature, raising a plain HTTPException
# with a string message means the frontend has to parse the string to
# render an upgrade prompt. Instead, raise FROM these helpers so the
# detail is a structured dict the frontend can read directly.

def cap_exceeded_detail(user: User, cap_key: str, current: int) -> dict[str, Any]:
    """Build the JSON payload for a 402-style "cap reached" error.
    Returns a dict suitable for HTTPException(detail=...). Frontend
    sees: { "error": "cap_exceeded", "cap": "...", "current": N,
    "limit": M, "plan": "...", "upgrade_to": "starter" }."""
    cap = get_cap(user, cap_key)
    needed = current + 1 if cap >= 0 else 1
    return {
        "error": "cap_exceeded",
        "cap": cap_key,
        "current": int(current),
        "limit": int(cap),
        "plan": effective_plan(user),
        "upgrade_to": min_plan_for_cap(cap_key, needed),
    }


def feature_locked_detail(user: User, feature: str) -> dict[str, Any]:
    """Build the JSON payload for a 402-style "feature locked" error."""
    return {
        "error": "feature_locked",
        "feature": feature,
        "plan": effective_plan(user),
        "upgrade_to": min_plan_for_feature(feature),
    }


# ─── enforce_* — drop-in router helpers ────────────────────────────────
#
# Routers should call enforce_cap()/enforce_feature() instead of building
# their own HTTPException — keeps the upgrade-prompt payload uniform
# across every gate so the frontend can render upgrade prompts from a
# single error shape. These import HTTPException locally so this module
# stays usable from non-FastAPI contexts (e.g. CLI scripts) without
# pulling FastAPI in transitively at import time.

def enforce_cap(user: User, cap_key: str, current: int) -> None:
    """Raise HTTPException(402, structured detail) iff the user has
    reached or exceeded their cap for `cap_key`. Otherwise no-op.

    Returns 402 (Payment Required) rather than 403 because the cap is
    a billing limit, not an access-control denial — the user has
    permission, they just need to upgrade. Frontend reads
    detail.upgrade_to to render the "Upgrade to Starter" CTA.
    """
    if at_cap(user, cap_key, current):
        from fastapi import HTTPException
        raise HTTPException(
            status_code=402,
            detail=cap_exceeded_detail(user, cap_key, current),
        )


def enforce_feature(user: User, feature: str) -> None:
    """Raise HTTPException(402, structured detail) iff the user's plan
    doesn't have the boolean feature flag `feature`. Otherwise no-op.
    """
    if not has_feature(user, feature):
        from fastapi import HTTPException
        raise HTTPException(
            status_code=402,
            detail=feature_locked_detail(user, feature),
        )
