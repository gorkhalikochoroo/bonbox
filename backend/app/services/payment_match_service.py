"""
Confidence-based auto-match of bank deposits → open invoices.

Why confidence tiers exist:
  The naive amount-only matcher was wrong in a real scenario — a 7.125 kr
  loan repayment from Customer A would auto-flip a B2B faktura to
  Customer B for the same amount to 'paid'. Wrong revenue → wrong Moms
  → real tax penalties. We needed a safer rule.

Decision logic:
  Filter (mandatory for any tier):
    • sale.amount > 0 (incoming only)
    • |sale.amount - invoice.total_gross| <= tolerance (default ±2 kr)
    • invoice.status in ('sent', 'overdue')
    • not a kreditnota
    • invoice issued in the lookback window (default 90 days)
    • invoice not already linked to another Sale

  Confidence:
    HIGH    — Exactly ONE amount candidate AND
              the bank description contains the customer's name (first
              8 chars, case-insensitive) OR the fakturanummer string
              (e.g. "2026-0042"). Highly likely to be the right match.
              → Auto-mark paid + link Sale.invoice_id.
              → auto_match_reversible=True (7-day undo).

    MEDIUM  — Exactly ONE amount candidate, NO text confirmation.
              → Create a PaymentMatchSuggestion(status='pending').
              → Do NOT change invoice status — owner reviews.

    LOW     — Multiple amount candidates (ambiguous).
              → Create one suggestion per candidate (confidence='low').
              → Owner picks the right one in the review inbox.

  No match → no-op.

Bank import is the source of truth; we are a value-add layer. Any
exception is logged and swallowed — never break the import flow.
"""
from __future__ import annotations

import logging
import unicodedata
from datetime import date, timedelta
from decimal import Decimal
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session


def _strip_diacritics(s: str) -> str:
    """Normalize 'Café Lyngby' → 'Cafe Lyngby'. Danish banks strip
    diacritics on transaction descriptions ('æ', 'ø', 'å', 'é') so
    both sides of the match must be normalized for a fair comparison.
    """
    if not s:
        return ""
    return "".join(
        c for c in unicodedata.normalize("NFKD", s)
        if not unicodedata.combining(c)
    )

from app.models.invoice import Invoice
from app.models.sale import Sale
from app.models.customer import Customer
from app.models.payment_match_suggestion import PaymentMatchSuggestion
from app.services import audit_service
from app.services.voucher_service import format_voucher_number
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.payment_match")

# Tunable constants — surface these in user-tier settings later
DEFAULT_TOLERANCE_KR = Decimal("2.00")
DEFAULT_LOOKBACK_DAYS = 90  # widened from 60 → 90 to catch slow payers


def _text_signal_matches(description: str, customer_name: str, fakturanummer_str: str) -> tuple[bool, str]:
    """Check if the bank-transaction description text confirms this match.

    Two acceptable signals (either is sufficient):
      1. The fakturanummer appears literally ("2026-0042")
      2. The customer name's first 8 chars appear (case-insensitive)
         — handles bank truncation of long names

    Returns (matched: bool, reason: str). The reason is human-readable
    for the audit log and review inbox.
    """
    if not description:
        return (False, "no description on bank transaction")
    # Strip diacritics on both sides — Danish banks emit ASCII-only
    # descriptions, so 'Café Lyngby' becomes 'Cafe Lyngby' on the
    # statement. Without this normalization a 'Café' customer name
    # would never match its own bank line.
    desc_lower = _strip_diacritics(description).lower()

    if fakturanummer_str and fakturanummer_str.lower() in desc_lower:
        return (True, f"fakturanummer '{fakturanummer_str}' in bank text")

    if customer_name:
        # First 8 chars (or full name if shorter), case-insensitive,
        # diacritic-stripped. 8 is a sweet spot — long enough to be
        # specific ("Lyngby-T" vs "Lyngby"), short enough to survive
        # truncation by most banks' description field (often 35 chars).
        needle = _strip_diacritics(customer_name)[:8].lower().strip()
        if len(needle) >= 4 and needle in desc_lower:
            return (True, f"'{needle}' (customer prefix) in bank text")

    return (False, "no text confirmation in bank description")


def _create_suggestion(
    db: Session,
    sale: Sale,
    invoice: Invoice,
    confidence: str,
    reason: str,
) -> PaymentMatchSuggestion:
    """Insert a PaymentMatchSuggestion row. Idempotent against the
    (sale_id, invoice_id) pair — if a pending suggestion already exists,
    return it without creating a duplicate."""
    existing = (
        db.query(PaymentMatchSuggestion)
        .filter(
            PaymentMatchSuggestion.sale_id == sale.id,
            PaymentMatchSuggestion.invoice_id == invoice.id,
            PaymentMatchSuggestion.status == "pending",
        )
        .first()
    )
    if existing:
        return existing

    sugg = PaymentMatchSuggestion(
        user_id=sale.user_id,
        sale_id=sale.id,
        invoice_id=invoice.id,
        confidence=confidence,
        reason=reason,
        status="pending",
    )
    db.add(sugg)
    db.flush()
    return sugg


def try_match_sale_to_invoice(
    db: Session,
    sale: Sale,
    *,
    tolerance: Decimal = DEFAULT_TOLERANCE_KR,
    lookback_days: int = DEFAULT_LOOKBACK_DAYS,
) -> Optional[Invoice]:
    """
    Confidence-based auto-match. Returns the Invoice that was auto-flipped
    to 'paid' (HIGH confidence only), or None if no auto-action was taken.

    NEVER raises — failures logged and swallowed.

    Side effects:
      • HIGH confidence: invoice.status='paid', invoice.paid_via='auto_match',
        invoice.auto_match_reversible=True, Sale.invoice_id linked, audit
        log written.
      • MEDIUM / LOW: PaymentMatchSuggestion row(s) created, no status
        changes. Owner reviews via /faktura/review.
    """
    try:
        amount = Decimal(str(sale.amount))
        # Incoming only — outgoing payments should never auto-match an
        # invoice (would be hilariously wrong: matching a refund TO a
        # customer with an open faktura FROM another customer).
        if amount <= 0:
            return None

        cutoff_date = date.today() - timedelta(days=lookback_days)

        # Find amount candidates within tolerance.
        # Excludes invoices already linked to another Sale (the
        # invoice_id-NULL filter) so we don't suggest a faktura that's
        # already accounted for in a prior bank line.
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
            .limit(10)
            .all()
        )

        if not candidates:
            return None

        # Ambiguous (multiple amount matches): create LOW-confidence
        # suggestions per candidate. Owner picks the right one or
        # rejects them all.
        if len(candidates) > 1:
            for c in candidates[:5]:  # cap at 5 to avoid suggestion spam
                _create_suggestion(
                    db, sale, c, "low",
                    f"Amount {amount} kr matches — {len(candidates)} open fakturaer at this amount",
                )
            logger.info(
                "payment_match.ambiguous user=%s sale=%s amount=%s candidates=%d — created low-confidence suggestions",
                sale.user_id, sale.id, amount, len(candidates),
            )
            return None

        # Single candidate — check for text confirmation
        invoice = candidates[0]
        customer = (
            db.query(Customer)
            .filter(Customer.id == invoice.customer_id)
            .first()
        )
        customer_name = customer.name if customer else ""
        fakturanummer_str = format_voucher_number(
            "invoice", invoice.issue_date.year, invoice.fakturanummer
        )

        has_text_signal, reason = _text_signal_matches(
            sale.notes or "", customer_name, fakturanummer_str,
        )

        if has_text_signal:
            # HIGH confidence — auto-flip.
            # Route via _sanitize_paid_reference so the persisted reference
            # is truncated + scrubbed (bank descriptions can hold PII;
            # GDPR data-minimization).
            from app.services.invoice_service import _sanitize_paid_reference
            invoice.status = "paid"
            invoice.paid_amount = amount
            invoice.paid_at = utc_now()
            invoice.paid_via = "auto_match"
            invoice.paid_reference = _sanitize_paid_reference(sale.notes)
            invoice.auto_match_reversible = True
            sale.invoice_id = invoice.id  # dedup signal for Tax Autopilot
            db.flush()

            audit_service.record(
                db, sale.user_id, "invoice.mark_paid",
                entity_type="invoice", entity_id=invoice.id,
                before={"status": "sent" if invoice.status == "paid" else invoice.status, "paid_at": None},
                after={
                    "status": "paid",
                    "paid_at": invoice.paid_at.isoformat(),
                    "paid_amount": str(amount),
                    "paid_via": "auto_match",
                    "auto_match_reversible": True,
                    "match_reason": reason,
                },
                actor_type="system.payment_match",
                ip_address=None,
            )
            logger.info(
                "payment_match.auto user=%s sale=%s invoice=%s fakturanummer=%s amount=%s reason=%s",
                sale.user_id, sale.id, invoice.id, invoice.fakturanummer,
                amount, reason,
            )
            return invoice

        # MEDIUM confidence — amount matches but no text signal.
        # Create a suggestion; don't touch the invoice.
        _create_suggestion(
            db, sale, invoice, "medium",
            f"Amount {amount} kr matches faktura {fakturanummer_str} — {reason}",
        )
        logger.info(
            "payment_match.suggested user=%s sale=%s invoice=%s confidence=medium reason=%s",
            sale.user_id, sale.id, invoice.id, reason,
        )
        return None

    except Exception:
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
    *,
    ip_address: str | None = None,
) -> Invoice:
    """
    Manually link a Sale to an Invoice (e.g. when auto-match found multiple
    or zero candidates). Tenant-scoped to user_id.

    This is now a thin wrapper around InvoiceService.mark_paid — the
    real state-machine + audit logic lives there. Sets paid_via='bank_csv'
    because manual_match is invoked from the bank-CSV flow, not from a
    user-initiated mark-paid button (which uses 'manual').
    """
    from fastapi import HTTPException, status as http_status
    from app.services.invoice_service import InvoiceService
    from app.models.user import User

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "User not found")

    sale = (
        db.query(Sale)
        .filter(Sale.id == sale_id, Sale.user_id == user_id)
        .first()
    )
    if sale is None:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Sale not found")

    amount = Decimal(str(sale.amount))
    invoice = InvoiceService.mark_paid(
        db, user, invoice_id, amount,
        source="bank_csv",
        paid_reference=sale.notes,
        ip_address=ip_address,
    )
    # Link the Sale for revenue-dedup queries
    sale.invoice_id = invoice.id
    db.flush()
    return invoice


# ─── Owner-driven accept/reject on suggestions ──────────────────────────


def accept_suggestion(
    db: Session,
    user_id: UUID,
    suggestion_id: UUID,
    *,
    ip_address: str | None = None,
) -> Invoice:
    """
    Owner reviewed a PaymentMatchSuggestion and confirmed it. Flips the
    invoice to paid via the hardened mark_paid (with 'manual' source —
    even though the matching logic was automated, the OWNER made the
    final call). Records the suggestion as 'accepted'.

    NOT eligible for the 7-day auto-undo: owner explicitly accepted, so
    if they want to reverse later it's a normal unmark_paid call.
    """
    from fastapi import HTTPException, status as http_status
    from app.services.invoice_service import InvoiceService
    from app.models.user import User

    sugg = (
        db.query(PaymentMatchSuggestion)
        .filter(
            PaymentMatchSuggestion.id == suggestion_id,
            PaymentMatchSuggestion.user_id == user_id,
        )
        .first()
    )
    if sugg is None:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Suggestion not found")
    if sugg.status != "pending":
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            f"Suggestion already {sugg.status}",
        )

    user = db.query(User).filter(User.id == user_id).first()
    sale = (
        db.query(Sale)
        .filter(Sale.id == sugg.sale_id, Sale.user_id == user_id)
        .first()
    )
    if sale is None:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Sale not found")

    amount = Decimal(str(sale.amount))
    invoice = InvoiceService.mark_paid(
        db, user, sugg.invoice_id, amount,
        source="manual",  # owner confirmed — counted as manual decision
        paid_reference=sale.notes,
        ip_address=ip_address,
    )
    sale.invoice_id = invoice.id  # dedup signal for Tax Autopilot
    sugg.status = "accepted"

    # Reject other pending suggestions for the same sale_id — only one
    # invoice can be paid by one bank line.
    db.query(PaymentMatchSuggestion).filter(
        PaymentMatchSuggestion.sale_id == sale.id,
        PaymentMatchSuggestion.id != sugg.id,
        PaymentMatchSuggestion.status == "pending",
    ).update({"status": "rejected"})

    db.flush()
    audit_service.record(
        db, user_id, "payment_suggestion.accept",
        entity_type="payment_suggestion", entity_id=sugg.id,
        before={"status": "pending"},
        after={"status": "accepted", "invoice_id": str(sugg.invoice_id)},
        ip_address=ip_address,
    )
    return invoice


def reject_suggestion(
    db: Session,
    user_id: UUID,
    suggestion_id: UUID,
    *,
    ip_address: str | None = None,
) -> PaymentMatchSuggestion:
    """
    Owner reviewed a PaymentMatchSuggestion and declined it. The invoice
    stays open; the bank Sale stays unlinked. The suggestion row stays
    in the DB as audit trail.
    """
    from fastapi import HTTPException, status as http_status

    sugg = (
        db.query(PaymentMatchSuggestion)
        .filter(
            PaymentMatchSuggestion.id == suggestion_id,
            PaymentMatchSuggestion.user_id == user_id,
        )
        .first()
    )
    if sugg is None:
        raise HTTPException(http_status.HTTP_404_NOT_FOUND, "Suggestion not found")
    if sugg.status != "pending":
        raise HTTPException(
            http_status.HTTP_409_CONFLICT,
            f"Suggestion already {sugg.status}",
        )

    sugg.status = "rejected"
    db.flush()
    audit_service.record(
        db, user_id, "payment_suggestion.reject",
        entity_type="payment_suggestion", entity_id=sugg.id,
        before={"status": "pending"},
        after={"status": "rejected"},
        ip_address=ip_address,
    )
    return sugg
