"""Tax Autopilot — deadlines, estimates, and reminders."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.tax_service import get_tax_overview

router = APIRouter()


@router.get("/overview")
def tax_overview(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Full tax autopilot: deadlines, estimates, alerts."""
    return get_tax_overview(user, db)
