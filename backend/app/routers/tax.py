"""Tax Autopilot — deadlines, estimates, and reminders.

Multi-layer defense: tax overview is a heavy aggregation — same risk pattern
as retention/branches. Wrap so a single bad row doesn't 503 the whole tab.
"""

import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, EmailStr, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.business_profile import BusinessProfile
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import effective_plan, has_feature
from app.services.tax_filing_pdf import (
    build_moms_filing_pdf,
    compute_filing_data,
    make_bilagsnummer,
    resolve_default_period,
)
from app.services.tax_service import get_tax_overview

router = APIRouter()
log = logging.getLogger("bonbox.tax")

# Per-IP rate limiter — protects PDF generation + email send.
# Same pattern as daily_close.py.
_limiter = Limiter(key_func=client_ip)

# Defense-in-depth: cap the requested period length so a malicious
# caller can't ask for a 50-year range and DOS us with table scans.
# 366 days = 1 calendar year + buffer. Real filings are quarterly or
# half-yearly — anyone needing more should call multiple times.
_MAX_FILING_PERIOD_DAYS = 366


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
        # New fields added by the DailyClose integration (commit a26d37c
        # + variance follow-up). Must be present even on the fail-soft
        # path so frontend destructure {pos_revenue_from_closes,
        # taxable_sales, variance_warnings, ...} doesn't blow up.
        # Layer 4 — fail-soft must ship valid shape.
        "taxable_sales": 0,
        "pos_revenue": 0,
        "pos_revenue_from_closes": 0,
        "pos_revenue_from_sales": 0,
        "pos_output_vat_from_closes": 0,
        "pos_output_vat_from_sales": 0,
        "invoice_revenue": 0,
        "expenses_total": 0,
        "exempt_sales": 0,
        "output_vat": 0,
        "input_vat": 0,
        "vat_payable": 0,
        "variance_warnings": [],
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


# ─── MOMS-angivelse filing-ready PDF ──────────────────────────────────
#
# Task #51 — the artifact that CLOSES THE LOOP on Tax Autopilot.
#
# Before this, owners saw the MOMS countdown + estimated amount on the
# Tax Autopilot page but still had to log into SKAT.dk and manually
# re-enter numbers. The filing PDF is pre-filled in the SKAT MOMS-
# angivelse layout: owner downloads, signs, uploads (or forwards to
# revisor). Saves 30+ minutes per filing.
#
# Tier gate: Pro+ only (tax_filing_pdf feature). Free + Starter see
# the upsell card with the same numbers but a locked download button.
#
# Layered defense (matches the daily-close send-to-accountant gate):
#   L1 auth (get_current_user)
#   L2 input bounds (period_start/end parsed by FastAPI; max 366 days)
#   L3 rate limit (10/min for downloads; 5/min for sends)
#   L4 tenant scope (user.id is the only filter on data queries)
#   L5 plan-feature gate (has_feature tax_filing_pdf)
#   L6 audit log (audit_service.record on success)


class SendFilingToAccountantRequest(BaseModel):
    """Email-the-filing-PDF body. Same shape as the daily-close
    send-to-accountant body so the frontend can reuse patterns.
    """
    accountant_email: EmailStr | None = None
    message: str | None = Field(default=None, max_length=2000)
    cc_self: bool = True


def _resolve_filing_period(
    period_start: date | None, period_end: date | None, user: User,
) -> tuple[date, date]:
    """Resolve the filing period: user-supplied dates or default from
    the user's filing frequency.

    Defensive bounds:
      • Both endpoints required if either is supplied (avoid half-spec).
      • End must be >= start.
      • Span <= 366 days (defense in depth — quarterly = 92 days, half-
        yearly = 184, annual = 366).
    """
    if period_start and period_end:
        if period_end < period_start:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "invalid_period",
                    "message": "period_end must be on or after period_start",
                },
            )
        span_days = (period_end - period_start).days
        if span_days > _MAX_FILING_PERIOD_DAYS:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "period_too_long",
                    "message": (
                        f"Filing period is limited to {_MAX_FILING_PERIOD_DAYS} days. "
                        "Generate multiple shorter filings instead."
                    ),
                    "max_days": _MAX_FILING_PERIOD_DAYS,
                    "got_days": span_days,
                },
            )
        return period_start, period_end
    if period_start or period_end:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "incomplete_period",
                "message": "Provide both period_start and period_end, or neither.",
            },
        )
    # Neither supplied — use the user's default filing-frequency period.
    return resolve_default_period(user)


def _enforce_tax_filing_pdf(user: User) -> None:
    """Pro+ gate for tax_filing_pdf. Raises 402 with the structured
    upgrade detail the frontend renders into the UpgradeNudge."""
    if not has_feature(user, "tax_filing_pdf"):
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "feature": "tax_filing_pdf",
                "required_plan": "pro",
                "current_plan": effective_plan(user),
                "message": (
                    "Filing-ready PDF is on Pro. You can still see the "
                    "MOMS estimate on this page and file manually on SKAT.dk."
                ),
            },
        )


@router.get("/filing-pdf")
@_limiter.limit("10/minute")
def tax_filing_pdf(
    request: Request,
    period_start: date | None = Query(None, description="Inclusive ISO date"),
    period_end: date | None = Query(None, description="Inclusive ISO date"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Download the MOMS-angivelse filing-ready PDF (Pro+).

    Returns a pre-filled SKAT MOMS-angivelse PDF for the requested
    period. If no period is supplied, defaults to the user's current
    filing-frequency period (e.g. current half-year for DK SMBs).
    """
    _enforce_tax_filing_pdf(user)
    p_start, p_end = _resolve_filing_period(period_start, period_end, user)

    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()

    business_name = (
        (getattr(profile, "company_name", None) if profile else None)
        or getattr(user, "business_name", None)
        or "MOMS-angivelse"
    )

    try:
        pdf_bytes = build_moms_filing_pdf(
            db, user, p_start, p_end,
            profile=profile, business_name=business_name,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("tax_filing_pdf build failed for user=%s: %s", user.id, e)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "pdf_generation_failed",
                "message": "Could not generate the filing PDF. Please try again.",
            },
        )

    bilagsnummer = make_bilagsnummer(p_start, p_end)
    filename = f"{bilagsnummer}.pdf"

    # Audit log — Bogføringsloven §10: track every PDF generation so
    # we have a delivery trail. Compute the totals from the same data
    # the PDF rendered so the audit row matches what the owner saw.
    try:
        data = compute_filing_data(db, user, p_start, p_end)
        audit_service.record(
            db, user=user,
            action="tax.filing_pdf_generated",
            entity_type="tax_filing",
            entity_id=None,
            before=None,
            after={
                "bilagsnummer": bilagsnummer,
                "period_start": p_start.isoformat(),
                "period_end": p_end.isoformat(),
                "currency": data["currency"],
                "moms_af_salg": data["moms_af_salg"],
                "moms_af_kob": data["moms_af_kob"],
                "moms_til_skat": data["moms_til_skat"],
                "sales_count": data["sales_count"],
                "expense_count": data["expense_count"],
                "pdf_size_bytes": len(pdf_bytes),
            },
            ip_address=getattr(request.client, "host", None) if request.client else None,
        )
        db.commit()
    except Exception as e:  # noqa: BLE001
        # Audit failure must NEVER block the PDF download. Log and proceed.
        log.warning("tax.filing_pdf_generated audit log failed: %s", e)

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(pdf_bytes)),
        },
    )


@router.post("/filing-pdf/send-to-accountant")
@_limiter.limit("5/minute")
def tax_filing_send_to_accountant(
    request: Request,
    body: SendFilingToAccountantRequest,
    period_start: date | None = Query(None, description="Inclusive ISO date"),
    period_end: date | None = Query(None, description="Inclusive ISO date"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Email the MOMS-angivelse filing PDF to the user's accountant (Pro+).

    Same pattern as daily_close.send_to_accountant — ships the PDF via
    Resend with reply_to = user.email so the revisor can hit Reply and
    reach the owner directly. cc_self lets the owner keep a copy.

    Pro+ tier gate. Free + Starter get the structured 402 that the
    frontend uses to render UpgradeNudge.
    """
    _enforce_tax_filing_pdf(user)
    p_start, p_end = _resolve_filing_period(period_start, period_end, user)

    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()

    # Pick recipient: body override → profile.accountant_email → 400.
    recipient = (
        (body.accountant_email or "").strip().lower()
        if body.accountant_email else ""
    ) or (
        (getattr(profile, "accountant_email", None) or "").strip().lower()
    )
    if not recipient:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "no_accountant_email",
                "message": (
                    "Set your accountant's email on Profile, or include "
                    "accountant_email in the request body."
                ),
            },
        )

    business_name = (
        (getattr(profile, "company_name", None) if profile else None)
        or getattr(user, "business_name", None)
        or "MOMS-angivelse"
    )
    currency = user.currency or "DKK"
    is_danish = (currency or "").upper() == "DKK"

    # Build the PDF and compute totals for the email body.
    try:
        pdf_bytes = build_moms_filing_pdf(
            db, user, p_start, p_end,
            profile=profile, business_name=business_name,
        )
        data = compute_filing_data(db, user, p_start, p_end)
    except Exception as e:  # noqa: BLE001
        log.exception("tax_filing send-to-accountant build failed: %s", e)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "pdf_generation_failed",
                "message": "Could not generate the filing PDF. Please try again.",
            },
        )

    bilagsnummer = make_bilagsnummer(p_start, p_end)
    filename = f"{bilagsnummer}.pdf"

    # Subject + body
    if is_danish:
        subject = f"MOMS-angivelse {p_start.isoformat()} → {p_end.isoformat()} — {business_name}"
    else:
        subject = f"VAT return {p_start.isoformat()} → {p_end.isoformat()} — {business_name}"

    html = _build_filing_email_body(
        business_name=business_name,
        from_iso=p_start.isoformat(),
        to_iso=p_end.isoformat(),
        currency=currency,
        moms_til_skat=data["moms_til_skat"],
        output_vat=data["moms_af_salg"],
        input_vat=data["moms_af_kob"],
        message=body.message,
        is_danish=is_danish,
    )

    from app.services.email_service import send_email_with_attachment

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
        # 503 so the frontend can fall back to a download + mailto flow.
        raise HTTPException(
            status_code=503,
            detail={
                "code": "email_send_failed",
                "reason": err or "unknown",
                "message": (
                    "Couldn't send email right now. The file is still "
                    "available to download."
                ),
            },
        )

    # Audit log — Bogføringsloven §10 third-party delivery trail.
    try:
        audit_service.record(
            db, user=user,
            action="tax.filing_sent_to_accountant",
            entity_type="tax_filing",
            entity_id=None,
            before=None,
            after={
                "recipient": recipient,
                "cc_self": bool(cc),
                "bilagsnummer": bilagsnummer,
                "period_start": p_start.isoformat(),
                "period_end": p_end.isoformat(),
                "filename": filename,
                "currency": currency,
                "moms_til_skat": data["moms_til_skat"],
                "moms_af_salg": data["moms_af_salg"],
                "moms_af_kob": data["moms_af_kob"],
            },
            ip_address=getattr(request.client, "host", None) if request.client else None,
        )
        db.commit()
    except Exception as e:  # noqa: BLE001
        log.warning("tax.filing_sent_to_accountant audit log failed: %s", e)

    return {
        "ok": True,
        "sent_to": recipient,
        "cc_self": bool(cc),
        "filename": filename,
        "bilagsnummer": bilagsnummer,
        "subject": subject,
        "period_start": p_start.isoformat(),
        "period_end": p_end.isoformat(),
    }


def _build_filing_email_body(*, business_name: str, from_iso: str,
                              to_iso: str, currency: str,
                              moms_til_skat: float,
                              output_vat: float, input_vat: float,
                              message: str | None, is_danish: bool) -> str:
    """Render the HTML body for the filing-PDF accountant email.

    Mirrors `_accountant_email_body` in daily_close.py — same look,
    same Danish-for-DKK convention. Includes the three numbers that
    matter most so the revisor can sanity-check the attachment before
    opening it.
    """
    def _fmt(v):
        if is_danish:
            return (
                f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
            )
        return f"{v:,.2f}"

    if is_danish:
        greeting = "Hej,"
        intro = (
            f"Vedhæftet finder du MOMS-angivelsen for "
            f"<strong>{business_name}</strong> for perioden "
            f"<strong>{from_iso} → {to_iso}</strong>."
        )
        label_owed = "Moms til SKAT"
        label_output = "Salgsmoms (udgående)"
        label_input = "Købsmoms (indgående)"
        footer = (
            "Filen er sendt direkte fra BonBox. "
            "Svar på denne mail for at kontakte ejeren."
        )
    else:
        greeting = "Hello,"
        intro = (
            f"Attached is the VAT return for <strong>{business_name}</strong> "
            f"for the period <strong>{from_iso} → {to_iso}</strong>."
        )
        label_owed = "Net VAT to tax authority"
        label_output = "Output VAT"
        label_input = "Input VAT"
        footer = (
            "Sent directly from BonBox. "
            "Reply to this email to reach the owner."
        )

    user_note_html = ""
    if (message or "").strip():
        from html import escape
        safe = escape(message.strip()).replace("\n", "<br>")
        user_note_html = (
            "<div style='margin:16px 0;padding:12px;background:#f9fafb;"
            "border-left:3px solid #10b981;color:#374151;font-size:14px;"
            "line-height:1.5;'>"
            f"{safe}"
            "</div>"
        )

    return (
        "<div style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#111827;line-height:1.5;font-size:14px;max-width:560px;'>"
        f"<p>{greeting}</p>"
        f"<p>{intro}</p>"
        f"{user_note_html}"
        "<table style='border-collapse:collapse;margin:16px 0;'>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{label_output}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>"
        f"{_fmt(output_vat)} {currency}</td></tr>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{label_input}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>"
        f"{_fmt(input_vat)} {currency}</td></tr>"
        f"<tr><td style='padding:8px 16px 4px 0;color:#111827;font-weight:600;"
        "border-top:1px solid #e5e7eb;'>"
        f"{label_owed}</td>"
        f"<td style='padding:8px 0 4px 0;font-weight:700;text-align:right;"
        "border-top:1px solid #e5e7eb;'>"
        f"{_fmt(moms_til_skat)} {currency}</td></tr>"
        "</table>"
        f"<p style='color:#6b7280;font-size:13px;'>{footer}</p>"
        "</div>"
    )
