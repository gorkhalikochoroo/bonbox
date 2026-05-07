"""
Trial + plan helpers — single source of truth for what tier a user is on
and how many trial days remain. Also home of PLAN_CAPS, the canonical
mapping from plan to numeric entitlements (branches, team users, modules).

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
"""

from datetime import datetime, timedelta

from app.models.user import User


TRIAL_DAYS = 14


# ─── PLAN_CAPS — single source of truth for tier entitlements ─────────
#
# Read by every cap-enforcement gate (branch.create, team.invite,
# modules.enable, etc.) and by the /billing/me response so frontend can
# show "X/Y used" UI consistently.
#
# Trial entitlements match Pro (per the marketing claim "14 days of full
# Pro" — verified true earlier). Adding a new field here propagates to
# every gate that reads via get_cap().
#
# Numbers match the SubscriptionPage TIERS array in the frontend:
#   Free:    1 branch, 1 user, 1 vertical module
#   Starter: 1 branch, 3 users, 1 vertical module
#   Pro:     3 branches, 5 users, all vertical modules (-1 = unlimited)
#   Business: custom-quoted, effectively unlimited
PLAN_CAPS: dict[str, dict[str, int]] = {
    # smart_imports_per_day caps the number of smart-inventory imports
    # (text/CSV/Excel/image upload → AI categorization → save) per
    # 24h rolling window. Image extractions cost the most so the cap
    # mostly protects our Anthropic spend; text/CSV/Excel could be
    # higher but we keep ONE number per tier for simplicity.
    #
    # Tier philosophy (Manoj, May 2026):
    #   Free 3       — meaningful taste of the AI feature.
    #   Starter 15   — symmetric with Z-report scan cap (15/15) —
    #                  easy to remember, supports a small kitchen
    #                  doing a daily fish/produce drop + 14 oddball
    #                  items per day.
    #   Pro 50       — covers multi-terminal venues + heavy stocktake
    #                  weeks (Mirabelle-scale).
    #
    # daily_close_export_days caps the SPAN of the Daily Close range
    # PDF/CSV export — the accountant handoff feature. Free gets a
    # weekly review window; Starter handles month-end; Pro+ get the
    # full year for compliance archives. The hard ceiling on the
    # service itself is 366d (router _MAX_RANGE_DAYS), so this gate
    # only constrains free + starter tiers — pro+ inherit the full
    # ceiling. Send-to-accountant inherits naturally (it generates
    # the same PDF, so caps follow).
    "free":     {"branches": 1, "team_users": 1, "modules": 1,  "smart_imports_per_day": 3,   "daily_close_export_days": 7},
    "trial":    {"branches": 3, "team_users": 5, "modules": -1, "smart_imports_per_day": 50,  "daily_close_export_days": 366},  # = full Pro
    "starter":  {"branches": 1, "team_users": 3, "modules": 1,  "smart_imports_per_day": 15,  "daily_close_export_days": 31},
    "pro":      {"branches": 3, "team_users": 5, "modules": -1, "smart_imports_per_day": 50,  "daily_close_export_days": 366},
    "business": {"branches": 999, "team_users": 999, "modules": -1, "smart_imports_per_day": 500, "daily_close_export_days": 366},
}


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
    """How many of `key` (branches | team_users | modules) is this user
    entitled to? Returns -1 to signal "unlimited" (caller treats < 0 as
    no cap). Never raises — unknown plan/key falls back to free's cap.

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
    so frontend can render "1/1 used — Upgrade for 3" without a second
    round-trip."""
    plan = effective_plan(user)
    days_left = trial_days_remaining(user)
    plan_caps = PLAN_CAPS.get(plan) or PLAN_CAPS["free"]
    return {
        "plan": plan,
        "trial_ends_at": user.trial_ends_at.isoformat() if getattr(user, "trial_ends_at", None) else None,
        "trial_days_remaining": days_left,
        "trial_active": plan == "trial",
        "is_paid": plan in ("starter", "pro", "business"),
        "raw_plan": (getattr(user, "plan", None) or "free").lower(),
        "caps": dict(plan_caps),  # copy so caller can't mutate the source-of-truth
    }
