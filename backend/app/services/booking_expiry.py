"""Pending-booking expiry sweep.

Per `docs/event-booking-product-spec.md` §5.3. A booking left in
`pending` past its `expires_at` is swept back to `expired` by this
service, releasing the capacity for the next visitor.

Why a cron not a deferred task:
  • In-process schedulers (apscheduler, etc.) lose pending work on
    process restart — fine for analytics but terrible for capacity
    management. A cron tick (`POST /api/internal/booking-expiry-tick`
    every minute from a platform scheduler) is durable + observable.
  • The endpoint guards itself with X-Cron-Secret so anyone hitting
    it without the header gets 401.

Idempotency:
  • Re-running the sweep is a no-op — only `pending` + past-expiry
    rows are affected, and the transition stamps them `expired` so
    a second pass finds nothing new.

Safety bounds:
  • Sweep is bounded at 500 rows per tick (defends against runaway
    DB churn if a misconfigured event creates a flood of pending
    bookings). When more remain, the next minute's tick catches them.
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.booking import Booking
from app.models.ticket import Ticket
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


_MAX_PER_TICK = 500


def sweep_expired_pending(db: Session, *, limit: int = _MAX_PER_TICK) -> dict[str, Any]:
    """Mark `pending` bookings past expires_at as `expired`.

    Also voids any tickets that were pre-allocated against those
    bookings (defense — pre-allocated tickets MUST NOT remain
    scannable past the expiry transition).

    Caller (the /api/internal/booking-expiry-tick route handler) is
    responsible for db.commit(). Returns a small dict with counts the
    handler echoes for observability.
    """
    now = utc_now()
    # Hard cap on limit — even if the caller passes 100,000 we never
    # touch more than 500 in one tick (protects the DB).
    limit = max(1, min(int(limit or _MAX_PER_TICK), _MAX_PER_TICK))

    candidates = (
        db.query(Booking)
        .filter(Booking.status == "pending")
        .filter(Booking.expires_at.isnot(None))
        .filter(Booking.expires_at <= now)
        .order_by(Booking.expires_at.asc())
        .limit(limit)
        .all()
    )

    if not candidates:
        return {"expired": 0, "voided_tickets": 0, "checked_at": now.isoformat()}

    expired_count = 0
    voided_ticket_count = 0
    for booking in candidates:
        booking.status = "expired"
        booking.updated_at = now
        expired_count += 1
        # Void any pre-issued tickets so a leaked QR can't be scanned
        # after the booking lapsed. We mark is_void rather than
        # delete — the audit trail stays whole.
        try:
            tix = (
                db.query(Ticket)
                .filter(Ticket.booking_id == booking.id)
                .filter(Ticket.is_void.is_(False))
                .all()
            )
            for t in tix:
                t.is_void = True
                voided_ticket_count += 1
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "booking_expiry: failed to void tickets for booking=%s: %s",
                booking.id, exc,
            )

    logger.info(
        "booking_expiry.sweep_expired_pending: expired=%d voided_tickets=%d",
        expired_count, voided_ticket_count,
    )
    return {
        "expired": expired_count,
        "voided_tickets": voided_ticket_count,
        "checked_at": now.isoformat(),
    }
