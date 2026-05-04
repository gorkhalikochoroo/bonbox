"""Cash Flow Prediction — 30-day projection with alerts and action items.

Multi-layer defense: forecast aggregation. Wrap so failures return a stable
empty payload with _error rather than 503.
"""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.cashflow_service import get_cashflow_forecast

router = APIRouter()
log = logging.getLogger("bonbox.cashflow")


def _safe_empty():
    return {
        "current_balance": 0,
        "projected": [],
        "alerts": [],
        "action_items": [],
        "_error": "Could not load cash flow forecast. Please try again.",
        "_recoverable": True,
    }


@router.get("/forecast")
def cashflow_forecast(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get 30-day cash flow projection with alerts and action items."""
    try:
        result = get_cashflow_forecast(user.id, db)
        return result if result is not None else _safe_empty()
    except Exception as e:
        log.exception("cashflow_forecast failed for user=%s: %s", user.id, e)
        return _safe_empty()
