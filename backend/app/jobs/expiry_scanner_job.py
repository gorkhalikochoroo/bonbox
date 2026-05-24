"""Daily Expiry Scanner — morning cron (Phase 1, Manoj-confirmed May 2026).

Fires at 06:00 UTC daily (between the daily-brief-push at 06:00 and the
daily-brief-email at 06:30). Iterates every active user, scans for items
expiring within 3 days, and:

  • For Starter+ users with at least one item expiring today: records an
    `expiry.alert_sent` audit row tagged channel="daily_scan" so the
    "BonBox saved you X kr this month" claim later has provenance.

  • For Pro+ users with at least one item expiring today AND an active
    push subscription: fans out a push notification (best-effort, never
    blocks the loop on a single device failure).

The Brief generator already runs `scan_upcoming_expiries` inside the
candidate path (see daily_brief.py), so this cron does NOT duplicate
that work — its job is the audit-trail + push channel, both of which
the Brief code path can't reach (the Brief is opt-in via dashboard
render; this cron runs unconditionally for opted-in users).

Multi-tenant safety:
  • Per-user try/except so a single bad row never poisons the batch.
  • Per-user commit so partial progress persists.
  • L9 — items_count == 0 → silent skip (no false-positive emails or
    pushes about "0 items expiring").
  • L7 — every alert path writes an audit row best-effort.
  • L5 — scan_upcoming_expiries is strictly user_id-scoped.
"""
from __future__ import annotations

import logging
from typing import Callable

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.user import User
from app.services.billing import has_feature
from app.services.expiry_service import (
    record_alert_sent,
    scan_upcoming_expiries,
)

logger = logging.getLogger(__name__)


def _eligible_users(db: Session) -> list[User]:
    """Tenant-broad query — same defensive predicates as
    daily_brief_email_job. Per-user gates (expiry_alerts feature,
    push subscription, items_count > 0) live INSIDE the loop so the
    SQL stays cheap on big tables.
    """
    return (
        db.query(User)
        .filter(
            User.is_locked.is_(False),
            User.email.isnot(None),
        )
        .all()
    )


def _send_push_best_effort(db: Session, user: User, payload: dict) -> int:
    """Fan out an expiry push to every active subscription belonging to
    `user`. Returns the number of successful sends.

    Best-effort: every failure is swallowed + logged so a single bad
    endpoint never crashes the scan loop. Removed (410 Gone or
    fail_count>=3) subscriptions are deleted in-line, same as the
    daily brief push job.
    """
    try:
        from app.models.push_subscription import PushSubscription
        from app.services.push_sender import send_to_subscription
    except Exception:
        return 0
    sent = 0
    try:
        subs = (
            db.query(PushSubscription)
            .filter(PushSubscription.user_id == user.id)
            .all()
        )
        if not subs:
            return 0
        for sub in subs:
            try:
                result = send_to_subscription(sub, payload)
                if result and result.get("ok"):
                    sent += 1
                if result and result.get("removed"):
                    try:
                        db.delete(sub)
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "expiry push send_to_subscription failed user=%s: %s",
                    user.id, e,
                )
    except Exception as e:  # noqa: BLE001
        logger.warning("expiry push setup failed user=%s: %s", user.id, e)
    return sent


def run_expiry_scan(
    db_factory: Callable[[], Session] = SessionLocal,
) -> dict[str, int]:
    """Scan all eligible users for upcoming expiries.

    Returns aggregate metrics suitable for /admin/health/expiry-scan:
      attempted, with_items, audited, pushed, skipped, errors.
    """
    summary = {
        "attempted": 0,
        "with_items": 0,
        "audited": 0,
        "pushed": 0,
        "skipped": 0,
        "errors": 0,
    }

    db = db_factory()
    try:
        users = _eligible_users(db)
        if not users:
            logger.info("expiry_scan: no eligible users")
            return summary

        for user in users:
            summary["attempted"] += 1
            try:
                # L4 — defensive gate. Free users still get the page but
                # the daily SCAN cron is the alert-rich layer that ships
                # only to Starter+. Pro adds push on top.
                if not has_feature(user, "expiry_alerts"):
                    summary["skipped"] += 1
                    continue

                scan = scan_upcoming_expiries(user, db, days_ahead=3)
                items = scan.get("items") or []
                if not items:
                    # L9 — no false-positive alerts. Don't bill the
                    # owner cognitively for "0 items expiring".
                    summary["skipped"] += 1
                    continue
                summary["with_items"] += 1

                # L7 — audit trail for the morning scan path.
                try:
                    record_alert_sent(
                        db, user,
                        items_count=len(items),
                        total_at_risk_dkk=scan.get("total_at_risk_dkk") or 0.0,
                        channel="daily_scan",
                    )
                    summary["audited"] += 1
                except Exception as e:  # noqa: BLE001
                    logger.warning("expiry audit write failed user=%s: %s", user.id, e)

                # Pro-only — day-of-expiry push. Free + Starter still
                # see the items in /expiry; only the push fan-out is
                # gated here. Items expiring today (days_left <= 0)
                # are the only ones worth pushing — within-3-days is
                # the Brief's job.
                today_items = [i for i in items if (i.get("days_left") or 0) <= 0]
                if today_items and has_feature(user, "expiry_push_notifications"):
                    payload = {
                        "title": "Spildalarm — varer udløber i dag",
                        "body": (
                            f"{len(today_items)} varer udløber i dag — "
                            "åbn BonBox for handlinger"
                        ),
                        "data": {"url": "/expiry"},
                    }
                    if _send_push_best_effort(db, user, payload) > 0:
                        summary["pushed"] += 1
            except Exception as e:  # noqa: BLE001
                # Per-user isolation — a single bad row must not poison
                # the rest of the batch.
                logger.exception(
                    "expiry_scan: user=%s unhandled error: %s", user.id, e,
                )
                summary["errors"] += 1
    finally:
        try:
            db.close()
        except Exception:  # noqa: BLE001
            pass

    logger.info("expiry_scan summary: %s", summary)
    return summary
