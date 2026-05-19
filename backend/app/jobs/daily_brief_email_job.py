"""Daily Brief email — morning cron (Task #54).

Fires at 06:30 UTC daily (≈ 07:30 Copenhagen winter / 08:30 summer).
Iterates every user with daily_brief_email_enabled=True who hasn't
already been sent today, generates the SAME brief that's on /dashboard,
and ships it as an inline-styled HTML email.

Multi-tenant safety:
  • Per-user try/except so a single bad row never poisons the batch.
  • Per-user commit so partial progress persists even if the process
    is killed mid-job (e.g. ops restart at 06:31).
  • Idempotency lives inside send_brief_to_user (last_brief_emailed_at
    stamp). The cron only does the iteration + metric aggregation.
  • is_locked users are skipped — they can't log in anyway, no point
    burning Resend quota or emailing a frozen account.

Returns a summary dict {attempted, sent, skipped, errors, by_reason}
suitable for a future health endpoint.
"""
from __future__ import annotations

import logging
from collections import Counter
from typing import Callable

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.user import User
from app.services.daily_brief_email import send_brief_to_user

logger = logging.getLogger(__name__)


def _eligible_users(db: Session) -> list[User]:
    """Tenant-broad query. The per-user policy gates (entitlement,
    preference, idempotency) live in send_brief_to_user so the SQL
    here only filters on the most expensive-to-process predicates:
      • daily_brief_email_enabled — preference toggle
      • is_locked False — locked accounts can't log in
      • email present — no point sending to NULL email rows
    """
    return (
        db.query(User)
        .filter(
            User.daily_brief_email_enabled.is_(True),
            User.is_locked.is_(False),
            User.email.isnot(None),
        )
        .all()
    )


def send_daily_brief_emails(
    db_factory: Callable[[], Session] = SessionLocal,
) -> dict[str, int]:
    """Send today's brief to every eligible user.

    Tenant safety: one db session, per-user commit inside
    send_brief_to_user so partial progress persists. Per-user errors
    isolated — one bad row can't take down the rest.

    Returns aggregate metrics suitable for log inspection + a future
    /admin/health/daily-brief endpoint.
    """
    summary = {
        "attempted": 0,
        "sent": 0,
        "skipped": 0,
        "errors": 0,
    }
    by_reason: Counter[str] = Counter()

    db = db_factory()
    try:
        users = _eligible_users(db)
        if not users:
            logger.info("daily_brief_email: no eligible users")
            return summary

        for user in users:
            summary["attempted"] += 1
            try:
                result = send_brief_to_user(db, user, force=False)
                if result.get("ok"):
                    summary["sent"] += 1
                elif result.get("error"):
                    summary["errors"] += 1
                    by_reason[result.get("error", "unknown")[:40]] += 1
                else:
                    summary["skipped"] += 1
                    by_reason[result.get("reason") or "unknown_skip"] += 1
            except Exception as e:  # noqa: BLE001
                # Defensive — send_brief_to_user already wraps in
                # try/except, but a bug in audit_service or db could
                # still escape. Catch here too.
                logger.exception(
                    "daily_brief_email: user=%s unhandled error: %s", user.id, e,
                )
                summary["errors"] += 1
                by_reason["unhandled"] += 1
                try:
                    db.rollback()
                except Exception:  # noqa: BLE001
                    pass

        logger.info(
            "daily_brief_email summary: %s reasons=%s",
            summary, dict(by_reason),
        )
        return summary
    finally:
        db.close()


if __name__ == "__main__":
    # Allow `python -m app.jobs.daily_brief_email_job` for manual debug.
    logging.basicConfig(level=logging.INFO)
    out = send_daily_brief_emails()
    print(out)
