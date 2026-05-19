"""
Smart Pricing Intelligence endpoints — neighborhood market comparison.

Two endpoints:
  • GET /api/smart-pricing/item?name=cappuccino  → one-item comparison
  • GET /api/smart-pricing/all                   → all priced items in batch

Both are auth-gated, audited via SecurityEvent (inside the service), and
cache-controlled to `private, max-age=300` so neither a proxy CDN nor a
shared browser cache can leak one tenant's response to another.

Even though `smart_pricing` is enabled on EVERY tier (Free + Starter +
Pro + Trial) — it's a retention hook, not a paywall — we still keep the
feature key in PLAN_FEATURES so future tier changes flip a single bool
rather than a code grep.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Query, Request, Response
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.routers.auth import get_current_user
from app.services.billing import enforce_feature
from app.services.smart_pricing import (
    get_all_market_comparisons,
    get_market_comparison,
)

router = APIRouter()
logger = logging.getLogger("bonbox.smart_pricing.router")

# Audit P2 (Task #73 follow-up): scraping defense.  A loop over every
# canonical name × postal cohort harvests neighborhood medians cheaply.
# 30/min on /item is fine for a curious owner browsing their menu;
# 6/min on /all is fine for opening PricingPage every few seconds.
# Above that, the rate limit catches abuse.
limiter = Limiter(key_func=get_remote_address)


# Cache headers we set on every successful response.
# `private` — never store in a shared cache (CDN, ISP proxy).
# `max-age=300` — browser-side memo for 5 min; UI revalidates after that.
_CACHE_HEADERS = {"Cache-Control": "private, max-age=300"}


@router.get("/item")
@limiter.limit("30/minute")
def market_comparison_for_item(
    request: Request,
    response: Response,
    name: str = Query(..., min_length=1, max_length=120, description="Raw item name (will be normalised)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Single-item neighborhood comparison.

    Response always includes `available` (bool). On `available=True`,
    safe aggregate payload (min, p25, median, p75, max, count) plus the
    user's own price + their deviation/percentile. On False, only
    `reason` (and optionally `min_samples`) — never a partial leak.
    """
    enforce_feature(current_user, "smart_pricing")  # always-on, defensive
    try:
        result = get_market_comparison(db, current_user, item_name=name)
    except Exception as e:  # noqa: BLE001
        logger.exception("smart_pricing.item failed user=%s: %s", current_user.id, e)
        return {
            "available": False,
            "reason": "temporarily_unavailable",
        }
    for k, v in _CACHE_HEADERS.items():
        response.headers[k] = v
    return result


@router.get("/all")
@limiter.limit("6/minute")
def market_comparison_for_all(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Batch comparison across every priced inventory item the user has.

    Powers the "Market comparison" section at the top of PricingPage.
    Audit fires once for the batch (not per item) — see
    smart_pricing.get_all_market_comparisons.
    """
    enforce_feature(current_user, "smart_pricing")
    try:
        result = get_all_market_comparisons(db, current_user)
    except Exception as e:  # noqa: BLE001
        logger.exception("smart_pricing.all failed user=%s: %s", current_user.id, e)
        return {
            "available_count": 0,
            "unavailable_count": 0,
            "comparisons": [],
            "needs_setup": False,
            "error": "temporarily_unavailable",
        }
    for k, v in _CACHE_HEADERS.items():
        response.headers[k] = v
    return result
