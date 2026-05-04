"""
Billing endpoints — read-only for now. No payment processing yet; the
"upgrade" flow uses the existing waitlist endpoint to capture intent.

All endpoints require authentication. None of them mutate user.plan
directly — that's intentional. plan changes happen server-side only when
payment is processed (future). No public API path can grant Pro/Business.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.billing import billing_summary

router = APIRouter()


@router.get("/me")
def my_billing(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return billing_summary(user)
