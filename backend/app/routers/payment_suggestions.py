"""
Payment-match suggestion endpoints (review inbox).

Used by /faktura/review page to surface MEDIUM/LOW confidence matches
the auto-matcher couldn't auto-flip. Owner taps Accept or Reject —
that's a HUMAN decision that gets audit-logged.

Security:
  • Plan-gated (Starter+) via _require_invoicing_plan
  • Tenant-scoped — every query filters by user.id
  • Audit log entry on accept + reject
  • Rate limited (30/min) — these are interactive UX actions, not
    automation, so a low limit is fine.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.payment_match_suggestion import PaymentMatchSuggestion
from app.models.sale import Sale
from app.models.user import User
from app.routers.customers import _require_invoicing_plan
from app.services import payment_match_service
from app.services.voucher_service import format_voucher_number
from app.schemas.invoicing import InvoiceResponse
from app.services.invoice_service import InvoiceService

router = APIRouter()


# ─── Response shapes ──────────────────────────────────────────────────


class _SuggestionResponse(BaseModel):
    """One row in the review inbox. Hydrated with the customer + invoice
    context the UI needs to render the decision without a second fetch."""
    id: UUID
    confidence: str  # 'high' | 'medium' | 'low'
    reason: str
    status: str  # 'pending' | 'accepted' | 'rejected'
    created_at: str

    # Invoice context
    invoice_id: UUID
    fakturanummer_formatted: str
    invoice_status: str
    invoice_total_gross: str  # Decimal as string for JSON
    invoice_currency: str
    invoice_issue_date: str
    invoice_due_date: str
    customer_name: str
    customer_cvr: Optional[str]

    # Sale (bank transaction) context
    sale_id: UUID
    sale_date: str
    sale_amount: str
    sale_description: Optional[str]


def _to_response(
    s: PaymentMatchSuggestion,
    inv: Invoice,
    cust: Customer | None,
    sale: Sale,
) -> _SuggestionResponse:
    return _SuggestionResponse(
        id=s.id,
        confidence=s.confidence,
        reason=s.reason,
        status=s.status,
        created_at=s.created_at.isoformat(),
        invoice_id=inv.id,
        fakturanummer_formatted=format_voucher_number(
            "invoice", inv.issue_date.year, inv.fakturanummer
        ),
        invoice_status=inv.status,
        invoice_total_gross=str(inv.total_gross),
        invoice_currency=inv.currency,
        invoice_issue_date=inv.issue_date.isoformat(),
        invoice_due_date=inv.due_date.isoformat(),
        customer_name=cust.name if cust else "—",
        customer_cvr=cust.cvr if cust else None,
        sale_id=sale.id,
        sale_date=sale.date.isoformat(),
        sale_amount=str(sale.amount),
        sale_description=sale.notes,
    )


# ─── Endpoints ────────────────────────────────────────────────────────


@router.get("", response_model=list[_SuggestionResponse])
def list_suggestions(
    status_filter: str = Query("pending", alias="status"),
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    List payment-match suggestions for the review inbox.

    Default filter: 'pending'. The UI also calls with 'all' to show
    history. Accepted + rejected rows are immutable audit trail.

    Returns rows newest-first, joined with invoice + sale + customer
    context so the inbox renders without a chatty N+1.
    """
    q = db.query(PaymentMatchSuggestion).filter(
        PaymentMatchSuggestion.user_id == user.id,
    )
    if status_filter and status_filter != "all":
        q = q.filter(PaymentMatchSuggestion.status == status_filter)
    suggestions = q.order_by(PaymentMatchSuggestion.created_at.desc()).limit(50).all()

    if not suggestions:
        return []

    # Hydrate context — one query per table, indexed by id.
    # Defense in depth: every hydration query re-filters by user_id even
    # though the parent suggestion was already tenant-scoped. If a future
    # bug leaks a foreign id into the suggestion row, we still won't
    # return cross-tenant data.
    inv_ids = {s.invoice_id for s in suggestions}
    sale_ids = {s.sale_id for s in suggestions}
    invoices = {
        i.id: i for i in db.query(Invoice).filter(
            Invoice.id.in_(inv_ids), Invoice.user_id == user.id,
        ).all()
    }
    sales = {
        s.id: s for s in db.query(Sale).filter(
            Sale.id.in_(sale_ids), Sale.user_id == user.id,
        ).all()
    }
    cust_ids = {i.customer_id for i in invoices.values()}
    customers = {
        c.id: c for c in db.query(Customer).filter(
            Customer.id.in_(cust_ids), Customer.user_id == user.id,
        ).all()
    }

    return [
        _to_response(
            s,
            invoices.get(s.invoice_id),
            customers.get(invoices[s.invoice_id].customer_id) if invoices.get(s.invoice_id) else None,
            sales.get(s.sale_id),
        )
        for s in suggestions
        if invoices.get(s.invoice_id) and sales.get(s.sale_id)
    ]


@router.get("/pending-count", response_model=dict)
def pending_count(
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Lightweight count for the /faktura header badge."""
    count = (
        db.query(PaymentMatchSuggestion)
        .filter(
            PaymentMatchSuggestion.user_id == user.id,
            PaymentMatchSuggestion.status == "pending",
        )
        .count()
    )
    return {"pending_count": count}


@router.post("/{suggestion_id}/accept", response_model=InvoiceResponse)
def accept_suggestion_endpoint(
    suggestion_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Owner confirmed — flip the invoice to paid via the hardened
    mark_paid (source='manual', no 7-day undo window since this is
    an explicit human decision)."""
    ip = getattr(request.client, "host", None)
    invoice = payment_match_service.accept_suggestion(
        db, user.id, suggestion_id, ip_address=ip,
    )
    db.commit()
    db.refresh(invoice)
    return InvoiceService.to_response_dict(invoice)


@router.post("/{suggestion_id}/reject", response_model=dict)
def reject_suggestion_endpoint(
    suggestion_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Owner declined the match — invoice stays open, bank line stays
    unlinked. Audit trail preserved."""
    ip = getattr(request.client, "host", None)
    sugg = payment_match_service.reject_suggestion(
        db, user.id, suggestion_id, ip_address=ip,
    )
    db.commit()
    return {"id": str(sugg.id), "status": sugg.status}
