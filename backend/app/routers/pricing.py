"""Price Optimization endpoints — margin analysis, ticket trends, price simulation."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.services.pricing_service import get_pricing_insights, simulate_price_change

router = APIRouter()


@router.get("/insights")
def pricing_insights(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full pricing analysis: avg ticket, margins, low-margin items, alerts."""
    return get_pricing_insights(current_user.id, db)


@router.get("/simulate")
def price_simulation(
    increase: float = 5,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Simulate impact of a per-transaction price increase."""
    return simulate_price_change(current_user.id, db, increase)
