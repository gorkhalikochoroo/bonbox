"""
Auto-match incoming bank deposits to open invoices.

Trigger point: bank_import router creates a Sale record from each imported
incoming transaction. Right after the Sale is committed, we look for an
open faktura with a total_gross close enough to be considered "the customer
paid this invoice."

Match criteria (tunable):
  • Same user_id
  • Invoice status = 'sent' (no 'paid', 'overdue' becomes 'paid' too)
  • |sale.amount - invoice.total_gross| ≤ 2 kr (tolerance for rounding)
  • Invoice issued in the last 60 days (don't auto-match year-old invoices)
  • EXACTLY ONE candidate (multiple matches → leave alone, owner picks)

Failure mode: any exception is logged but never raised — bank import
must keep working even if the matcher chokes.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional
from uuid import UUID

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.invoice import Invoice
from app.models.sale import Sale
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.payment_match")

# Tunable constants — surface these in user-tier settings later
DEFAULT_TOLERANCE_KR = Decimal("2.00")
DEFAULT_LOOKBACK_DAYS = 60


def try_match_sale_to_invoice(
    db: Session,
    sale: Sale,
    *,
    tolerance: Decimal = DEFAULT_TOLERANCE_KR,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
) -> Optional[Invoice]:
    """
    Attempt to mark an open invoice as paid based on this incoming Sale.

    Returns the Invoice that was matched (now status='paid'), or None if
    no unambiguous match was found. NEVER raises — the bank import is
    the source of truth; we're a value-add on top.
    """
    try:
        amount = Decimal(str(sale.amount))
        if amount <= 0:
            return None

        cutoff_date = date.today() - timedelta(days=lookback_days)

        # Find candidates within tolerance
        candidates = (
            db.query(Invoice)
            .filter(
                Invoice.user_id == sale.user_id,
                Invoice.status.in_(("sent", "overdue")),
                Invoice.is_credit_note.is_(False),
                Invoice.issue_date >= cutoff_date,
                Invoice.total_gross >= amount - tolerance,
                Invoice.total_gross <= amount + tolerance,
            )
            .order_by(Invoice.issue_date.asc())
            .limit(5)
            .all()
        )

        if not candidates:
            return None
        if len(candidates) > 1:
            logger.info(
                "payment_match.ambiguous user=%s sale=%s amount=%s candidates=%d — leaving for manual",
                sale.user_id, sale.id, amount, len(candidates),
            )
            return None

        invoice = candidates[0]
        # Mark paid — same logic as InvoiceService.mark_paid but skip the
        # 402-plan gate (we're internal, not a user-facing endpoint).
        invoice.status = "paid"
        invoice.paid_amount = amount
        invoice.paid_at = utc_now()
        db.flush()

        logger.info(
            "payment_match.auto user=%s sale=%s invoice=%s fakturanummer=%s amount=%s diff=%s",
            sale.user_id, sale.id, invoice.id, invoice.fakturanummer,
            amount, amount - invoice.total_gross,
        )
        return invoice

    except Exception:
        # Log and swallow — never let payment matching break bank import.
        logger.exception(
            "payment_match.failed user=%s sale=%s — continuing",
            sale.user_id if sale else None,
            sale.id if sale else None,
        )
        return None


def manual_match(
    db: Session,
    user_id: UUID,
    sale_id: UUID,
    invoice_id: UUID,
) -> Invoice:
    """
    Manually link a Sale to an Invoice (e.g. when auto-match found multiple
    or zero candidates). Tenant-scoped to user_id.
    """
    from fastapi import HTTPException, status as http_status

    invoice = (
        db.query(Invoice)
        .filter(Invoice.id == invoice_id, Invoice.user_id == user_id)
        .first()
    )
    sale = (
        db.query(Sale)
        .filter(Sale.id == sale_id, Sale.user_id == user_id)
        .first()
    )
    if invoice is None or sale is None:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Invoice or sale not found")
    if invoice.status not in ("sent", "overdue"):
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            f"Invoice is {invoice.status}; only sent/overdue invoices can be matched",
        )

    amount = Decimal(str(sale.amount))
    invoice.status = "paid"
    invoice.paid_amount = amount
    invoice.paid_at = utc_now()
    db.flush()
    logger.info(
        "payment_match.manual user=%s sale=%s invoice=%s amount=%s",
        user_id, sale_id, invoice_id, amount,
    )
    return invoice
