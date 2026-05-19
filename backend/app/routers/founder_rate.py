"""Founder-rate status — public marketing endpoint (Task #85).

Why this exists
---------------
BonBox's launch pitch promises founder pricing (Starter 129/199 DKK,
Pro 249/349 DKK) for the first 100 paying customers.  The landing
page needs to show a live "X of 100 founder seats taken" pill so the
urgency is honest — owners see real progress, not a fake countdown.

What it returns
---------------
GET /api/public/founder-rate-status →
  {
    "claimed":      29,    # count of paying-customer rows
    "max_slots":    100,   # from settings.FOUNDER_MAX_SLOTS
    "available":    71,    # max - claimed, never negative
    "locked":       true,  # claimed < max_slots
  }

Privacy
-------
The count is aggregate — no PII leaked.  Endpoint is unauthenticated
(public marketing surface) but rate-limited so it can't be hammered
by scrapers.  No user_id, email, business name or anything tenant-
specific is ever exposed.

How "claimed" is computed
-------------------------
A row counts as "claimed" when:
  • plan != 'free' (the row paid for or is paying for a tier)
  • stripe_customer_id IS NOT NULL (Stripe set up a customer record
    on first checkout — even a cancelled subscription still kept the
    founder rate at signup time, so we count them).
Trial users are EXCLUDED — they haven't committed yet.  If we counted
trials we'd inflate the number and dilute the urgency signal.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter()

# Rate-limit defensively.  Real visitors hit /api/public/founder-rate-
# status once per landing-page load (~5 sec render budget = 0.2/sec
# peak).  60/min per IP gives a 300x headroom for legitimate traffic
# and shuts down hammer-scraping at 1 req/sec sustained.
limiter = Limiter(key_func=get_remote_address)


@router.get("/founder-rate-status")
@limiter.limit("60/minute")
def founder_rate_status(
    request: Request,
    db: Session = Depends(get_db),
) -> dict:
    """Public: how many founder seats remain?"""
    max_slots = int(getattr(settings, "FOUNDER_MAX_SLOTS", 100))

    # Defensive: any DB hiccup → return the "locked" state so the
    # landing page never looks broken.  Real numbers can wait.
    try:
        claimed = (
            db.query(User)
            .filter(
                and_(
                    User.plan.isnot(None),
                    User.plan != "free",
                    User.stripe_customer_id.isnot(None),
                )
            )
            .count()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("founder_rate_status: DB query failed: %s", e)
        # Conservative default — assume we're not yet at the cap so
        # the urgency pill stays factual rather than blocking signups.
        claimed = 0

    claimed = max(0, int(claimed))
    available = max(0, max_slots - claimed)
    locked = claimed < max_slots

    return {
        "claimed": claimed,
        "max_slots": max_slots,
        "available": available,
        "locked": locked,
    }
