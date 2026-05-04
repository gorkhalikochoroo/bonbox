"""Price Optimization endpoints — margin analysis, ticket trends, price simulation.

Multi-layer defense: heavy aggregation across sales × items. Wrap both
endpoints; never propagate 503.
"""

import logging

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.services.pricing_service import get_pricing_insights, simulate_price_change

router = APIRouter()
log = logging.getLogger("bonbox.pricing")


def _safe_empty_insights():
    return {
        "avg_ticket": 0,
        "margin_pct": 0,
        "low_margin_items": [],
        "trends": [],
        "alerts": [],
        "_error": "Could not load pricing insights. Please try again.",
        "_recoverable": True,
    }


def _safe_empty_simulation(increase: float):
    return {
        "increase_pct": increase,
        "projected_revenue_delta": 0,
        "projected_margin_delta": 0,
        "_error": "Could not simulate price change. Please try again.",
        "_recoverable": True,
    }


@router.get("/insights")
def pricing_insights(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full pricing analysis: avg ticket, margins, low-margin items, alerts."""
    try:
        result = get_pricing_insights(current_user.id, db)
        return result if result is not None else _safe_empty_insights()
    except Exception as e:
        log.exception("pricing_insights failed for user=%s: %s", current_user.id, e)
        return _safe_empty_insights()


@router.get("/simulate")
def price_simulation(
    increase: float = Query(5, ge=-50, le=200),  # bound increase to sane range
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Simulate impact of a per-transaction price increase."""
    try:
        result = simulate_price_change(current_user.id, db, increase)
        return result if result is not None else _safe_empty_simulation(increase)
    except Exception as e:
        log.exception("price_simulation failed for user=%s: %s", current_user.id, e)
        return _safe_empty_simulation(increase)
