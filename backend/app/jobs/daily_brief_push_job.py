"""Daily Brief push — morning cron (Task #72).

Fires at 06:00 UTC daily — slightly before the email cron at 06:30
UTC because native push delivery is fan-out across many devices and
can take 15-30 seconds when there's a backlog at the push provider.
By the time the email lands, the push is already showing on the lock
screen. Both surfaces converge on the SAME brief (Layer 2 in
daily_brief.py — both surfaces call get_or_create_brief, which
caches per-day, so the second caller hits the cache).

Multi-tenant safety:
  • Per-user try/except so a single bad row never poisons the batch.
  • Per-user commit so partial progress persists even if the process
    is killed mid-job (ops restart, OOM, etc.).
  • is_locked users are skipped — they can't log in anyway, no point
    waking them with a push to an account they can't open.

Privacy posture (NON-NEGOTIABLE — GDPR):
  • The aggregate log line records counts only — never endpoints.
  • The per-user audit row records counts only — never endpoints.
  • The push payload itself is a one-line summary, no amounts, no
    customer names (enforced by push_sender._compose_brief_payload).

Returns a summary dict {users_total, attempted, sent, removed, errors}
suitable for a future /admin/health/push endpoint and unit assertions.
"""
from __future__ import annotations

import logging
from typing import Callable

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.push_subscription import PushSubscription
from app.models.user import User
from app.services import audit_service
from app.services.push_sender import send_brief_push

logger = logging.getLogger(__name__)


def _eligible_users(db: Session) -> list[User]:
    """Users with at least one push subscription, not locked, and with
    an email column populated (defense — the brief generator needs a
    valid user row). The tier check happens INSIDE send_brief_push via
    get_or_create_brief — Free tier is included intentionally; this is
    a retention lever not an upsell.
    """
    # Distinct users that own at least one PushSubscription row. We do
    # the join + distinct here so we don't burn a row-per-subscription
    # iteration when a user has 3 devices.
    return (
        db.query(User)
        .join(PushSubscription, PushSubscription.user_id == User.id)
        .filter(
            User.is_locked.is_(False),
            User.email.isnot(None),
        )
        .distinct()
        .all()
    )


def send_daily_brief_pushes(
    db_factory: Callable[[], Session] = SessionLocal,
) -> dict[str, int]:
    """Fan the morning brief push out to every eligible user.

    Tenant safety: one db session, per-user commit inside
    send_brief_push so partial progress persists. Per-user errors
    isolated — one bad row can't take down the rest of the batch.

    Returns aggregate metrics suitable for log inspection.
    """
    summary = {
        "users_total": 0,
        "attempted": 0,
        "sent": 0,
        "removed": 0,
        "errors": 0,
        "skipped_users": 0,
    }

    db = db_factory()
    try:
        users = _eligible_users(db)
        if not users:
            logger.info("daily_brief_push: no eligible users")
            return summary

        summary["users_total"] = len(users)

        for user in users:
            try:
                result = send_brief_push(db, user)
                summary["attempted"] += int(result.get("attempted") or 0)
                summary["sent"] += int(result.get("sent") or 0)
                summary["removed"] += int(result.get("removed") or 0)
                if result.get("skipped"):
                    summary["skipped_users"] += 1

                # Per-user audit row — count only, never endpoints. This
                # is the GDPR-safe footprint: the owner can later prove
                # that we attempted to deliver a brief on a given day
                # without us exposing which devices we hit.
                try:
                    audit_service.record(
                        db, user, "push.brief.sent", "push_subscription",
                        after={
                            "attempted": int(result.get("attempted") or 0),
                            "sent": int(result.get("sent") or 0),
                            "removed": int(result.get("removed") or 0),
                        },
                        actor_type="system.daily_brief_push",
                    )
                except Exception:  # noqa: BLE001
                    # Audit failure must NEVER block the cron.
                    pass

                try:
                    db.commit()
                except Exception as e:  # noqa: BLE001
                    db.rollback()
                    summary["errors"] += 1
                    logger.warning(
                        "daily_brief_push: user=%s commit failed: %s",
                        user.id, e,
                    )
            except Exception as e:  # noqa: BLE001
                summary["errors"] += 1
                logger.exception(
                    "daily_brief_push: user=%s unhandled error: %s", user.id, e,
                )
                try:
                    db.rollback()
                except Exception:  # noqa: BLE001
                    pass

        # Aggregate log — count only, no endpoints, no user emails.
        logger.info(
            "daily_brief_push summary: users=%d attempted=%d sent=%d "
            "removed=%d errors=%d skipped_users=%d",
            summary["users_total"],
            summary["attempted"],
            summary["sent"],
            summary["removed"],
            summary["errors"],
            summary["skipped_users"],
        )
        return summary
    finally:
        db.close()


if __name__ == "__main__":
    # Allow `python -m app.jobs.daily_brief_push_job` for manual debug.
    logging.basicConfig(level=logging.INFO)
    out = send_daily_brief_pushes()
    print(out)
