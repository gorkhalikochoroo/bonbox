"""Stripe subscription reconciliation sweep — the downgrade backstop.

Runs every 6 hours. Until now the entire paid→free downgrade lifecycle was
100% webhook-driven, and in prod the Stripe webhook has NEVER fired — leaving
two accounts stuck at plan='pro' two months past their paid-through date.

The read-time entitlement guard (billing.subscription_entitles) already makes
ENTITLEMENT correct regardless of this job — a lapsed sub loses paid features
instantly at read time. This sweep is the third, column-hygiene layer: it keeps
the raw `plan` column honest (so /billing/me, the founding-seat counter, and any
code that reads user.plan directly can't see a lapsed account as 'pro') and
writes the audit trail. Defense-in-depth:

  1. webhook fast-path       — keeps columns fresh in real time (once live)
  2. read-time guard         — denies entitlement instantly on lapse
  3. THIS reconcile sweep    — reconciles the column + audits, so nothing rots

Safety invariants (a wrongful downgrade of a genuinely-paying customer is the
one thing this job must never do):
  • Never touches a subscription the read-time guard considers alive.
  • Never touches super_admins — their Pro is an entitlement override, not a
    paid plan; rewriting their column would be wrong and pointless.
  • When Stripe is the authority (configured + customer linked), it force-syncs
    and trusts Stripe: alive → keep; definitively not-live → downgrade; and if
    Stripe is unreachable this run (hard error) it does NOTHING and defers to
    the next run — a transient Stripe outage can never cause a column downgrade.
  • Only when Stripe is not configured / not linked does it downgrade on our own
    recorded paid-through date, which subscription_entitles already judged
    lapsed (past the date + the dunning grace).
  • Per-user try/except + per-user commit: one bad row can't poison the batch.
"""
from __future__ import annotations

import logging
from typing import Callable

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.user import User

logger = logging.getLogger(__name__)


def _paid_candidates(db: Session) -> list[User]:
    """Owner accounts whose stored plan is a paid tier. Cheap query — the
    per-user liveness/entitlement decision happens in the loop. Free/trial
    users are never candidates (nothing to downgrade)."""
    return (
        db.query(User)
        .filter(
            User.owner_id.is_(None),
            User.plan.in_(("starter", "pro", "business")),
        )
        .all()
    )


def _downgrade_to_free(db: Session, user: User, *, reason: str) -> None:
    """Genuine downgrade of the plan COLUMN (entitlement is already gone via
    the read-time guard). Sets plan='free' and clears the subscription state,
    keeping stripe_customer_id / stripe_subscription_id for audit + a future
    re-subscribe or sync. Writes a SecurityEvent capturing the before-state so
    the 'why' is never lost. Idempotent: no-ops if already free."""
    old_plan = (user.plan or "free")
    if old_plan == "free":
        return
    old_status = user.subscription_status
    old_period_end = user.subscription_period_end

    user.plan = "free"
    # Clear the entitlement-bearing subscription fields; keep the Stripe id
    # linkage (customer/subscription) so history + future reconciliation work.
    user.subscription_status = None
    user.subscription_period_end = None

    try:
        from app.models.security_event import SecurityEvent

        detail = (
            f"reconcile downgrade: plan {old_plan!r}->'free' "
            f"status={old_status!r} "
            f"period_end={old_period_end.isoformat() if old_period_end else '-'} "
            f"reason={reason}"
        )
        db.add(
            SecurityEvent(
                user_id=getattr(user, "id", None),
                event_type="billing.reconcile_downgrade",
                ip_address=None,
                user_agent=None,
                detail=detail[:1900],
            )
        )
        db.commit()
        logger.info(
            "reconcile: downgraded user=%s plan=%s->free reason=%s",
            user.id, old_plan, reason,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("reconcile: downgrade commit failed user=%s: %s", user.id, e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def run_subscription_reconcile(
    db_factory: Callable[[], Session] = SessionLocal,
) -> dict[str, int]:
    """Reconcile every paid-plan owner whose subscription is no longer alive.

    Returns aggregate metrics for /admin health surfaces:
      attempted, still_live, resynced_live, downgraded, skipped_admin,
      stripe_unreachable, errors.
    """
    summary = {
        "attempted": 0,
        "still_live": 0,
        "resynced_live": 0,
        "downgraded": 0,
        "skipped_admin": 0,
        "stripe_unreachable": 0,
        "errors": 0,
    }

    db = db_factory()
    try:
        # Imported here (not at module load) to keep this job import-light and
        # avoid any import-order surprises during app startup.
        from app.services import stripe_billing
        from app.services.billing import subscription_entitles

        users = _paid_candidates(db)
        if not users:
            logger.info("subscription_reconcile: no paid-plan users")
            return summary

        for user in users:
            summary["attempted"] += 1
            try:
                # super_admins hold Pro via an entitlement override, not a paid
                # plan — never rewrite their column.
                if getattr(user, "role", None) == "super_admin":
                    summary["skipped_admin"] += 1
                    continue

                # Alive by our own records → nothing to do.
                if subscription_entitles(user):
                    summary["still_live"] += 1
                    continue

                if stripe_billing.is_configured() and user.stripe_customer_id:
                    # Stripe is the authority. Force-sync (bypasses the 30s
                    # cooldown) and trust the result.
                    try:
                        result = stripe_billing.sync_user_subscription_from_stripe(
                            user, db, force=True
                        )
                        db.refresh(user)
                    except Exception as e:  # noqa: BLE001
                        logger.warning("reconcile: force-sync raised user=%s: %s", user.id, e)
                        result = None

                    if subscription_entitles(user):
                        # Stripe corrected our stale data — the sub IS live
                        # (e.g. period_end was behind a renewal). Keep it.
                        summary["resynced_live"] += 1
                        continue

                    if result is None:
                        # Couldn't get a definitive answer from Stripe this run.
                        # Do NOT downgrade the column on a transient outage —
                        # entitlement is already denied by the read-time guard;
                        # try again next run.
                        summary["stripe_unreachable"] += 1
                        continue

                    # Stripe reached and still not live → confirmed dead.
                    _downgrade_to_free(db, user, reason="stripe_confirmed_not_live")
                    summary["downgraded"] += 1
                    continue

                # Stripe not configured / no customer link → honor our recorded
                # paid-through date, which subscription_entitles judged lapsed.
                _downgrade_to_free(db, user, reason="recorded_period_end_lapsed")
                summary["downgraded"] += 1
            except Exception as e:  # noqa: BLE001
                logger.exception("subscription_reconcile: user=%s error: %s", user.id, e)
                summary["errors"] += 1
                try:
                    db.rollback()
                except Exception:  # noqa: BLE001
                    pass
    finally:
        try:
            db.close()
        except Exception:  # noqa: BLE001
            pass

    logger.info("subscription_reconcile summary: %s", summary)
    return summary
