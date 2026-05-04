"""Tax Autopilot — deadlines, estimates, and reminders.

Multi-layer defense: tax overview is a heavy aggregation — same risk pattern
as retention/branches. Wrap so a single bad row doesn't 503 the whole tab.
"""

import logging

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.tax_service import get_tax_overview

router = APIRouter()
log = logging.getLogger("bonbox.tax")


def _safe_empty():
    """Shape-stable empty so the page renders even if the service fails."""
    return {
        "ytd_revenue": 0,
        "ytd_expenses": 0,
        "estimated_tax": 0,
        "upcoming_deadlines": [],
        "alerts": [],
        "_error": "Could not load tax data right now. Please try again.",
        "_recoverable": True,
    }


@router.get("/overview")
def tax_overview(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Full tax autopilot: deadlines, estimates, alerts."""
    try:
        result = get_tax_overview(user, db)
        if result is None:
            log.warning("tax_overview: service returned None for user=%s", user.id)
            return _safe_empty()
        return result
    except Exception as e:
        log.exception("tax_overview failed for user=%s: %s", user.id, e)
        return _safe_empty()
