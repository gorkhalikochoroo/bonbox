"""Expiry Forecasting endpoints — expiry alerts, waste prediction, order recommendations.

Multi-layer defense: heavy aggregation. Wrap so a single corrupt row doesn't
503 the page; return a stable shape with _error so the frontend renders.
"""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.services.expiry_service import get_expiry_forecast

router = APIRouter()
log = logging.getLogger("bonbox.expiry")


def _safe_empty():
    return {
        "expiring_soon": [],
        "expired": [],
        "waste_trend": [],
        "recommendations": [],
        "_error": "Could not load expiry forecast. Please try again.",
        "_recoverable": True,
    }


@router.get("/forecast")
def expiry_forecast(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full expiry analysis: upcoming expirations, waste trends, recommendations."""
    try:
        result = get_expiry_forecast(current_user.id, db)
        return result if result is not None else _safe_empty()
    except Exception as e:
        log.exception("expiry_forecast failed for user=%s: %s", current_user.id, e)
        return _safe_empty()
