"""
Invoice (faktura) endpoints.

Plan gating: Starter and above. Free tier gets a 402 if they hit any of
these routes — frontend should hide the menu items for Free, but we
still enforce server-side as defense in depth.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.invoice import Invoice
from app.models.user import User
from app.routers.auth import get_current_user
from app.routers.customers import _require_invoicing_plan
from app.schemas.invoicing import (
    InvoiceCreate, InvoiceResponse, InvoiceMarkPaid, InvoiceVoid,
)
from app.services.invoice_service import InvoiceService
from app.services.invoice_pdf import render_invoice_pdf
from fastapi.responses import Response

router = APIRouter()


# ─── Endpoints ───────────────────────────────────────────────────────

@router.post("", response_model=InvoiceResponse, status_code=status.HTTP_201_CREATED)
def create_invoice(
    data: InvoiceCreate,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    Create a draft invoice. Allocates the next fakturanummer for the
    user × branch × year immediately so the owner sees a stable ID.
    """
    inv = InvoiceService.create_draft(
        db=db,
        user=user,
        customer_id=data.customer_id,
        branch_id=data.branch_id,
        issue_date=data.issue_date,
        due_days=data.due_days,
        delivery_date=data.delivery_date,
        notes=data.notes,
        currency=data.currency,
        lines=[line.model_dump() for line in data.lines],
    )
    db.commit()
    db.refresh(inv)
    return InvoiceService.to_response_dict(inv)


@router.get("", response_model=list[InvoiceResponse])
def list_invoices(
    status_filter: Optional[str] = None,
    customer_id: Optional[UUID] = None,
    branch_id: Optional[UUID] = None,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """List invoices for the current user, newest first."""
    query = db.query(Invoice).filter(Invoice.user_id == user.id)
    if status_filter:
        query = query.filter(Invoice.status == status_filter)
    if customer_id is not None:
        query = query.filter(Invoice.customer_id == customer_id)
    if branch_id is not None:
        query = query.filter(Invoice.branch_id == branch_id)
    invoices = query.order_by(Invoice.issue_date.desc(), Invoice.fakturanummer.desc()).all()
    return [InvoiceService.to_response_dict(i) for i in invoices]


@router.get("/{invoice_id}", response_model=InvoiceResponse)
def get_invoice(
    invoice_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    inv = (
        db.query(Invoice)
        .filter(Invoice.id == invoice_id, Invoice.user_id == user.id)
        .first()
    )
    if inv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")
    return InvoiceService.to_response_dict(inv)


@router.post("/{invoice_id}/send", response_model=InvoiceResponse)
def send_invoice(
    invoice_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    Mark a draft as sent.

    NOTE: This endpoint only flips the status + locks the record. The
    PDF generation and mailto: link happen client-side from the response
    payload. Server-side SMTP delivery is a v2 feature.
    """
    inv = InvoiceService.mark_sent(db, user, invoice_id)
    db.commit()
    db.refresh(inv)
    return InvoiceService.to_response_dict(inv)


@router.post("/{invoice_id}/mark-paid", response_model=InvoiceResponse)
def mark_invoice_paid(
    invoice_id: UUID,
    payload: InvoiceMarkPaid,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Mark a sent invoice as paid (manual confirmation)."""
    inv = InvoiceService.mark_paid(
        db, user, invoice_id, payload.amount, payload.source,
    )
    db.commit()
    db.refresh(inv)
    return InvoiceService.to_response_dict(inv)


@router.get("/{invoice_id}/pdf")
def get_invoice_pdf(
    invoice_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    Return the invoice as a PDF byte stream.

    Used by the frontend's "Send" flow: fetch PDF → save to local disk
    → attach to mailto: link. Also reused by future "preview" + "download"
    UI affordances.

    Cache headers intentionally absent — fakturas are sensitive personal
    data and must not be cached by intermediaries.
    """
    inv = (
        db.query(Invoice)
        .filter(Invoice.id == invoice_id, Invoice.user_id == user.id)
        .first()
    )
    if inv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")
    pdf_bytes = render_invoice_pdf(db, inv)
    fakturanr = f"{inv.issue_date.year}-{inv.fakturanummer:04d}"
    filename = f"faktura-{fakturanr}.pdf"
    if inv.is_credit_note:
        filename = f"kreditnota-{fakturanr}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/{invoice_id}/void", response_model=InvoiceResponse)
def void_invoice(
    invoice_id: UUID,
    payload: InvoiceVoid,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    Void a sent invoice by generating a kreditnota.

    Returns the NEW kreditnota (not the original). The original is
    updated server-side to status='credited' with credited_by_id
    pointing at the new record.
    """
    kreditnota = InvoiceService.void_and_credit(
        db, user, invoice_id, payload.reason,
    )
    db.commit()
    db.refresh(kreditnota)
    return InvoiceService.to_response_dict(kreditnota)
