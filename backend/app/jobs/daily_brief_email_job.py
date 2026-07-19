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

from datetime import timedelta

from sqlalchemy import and_, exists, or_
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.daily_close import DailyClose
from app.models.expense import Expense
from app.models.invoice import Invoice
from app.models.reservation import Reservation
from app.models.sale import Sale
from app.models.user import User
from app.services.daily_brief_email import send_brief_to_user
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

# How far back we look for a sign of life before we stop sending the
# automatic brief. Deliberately generous — a venue can be shut for a
# seasonal break or a long holiday and must not be cut off for it.
BRIEF_ACTIVITY_WINDOW_DAYS = 60


def _eligible_users(db: Session) -> tuple[list[User], int]:
    """Tenant-broad query. The per-user policy gates (entitlement,
    preference, idempotency) live in send_brief_to_user so the SQL
    here only filters on the most expensive-to-process predicates:
      • daily_brief_email_enabled — preference toggle
      • is_locked False — locked accounts can't log in
      • email present — no point sending to NULL email rows
      • SIGN OF LIFE — see below

    Sign of life (added 2026-07-19 after measuring production): the brief
    was going to every account that merely existed. 4,088 briefs had been
    sent since 2026-05-20, and 2,323 of them — 57% — went to 40 accounts
    that had never entered a single row of data. Those are unsolicited
    daily emails to people who never used the product: bad for sender
    reputation with Gmail, a real cost per send, and against our own
    no-spam rule. A brief for an account with no data has nothing to say
    anyway — it can only be empty.

    So the automatic brief now requires a real business event inside the
    window. The signal set is deliberately WIDE (sale, expense, daily
    close, reservation, invoice) and fails toward SENDING: a venue that
    only writes faktura, or only takes bookings, still qualifies. Only an
    account with no trace of use anywhere drops out.

    This gates the CRON only. The owner-initiated "send me my brief now"
    endpoint calls send_brief_to_user directly with force=True and is
    deliberately untouched — if someone asks for their brief, they get it.

    Returns (users, suppressed_dormant_count) so the caller can log how
    many accounts the sign-of-life gate held back.
    """
    cutoff = utc_now() - timedelta(days=BRIEF_ACTIVITY_WINDOW_DAYS)

    # EXISTS per signal — index-friendly and short-circuits per user; far
    # cheaper than building a brief (which can hit the AI pipeline) for an
    # account we're about to skip anyway.
    alive = or_(
        exists().where(and_(Sale.user_id == User.id, Sale.created_at >= cutoff)),
        exists().where(and_(Expense.user_id == User.id, Expense.created_at >= cutoff)),
        exists().where(and_(DailyClose.user_id == User.id, DailyClose.created_at >= cutoff)),
        exists().where(and_(Reservation.user_id == User.id, Reservation.created_at >= cutoff)),
        exists().where(and_(Invoice.user_id == User.id, Invoice.created_at >= cutoff)),
    )

    opted_in = db.query(User).filter(
        User.daily_brief_email_enabled.is_(True),
        User.is_locked.is_(False),
        User.email.isnot(None),
    )
    users = opted_in.filter(alive).all()
    suppressed = max(opted_in.count() - len(users), 0)
    return users, suppressed


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
        # Accounts opted in but with no sign of life in the window — held
        # back by the sign-of-life gate. Surfaced so this stays observable
        # instead of silently shrinking the batch.
        "suppressed_dormant": 0,
    }
    by_reason: Counter[str] = Counter()

    db = db_factory()
    try:
        users, suppressed = _eligible_users(db)
        summary["suppressed_dormant"] = suppressed
        if not users:
            logger.info(
                "daily_brief_email: no eligible users (suppressed_dormant=%s)",
                suppressed,
            )
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
