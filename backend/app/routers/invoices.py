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
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.business_profile import BusinessProfile
from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.user import User
from app.routers.auth import get_current_user
from app.routers.customers import _require_invoicing_plan
from app.schemas.invoicing import (
    InvoiceCreate, InvoiceResponse, InvoiceMarkPaid, InvoiceVoid,
)
from app.services.email_service import send_email_with_attachment
from app.services.invoice_service import InvoiceService
from app.services.invoice_pdf import render_invoice_pdf
from fastapi.responses import Response

router = APIRouter()


# ─── Endpoints ───────────────────────────────────────────────────────

def _enforce_monthly_invoice_cap(db: Session, user: User, issue_date):
    """Tier-aware monthly faktura cap. Starter = 30/month. Pro = unlimited.
    Free is already blocked by `_require_invoicing_plan`.

    Counts invoices issued in the SAME calendar month as the new one
    (so a Starter user creating a draft dated 2026-05-02 is measured
    against May's count, not "the last 30 days"). is_voided rows are
    excluded — voids shouldn't count toward the quota.
    """
    from datetime import date as _date
    from app.services.billing import get_cap, effective_plan

    cap = get_cap(user, "invoices_per_month")
    if cap is None or cap < 0:
        return  # unlimited (Pro / Trial)

    # Issue date can be None (defaults to today server-side later); use
    # today as the reference month if so.
    target = issue_date or _date.today()
    month_start = target.replace(day=1)
    if target.month == 12:
        next_month_start = target.replace(year=target.year + 1, month=1, day=1)
    else:
        next_month_start = target.replace(month=target.month + 1, day=1)

    issued_this_month = (
        db.query(Invoice)
        .filter(
            Invoice.user_id == user.id,
            Invoice.issue_date >= month_start,
            Invoice.issue_date < next_month_start,
            # Voided invoices don't count — the owner had to retract them
            Invoice.status != "voided",
        )
        .count()
    )

    if issued_this_month >= cap:
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "feature": "unlimited_invoices",
                "required_plan": "pro",
                "current_plan": effective_plan(user),
                "used_this_month": issued_this_month,
                "monthly_cap": cap,
                "message": (
                    f"You've issued {issued_this_month} of your {cap} "
                    f"monthly fakturaer on Starter. Upgrade to Pro for "
                    f"unlimited invoicing."
                ),
            },
        )


@router.post("", response_model=InvoiceResponse, status_code=status.HTTP_201_CREATED)
def create_invoice(
    data: InvoiceCreate,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    Create a draft invoice. Allocates the next fakturanummer for the
    user × branch × year immediately so the owner sees a stable ID.

    Tier-aware: Starter is capped at 30 invoices/month (per
    PLAN_CAPS.invoices_per_month). Pro is unlimited. Free is already
    blocked by `_require_invoicing_plan`. The 402 from the cap returns
    structured detail the frontend uses to render the UpgradeNudge.
    """
    _enforce_monthly_invoice_cap(db, user, data.issue_date)
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


@router.get("/usage")
def get_invoice_usage(
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Current-month invoice counter for the UI.

    Returns the same data the UpgradeNudge needs to show e.g.
    "12 of 30 this month" on the Faktura page, plus the structured
    plan + cap fields so the page can choose the right tone.

    Used by FakturaPage to render the inline progress chip + the
    "Upgrade to Pro for unlimited" nudge near the 30-cap edge.
    """
    from datetime import date as _date
    from app.services.billing import get_cap, effective_plan

    today = _date.today()
    month_start = today.replace(day=1)
    if today.month == 12:
        next_month_start = today.replace(year=today.year + 1, month=1, day=1)
    else:
        next_month_start = today.replace(month=today.month + 1, day=1)

    used = (
        db.query(Invoice)
        .filter(
            Invoice.user_id == user.id,
            Invoice.issue_date >= month_start,
            Invoice.issue_date < next_month_start,
            Invoice.status != "voided",
        )
        .count()
    )
    cap = get_cap(user, "invoices_per_month")
    unlimited = cap is None or cap < 0
    return {
        "used_this_month": used,
        "monthly_cap": (None if unlimited else cap),
        "unlimited": unlimited,
        "plan": effective_plan(user),
        "month": today.strftime("%Y-%m"),
    }


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

    Status transition only — locks the record + records sent_at. Use
    /send-email below to actually deliver the PDF to the customer
    (or stick with the mailto: fallback on the frontend).
    """
    ip = getattr(request.client, "host", None)
    inv = InvoiceService.mark_sent(db, user, invoice_id, ip_address=ip)
    db.commit()
    db.refresh(inv)
    return InvoiceService.to_response_dict(inv)


class InvoiceSendEmailRequest(BaseModel):
    """Body for the direct-email send. All fields optional — sane
    defaults pulled from the invoice + customer + user profile."""
    # Override recipient — defaults to invoice.customer.email
    to: EmailStr | None = None
    # Free-text message prepended to the standard body. Capped so a
    # malicious user can't ship spam volumes through our Resend domain.
    message: str | None = Field(default=None, max_length=2000)
    # cc the user's own email so they have a copy
    cc_self: bool = True


@router.post("/{invoice_id}/send-email")
def send_invoice_email(
    invoice_id: UUID,
    body: InvoiceSendEmailRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Email the faktura PDF directly to the customer via Resend.

    Unlike /send (state transition), this can run on any non-draft
    invoice — typical use case is resending an already-sent invoice
    as a payment reminder. It does NOT mark anything as sent; pair
    it with /send when transitioning from draft.

    Recipient resolution: body.to → invoice.customer.email → 400 with
    `code: no_recipient` so the frontend can fall back to mailto.

    Reply-to is the user's own email so the customer hits Reply and
    reaches the business owner directly (not noreply@bonbox.dk).

    Audited via the existing audit_service (`invoice.email_sent`).
    """
    inv = (
        db.query(Invoice)
        .filter(Invoice.id == invoice_id, Invoice.user_id == user.id)
        .first()
    )
    if inv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Invoice not found")

    customer = (
        db.query(Customer)
        .filter(Customer.id == inv.customer_id, Customer.user_id == user.id)
        .first()
    )
    if customer is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found")

    # Recipient resolution: body override → customer.email → 400
    recipient = (
        (body.to or "").strip().lower()
        if body.to else ""
    ) or ((customer.email or "").strip().lower())
    if not recipient:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "no_recipient",
                "message": "Customer has no email. Add one in Customers, or pass `to` in the request.",
            },
        )

    # Render the PDF (uses the existing pipeline — byte-identical to
    # what /pdf returns, so the customer sees exactly what the owner
    # would see when they download).
    pdf_bytes = render_invoice_pdf(db, inv)
    fakturanr = f"{inv.issue_date.year}-{inv.fakturanummer:04d}"
    is_credit = bool(getattr(inv, "is_credit_note", False))
    doc_word = "kreditnota" if is_credit else "faktura"
    filename = f"{doc_word}-{fakturanr}.pdf"

    # Language: invoice.customer_lang → fallback to "da" for DKK / "en" else
    lang = (getattr(inv, "customer_lang", None) or "").lower().strip()
    if lang not in ("da", "en"):
        lang = "da" if (inv.currency or "DKK") == "DKK" else "en"
    is_danish = (lang == "da")

    # Business name on the FROM display + email body
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    biz_name = (
        getattr(profile, "company_name", None)
        or getattr(user, "business_name", None)
        or "BonBox"
    )

    # Subject + body (HTML, never trust user input — escape the
    # personal message)
    if is_danish:
        if is_credit:
            subject = f"Kreditnota {fakturanr} fra {biz_name}"
            greeting = f"Hej {customer.name or ''},".strip(", ")
            intro = f"Vedhæftet finder du kreditnota {fakturanr}."
            amount_label = "Beløb (kredit)"
        else:
            subject = f"Faktura {fakturanr} fra {biz_name}"
            greeting = f"Hej {customer.name or ''},".strip(", ")
            intro = f"Vedhæftet finder du faktura {fakturanr}."
            amount_label = "Beløb"
        due_label = "Forfald"
        footer = (
            f"Sendt direkte fra BonBox på vegne af {biz_name}. "
            "Svar på denne mail for at kontakte os."
        )
    else:
        if is_credit:
            subject = f"Credit note {fakturanr} from {biz_name}"
            greeting = f"Hi {customer.name or ''},".strip(", ")
            intro = f"Attached is credit note {fakturanr}."
            amount_label = "Amount (credit)"
        else:
            subject = f"Invoice {fakturanr} from {biz_name}"
            greeting = f"Hi {customer.name or ''},".strip(", ")
            intro = f"Attached is invoice {fakturanr}."
            amount_label = "Amount"
        due_label = "Due"
        footer = (
            f"Sent directly from BonBox on behalf of {biz_name}. "
            "Reply to this email to reach us."
        )

    # Format amount in customer locale
    try:
        amt = float(inv.total_gross or 0)
        if is_danish:
            amt_str = f"{amt:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        else:
            amt_str = f"{amt:,.2f}"
    except Exception:
        amt_str = "—"
    amt_str = f"{amt_str} {inv.currency or 'DKK'}"

    due_str = inv.due_date.isoformat() if inv.due_date else "—"

    # User message (escaped) — only rendered if present
    user_note_html = ""
    if (body.message or "").strip():
        from html import escape
        safe = escape(body.message.strip()).replace("\n", "<br>")
        user_note_html = (
            "<div style='margin:16px 0;padding:12px;background:#f9fafb;"
            "border-left:3px solid #10b981;color:#374151;font-size:14px;"
            "line-height:1.5;'>"
            f"{safe}"
            "</div>"
        )

    html = (
        "<div style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#111827;line-height:1.5;font-size:14px;max-width:560px;'>"
        f"<p>{greeting}</p>"
        f"<p>{intro}</p>"
        f"{user_note_html}"
        "<table style='border-collapse:collapse;margin:16px 0;'>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{amount_label}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>{amt_str}</td></tr>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{due_label}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>{due_str}</td></tr>"
        "</table>"
        f"<p style='color:#6b7280;font-size:13px;margin-top:16px;'>{footer}</p>"
        "</div>"
    )

    cc = [user.email] if (body.cc_self and user.email) else None
    ok, err = send_email_with_attachment(
        recipient, subject, html,
        attachment_bytes=pdf_bytes,
        attachment_filename=filename,
        attachment_mime="application/pdf",
        reply_to=user.email,
        cc=cc,
    )

    if not ok:
        # 503 so the frontend can fall back to mailto
        raise HTTPException(
            status_code=503,
            detail={
                "code": "email_send_failed",
                "reason": err or "unknown",
                "message": "Couldn't send email right now. You can still download the PDF and email it manually.",
            },
        )

    # Audit — every email send is a record for SKAT defensibility
    try:
        from app.services import audit_service
        audit_service.record(
            db, user, "invoice.email_sent",
            entity_type="invoice", entity_id=inv.id,
            before=None,
            after={
                "to": recipient,
                "cc_self": bool(cc),
                "filename": filename,
                "subject": subject,
            },
            ip_address=getattr(request.client, "host", None),
        )
        db.commit()
    except Exception:  # noqa: BLE001
        # Never fail the request because of audit-log issues
        try:
            db.rollback()
        except Exception:
            pass

    return {
        "ok": True,
        "sent_to": recipient,
        "cc_self": bool(cc),
        "filename": filename,
        "subject": subject,
        "invoice_id": str(inv.id),
        "fakturanummer": fakturanr,
    }


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
