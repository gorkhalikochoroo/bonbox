"""The owner's ping budget for online bookings (R1, 24 Oct 2026).

Every online booking and every guest cancellation used to push the owner's
phone AND e-mail the owner, with no cap and no summary: 66 fake bookings in a
minute were 66 pushes and 66 e-mails (spam audit (h)). Booking needs no
account, so a stranger could buzz the owner's phone as often as they liked.

The budget, per venue (counted on the owner's push log, which has one row per
event whether or not a device is subscribed):
  • fewer than OWNER_BOOKING_PINGS_PER_HOUR pings in the last hour → "send":
    the push and the e-mail as before;
  • over that, once an hour → "burst": ONE summary push and ONE summary e-mail
    ("12 new online bookings in the last hour — see the rest in your book");
  • after the summary, for the rest of that hour → "suppress": nothing; a
    log row records what was held back;
  • OWNER_BOOKING_PINGS_PER_DAY pings in a rolling 24 h → "suppress".

Guest cancellations and the freed-table nudge share the same budget. The
guest's own e-mails are not affected (they have their own caps).

FAIL-OPEN: a failed count answers "send". A broken budget must never hide a
real booking from the owner — the worst case is the old behaviour.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta

from sqlalchemy import func

from app.config import settings as app_config
from app.models.staff import NotificationLog

logger = logging.getLogger(__name__)

# The owner push events that spend the budget (NotificationLog.event_type).
PING_EVENTS = ("reservation_created", "reservation_cancelled",
               "waitlist_freed_table", "owner_booking_burst")
BURST_EVENT = "owner_booking_burst"
# A held-back ping is logged with this status; the counts never read it.
SUPPRESSED = "suppressed"


def _pings_since(db, owner_id, since: datetime, events=PING_EVENTS) -> int:
    return int(
        db.query(func.count(NotificationLog.id))
        .filter(
            NotificationLog.user_id == owner_id,
            NotificationLog.staff_id.is_(None),
            NotificationLog.channel == "push",
            NotificationLog.event_type.in_(events),
            NotificationLog.status.in_(("sent", "failed")),
            NotificationLog.created_at >= since,
        )
        .scalar() or 0
    )


def decide(db, owner_id, *, now_utc: datetime) -> str:
    """"send" | "burst" | "suppress" for the next owner ping. `now_utc` is
    naive UTC (the NotificationLog clock). Never raises."""
    try:
        per_day = int(app_config.OWNER_BOOKING_PINGS_PER_DAY)
        per_hour = int(app_config.OWNER_BOOKING_PINGS_PER_HOUR)
        if per_day > 0 and _pings_since(db, owner_id, now_utc - timedelta(days=1)) >= per_day:
            return "suppress"
        if per_hour <= 0:
            return "send"
        hour_ago = now_utc - timedelta(hours=1)
        if _pings_since(db, owner_id, hour_ago) < per_hour:
            return "send"
        if _pings_since(db, owner_id, hour_ago, events=(BURST_EVENT,)) > 0:
            return "suppress"
        return "burst"
    except Exception:  # noqa: BLE001 — fail open: never hide a real booking
        logger.warning("owner ping budget check failed — sending", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return "send"


def log_suppressed(db, owner_id, event_type: str) -> None:
    """One row for a ping the budget held back (no PII). Its own savepoint, so
    a failed write never touches the caller's work."""
    try:
        with db.begin_nested():
            db.add(NotificationLog(
                id=uuid.uuid4(), user_id=owner_id, staff_id=None, channel="push",
                event_type=event_type, subject="Owner ping held back (budget)",
                body=None, status=SUPPRESSED, error_message="owner_ping_budget",
            ))
            db.flush()
        db.commit()
    except Exception:  # noqa: BLE001 — losing a log row is acceptable
        logger.warning("suppressed-ping log write failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
