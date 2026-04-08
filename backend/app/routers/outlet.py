"""Cross-Outlet Intelligence endpoints — multi-outlet comparison, stock transfers."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.services.outlet_intelligence import get_outlet_intelligence

router = APIRouter()


@router.get("/intelligence")
def outlet_intelligence(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Cross-outlet comparison: performance, stock imbalances, transfer suggestions."""
    return get_outlet_intelligence(current_user.id, db)
