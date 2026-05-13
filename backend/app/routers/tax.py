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
    """Shape-stable empty so the page renders even if the service fails.

    CRITICAL: must mirror the shape of `get_tax_overview()` output —
    in particular `current_month` and `ytd` MUST be objects with the
    same keys as `_calc_vat()` returns, otherwise the frontend destructure
    `const { current_month, ytd } = data; current_month.vat_payable`
    crashes with 'cannot read properties of undefined'.

    Previous version (2026-05-13) shipped a flat shape that triggered
    exactly that crash on TaxAutopilotPage — root cause was a Postgres
    FK type mismatch in migration 034 that left Sale.invoice_id missing
    and every Sale query 500'd, falling here. The migration is now fixed
    BUT this fallback must remain crash-proof regardless.
    """
    empty_vat_block = {
        "sales_total": 0,
        "pos_revenue": 0,
        "invoice_revenue": 0,
        "expenses_total": 0,
        "output_vat": 0,
        "input_vat": 0,
        "vat_payable": 0,
    }
    return {
        "tax_name": "VAT",
        "authority": "Tax Authority",
        "rate": 0.25,
        "rate_pct": 25.0,
        "frequency": "quarterly",
        "available_frequencies": [],
        "prices_include_moms": True,
        "currency": "DKK",
        "upcoming_deadlines": [],
        "payroll_deadlines": [],
        "current_month": {**empty_vat_block, "month": ""},
        "ytd": {**empty_vat_block, "year": 0},
        "alerts": [],
        "daily_close_reconciliation": {
            "current_month": {
                "moms_from_closes": 0, "moms_from_sales": 0,
                "closes_count": 0, "drafts_count": 0,
                "manual_count": 0, "revenue_from_closes": 0,
                "discrepancy": None, "discrepancy_pct": None,
                "status": "no_data",
            },
            "ytd": {
                "moms_from_closes": 0, "moms_from_sales": 0,
                "closes_count": 0, "revenue_from_closes": 0,
            },
        },
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
