"""Customer Retention endpoints — repeat rate, churn, CLV.

Multi-layer defense: the retention service runs heavy aggregations across
sales × customers. If any join fails we return a safe empty payload with
_error so the page renders instead of 503'ing.
"""

import logging

from fastapi import APIRouter, Depends, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.services.retention_service import get_retention_insights

router = APIRouter()
log = logging.getLogger("bonbox.retention")
# Retention insights run heavy aggregations across the whole customer × txn
# table. Rate-limit per IP so we can't be DoS'd into a thundering herd.
limiter = Limiter(key_func=get_remote_address)


def _safe_empty():
    """Shape-stable empty response. Frontend can render this without conditional
    nullchecks, and the _error flag triggers the banner."""
    return {
        "total_customers": 0,
        "repeat_customers": 0,
        "repeat_rate": 0,
        "avg_clv": 0,
        "at_risk": [],
        "top_customers": [],
        "_error": "Could not load retention data right now. Please try again.",
        "_recoverable": True,
    }


@router.get("/insights")
@limiter.limit("30/minute")
def retention_insights(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full customer retention analysis: repeat rates, churn, CLV, at-risk customers."""
    try:
        result = get_retention_insights(current_user.id, db)
        # Service may legitimately return None on error — defense in depth
        if result is None:
            log.warning("retention_insights: service returned None for user=%s", current_user.id)
            return _safe_empty()
        return result
    except Exception as e:
        log.exception("retention_insights failed for user=%s: %s", current_user.id, e)
        return _safe_empty()
