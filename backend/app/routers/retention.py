"""Customer Retention endpoints — repeat rate, churn, CLV."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.services.retention_service import get_retention_insights

router = APIRouter()


@router.get("/insights")
def retention_insights(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full customer retention analysis: repeat rates, churn, CLV, at-risk customers."""
    return get_retention_insights(current_user.id, db)
