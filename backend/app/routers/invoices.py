"""
Invoice (faktura) endpoints.

Plan gating: Starter and above. Free tier gets a 402 if they hit any of
these routes — frontend should hide the menu items for Free, but we
still enforce server-side as defense in depth.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status
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
    from_date: Optional[str] = None,   # ISO YYYY-MM-DD
    to_date: Optional[str] = None,     # ISO YYYY-MM-DD
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    List invoices for the current user, newest first.

    Date range params (from_date / to_date) filter by issue_date. Both
    are inclusive. Either can be omitted. Invalid ISO strings are
    silently ignored (better UX than 422 on an old query string).
    """
    from datetime import date as date_type

    query = db.query(Invoice).filter(Invoice.user_id == user.id)
    if status_filter:
        query = query.filter(Invoice.status == status_filter)
    if customer_id is not None:
        query = query.filter(Invoice.customer_id == customer_id)
    if branch_id is not None:
        query = query.filter(Invoice.branch_id == branch_id)
    if from_date:
        try:
            d = date_type.fromisoformat(from_date)
            query = query.filter(Invoice.issue_date >= d)
        except ValueError:
            pass  # ignore garbage input rather than 422
    if to_date:
        try:
            d = date_type.fromisoformat(to_date)
            query = query.filter(Invoice.issue_date <= d)
        except ValueError:
            pass
    invoices = query.order_by(
        Invoice.issue_date.desc(), Invoice.fakturanummer.desc()
    ).limit(500).all()  # safety cap — UI is paginated client-side
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
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    Mark a draft as sent.

    NOTE: This endpoint only flips the status + locks the record. The
    PDF generation and mailto: link happen client-side from the response
    payload. Server-side SMTP delivery is a v2 feature.
    """
    ip = getattr(request.client, "host", None)
    inv = InvoiceService.mark_sent(db, user, invoice_id, ip_address=ip)
    db.commit()
    db.refresh(inv)
    return InvoiceService.to_response_dict(inv)


@router.post("/{invoice_id}/mark-paid", response_model=InvoiceResponse)
def mark_invoice_paid(
    invoice_id: UUID,
    payload: InvoiceMarkPaid,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Mark a sent invoice as paid (manual confirmation)."""
    ip = getattr(request.client, "host", None)
    inv = InvoiceService.mark_paid(
        db, user, invoice_id, payload.amount, payload.source,
        paid_reference=getattr(payload, "paid_reference", None),
        ip_address=ip,
    )
    db.commit()
    db.refresh(inv)
    return InvoiceService.to_response_dict(inv)


@router.post("/{invoice_id}/unmark-paid", response_model=InvoiceResponse)
def unmark_invoice_paid(
    invoice_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    Reverse a paid status (one-tap undo).

    Auto-matches reversible only within 7 days.
    Manual marks always reversible.
    Service-layer enforces both rules.
    """
    ip = getattr(request.client, "host", None)
    inv = InvoiceService.unmark_paid(db, user, invoice_id, ip_address=ip)
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
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    Void a sent invoice by generating a kreditnota.

    Returns the NEW kreditnota (not the original). The original is
    updated server-side to status='credited' with credited_by_id
    pointing at the new record.
    """
    ip = getattr(request.client, "host", None)
    kreditnota = InvoiceService.void_and_credit(
        db, user, invoice_id, payload.reason, ip_address=ip,
    )
    db.commit()
    db.refresh(kreditnota)
    return InvoiceService.to_response_dict(kreditnota)
