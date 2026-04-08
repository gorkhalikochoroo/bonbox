"""Expiry Forecasting endpoints — expiry alerts, waste prediction, order recommendations."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.services.expiry_service import get_expiry_forecast

router = APIRouter()


@router.get("/forecast")
def expiry_forecast(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full expiry analysis: upcoming expirations, waste trends, recommendations."""
    return get_expiry_forecast(current_user.id, db)
