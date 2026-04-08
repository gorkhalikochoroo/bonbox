"""Cash Flow Prediction — 30-day projection with alerts and action items."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.cashflow_service import get_cashflow_forecast

router = APIRouter()


@router.get("/forecast")
def cashflow_forecast(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get 30-day cash flow projection with alerts and action items."""
    return get_cashflow_forecast(user.id, db)
