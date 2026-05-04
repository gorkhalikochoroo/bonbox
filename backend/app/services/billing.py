"""
Trial + plan helpers — single source of truth for what tier a user is on
and how many trial days remain.

Source-of-truth rules:
  1. plan column trumps everything when set to "pro" or "business" (paid).
  2. Otherwise, if trial_ends_at is in the future → user is on "trial"
     (functionally same as Pro, but auto-downgrades to Free on expiry).
  3. Otherwise → "free".

The trial NEVER auto-charges. Payment is a separate explicit user action.
This keeps us out of the "dark pattern" zone — no surprise bills.

Activated at signup: trial_ends_at = now + 14 days, plan = "free".
On day 14 the front-end nudges the user to choose Pro or stay Free.
"""

from datetime import datetime, timedelta

from app.models.user import User


TRIAL_DAYS = 14


def effective_plan(user: User) -> str:
    """
    Returns the plan the UI should treat the user as having.
    'free' | 'trial' | 'pro' | 'business'
    """
    plan = (getattr(user, "plan", None) or "free").lower()
    if plan in ("pro", "business"):
        return plan
    # Plan is "free" or unset — but a live trial overrides
    if getattr(user, "trial_ends_at", None) and user.trial_ends_at > datetime.utcnow():
        return "trial"
    return "free"


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
    """Compact dict for the /billing/me endpoint."""
    plan = effective_plan(user)
    days_left = trial_days_remaining(user)
    return {
        "plan": plan,
        "trial_ends_at": user.trial_ends_at.isoformat() if getattr(user, "trial_ends_at", None) else None,
        "trial_days_remaining": days_left,
        "trial_active": plan == "trial",
        "is_paid": plan in ("pro", "business"),
        "raw_plan": (getattr(user, "plan", None) or "free").lower(),
    }
