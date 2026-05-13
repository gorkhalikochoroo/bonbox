"""
Invoice (faktura) business logic.

Responsibilities:
  1. Allocate gap-less fakturanummer via voucher_service.
  2. Compute line totals + invoice totals (net, moms, gross).
  3. Enforce the locked-after-send rule.
  4. Generate kreditnota on void (never delete).
  5. Coordinate with PDF + email layers (called from the router).

This module is intentionally fat — keeping all the invariants in one
place beats spreading them across the router and the ORM.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.customer import Customer
from app.models.invoice import Invoice, InvoiceLine
from app.models.user import User
from app.services import audit_service
from app.services.voucher_service import allocate_invoice_number, format_voucher_number
from app.utils.time import utc_now

# Reversibility window for auto-matched invoices. If an auto-flip turns
# out to be wrong (coincidental amount match, bank API quirk), the owner
# has 7 days to undo it via /api/invoices/{id}/unmark-paid. Manual marks
# are always reversible — they were explicit user actions, the user can
# always change their mind.
AUTO_MATCH_REVERSIBLE_DAYS = 7

logger = logging.getLogger(__name__)


# Rounding: every monetary value rounds to 2 decimals using banker's-
# friendly HALF_UP. SKAT accepts this; HALF_EVEN would also be defensible.
def _round_kr(v: Decimal) -> Decimal:
    return Decimal(v).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


class InvoiceService:
    """Stateless namespace — every method takes db + caller info explicitly."""

    # ─── Create draft invoice ───────────────────────────────────────

    @staticmethod
    def create_draft(
        db: Session,
        user: User,
        customer_id: UUID,
        lines: list[dict],
        branch_id: Optional[UUID] = None,
        issue_date: Optional[date] = None,
        due_days: Optional[int] = None,
        delivery_date: Optional[date] = None,
        notes: Optional[str] = None,
        currency: str = "DKK",
    ) -> Invoice:
        """
        Create a draft faktura. Allocates fakturanummer immediately (so the
        owner sees a stable number from the moment of creation), but status
        stays 'draft' and locked=False until send() is called.
        """
        # 1. Tenant + ownership check on the customer
        customer = (
            db.query(Customer)
            .filter(
                Customer.id == customer_id,
                Customer.user_id == user.id,
                Customer.is_deleted.is_(False),
            )
            .first()
        )
        if customer is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Customer not found",
            )

        # 2. Resolve dates
        issue = issue_date or date.today()
        terms = due_days if due_days is not None else customer.payment_terms_days
        due = issue + timedelta(days=terms)

        # 3. Allocate fakturanummer (gap-less per user × branch × year)
        # Caller's transaction will commit it.
        number = allocate_invoice_number(db, user.id, branch_id, issue.year)

        # 4. Build the Invoice + lines, computing totals
        inv = Invoice(
            user_id=user.id,
            branch_id=branch_id,
            customer_id=customer.id,
            fakturanummer=number,
            issue_date=issue,
            due_date=due,
            # Only store leveringsdato when it differs from issue_date —
            # nulling it for same-day work keeps the PDF clean (it only
            # prints the leveringsdato line when present).
            delivery_date=delivery_date if delivery_date and delivery_date != issue else None,
            status="draft",
            currency=currency,
            notes=notes,
            customer_lang=customer.default_lang,
            locked=False,
        )

        subtotal_net = Decimal("0")
        moms_total = Decimal("0")
        for i, raw in enumerate(lines):
            qty = Decimal(str(raw["quantity"]))
            unit_price = Decimal(str(raw["unit_price_net"]))
            moms_rate = Decimal(str(raw["moms_rate"]))

            line_net = _round_kr(qty * unit_price)
            line_moms = _round_kr(line_net * moms_rate)
            line_gross = _round_kr(line_net + line_moms)

            line = InvoiceLine(
                line_order=i,
                description=raw["description"],
                quantity=qty,
                unit=raw.get("unit"),
                unit_price_net=unit_price,
                moms_rate=moms_rate,
                line_net=line_net,
                line_moms=line_moms,
                line_gross=line_gross,
            )
            inv.lines.append(line)
            subtotal_net += line_net
            moms_total += line_moms

        inv.subtotal_net = _round_kr(subtotal_net)
        inv.moms_total = _round_kr(moms_total)
        inv.total_gross = _round_kr(subtotal_net + moms_total)

        db.add(inv)
        db.flush()  # populate inv.id without committing

        logger.info(
            "invoice.draft.created user=%s fakturanummer=%s total=%s",
            user.id, number, inv.total_gross,
        )
        return inv

    # ─── Send: flip to sent + lock + record sent_at ─────────────────

    @staticmethod
    def mark_sent(
        db: Session, user: User, invoice_id: UUID,
        ip_address: str | None = None,
    ) -> Invoice:
        """
        Flip status draft → sent. After this, the invoice is locked.

        Does NOT email/PDF — that's the router's job (it generates a PDF
        URL and opens mailto: on the client). This method is the
        authoritative state transition.

        Writes an audit log entry — every send is a real-world
        revenue-recognition event under accrual accounting (Bogføringsloven
        §9), so we must be able to defend the timing if challenged.
        """
        inv = InvoiceService._get_owned_or_404(db, user, invoice_id)
        if inv.status != "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Invoice is already {inv.status}; can only send drafts",
            )
        before = {"id": str(inv.id), "status": inv.status, "locked": inv.locked}
        inv.status = "sent"
        inv.sent_at = utc_now()
        inv.locked = True
        db.flush()
        audit_service.record(
            db, user, "invoice.send",
            entity_type="invoice", entity_id=inv.id,
            before=before,
            after={"id": str(inv.id), "status": "sent", "sent_at": inv.sent_at.isoformat(), "locked": True},
            ip_address=ip_address,
        )
        logger.info("invoice.sent user=%s fakturanummer=%s", user.id, inv.fakturanummer)
        return inv

    # ─── Mark paid (manual or via bank-match) ───────────────────────

    @staticmethod
    def mark_paid(
        db: Session,
        user: User,
        invoice_id: UUID,
        amount: Decimal,
        source: str = "manual",
        paid_reference: str | None = None,
        ip_address: str | None = None,
    ) -> Invoice:
        """
        Mark a sent/overdue invoice as paid.

        State machine: only 'sent' or 'overdue' invoices can transition
        to 'paid'. Drafts must be sent first; paid is idempotent (re-call
        returns the existing record); credited is terminal.

        Provenance tracked via `source` (paid_via column):
          'manual'      — owner clicked Mark as Paid
          'bank_csv'    — matched from a CSV upload
          'auto_match'  — high-confidence bank-import auto-match
                          (sets auto_match_reversible=True, opens 7-day undo)
          'mobilepay'   — future MobilePay webhook
          'open_banking'— future GoCardless integration

        Audit log captures who/when/IP/amount/source — required for
        Skattestyrelsen dispute defense and for the future revenue
        Tax Autopilot accuracy.
        """
        inv = InvoiceService._get_owned_or_404(db, user, invoice_id)

        # Idempotency: re-marking already-paid invoice from the same
        # source is a no-op (returns existing). Prevents double-audit
        # when bank import races with manual click.
        if inv.status == "paid":
            return inv

        if inv.status not in ("sent", "overdue"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Invoice is {inv.status}; can only mark sent/overdue invoices as paid",
            )

        amount = _round_kr(Decimal(str(amount)))
        # V1: require full payment to flip status (±2 kr tolerance for
        # bank gebyr). Partial payments are a v2 feature requiring
        # different state ('partial') and accumulated paid_amount.
        if amount < inv.total_gross - Decimal("2"):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Amount {amount} is below invoice total {inv.total_gross}. "
                "Partial payments not yet supported.",
            )

        before = {
            "id": str(inv.id),
            "status": inv.status,
            "paid_at": None,
            "paid_amount": str(inv.paid_amount) if inv.paid_amount else None,
            "paid_via": inv.paid_via,
        }
        inv.status = "paid"
        inv.paid_amount = amount
        inv.paid_at = utc_now()
        inv.paid_via = source
        inv.paid_reference = paid_reference
        # Auto-matches get a 7-day undo window. Manual marks don't need
        # the flag — they're always reversible via unmark_paid.
        inv.auto_match_reversible = (source == "auto_match")
        db.flush()

        audit_service.record(
            db, user, "invoice.mark_paid",
            entity_type="invoice", entity_id=inv.id,
            before=before,
            after={
                "status": "paid",
                "paid_at": inv.paid_at.isoformat(),
                "paid_amount": str(amount),
                "paid_via": source,
                "paid_reference": paid_reference,
                "auto_match_reversible": inv.auto_match_reversible,
            },
            ip_address=ip_address,
        )
        logger.info(
            "invoice.paid user=%s fakturanummer=%s source=%s amount=%s",
            user.id, inv.fakturanummer, source, amount,
        )
        return inv

    # ─── Unmark paid (reverse a mistake) ────────────────────────────

    @staticmethod
    def unmark_paid(
        db: Session,
        user: User,
        invoice_id: UUID,
        ip_address: str | None = None,
    ) -> Invoice:
        """
        Reverse a 'paid' status back to 'sent' (or 'overdue' if past due).

        Eligibility:
          • Status must currently be 'paid'.
          • Auto-matches: only reversible within 7 days of paid_at, and
            only if auto_match_reversible=True (set by mark_paid for
            source='auto_match'). After that window the auto-match is
            considered settled — owner needs to use kreditnota to
            correct further.
          • Manual marks (paid_via='manual' / 'bank_csv'): always
            reversible — owner explicitly marked it, owner can change
            their mind.

        Audit log captures the reversal with full before/after state
        so the trail shows what was paid + when + reversed by whom.
        """
        inv = InvoiceService._get_owned_or_404(db, user, invoice_id)
        if inv.status != "paid":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Invoice is {inv.status}; only paid invoices can be unmarked",
            )

        # Auto-match 7-day window enforcement
        if inv.paid_via == "auto_match":
            if not inv.auto_match_reversible:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Auto-match reversibility window has expired. Use kreditnota to correct.",
                )
            if inv.paid_at:
                age = (utc_now() - inv.paid_at).days
                if age > AUTO_MATCH_REVERSIBLE_DAYS:
                    inv.auto_match_reversible = False
                    db.flush()
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        f"Auto-match more than {AUTO_MATCH_REVERSIBLE_DAYS} days old "
                        "can't be auto-reversed. Use kreditnota to correct.",
                    )

        before = {
            "id": str(inv.id),
            "status": "paid",
            "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
            "paid_amount": str(inv.paid_amount) if inv.paid_amount else None,
            "paid_via": inv.paid_via,
        }

        # Restore to 'sent' or 'overdue' based on whether due_date passed
        new_status = "overdue" if inv.due_date < date.today() else "sent"
        inv.status = new_status
        inv.paid_at = None
        inv.paid_amount = None
        inv.paid_via = None
        inv.paid_reference = None
        inv.auto_match_reversible = False

        # Detach any linked Sale row so revenue queries don't double-count.
        # (Sale.invoice_id is the dedup signal in Tax Autopilot.)
        from app.models.sale import Sale
        db.query(Sale).filter(
            Sale.user_id == user.id,
            Sale.invoice_id == inv.id,
        ).update({"invoice_id": None})

        db.flush()

        audit_service.record(
            db, user, "invoice.unmark_paid",
            entity_type="invoice", entity_id=inv.id,
            before=before,
            after={"status": new_status},
            ip_address=ip_address,
        )
        logger.info(
            "invoice.unmark_paid user=%s fakturanummer=%s from=%s to=%s",
            user.id, inv.fakturanummer, "paid", new_status,
        )
        return inv

    # ─── Void → generate kreditnota (never delete) ──────────────────

    @staticmethod
    def void_and_credit(
        db: Session,
        user: User,
        invoice_id: UUID,
        reason: str,
        ip_address: str | None = None,
    ) -> Invoice:
        """
        Void an already-sent invoice by creating a kreditnota (credit note).

        The original invoice keeps its fakturanummer and stays in the
        ledger (status='credited'). The new kreditnota has the next
        fakturanummer in sequence and contains the same lines with
        negated amounts.
        """
        original = InvoiceService._get_owned_or_404(db, user, invoice_id)
        if original.status not in ("sent", "overdue", "paid"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Cannot credit an invoice in status {original.status}",
            )
        if original.is_credit_note:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Cannot credit a credit note",
            )

        # Build the kreditnota with negated values
        today = date.today()
        kn_number = allocate_invoice_number(db, user.id, original.branch_id, today.year)
        kn = Invoice(
            user_id=user.id,
            branch_id=original.branch_id,
            customer_id=original.customer_id,
            fakturanummer=kn_number,
            issue_date=today,
            due_date=today,
            status="sent",  # kreditnotas are issued immediately, no draft state
            currency=original.currency,
            notes=f"Kreditnota til faktura {original.fakturanummer}: {reason}",
            customer_lang=original.customer_lang,
            is_credit_note=True,
            sent_at=utc_now(),
            locked=True,
            subtotal_net=-original.subtotal_net,
            moms_total=-original.moms_total,
            total_gross=-original.total_gross,
        )
        for original_line in original.lines:
            kn.lines.append(InvoiceLine(
                line_order=original_line.line_order,
                description=f"Kreditering: {original_line.description}",
                quantity=-original_line.quantity,
                unit=original_line.unit,
                unit_price_net=original_line.unit_price_net,
                moms_rate=original_line.moms_rate,
                line_net=-original_line.line_net,
                line_moms=-original_line.line_moms,
                line_gross=-original_line.line_gross,
            ))
        db.add(kn)
        db.flush()

        original_status_before = original.status
        # Link the original
        original.status = "credited"
        original.credited_by_id = kn.id
        db.flush()

        # Audit both records — the original is now credited, the kreditnota
        # is a new ledger entry. Two log rows so the trail shows both halves
        # of the reversal cleanly.
        audit_service.record(
            db, user, "invoice.void",
            entity_type="invoice", entity_id=original.id,
            before={"id": str(original.id), "status": original_status_before},
            after={"status": "credited", "credited_by_id": str(kn.id), "reason": reason},
            ip_address=ip_address,
        )
        audit_service.record(
            db, user, "invoice.credit_note_issued",
            entity_type="invoice", entity_id=kn.id,
            before=None,
            after={
                "fakturanummer": kn.fakturanummer,
                "is_credit_note": True,
                "credits_invoice_id": str(original.id),
                "total_gross": str(kn.total_gross),
            },
            ip_address=ip_address,
        )

        logger.info(
            "invoice.credited user=%s original=%s kreditnota=%s reason=%s",
            user.id, original.fakturanummer, kn.fakturanummer, reason,
        )
        return kn

    # ─── Helpers ────────────────────────────────────────────────────

    @staticmethod
    def _get_owned_or_404(db: Session, user: User, invoice_id: UUID) -> Invoice:
        inv = (
            db.query(Invoice)
            .filter(Invoice.id == invoice_id, Invoice.user_id == user.id)
            .first()
        )
        if inv is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")
        return inv

    @staticmethod
    def to_response_dict(inv: Invoice) -> dict:
        """Build a response dict including the formatted fakturanummer."""
        d = {
            "id": inv.id,
            "user_id": inv.user_id,
            "branch_id": inv.branch_id,
            "customer_id": inv.customer_id,
            "fakturanummer": inv.fakturanummer,
            "fakturanummer_formatted": format_voucher_number(
                "invoice", inv.issue_date.year, inv.fakturanummer
            ),
            "issue_date": inv.issue_date,
            "due_date": inv.due_date,
            "delivery_date": inv.delivery_date,
            "sent_at": inv.sent_at,
            "paid_at": inv.paid_at,
            "status": inv.status,
            "subtotal_net": inv.subtotal_net,
            "moms_total": inv.moms_total,
            "total_gross": inv.total_gross,
            "paid_amount": inv.paid_amount,
            "paid_via": inv.paid_via,
            "paid_reference": inv.paid_reference,
            "auto_match_reversible": bool(inv.auto_match_reversible),
            "currency": inv.currency,
            "notes": inv.notes,
            "customer_lang": inv.customer_lang,
            "credited_by_id": inv.credited_by_id,
            "is_credit_note": inv.is_credit_note,
            "locked": inv.locked,
            "created_at": inv.created_at,
            "updated_at": inv.updated_at,
            "lines": [
                {
                    "id": l.id,
                    "line_order": l.line_order,
                    "description": l.description,
                    "quantity": l.quantity,
                    "unit": l.unit,
                    "unit_price_net": l.unit_price_net,
                    "moms_rate": l.moms_rate,
                    "line_net": l.line_net,
                    "line_moms": l.line_moms,
                    "line_gross": l.line_gross,
                }
                for l in sorted(inv.lines, key=lambda x: x.line_order)
            ],
        }
        return d
