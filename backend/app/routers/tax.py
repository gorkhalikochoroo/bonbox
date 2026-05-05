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


@router.get("/voucher-audit")
def voucher_audit(
    year: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Bilagsnummer compliance check (Bogføringsloven 2024).

    Returns gap analysis for the user's sales + expenses in the given
    fiscal year. SKAT auditors look for unbroken sequences — a missing
    voucher number can trigger a full audit.

    If no `year` provided, defaults to the current calendar year.
    Multi-tenant: scoped by user_id automatically.
    """
    from datetime import date as _date
    from app.services.voucher_service import assert_no_gaps
    yr = year or _date.today().year

    try:
        sales = assert_no_gaps(db, user.id, "sale", yr)
        expenses = assert_no_gaps(db, user.id, "expense", yr)
    except Exception as e:  # noqa: BLE001
        log.exception("voucher_audit failed for user=%s: %s", user.id, e)
        return {
            "year": yr,
            "_error": "Could not run voucher audit right now.",
            "_recoverable": True,
        }

    return {
        "year": yr,
        "sales": sales,
        "expenses": expenses,
        "is_compliant": sales["is_compliant"] and expenses["is_compliant"],
        "regulation": "Bogføringsloven 2024 § 7 — sequential bilagsnummer",
    }
