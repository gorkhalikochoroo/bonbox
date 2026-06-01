"""
Daily Close (Kasserapport) — structured end-of-day closing for restaurants.

Endpoints:
  POST   /api/daily-close              — submit daily close
  GET    /api/daily-close               — list closes (date range)
  GET    /api/daily-close/insights      — aggregated insights
  GET    /api/daily-close/prefill       — prefill from sales/expenses/cash
  POST   /api/daily-close/scan-report   — scan Z-report image via OCR
  GET    /api/daily-close/{id}          — single close
  GET    /api/daily-close/{id}/pdf      — kasserapport PDF
  DELETE /api/daily-close/{id}          — soft delete
"""

import logging
import uuid
from datetime import date, datetime, timedelta
from collections import defaultdict
from io import BytesIO
from typing import Any

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, UploadFile
from pydantic import BaseModel, EmailStr, Field
from fastapi.responses import Response, StreamingResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.daily_close import DailyClose, encode_breakdown, decode_breakdown
from app.models.branch import Branch
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.cashbook import CashTransaction
from app.models.business_profile import BusinessProfile
from app.models.terminal import Terminal
from app.models.kasserapport import KasserapportExtraction
from app.schemas.daily_close import DailyCloseCreate, DailyCloseResponse, DailyCloseUnlock
from app.services.auth import get_current_user
from app.services.billing import effective_plan, get_cap, has_feature, record_feature_skip
from app.services.receipt_ocr import save_receipt_photo, parse_z_report
from app.services.daily_close_range_export import (
    build_daily_close_range_pdf,
    closes_to_csv_bytes,
    build_daily_close_range_xlsx,
)
from app.services import audit_service
from app.services.tz_utils import business_today_local
from app.utils.time import utc_now
from app.utils.document_hash import compute_document_hash, short_hash

router = APIRouter()

# Per-IP rate limiter — protects state-changing daily-close endpoints.
# Same shape as inventory/pour, modules, smart-import: a per-router
# Limiter so each router controls its own thresholds. Mirrors the
# 6-layer pattern (auth, bounds, rate limit, tenant scope, plan/quota,
# audit) used everywhere else.
_limiter = Limiter(key_func=get_remote_address)

# Per-tier daily Z-report scan caps live in PLAN_CAPS
# ("z_report_scans_per_day") — see services/billing.py for the source
# of truth. Local dict removed (May 2026 consolidation) so cap changes
# happen in one place.


def _invalidate_daily_brief_cache(db: Session, user: User) -> None:
    """Drop today's cached DailyBrief so the next /daily-brief call regenerates.

    Without this, the AI brief insight "Latest close (2026-05-04) is 76% below
    POS sales…" stays stale all day even after the owner confirms a new close
    at 05:37 — the brief row was generated before the close landed and the
    cache key (user_id, brief_date=today) keeps serving the old payload.

    The cache key in services/daily_brief.py:1357 uses ``date.today()`` (UTC),
    so we MUST match that here. Using ``business_today_local`` would create a
    timezone mismatch where the brief was stored under one date and we try
    to delete a different date — see CLAUDE.md TZ-cutoff doctrine.

    L8 — graceful degradation: never raise into the close-confirm flow. If
    DailyBrief invalidation fails for any reason (corrupt row, db hiccup),
    we log a warning and let the caller keep going. The brief will refresh
    on its own at the next 8 a.m. cron tick at worst.
    """
    try:
        from app.models.daily_brief import DailyBrief
        today_utc = date.today()
        db.query(DailyBrief).filter(
            DailyBrief.user_id == user.id,
            DailyBrief.brief_date == today_utc,
        ).delete(synchronize_session=False)
        # No explicit commit — the caller's transaction (close confirm)
        # encloses this; the brief drop rides along with the close write.
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "daily_close.confirm: failed to invalidate DailyBrief for user=%s: %s",
            user.id, e,
        )


def _today_scan_count(db: Session, user: User) -> int:
    """How many Z-report scans this user already triggered today.
    Counted via DailyClose rows with receipt_photo set on today's
    business date — the scan-report endpoint doesn't have its own
    audit table, but a successful scan that produces a close lands here.

    Uses `business_today_local(user)` (not `date.today()`) so a 02:00
    CEST scan still belongs to the shift's business date — same TZ
    drift class as the Report Coherence audit (#148) CRITs already
    landed. Without this, an owner closing past midnight could trip
    the next-day quota an hour after starting their close ritual.
    """
    today = business_today_local(user)
    return (
        db.query(func.count(DailyClose.id))
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date == today,
            DailyClose.receipt_photo.isnot(None),
        )
        .scalar()
    ) or 0


# ─── Helpers ───

def _to_response(dc: DailyClose) -> dict:
    """Convert DailyClose ORM to response dict with decoded breakdowns."""
    return {
        "id": dc.id,
        "date": dc.date,
        "branch_id": dc.branch_id,
        "revenue_breakdown": decode_breakdown(dc.revenue_categories),
        "revenue_total": float(dc.revenue_total or 0),
        "payment_breakdown": decode_breakdown(dc.payment_categories),
        "payment_total": float(dc.payment_total or 0),
        "moms_total": float(dc.moms_total) if dc.moms_total is not None else None,
        "revenue_ex_moms": float(dc.revenue_ex_moms) if dc.revenue_ex_moms is not None else None,
        "moms_mode": dc.moms_mode,
        "cash_expected": float(dc.cash_expected) if dc.cash_expected is not None else None,
        "cash_counted": float(dc.cash_counted) if dc.cash_counted is not None else None,
        "cash_difference": float(dc.cash_difference) if dc.cash_difference is not None else None,
        "tips_total": float(dc.tips_total) if dc.tips_total is not None else None,
        "tips_staff_count": dc.tips_staff_count,
        "tips_per_person": float(dc.tips_per_person) if dc.tips_per_person is not None else None,
        "status": getattr(dc, "status", None) or "confirmed",
        "notes": dc.notes,
        "closed_by": dc.closed_by,
        "closed_at": dc.closed_at,
        "unlock_reason": getattr(dc, "unlock_reason", None),
        "unlocked_by": getattr(dc, "unlocked_by", None),
        "unlocked_at": getattr(dc, "unlocked_at", None),
        "is_deleted": dc.is_deleted,
        "created_at": dc.created_at,
        "receipt_photo": getattr(dc, "receipt_photo", None),
    }


# ─── Lane A — close-ritual auto-email helpers (Manoj-confirmed) ───
#
# When the FoH staff taps "Confirm & Lock" on the daily close, we
# auto-fire one email to owner + accountant with the kasserapport PDF
# + scanned Z-report photo (Starter+ feature). The lock-time email
# replaces the old "remember to tap Send to accountant after locking"
# step — one tap, both audiences notified, no forgetting.
#
# Multi-barrier:
#   L3 (router) — `_fire_close_auto_email` is only called for
#                 status="confirmed" and after `has_feature` + the
#                 user's `auto_email_on_close` preference pass.
#   L4 (service) — `send_close_notification` re-checks `has_feature`
#                  inside email_service so a future refactor that
#                  drops the L3 gate still can't leak the feature.
#   L6 (fail-closed) — missing recipients → falls back to user.email,
#                      partial send is acceptable, never raises.
#   L7 (audit) — every attempt writes an audit_logs row + a
#                SecurityEvent on failure for operator monitoring.
#   L8 (degrade) — scan-image fetch failure → email sends with PDF
#                  only and a "scan unavailable" note; Resend hiccup →
#                  status="queued_retry" so the operator can re-trigger.
#   L9 (UI) — return shape tells the frontend exactly what happened:
#             email_status, recipients, has_scan, bank_drop block.


def _serialize_close_for_email(dc: DailyClose) -> dict:
    """Compact dict the email template uses — only the four numbers
    that matter for an accountant glance: total revenue, MOMS, cash
    difference, and tips. Mirrors the kasserapport one-page summary."""
    return {
        "date": dc.date.isoformat() if dc.date else None,
        "revenue_total": float(dc.revenue_total or 0),
        "moms_total": float(dc.moms_total or 0),
        "cash_difference": float(dc.cash_difference) if dc.cash_difference is not None else None,
        "tips_total": float(dc.tips_total) if dc.tips_total is not None else None,
    }


def _build_close_email_html(
    *,
    business_name: str,
    dc: DailyClose,
    currency: str,
    closed_by: str | None,
    has_scan: bool,
    scan_degraded: bool,
    is_danish: bool,
) -> tuple[str, str]:
    """Build (subject, html) for the lock-time auto-email.

    Danish for DKK users, English otherwise. Keeps the format tight —
    accountants are glancing at the email body to decide whether to
    open the attachments, not reading prose.

    Jurisdiction-locked DK terms (`Salgsmoms`, `kasserapport`) stay
    Danish in BOTH languages — the email lands in the revisor's inbox
    and they expect the Danish bookkeeping vocabulary regardless of
    which UI language the owner picked. The VAT rate is currency-
    derived (DKK 25%, NPR 13%, GBP 20%, etc.) via
    `tax_service._get_vat_rate` — the previous hardcoded 25% gave
    every non-DK user a wrong percentage in their email body.
    """
    rev = float(dc.revenue_total or 0)
    moms = float(dc.moms_total or 0)
    cash_diff = float(dc.cash_difference or 0) if dc.cash_difference is not None else None
    closer = (closed_by or "").strip() or ("personalet" if is_danish else "staff")

    # Currency-derived VAT rate. Safe fallback to 0.25 if the tax
    # service import fails — mirrors the same defensive pattern used
    # in the create_daily_close handler above.
    try:
        from app.services.tax_service import _get_vat_rate
        vat_rate = _get_vat_rate(currency or "DKK")
    except Exception:  # noqa: BLE001
        vat_rate = 0.25
    vat_rate_pct = round(vat_rate * 100)

    def _fmt(v: float) -> str:
        if is_danish:
            return f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        return f"{v:,.2f}"

    if is_danish:
        subject = f"Aftenens kasserapport — {dc.date.isoformat()} — {business_name}"
        scan_line = (
            "<p style='color:#6b7280;font-size:13px;'>📷 Z-rapport-foto vedhæftet.</p>"
            if has_scan else
            ("<p style='color:#b45309;font-size:13px;'>⚠️ Z-rapport-foto kunne ikke hentes lige nu — kun PDF vedhæftet.</p>"
             if scan_degraded else "")
        )
        cash_line = (
            f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>Kassedifference</td>"
            f"<td style='padding:4px 0;text-align:right;'>{_fmt(cash_diff)} {currency}</td></tr>"
            if cash_diff is not None else ""
        )
        intro = (
            f"<p>Hej,</p>"
            f"<p>Dagens kasserapport for <strong>{business_name}</strong> er låst "
            f"af {closer} kl. {dc.closed_at.strftime('%H:%M') if dc.closed_at else '—'}.</p>"
        )
        footer = (
            "<p style='color:#6b7280;font-size:13px;'>"
            "Sendt automatisk fra BonBox da dagsafslutningen blev låst. "
            "Svar på denne mail for at kontakte ejeren."
            "</p>"
        )
        kpi_rev = "Omsætning"
        kpi_moms = f"Salgsmoms ({vat_rate_pct}%)"
    else:
        subject = f"Tonight's close — {dc.date.isoformat()} — {business_name}"
        scan_line = (
            "<p style='color:#6b7280;font-size:13px;'>📷 Z-report photo attached.</p>"
            if has_scan else
            ("<p style='color:#b45309;font-size:13px;'>⚠️ Z-report photo couldn't be fetched right now — PDF only.</p>"
             if scan_degraded else "")
        )
        cash_line = (
            f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>Cash difference</td>"
            f"<td style='padding:4px 0;text-align:right;'>{_fmt(cash_diff)} {currency}</td></tr>"
            if cash_diff is not None else ""
        )
        intro = (
            f"<p>Hello,</p>"
            f"<p>Tonight's close for <strong>{business_name}</strong> is locked "
            f"by {closer} at {dc.closed_at.strftime('%H:%M') if dc.closed_at else '—'}.</p>"
        )
        footer = (
            "<p style='color:#6b7280;font-size:13px;'>"
            "Sent automatically from BonBox when the daily close was locked. "
            "Reply to this email to reach the owner."
            "</p>"
        )
        kpi_rev = "Revenue"
        # DK term `Salgsmoms` stays Danish in BOTH languages — this is
        # what the Danish accountant (the actual reader of this email)
        # expects to see on the row label, regardless of which UI
        # language the owner selected. Jurisdiction lock per #148.
        kpi_moms = f"Salgsmoms ({vat_rate_pct}%)"

    html = (
        "<div style='font-family:system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif;"
        "color:#111827;line-height:1.5;font-size:14px;max-width:560px;'>"
        f"{intro}"
        "<table style='border-collapse:collapse;margin:16px 0;'>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{kpi_rev}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>{_fmt(rev)} {currency}</td></tr>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{kpi_moms}</td>"
        f"<td style='padding:4px 0;text-align:right;'>{_fmt(moms)} {currency}</td></tr>"
        f"{cash_line}"
        "</table>"
        f"{scan_line}"
        f"{footer}"
        "</div>"
    )
    return subject, html


def _fetch_scan_bytes_best_effort(receipt_url: str | None) -> tuple[bytes | None, str | None]:
    """Best-effort fetch of the Z-report photo for email attachment.
    Returns (bytes, filename) or (None, None) on any failure — never
    raises into the close-confirm path. L8 — graceful degradation.

    Supports two storage shapes:
      • Supabase URL (starts with "http"): GET it
      • Local path (uploads/...): read from disk
    """
    if not receipt_url:
        return None, None
    try:
        if receipt_url.startswith("http"):
            # Supabase signed URL or public path. urlopen is fine for
            # the small JPEGs we deal with; httpx is already in the
            # service stack but keeping the import local.
            from urllib.request import Request, urlopen
            req = Request(receipt_url, headers={"User-Agent": "BonBox/1.0"})
            with urlopen(req, timeout=8) as resp:  # noqa: S310 — internal URL only
                data = resp.read()
            return data, "z_report.jpg"
        # Local path branch — read from disk
        from pathlib import Path
        p = Path(receipt_url)
        if p.is_file():
            return p.read_bytes(), p.name
    except Exception as e:  # noqa: BLE001
        logger.warning("scan_image fetch failed: %s", e)
    return None, None


def _compute_bank_drop_hint(dc: DailyClose) -> dict | None:
    """Build the bank-drop reminder block for the locked-state card.
    Universal (all tiers — low cost).

    The hint is informational — it tells the staff how much cash is
    currently in the drawer per their count, and suggests a "leave a
    float of 1.000 DKK, bag the rest" rule. Owners can fine-tune via
    the Profile page later (out of scope for Lane A).
    """
    counted = float(dc.cash_counted) if dc.cash_counted is not None else None
    if counted is None or counted <= 0:
        return None
    # Conservative default float — 1.000 DKK is the Copenhagen café
    # standard for opening cash. Anything left over goes in the safe
    # / drop bag for the morning trip to the bank.
    DEFAULT_FLOAT = 1000.0
    to_drop = max(0.0, round(counted - DEFAULT_FLOAT, 2))
    return {
        "counted_dkk": round(counted, 2),
        "leave_in_drawer_dkk": DEFAULT_FLOAT,
        "to_drop_dkk": to_drop,
    }


def _fire_close_auto_email(
    db: Session,
    request: Request,
    user: User,
    dc: DailyClose,
) -> dict:
    """Run the Lane A auto-email pipeline after a successful lock.

    Returns a structured status block the router embeds in its
    response so the frontend can render an honest locked-state card:

        {
            "feature_available": bool,       # L3 — tier has close_auto_email
            "preference_on": bool,            # L3 — user opted in
            "email_status": "...",            # L9 — sent | queued_retry | skipped_* | failed_skipped
            "sent_to": [...],
            "has_scan": bool,
            "scan_degraded": bool,            # L8 — scan should have been attached but wasn't
            "pdf_hash": "...",                # L7 — hash matches what's in audit_logs
            "push_status": "...",             # L3 — pro-only push notification
            "bank_drop": {...} | None,        # universal — informational
            "upgrade_hint": {...} | None,     # L10 — for Free users in the response
        }

    NEVER raises into the close-confirm flow. Every failure mode is
    swallowed + logged + reflected in the return dict.
    """
    result: dict[str, Any] = {
        "feature_available": False,
        "preference_on": bool(getattr(user, "auto_email_on_close", True)),
        "email_status": "skipped_feature_locked",
        "sent_to": [],
        "has_scan": False,
        "scan_degraded": False,
        "pdf_hash": None,
        "push_status": "skipped_feature_locked",
        "bank_drop": _compute_bank_drop_hint(dc),
        "upgrade_hint": None,
    }

    feature_on = has_feature(user, "close_auto_email")
    result["feature_available"] = feature_on

    # L10 — Free user gets a structured upgrade hint they can render
    # next to the "Send to accountant" button. The actual button still
    # works (Free has direct_accountant_email gate — that's a different
    # tier; close_auto_email is Starter+).
    if not feature_on:
        from app.services.billing import min_plan_for_feature, feature_locked_detail
        result["upgrade_hint"] = feature_locked_detail(user, "close_auto_email")
        # L7 — record the skip so we can see "this Free user just
        # closed; if they were on Starter we'd have auto-emailed".
        # Strong upgrade-pitch signal.
        try:
            record_feature_skip(
                user, "close_auto_email",
                {"close_id": str(dc.id), "stage": "lock_handler"},
            )
        except Exception:  # noqa: BLE001
            pass
        # Push to owner — Pro-only. Still skipped for the same reason.
        return result

    # L3 — user preference. Honest about WHY we didn't send so the
    # frontend can offer "Turn auto-send back on?" instead of
    # silently appearing broken.
    pref_on = bool(getattr(user, "auto_email_on_close", True))
    result["preference_on"] = pref_on
    if not pref_on:
        result["email_status"] = "skipped_preference_off"
        # Push notification is independently useful even with email
        # off — but we still gate it on the same preference (Lane A
        # is "the close is locked, let the owner know"). Pro tier
        # gets the push.
        result["push_status"] = _fire_close_push(db, user, dc)
        return result

    # Build PDF for the single-day range (reuses the kasserapport
    # accountant-grade PDF generator that's already tested + audit-
    # graded). One-day range = a single close → one-page PDF.
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    business_name = (
        (profile.company_name if profile and profile.company_name else None)
        or getattr(user, "business_name", None)
        or "BonBox"
    )
    currency = user.currency or "DKK"
    is_danish = (currency == "DKK")

    try:
        pdf_bytes = build_daily_close_range_pdf(
            [dc], from_date=dc.date, to_date=dc.date,
            business_name=business_name, currency=currency,
            profile=profile, db=db, user_id=user.id,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("close_auto_email: PDF build failed close_id=%s: %s", dc.id, e)
        result["email_status"] = "failed_skipped"
        return result

    pdf_hash = compute_document_hash(pdf_bytes)
    pdf_short = short_hash(pdf_bytes)
    result["pdf_hash"] = pdf_hash

    # L6 — recipient resolution with fallback chain. owner_email from
    # BusinessProfile if set, else the account-holder's own email.
    # Accountant is best-effort; partial send (just owner) is OK.
    owner_email = ""
    if profile and getattr(profile, "email", None):
        owner_email = (profile.email or "").strip().lower()
    if not owner_email:
        owner_email = (user.email or "").strip().lower()
    accountant_email = ""
    if profile and getattr(profile, "accountant_email", None):
        accountant_email = (profile.accountant_email or "").strip().lower()

    recipients: list[str] = []
    if owner_email:
        recipients.append(owner_email)
    if accountant_email and accountant_email != owner_email:
        recipients.append(accountant_email)

    if not recipients:
        result["email_status"] = "skipped_no_recipient"
        # L7 — record the audit attempt anyway so operator can see
        # "owner has no email on file" as a friction signal.
        audit_service.record(
            db, user=user,
            action="close.auto_emailed",
            entity_type="daily_close",
            entity_id=dc.id,
            before={"recipients": [], "has_scan": False, "pdf_hash": pdf_hash},
            after={"email_status": "skipped_no_recipient", "message_id": None},
            ip_address=getattr(request.client, "host", None) if request.client else None,
        )
        result["push_status"] = _fire_close_push(db, user, dc)
        return result

    # L8 — scan image, best-effort. If fetch fails we still send the
    # PDF + a "scan unavailable" line in the body. `scan_degraded`
    # is True ONLY when there WAS a scan recorded on the close but
    # we couldn't fetch the bytes — "no scan recorded" is normal,
    # not degradation (owner may not have used the Snap Z-report
    # flow tonight).
    scan_bytes, scan_filename = (None, None)
    scan_supposed_to_attach = has_feature(user, "close_scan_attached")
    receipt_url = getattr(dc, "receipt_photo", None)
    if scan_supposed_to_attach and receipt_url:
        scan_bytes, scan_filename = _fetch_scan_bytes_best_effort(receipt_url)
    scan_degraded = bool(scan_supposed_to_attach and receipt_url and not scan_bytes)
    result["scan_degraded"] = scan_degraded

    pdf_filename = f"kasserapport_{dc.date.isoformat()}_{pdf_short}.pdf"

    subject, html = _build_close_email_html(
        business_name=business_name,
        dc=dc, currency=currency,
        closed_by=dc.closed_by,
        has_scan=bool(scan_bytes),
        scan_degraded=scan_degraded,
        is_danish=is_danish,
    )

    # L4 — service-layer entitlement gate happens INSIDE
    # send_close_notification. The router gate above is the primary;
    # the service gate is the backup. Both must agree.
    from app.services.email_service import send_close_notification
    send_result = send_close_notification(
        user,
        close_id=dc.id,
        pdf_bytes=pdf_bytes,
        scan_image_bytes=scan_bytes,
        pdf_filename=pdf_filename,
        scan_filename=scan_filename,
        recipients=recipients,
        subject=subject, html=html,
        reply_to=user.email,
    )
    result["email_status"] = send_result["status"]
    result["sent_to"] = send_result["sent_to"]
    result["has_scan"] = send_result["has_scan"]

    # L7 — audit row for every attempt, success or not.
    audit_service.record(
        db, user=user,
        action="close.auto_emailed",
        entity_type="daily_close",
        entity_id=dc.id,
        before={
            "recipients": list(recipients),
            "has_scan": bool(scan_bytes),
            "pdf_hash": pdf_hash,
        },
        after={
            "email_status": send_result["status"],
            "sent_to": send_result["sent_to"],
            "scan_degraded": scan_degraded,
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )

    # L7 — SecurityEvent on failure so operator monitoring can spot
    # "Resend is down" without grepping logs.
    if send_result["status"] in ("queued_retry", "failed_skipped"):
        try:
            from app.services.billing import _record_gate_refusal
            _record_gate_refusal(
                user, "gate_skipped.close_auto_email_failed",
                {
                    "close_id": str(dc.id),
                    "email_status": send_result["status"],
                    "error": send_result.get("error"),
                    "recipients_count": len(recipients),
                    "scan_degraded": scan_degraded,
                },
            )
        except Exception:  # noqa: BLE001
            pass

    # Pro-only push to owner — independent of email status (an owner
    # who muted email may still want the push).
    result["push_status"] = _fire_close_push(db, user, dc)

    return result


def _fire_close_push(db: Session, user: User, dc: DailyClose) -> str:
    """Send a privacy-safe push to the owner that staff just locked
    the close. Pro-only feature; degrades gracefully when there's no
    push subscription, no VAPID config, or pywebpush isn't installed.

    Returns the status string the response payload includes:
        "sent" | "skipped_feature_locked" | "skipped_no_subscription"
        | "queued_retry" | "failed_skipped"
    """
    if not has_feature(user, "close_push_notification"):
        return "skipped_feature_locked"
    try:
        from app.models.push_subscription import PushSubscription
        from app.services.push_sender import send_to_subscription
        subs = db.query(PushSubscription).filter(
            PushSubscription.user_id == user.id,
        ).all()
        if not subs:
            return "skipped_no_subscription"
        # Privacy-safe payload — no amounts, no customer names, only
        # a generic "close locked" notification. Owner taps to open
        # the Daily Close history page.
        currency = user.currency or "DKK"
        is_danish = (currency == "DKK")
        title = "BonBox · Dagsafslutning låst" if is_danish else "BonBox · Close locked"
        body = (
            f"{dc.closed_by or 'Personalet'} har låst dagens kasserapport."
            if is_danish else
            f"{dc.closed_by or 'Staff'} just locked tonight's close."
        )
        payload = {
            "title": title, "body": body[:140],
            "tag": "bonbox-close-locked",
            "data": {"url": "/daily-close"},
        }
        any_ok = False
        for sub in subs:
            res = send_to_subscription(sub, payload)
            if res.get("ok"):
                any_ok = True
        try:
            db.commit()
        except Exception:  # noqa: BLE001
            pass
        return "sent" if any_ok else "queued_retry"
    except Exception as e:  # noqa: BLE001
        logger.warning("close_push: failed user=%s err=%s", user.id, e)
        return "failed_skipped"


def _register_cash_for_date(db: Session, *, user: User, target_date, branch_id) -> float | None:
    """Cash the POS register says was taken on `target_date`.

    Sums completed, non-deleted `Sale` rows whose payment method maps to
    cash (`cash` / `kontant`) for the day — the SAME grouping the
    /daily-close/prefill endpoint uses (kontant → cash). This is the REAL
    expected-cash baseline for the drawer variance: counted drawer vs what
    the till recorded, which surfaces a genuine shortage/theft instead of
    the self-referential "typed cash vs counted cash".

    Returns None when the date has NO completed sales at all — i.e. there is
    no synced register to compare against (pure manual / cash-only closers).
    In that case the caller falls back to the payment-breakdown cash the
    owner typed, preserving the prior behaviour for those users. Returns 0.0
    when there ARE sales but none were cash (legit "no cash today"), so the
    variance still anchors on the register.

    Fail-soft: any DB error returns None → graceful fall back to typed cash.
    """
    try:
        q = db.query(Sale).filter(
            Sale.user_id == user.id,
            Sale.date == target_date,
            Sale.is_deleted.isnot(True),
            Sale.status == "completed",
        )
        if branch_id:
            q = q.filter(Sale.branch_id == branch_id)
        # No synced register for the day → let the caller fall back.
        if q.count() == 0:
            return None
        cash_methods = ("cash", "kontant")
        cash_total = (
            q.filter(func.lower(Sale.payment_method).in_(cash_methods))
            .with_entities(func.coalesce(func.sum(Sale.amount), 0))
            .scalar()
        )
        return round(float(cash_total or 0), 2)
    except Exception:  # noqa: BLE001
        return None


# ─── POST — submit daily close ───

def _capture_extraction_correction(db, user, *, status, final_values):
    """Close the OCR learning loop: stamp what the owner ACTUALLY saved
    (final_json) onto the most recent uncommitted scan extraction for this
    user, plus user_corrected (did they change the model's totals?). The
    extracted_json ↔ final_json diff is the training signal for which POS
    layouts / fields the model misreads — fuel for the admin review +
    prompt/format tuning.

    Matches the latest open (committed_at IS NULL) /scan-report row within
    24h — a backend-only match so no extraction_id has to be threaded
    through the frontend (keeps this shippable via Render alone). Precise
    per-scan linking (multi-terminal days) is a later refinement. Never
    raises — a logging failure must never block a close.
    """
    try:
        from datetime import timedelta
        cutoff = utc_now() - timedelta(hours=24)
        row = (
            db.query(KasserapportExtraction)
            .filter(
                KasserapportExtraction.user_id == user.id,
                KasserapportExtraction.committed_at.is_(None),
                KasserapportExtraction.created_at >= cutoff,
            )
            .order_by(KasserapportExtraction.created_at.desc())
            .first()
        )
        if row is None:
            return  # close wasn't created from a scan (pure manual entry)

        row.final_json = final_values

        # user_corrected = did the saved totals differ from what OCR read?
        ext = row.extracted_json or {}

        def _close(a, b, tol=0.5):
            if a is None or b is None:
                return (a is None) == (b is None)
            try:
                return abs(float(a) - float(b)) <= tol
            except (TypeError, ValueError):
                return a == b

        row.user_corrected = not (
            _close(ext.get("revenue_total"), final_values.get("revenue_total"))
            and _close(ext.get("moms_total"), final_values.get("moms_total"))
        )
        # Only "close the book" on this extraction when the day is locked;
        # draft saves leave it open so a later edit can re-stamp final_json.
        if status == "confirmed":
            row.committed_at = utc_now()
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("daily_close: extraction correction-capture failed: %s", e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


@router.post("")
@_limiter.limit("30/minute")
def create_daily_close(
    request: Request,
    data: DailyCloseCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Check for existing close on same date+branch (upsert)
    existing = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date == data.date,
            DailyClose.branch_id == data.branch_id,
            DailyClose.is_deleted.isnot(True),
        )
        .first()
    )

    # Revenue total: when the OCR detected a bottom-line total
    # (revenue_total_override) AND the user didn't fully reconcile the
    # category breakdown, prefer the larger value. Three cases:
    #   • All categories filled, sum = override        → save sum (= override)
    #   • Categories partial (e.g. only Drinks=1.82),
    #     override = 17030                             → save 17030 (override
    #                                                    wins; breakdown is
    #                                                    incomplete or wrong)
    #   • Categories filled past override (user added
    #     extra revenue manually)                      → save sum (user
    #                                                    customizing)
    # The previous logic preferred any non-zero breakdown sum, which
    # broke the "skip — total saves correctly either way" promise of
    # the partial-detection banner: a single wrong OCR parse like 1.82
    # would silently overwrite the real 17,030 total.
    breakdown_sum = sum((data.revenue_breakdown or {}).values())
    override = data.revenue_total_override
    if override is not None and override > 0:
        revenue_total = float(max(breakdown_sum, override))
    elif breakdown_sum > 0:
        revenue_total = breakdown_sum
    else:
        revenue_total = 0

    # Detective control — when the breakdown sum diverges wildly from
    # the OCR'd override (>5x apart), emit a structured warning so an
    # admin can spot OCR quality issues + edge-case bugs in production
    # logs WITHOUT blocking the save (the save itself uses max() which
    # is the safe value for the user). Pairs with the schema + service
    # layers as a per-row monitor.
    if (
        breakdown_sum > 0
        and override is not None
        and override > 0
        and abs(breakdown_sum - override) / max(breakdown_sum, override) > 0.8
    ):
        logger.warning(
            "daily_close: revenue mismatch (using max=%s) "
            "user=%s breakdown_sum=%s override=%s breakdown=%s",
            revenue_total, user.id, breakdown_sum, override,
            data.revenue_breakdown,
        )

    # payment_total sums ONLY the headline payment methods. Card brand /
    # channel splits (dankort/visa/mastercard/softpay/betalingskort) may ride
    # along in payment_breakdown for accountant fidelity / the kasserapport
    # PDF, but they are a BREAKDOWN of the card line — summing them would
    # double-count. Exclude them here: a server-side guarantee that mirrors
    # the close-UI invariant (brands display under the card line, never add).
    _CARD_BREAKDOWN_KEYS = {"dankort", "visa", "mastercard", "softpay", "betalingskort"}
    payment_total = sum(
        v for k, v in (data.payment_breakdown or {}).items()
        if k not in _CARD_BREAKDOWN_KEYS and isinstance(v, (int, float))
    )

    # Cash expected — the baseline the counted drawer is measured against.
    # Prefer the SYNCED POS register cash for the date (what the till says
    # was taken) over the owner's typed cash line: typed-vs-counted is
    # self-referential and can never reveal a real shortage/theft, whereas
    # register-vs-drawer can. _register_cash_for_date returns None when the
    # date has no completed sales (pure manual / cash-only closers) — in
    # that case we fall back to the typed payment-breakdown cash, preserving
    # the prior behaviour for those users. This keeps the persisted
    # cash_difference (and the revisor kasserapport PDF / L7 audit row) in
    # lockstep with the "Expected (from register)" figure the close screen
    # now shows. Explicit None checks so 0 ("no cash today") isn't treated
    # as missing — the previous `or` chain coerced 0 → None.
    pb = data.payment_breakdown or {}
    register_cash = _register_cash_for_date(
        db, user=user, target_date=data.date, branch_id=data.branch_id,
    )
    if register_cash is not None:
        cash_expected = register_cash
    elif "cash" in pb:
        cash_expected = pb["cash"]
    elif "kontant" in pb:
        cash_expected = pb["kontant"]
    else:
        cash_expected = None
    cash_difference = None
    if cash_expected is not None and data.cash_counted is not None:
        cash_difference = round(float(data.cash_counted) - float(cash_expected), 2)

    tips_per_person = None
    if data.tips_total and data.tips_staff_count and data.tips_staff_count > 0:
        tips_per_person = round(data.tips_total / data.tips_staff_count, 2)

    # MOMS / VAT — use provided value or auto-calculate using the user's
    # currency rate AND their prices-include-Moms preference.
    # Previously hardcoded 25% which gave wrong MOMS for any non-DK user
    # (NPR 13%, GBP 20%, EUR 21%, etc.) and ignored B2B net-amount mode.
    moms_mode = data.moms_mode or "auto"
    if data.moms_total is not None:
        moms_total = round(data.moms_total, 2)
    else:
        try:
            from app.services.tax_service import _get_vat_rate
            vat_rate = _get_vat_rate(user.currency or "DKK")
        except Exception:  # noqa: BLE001
            vat_rate = 0.25  # safe DK fallback if tax service load fails
        # Per-close override beats user-level default (e.g. "this Z-report
        # is gross because the user picked 'with MOMS' before scanning").
        if data.prices_include_moms_override is not None:
            prices_incl_moms = bool(data.prices_include_moms_override)
        else:
            prices_incl_moms = bool(getattr(user, "prices_include_moms", True))
        if revenue_total > 0 and vat_rate > 0:
            if prices_incl_moms:
                # Gross-input mode (B2C): extract VAT from total
                moms_total = round(revenue_total * vat_rate / (1 + vat_rate), 2)
            else:
                # Net-input mode (B2B): VAT is rate × net
                moms_total = round(revenue_total * vat_rate, 2)
        else:
            moms_total = 0
    revenue_ex_moms = round(revenue_total - moms_total, 2) if revenue_total > 0 else 0

    status = data.status if data.status in ("draft", "confirmed") else "confirmed"

    # ─── Detective control — anomaly double-check before the lock ───
    # close_sanity compares today's total against the recent same-weekday
    # baseline; a confidently-wrong OCR misread (the classic 2.234 read
    # instead of 22.340) trips the flag. We return a soft
    # {requires_confirmation} WITHOUT mutating anything, so the frontend
    # surfaces a "double-check" dialog; the owner then either fixes the
    # numbers or re-submits with acknowledge_anomaly=True to lock anyway.
    # Only gates the LOCK (status=="confirmed"), never a draft auto-save,
    # and is fully fail-closed — the guard never raises and an error here
    # must never block a legitimate close.
    if status == "confirmed" and not data.acknowledge_anomaly:
        try:
            from app.services.close_sanity import check_close_anomaly
            _anomaly = check_close_anomaly(
                db, user=user, today=data.date, today_total=float(revenue_total),
            )
        except Exception:  # noqa: BLE001
            _anomaly = {"flagged": False}
        if _anomaly.get("flagged"):
            return {
                "requires_confirmation": True,
                "anomaly": {
                    "reason": _anomaly.get("reason"),
                    "today_total": _anomaly.get("today_total"),
                    "baseline_avg": _anomaly.get("baseline_avg"),
                    "baseline_days": _anomaly.get("baseline_days"),
                    "delta_pct": _anomaly.get("delta_pct"),
                },
            }

    if existing:
        # Block edits to confirmed (locked) entries — must unlock first
        existing_status = getattr(existing, "status", None) or "confirmed"
        if existing_status == "confirmed" and status != "draft":
            raise HTTPException(
                status_code=409,
                detail="This daily close is locked. Unlock it first to make changes."
            )
        # Update existing
        existing.revenue_categories = encode_breakdown(data.revenue_breakdown)
        existing.revenue_total = revenue_total
        existing.payment_categories = encode_breakdown(data.payment_breakdown)
        existing.payment_total = payment_total
        existing.moms_total = moms_total
        existing.revenue_ex_moms = revenue_ex_moms
        existing.moms_mode = moms_mode
        existing.cash_expected = cash_expected
        existing.cash_counted = data.cash_counted
        existing.cash_difference = cash_difference
        existing.tips_total = data.tips_total
        existing.tips_staff_count = data.tips_staff_count
        existing.tips_per_person = tips_per_person
        existing.status = status
        existing.notes = data.notes
        existing.closed_by = data.closed_by
        # Only overwrite the photo if the caller provided one — owners
        # editing a draft without re-uploading the photo shouldn't lose
        # the existing reference.
        if data.receipt_photo:
            existing.receipt_photo = data.receipt_photo
        if status == "confirmed":
            existing.closed_at = utc_now()
            # Clear unlock audit when re-confirming
            existing.unlock_reason = None
            existing.unlocked_by = None
            existing.unlocked_at = None
        # Bogføringsloven §10 — append-only audit row for the financial mutation.
        # Action depends on whether this is a confirm/lock or a draft save.
        _audit_action = "daily_close.lock" if status == "confirmed" else "daily_close.update"
        audit_service.record(
            db, user=user,
            action=_audit_action,
            entity_type="daily_close",
            entity_id=existing.id,
            before={"status": existing_status, "revenue_total": float(existing.revenue_total or 0)},
            after={
                "status": status, "revenue_total": revenue_total,
                "payment_total": payment_total, "moms_total": moms_total,
                "cash_difference": cash_difference, "closed_by": data.closed_by,
            },
            ip_address=getattr(request.client, "host", None) if request.client else None,
        )
        db.commit()
        db.refresh(existing)
        _capture_extraction_correction(
            db, user, status=status,
            final_values={
                "revenue_total": revenue_total, "moms_total": moms_total,
                "payment_breakdown": data.payment_breakdown,
                "revenue_breakdown": data.revenue_breakdown,
                "cash_counted": data.cash_counted,
            },
        )
        response = _to_response(existing)
        # L3 — Lane A close-ritual auto-email. Only on transition INTO
        # confirmed (i.e. the lock event), not on subsequent draft saves
        # of an unlocked-then-edited close. The helper handles all the
        # tier + preference gating + scan attachment + retry — never
        # raises into this path.
        if status == "confirmed":
            _invalidate_daily_brief_cache(db, user)
            response["close_ritual"] = _fire_close_auto_email(db, request, user, existing)
        return response

    dc = DailyClose(
        id=uuid.uuid4(),
        user_id=user.id,
        branch_id=data.branch_id,
        date=data.date,
        revenue_categories=encode_breakdown(data.revenue_breakdown),
        revenue_total=revenue_total,
        payment_categories=encode_breakdown(data.payment_breakdown),
        payment_total=payment_total,
        moms_total=moms_total,
        revenue_ex_moms=revenue_ex_moms,
        moms_mode=moms_mode,
        cash_expected=cash_expected,
        cash_counted=data.cash_counted,
        cash_difference=cash_difference,
        tips_total=data.tips_total,
        tips_staff_count=data.tips_staff_count,
        tips_per_person=tips_per_person,
        status=status,
        notes=data.notes,
        closed_by=data.closed_by,
        closed_at=utc_now() if status == "confirmed" else None,
        receipt_photo=data.receipt_photo,
    )
    db.add(dc)
    db.flush()  # populate dc.id before the audit row references it
    # Bogføringsloven §10 — append-only audit row for the new close.
    audit_service.record(
        db, user=user,
        action="daily_close.lock" if status == "confirmed" else "daily_close.create",
        entity_type="daily_close",
        entity_id=dc.id,
        before=None,
        after={
            "status": status, "date": data.date.isoformat() if data.date else None,
            "revenue_total": revenue_total, "payment_total": payment_total,
            "moms_total": moms_total, "cash_difference": cash_difference,
            "closed_by": data.closed_by, "branch_id": data.branch_id,
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    db.commit()
    db.refresh(dc)
    _capture_extraction_correction(
        db, user, status=status,
        final_values={
            "revenue_total": revenue_total, "moms_total": moms_total,
            "payment_breakdown": data.payment_breakdown,
            "revenue_breakdown": data.revenue_breakdown,
            "cash_counted": data.cash_counted,
        },
    )
    response = _to_response(dc)
    # L3 — Lane A close-ritual auto-email. Only on the lock transition.
    # Drafts (status="draft") do NOT trigger — the email is the "the
    # day is officially closed, here's the kasserapport" notification.
    if status == "confirmed":
        _invalidate_daily_brief_cache(db, user)
        response["close_ritual"] = _fire_close_auto_email(db, request, user, dc)
    return response


# ─── POST — dismiss bank-drop reminder (Lane A — universal) ──
#
# Stores the close_id in user.bank_drop_dismissed_ids so the locked-
# state card no longer shows the "🏦 Bank drop" reminder for this
# close. Universal across all tiers (Free/Starter/Pro/Trial) — the
# reminder itself is free.

@router.post("/{close_id}/bank-drop-dismiss")
@_limiter.limit("30/minute")
def dismiss_bank_drop_reminder(
    request: Request,
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mark the bank-drop reminder for a specific close as done. Idempotent.

    The reminder card on the locked-state UI ("🏦 Put X DKK in safe")
    shows until the staff taps "Sat i sikkerhedsboks" — that triggers
    this endpoint. Stored on user.bank_drop_dismissed_ids as a comma-
    separated list, FIFO-trimmed at 30 entries (~1 month of closes).
    """
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
        DailyClose.is_deleted.isnot(True),
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")

    raw = (getattr(user, "bank_drop_dismissed_ids", None) or "").strip()
    existing = [x for x in raw.split(",") if x]
    sid = str(close_id)
    if sid not in existing:
        existing.append(sid)
        # FIFO rolloff — keep only the most-recent 30.
        existing = existing[-30:]
        user.bank_drop_dismissed_ids = ",".join(existing)
        db.commit()
    return {"ok": True, "dismissed_count": len(existing)}


# ─── POST — unlock a confirmed daily close ───

@router.post("/{close_id}/unlock")
@_limiter.limit("5/minute")
def unlock_daily_close(
    request: Request,
    close_id: str,
    data: DailyCloseUnlock,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Unlock a confirmed daily close so it can be edited. Owner only. Requires a reason."""
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
        DailyClose.is_deleted.isnot(True),
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    current_status = getattr(dc, "status", None) or "confirmed"
    if current_status != "confirmed":
        raise HTTPException(status_code=400, detail="Only confirmed closes can be unlocked")
    if not data.reason or not data.reason.strip():
        raise HTTPException(status_code=422, detail="A reason is required to unlock")

    dc.status = "draft"
    dc.unlock_reason = data.reason.strip()
    dc.unlocked_by = user.email or str(user.id)
    dc.unlocked_at = utc_now()
    # Bogføringsloven §10 — unlock is a sensitive mutation; capture reason
    # in the immutable audit trail alongside the per-row fields.
    audit_service.record(
        db, user=user,
        action="daily_close.unlock",
        entity_type="daily_close",
        entity_id=dc.id,
        before={"status": current_status, "date": dc.date.isoformat() if dc.date else None},
        after={
            "status": "draft", "unlock_reason": data.reason.strip(),
            "unlocked_by": dc.unlocked_by, "unlocked_at": dc.unlocked_at.isoformat(),
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    db.commit()
    db.refresh(dc)
    return _to_response(dc)


# ─── GET — list daily closes ───

@router.get("")
def list_daily_closes(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(DailyClose).filter(
        DailyClose.user_id == user.id,
        DailyClose.is_deleted.isnot(True),
    )
    if from_date:
        q = q.filter(DailyClose.date >= from_date)
    if to_date:
        q = q.filter(DailyClose.date <= to_date)
    if branch_id:
        q = q.filter(DailyClose.branch_id == branch_id)

    closes = q.order_by(DailyClose.date.desc()).limit(90).all()
    return [_to_response(dc) for dc in closes]


# ─── GET — insights ───

@router.get("/insights")
def daily_close_insights(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    d90 = date.today() - timedelta(days=90)
    closes = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.is_deleted.isnot(True),
            DailyClose.date >= d90,
        )
        .order_by(DailyClose.date.desc())
        .all()
    )

    if not closes:
        return {"has_data": False, "insights": [], "summary": {}}

    # Aggregate data
    total_revenue = 0
    total_food = 0
    total_drinks = 0
    total_takeaway = 0
    total_tips = 0
    total_cash_diff = 0
    cash_diff_negative_days = 0
    cash_diff_count = 0
    tips_by_weekday = defaultdict(list)
    takeaway_by_month = defaultdict(float)
    revenue_by_month = defaultdict(float)

    for dc in closes:
        rev = decode_breakdown(dc.revenue_categories)
        rev_total = float(dc.revenue_total or 0)
        total_revenue += rev_total

        food = sum(v for k, v in rev.items() if k.lower() in ("food", "mad"))
        drinks = sum(v for k, v in rev.items() if k.lower() in ("drinks", "drikkevarer", "beverages"))
        takeaway = sum(v for k, v in rev.items() if k.lower() in ("takeaway", "udbringning", "delivery"))
        total_food += food
        total_drinks += drinks
        total_takeaway += takeaway

        if dc.tips_total:
            total_tips += float(dc.tips_total)
            weekday = dc.date.strftime("%A")
            tips_by_weekday[weekday].append(float(dc.tips_total))

        if dc.cash_difference is not None:
            diff = float(dc.cash_difference)
            total_cash_diff += diff
            cash_diff_count += 1
            if diff < 0:
                cash_diff_negative_days += 1

        month_key = dc.date.strftime("%Y-%m")
        takeaway_by_month[month_key] += takeaway
        revenue_by_month[month_key] += rev_total

    insights = []
    count = len(closes)

    # 1. Drink-to-food ratio
    if total_food > 0:
        ratio = round((total_drinks / (total_food + total_drinks)) * 100, 1)
        insights.append({
            "type": "drink_ratio",
            "icon": "🍸",
            "title": f"Drink-to-food ratio: {ratio}%",
            "detail": "Danish restaurant average is 35-45%. "
                      + ("You might be under-selling beverages — consider upselling wine with dinner." if ratio < 35
                         else "Great balance!" if ratio <= 45
                         else "Strong drink sales! Make sure food margins are healthy too."),
            "value": ratio,
            "benchmark": "35-45%",
        })

    # 2. Tip trends by weekday
    if tips_by_weekday:
        tip_avgs = {day: round(sum(vals) / len(vals)) for day, vals in tips_by_weekday.items()}
        best_day = max(tip_avgs, key=tip_avgs.get)
        worst_day = min(tip_avgs, key=tip_avgs.get)
        if tip_avgs[best_day] > 0 and tip_avgs[worst_day] > 0:
            multiplier = round(tip_avgs[best_day] / tip_avgs[worst_day], 1)
            insights.append({
                "type": "tip_trends",
                "icon": "💰",
                "title": f"{best_day} tips avg {tip_avgs[best_day]:,} vs {worst_day} avg {tip_avgs[worst_day]:,}",
                "detail": f"Your {best_day} staff earns {multiplier}x more in tips than {worst_day} staff.",
                "weekday_averages": tip_avgs,
            })

    # 3. Cash difference tracking
    if cash_diff_count >= 5:
        insights.append({
            "type": "cash_drift",
            "icon": "🔍" if total_cash_diff < -200 else "✅",
            "title": f"Cash difference: {total_cash_diff:+,.0f} over {cash_diff_count} days",
            "detail": (
                f"Negative {cash_diff_negative_days} out of {cash_diff_count} days. Investigate — could be counting errors or shrinkage."
                if cash_diff_negative_days > cash_diff_count * 0.5
                else "Cash drawer tracking looks healthy."
            ),
            "total_drift": round(total_cash_diff, 2),
            "negative_days": cash_diff_negative_days,
            "total_days": cash_diff_count,
        })

    # 5. Cash variance streak detection — consecutive nights short
    streak_alert = None
    closes_by_date = sorted(
        [(dc.date, float(dc.cash_difference)) for dc in closes if dc.cash_difference is not None],
        key=lambda x: x[0],
    )

    if len(closes_by_date) >= 2:
        streaks = []
        cur_streak = []

        for d, diff in closes_by_date:
            if diff < 0:
                if not cur_streak:
                    cur_streak = [(d, diff)]
                else:
                    gap = (d - cur_streak[-1][0]).days
                    if gap <= 3:          # allow gaps for days the business is closed
                        cur_streak.append((d, diff))
                    else:
                        if len(cur_streak) >= 2:
                            streaks.append(list(cur_streak))
                        cur_streak = [(d, diff)]
            else:
                if len(cur_streak) >= 2:
                    streaks.append(list(cur_streak))
                cur_streak = []

        if len(cur_streak) >= 2:
            streaks.append(list(cur_streak))

        if streaks:
            latest = streaks[-1]
            s_len = len(latest)
            s_total = round(sum(diff for _, diff in latest), 2)
            s_start = latest[0][0].strftime("%-d %b")
            s_end = latest[-1][0].strftime("%-d %b")
            most_recent = closes_by_date[-1][0]
            is_active = (most_recent - latest[-1][0]).days <= 2

            if s_len >= 5:
                severity, icon = "critical", "\U0001f6a8"
                title = f"Cash short {s_len} nights in a row"
                detail = (
                    f"Total shortage: {s_total:,.0f} over {s_len} consecutive days "
                    f"({s_start}\u2013{s_end}). This pattern suggests systematic issues \u2014 "
                    "review camera footage, POS reconciliation, and cash handling procedures."
                )
            elif s_len >= 3:
                severity, icon = "warning", "\u26a0\ufe0f"
                title = f"Cash short {s_len} nights in a row"
                detail = (
                    f"Total shortage: {s_total:,.0f} from {s_start} to {s_end}. "
                    "Three or more consecutive shortages is a pattern worth investigating."
                )
            else:
                severity, icon = "info", "\U0001f4a1"
                title = "Cash short 2 nights in a row"
                detail = (
                    f"Total shortage: {s_total:,.0f} on {s_start} and {s_end}. "
                    "Might be coincidence, but keep an eye on it."
                )

            streak_alert = {
                "type": "cash_streak",
                "icon": icon,
                "title": title,
                "detail": detail,
                "severity": severity,
                "streak_length": s_len,
                "streak_total": s_total,
                "streak_start": latest[0][0].isoformat(),
                "streak_end": latest[-1][0].isoformat(),
                "is_active": is_active,
                "total_streaks": len(streaks),
            }
            insights.insert(0, streak_alert)

    # 4. Takeaway growth
    sorted_months = sorted(revenue_by_month.keys())
    if len(sorted_months) >= 2:
        curr = sorted_months[-1]
        prev = sorted_months[-2]
        curr_takeaway = takeaway_by_month.get(curr, 0)
        prev_takeaway = takeaway_by_month.get(prev, 0)
        curr_rev = revenue_by_month.get(curr, 0)
        prev_rev = revenue_by_month.get(prev, 0)
        if prev_takeaway > 0 and curr_rev > 0:
            growth = round(((curr_takeaway - prev_takeaway) / prev_takeaway) * 100)
            share_curr = round((curr_takeaway / curr_rev) * 100, 1) if curr_rev else 0
            share_prev = round((prev_takeaway / prev_rev) * 100, 1) if prev_rev else 0
            if growth != 0:
                insights.append({
                    "type": "takeaway_growth",
                    "icon": "📦",
                    "title": f"Takeaway {'grew' if growth > 0 else 'dropped'} {abs(growth)}% this month",
                    "detail": f"Now {share_curr}% of total sales vs {share_prev}% last month.",
                    "growth_pct": growth,
                    "current_share": share_curr,
                })

    summary = {
        "total_closes": count,
        "total_revenue": round(total_revenue, 2),
        "avg_daily_revenue": round(total_revenue / count, 2) if count else 0,
        "total_tips": round(total_tips, 2),
        "avg_daily_tips": round(total_tips / count, 2) if count else 0,
        "total_cash_difference": round(total_cash_diff, 2),
        "cash_streak": streak_alert,
    }

    return {"has_data": True, "insights": insights, "summary": summary}


# ─── GET — multi-branch daily summary ───

@router.get("/branch-summary")
def branch_summary(
    target_date: date = Query(None, alias="date"),
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Cross-branch comparison: per-branch revenue, cash, tips for a date or range."""
    if target_date:
        from_date = to_date = target_date
    if not from_date:
        from_date = date.today() - timedelta(days=7)
    if not to_date:
        to_date = date.today()

    closes = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user.id,
            DailyClose.date >= from_date,
            DailyClose.date <= to_date,
            DailyClose.is_deleted.isnot(True),
        )
        .order_by(DailyClose.date.desc())
        .all()
    )

    # Fetch branch names
    branches = db.query(Branch).filter(Branch.user_id == user.id, Branch.is_active.isnot(False)).all()
    branch_names = {str(b.id): b.name for b in branches}
    branch_names[None] = "No Branch"

    # Aggregate per branch
    per_branch = defaultdict(lambda: {
        "revenue_total": 0, "payment_total": 0, "cash_diff_total": 0,
        "tips_total": 0, "days_count": 0, "cash_diff_count": 0,
    })

    for dc in closes:
        bid = str(dc.branch_id) if dc.branch_id else None
        b = per_branch[bid]
        b["revenue_total"] += float(dc.revenue_total or 0)
        b["payment_total"] += float(dc.payment_total or 0)
        b["tips_total"] += float(dc.tips_total or 0)
        b["days_count"] += 1
        if dc.cash_difference is not None:
            b["cash_diff_total"] += float(dc.cash_difference)
            b["cash_diff_count"] += 1

    # Build response list
    results = []
    for bid, agg in per_branch.items():
        results.append({
            "branch_id": bid,
            "branch_name": branch_names.get(bid, bid or "Unknown"),
            "revenue_total": round(agg["revenue_total"], 2),
            "avg_daily_revenue": round(agg["revenue_total"] / agg["days_count"], 2) if agg["days_count"] else 0,
            "payment_total": round(agg["payment_total"], 2),
            "cash_diff_total": round(agg["cash_diff_total"], 2),
            "tips_total": round(agg["tips_total"], 2),
            "days_count": agg["days_count"],
        })

    # Sort by revenue descending (top performers first)
    results.sort(key=lambda x: x["revenue_total"], reverse=True)

    grand = {
        "revenue_total": round(sum(r["revenue_total"] for r in results), 2),
        "cash_diff_total": round(sum(r["cash_diff_total"] for r in results), 2),
        "tips_total": round(sum(r["tips_total"] for r in results), 2),
        "total_days": sum(r["days_count"] for r in results),
        "branch_count": len(results),
    }

    return {
        "from_date": from_date.isoformat(),
        "to_date": to_date.isoformat(),
        "branches": results,
        "grand_total": grand,
    }


# ─── GET — prefill from real sales/expenses/cash data ───

@router.get("/prefill")
def prefill_daily_close(
    target_date: date = Query(default=None, alias="date"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Pull today's actual sales/expenses/cash to pre-fill the daily close form."""
    if not target_date:
        target_date = date.today()

    # ── Sales total + by payment method ──
    sales_q = db.query(Sale).filter(
        Sale.user_id == user.id,
        Sale.date == target_date,
        Sale.is_deleted.isnot(True),
        Sale.status == "completed",
    )
    if branch_id:
        sales_q = sales_q.filter(Sale.branch_id == branch_id)

    sales_total = float(
        sales_q.with_entities(func.coalesce(func.sum(Sale.amount), 0)).scalar()
    )
    sales_count = sales_q.count()

    payment_rows = (
        sales_q.with_entities(Sale.payment_method, func.sum(Sale.amount).label("total"))
        .group_by(Sale.payment_method)
        .all()
    )
    by_payment = {}
    for method, total in payment_rows:
        key = (method or "other").lower()
        if key == "kontant":
            key = "cash"
        elif key == "dankort":
            key = "card"
        by_payment[key] = by_payment.get(key, 0) + round(float(total), 2)

    # ── Sales by item_name (for revenue breakdown hints) ──
    item_rows = (
        sales_q.filter(Sale.item_name.isnot(None))
        .with_entities(Sale.item_name, func.sum(Sale.amount).label("total"))
        .group_by(Sale.item_name)
        .all()
    )
    by_item = {name: round(float(total), 2) for name, total in item_rows}

    # ── Expenses by category ──
    expense_q = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(
            Expense.user_id == user.id,
            Expense.date == target_date,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
        )
    )
    if branch_id:
        expense_q = expense_q.filter(Expense.branch_id == branch_id)

    expense_rows = expense_q.group_by(ExpenseCategory.name).all()
    by_expense_cat = {name: round(float(total), 2) for name, total in expense_rows}
    expenses_total = sum(by_expense_cat.values())

    expenses_count = db.query(func.count(Expense.id)).filter(
        Expense.user_id == user.id,
        Expense.date == target_date,
        Expense.is_deleted.isnot(True),
        Expense.is_personal.isnot(True),
    ).scalar() or 0

    # ── Cash transactions ──
    cash_q = db.query(CashTransaction).filter(
        CashTransaction.user_id == user.id,
        CashTransaction.date == target_date,
        CashTransaction.is_deleted.isnot(True),
    )
    if branch_id:
        cash_q = cash_q.filter(CashTransaction.branch_id == branch_id)

    cash_in = float(
        cash_q.filter(CashTransaction.type == "cash_in")
        .with_entities(func.coalesce(func.sum(CashTransaction.amount), 0)).scalar()
    )
    cash_out = float(
        cash_q.filter(CashTransaction.type == "cash_out")
        .with_entities(func.coalesce(func.sum(CashTransaction.amount), 0)).scalar()
    )

    has_data = sales_count > 0 or expenses_count > 0

    # Night shift cutoff from business profile. DK-first default: an unset
    # cutoff → 06:00 (Europe/Copenhagen restaurant convention). An explicit
    # value (including 0) is respected; only a missing/None cutoff falls back
    # to 6 — the previous `or 0` forced midnight for new DK signups, which
    # pre-selected the wrong business day for a late-night closer.
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    _cut = getattr(profile, "day_cutoff_hour", None)
    cutoff = 6 if _cut is None else int(_cut)

    return {
        "date": target_date.isoformat(),
        "has_data": has_data,
        "day_cutoff_hour": cutoff,
        "sales": {
            "total": sales_total,
            "count": sales_count,
            "by_payment_method": by_payment,
            "by_item": by_item,
        },
        "expenses": {
            "total": expenses_total,
            "count": expenses_count,
            "by_category": by_expense_cat,
        },
        "cash": {
            "total_in": cash_in,
            "total_out": cash_out,
            "net": round(cash_in - cash_out, 2),
        },
        "suggested_prefill": {
            "revenue_total": sales_total,
            "payment_breakdown": by_payment,
            "cash_expected": by_payment.get("cash", 0),
        },
    }


# ─── POST — scan Z-report image ───

@router.post("/scan-report")
# Tightened 2026-05-28 with the Opus 4.7 OCR upgrade — now ~5x cost
# per call, so the per-IP burst limit drops AND a daily ceiling is
# added. 6/min handles legitimate multi-terminal owners (one Z-report
# per terminal at end of day); the 80/day per-IP ceiling defends
# against slow-and-steady abuse from a single IP across multiple
# accounts. The per-user PLAN_CAPS cap below enforces the tier limit
# (Free=3/day, Starter=20/day, Pro=100/day) independently.
@_limiter.limit("6/minute;80/day")
async def scan_z_report(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a Z-report / kasserapport photo and extract structured data via OCR.

    Multi-layer defense:
      L1 — auth (get_current_user dep).
      L2 — input bounds: content-type prefix check + 12MB size cap.
      L3 — rate limit (@_limiter.limit("12/minute") per IP). Tight
           because each call may run a Sonnet vision pass = real $.
      L4 — tenant scope: image bytes go to <user_id>/kasserapport/<sha>.jpg
           via the storage abstraction.
      L5 — daily quota: PLAN_CAPS["z_report_scans_per_day"] — Free=5/day,
           Starter=15/day, Pro=50/day. Refuses 429 when exceeded so a
           script can't drain Anthropic spend even within a single
           rate-limit window.
      L6 — audit trail: the resulting DailyClose row carries the
           image_url + receipt_photo path for §10 retention.
    """
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    file_bytes = await file.read()
    # Size cap matches kasserapport extractor (12 MB) — same threshold
    # everywhere the user might upload an image.
    if len(file_bytes) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 12 MB)")

    # L5 — per-tier daily quota (PLAN_CAPS["z_report_scans_per_day"]).
    plan = effective_plan(user) or "free"
    cap = get_cap(user, "z_report_scans_per_day")
    used = _today_scan_count(db, user)
    if used >= cap:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Daily Z-report scan limit reached ({used}/{cap}). "
                "Upgrade or try again tomorrow."
            ),
        )

    # Save the image (Supabase or local fallback). kind="kasserapport"
    # routes the storage path to <user_id>/kasserapport/<sha>.jpg so Z-
    # report photos sit in their own namespace separate from per-receipt
    # photos on individual sales / expenses.
    image_url = save_receipt_photo(
        file_bytes,
        file.filename or "z_report.jpg",
        str(user.id),
        kind="kasserapport",
    )

    # Resolve the local path for OCR processing
    # save_receipt_photo returns either a Supabase URL or a local path
    if image_url.startswith("http"):
        # Image was uploaded to Supabase — local copy is in uploads/receipts/
        import time
        from pathlib import Path
        local_dir = Path("uploads/receipts")
        # Find the most recent file for this user (saved moments ago)
        candidates = sorted(local_dir.glob(f"{user.id}_*.jpg"), key=lambda p: p.stat().st_mtime, reverse=True)
        if candidates:
            local_path = str(candidates[0])
        else:
            raise HTTPException(status_code=500, detail="Failed to save image for OCR processing")
    else:
        local_path = image_url

    # Parse the Z-report
    parsed = parse_z_report(local_path)
    parsed["image_url"] = image_url

    # When the specialized Z-report extractor ran, package the rich
    # fields into a `prefill` block the frontend uses to auto-populate
    # all three daily-close steps. The legacy keys (revenue / payments
    # / tips / moms_total / revenue_total) remain at the top level so
    # existing callers + the simple "Apply OCR" path still work.
    if parsed.get("doc_type") == "z_report":
        rb = parsed.get("revenue_breakdown") or {}
        pb = parsed.get("payment_breakdown") or {}
        per_clerk = parsed.get("per_clerk") or []
        cash_denoms = parsed.get("cash_denominations") or {}

        # Per-clerk earnings summary — frontend drops this into the
        # Notes field so the owner can spot-check vs. their schedule
        # (which is the most common kasserapport error class: clerk
        # logged into the wrong terminal).
        clerk_notes = None
        if per_clerk:
            clerk_lines = [
                f"{c.get('name') or c.get('id') or '?'}: "
                f"{c.get('total'):.2f} kr" if isinstance(c.get('total'), (int, float))
                else f"{c.get('name') or c.get('id') or '?'}: (uklart)"
                for c in per_clerk
            ]
            clerk_notes = "Pr. ekspedient: " + ", ".join(clerk_lines)

        parsed["prefill"] = {
            # Step 1 — Revenue breakdown
            "revenue_breakdown": {
                "food": rb.get("food"),
                "drinks": rb.get("drinks"),
                "other": rb.get("other"),
                "tips": rb.get("tips"),
                "surcharge": rb.get("surcharge"),
            },
            # Step 2 — Payment methods
            "payment_breakdown": {
                "cash": pb.get("cash"),
                "card": parsed.get("payments", {}).get("card"),
                "mobilepay": pb.get("mobilepay"),
                "softpay": pb.get("softpay"),
                "visa": pb.get("visa"),
                "mastercard": pb.get("mastercard"),
                "dankort": pb.get("dankort"),
            },
            # Step 3 — Cash drawer count + denomination breakdown
            "cash_drawer": {
                "counted_total": parsed.get("cash_counted_total"),
                "denominations": cash_denoms,
                "kasse_dif": parsed.get("kasse_dif"),
            },
            # Cross-check + Notes prefill
            "transactions": parsed.get("transactions") or {},
            "per_clerk": per_clerk,
            "per_clerk_notes": clerk_notes,
            "business_date": parsed.get("business_date"),
        }

    # ─── POS terminal auto-detect — Commit 2 + Commit 3 (2026-05-28) ────
    #
    # Layered defense:
    #   L4 fail-soft: the entire detection block is wrapped in try/except.
    #     Detection / persistence / silent-link / conflict-detection
    #     failure NEVER blocks the close ritual — the owner gets the
    #     prefill response either way.
    #   L6 fail-closed: conflict detection (Commit 3) never overwrites
    #     a provider_locked_by_owner=True terminal. Surfaces the mismatch
    #     in the response, audit-logs the event, lets the owner decide.
    #   L7 audit: terminal_provider_detected (always when detected),
    #     terminal_provider_auto_linked (silent link path),
    #     terminal_provider_conflict (Commit 3) — written via
    #     audit_service.record.
    #   L8 graceful: detect_provider returns None on catalog hiccup / no
    #     match; we just skip the chip + skip the silent link.
    #
    # The detection block also persists the scan-level extraction row.
    # This is the first time /scan-report writes a KasserapportExtraction
    # row directly (the /api/kasserapport endpoint also writes one, but
    # /scan-report previously never did). We log the detection result
    # whether or not detection succeeded, so the admin training review
    # has a row to compare against owner corrections in Commit 3.
    parsed["detected_provider"] = None
    parsed["conflict"] = None
    try:
        from app.services.terminal_provider_detector import detect_provider

        header_text = parsed.get("payment_terminal_header") or ""
        footer_text = parsed.get("payment_terminal_footer") or ""
        detection = detect_provider(
            db=db,
            header_text=header_text,
            footer_text=footer_text,
        )

        # Persist the FULL scan-level extraction row regardless of detection
        # outcome — this is the learning loop's raw material: extracted_json
        # (what the model read) is later compared to final_json (what the
        # owner saved on close) to reveal which POS layouts / fields get
        # misread. Reconciliation results (validator_failures / manual_review
        # / consistency) ride along from kasserapport_reconciliation via
        # parse_z_report. Wrapped so a persist failure never blocks the scan.
        try:
            import hashlib as _hashlib
            from app.services.claude_vision_ocr import Z_REPORT_PROMPT_VERSION
            _conf = parsed.get("confidence_per_field") or {}
            _overall = _conf.get("overall") if isinstance(_conf, dict) else None
            extraction_row = KasserapportExtraction(
                id=uuid.uuid4(),
                user_id=user.id,
                image_url=image_url,
                document_type=parsed.get("doc_type") or "unknown",
                pos_system=(detection["slug"] if detection else "unknown"),
                extraction_confidence=_overall,
                extracted_json={
                    "revenue_total": parsed.get("revenue_total"),
                    "moms_total": parsed.get("moms_total"),
                    "moms_rate": parsed.get("moms_rate"),
                    "revenue_breakdown": parsed.get("revenue_breakdown"),
                    "payment_breakdown": parsed.get("payment_breakdown"),
                    "cash_counted_total": parsed.get("cash_counted_total"),
                    "cash_denominations": parsed.get("cash_denominations"),
                    "per_clerk": parsed.get("per_clerk"),
                    "tips": parsed.get("tips"),
                    "surcharge": parsed.get("surcharge"),
                    "doc_type": parsed.get("doc_type"),
                    "business_date": parsed.get("business_date"),
                    "totals_inconsistent": parsed.get("totals_inconsistent", False),
                    "consistency_score": parsed.get("consistency_score"),
                    "confidence": _conf,
                    "notes": parsed.get("claude_notes"),
                    "provider": parsed.get("_provider"),
                    "payment_terminal_header": header_text or None,
                    "payment_terminal_footer": footer_text or None,
                },
                validator_failures=parsed.get("validator_failures") or [],
                manual_review_needed=bool(parsed.get("manual_review_needed", False)),
                image_sha256=_hashlib.sha256(file_bytes).hexdigest(),
                prompt_version=Z_REPORT_PROMPT_VERSION,
                detected_provider_slug=detection["slug"] if detection else None,
                detected_provider_confidence=(
                    detection["confidence"] if detection else None
                ),
            )
            db.add(extraction_row)
            # Commit NOW, independent of detection. Previously the only commit
            # lived inside the `if detection:` branch below, so a scan with no
            # detected provider — the common case — silently rolled back and
            # the table stayed empty. Surface the row id so the close-save can
            # stamp final_json back onto this exact extraction.
            db.commit()
            db.refresh(extraction_row)
            parsed["extraction_id"] = str(extraction_row.id)
        except Exception as e:  # noqa: BLE001
            # Persistence failure must NOT block the scan — the owner still
            # gets their prefill + detection chip; we just lose the audit-
            # history row for this scan.
            logger.warning(
                "scan-report: extraction-row persist failed: %s", e,
            )
            db.rollback()
            extraction_row = None
            parsed["extraction_id"] = None

        unlinked_count = 0
        if detection:
            # L7 audit — we detected something. Log it even at low
            # confidence; the admin review needs the full picture, not
            # just the high-confidence wins.
            audit_service.record(
                db=db,
                user=user,
                action="terminal_provider_detected",
                entity_type="kasserapport_extraction",
                entity_id=extraction_row.id if extraction_row else None,
                after={
                    "slug": detection["slug"],
                    "confidence": round(float(detection["confidence"]), 2),
                },
                ip_address=request.client.host if request.client else None,
            )

            # ─── Commit 3 conflict detection ────────────────────────────
            # If the owner has any terminal locked to a DIFFERENT provider
            # than what we just detected, raise a conflict flag. The
            # frontend renders an amber warning above the prefill so the
            # owner can decide: was a backup terminal used today, or did
            # someone hand us the wrong receipt? Crucial: we DO NOT
            # overwrite a locked provider — L6 fail-closed doctrine.
            #
            # Scope: only locked-by-owner terminals count for conflict.
            # An auto-linked-but-unconfirmed terminal (provider_id set
            # but provider_locked_by_owner=False) is fair game for the
            # detector to flip — the owner never asserted ownership.
            #
            # Picks the first conflicting terminal; if the owner has
            # multiple locked terminals all pointing somewhere different,
            # one warning is enough — the Connections page lets them
            # audit the rest.
            try:
                # Multi-terminal short-circuit (audit R2 hotfix):
                # If ANY of the user's linked terminals already matches
                # the detected provider, the scan is consistent with
                # their setup — don't flag the *other* terminals as
                # conflicts. Multi-terminal cafés (Pro tier) commonly
                # run Nets + Worldline side by side; a Nets scan is
                # not a conflict against the Worldline terminal.
                any_matches_detected = (
                    db.query(Terminal.id)
                    .filter(
                        Terminal.user_id == user.id,
                        Terminal.is_deleted.isnot(True),
                        Terminal.provider_id == detection["provider_id"],
                    )
                    .first()
                    is not None
                )
                locked_others = (
                    []
                    if any_matches_detected
                    else (
                        db.query(Terminal)
                        .filter(
                            Terminal.user_id == user.id,
                            Terminal.is_deleted.isnot(True),
                            Terminal.provider_locked_by_owner.is_(True),
                            Terminal.provider_id.isnot(None),
                            Terminal.provider_id != detection["provider_id"],
                        )
                        .all()
                    )
                )
                if locked_others:
                    current = locked_others[0]
                    cur_prov = current.provider  # joined relationship
                    parsed["conflict"] = {
                        "detected": {
                            "slug": detection["slug"],
                            "display_name": detection["display_name"],
                            "confidence": round(
                                float(detection["confidence"]), 2,
                            ),
                        },
                        "current": {
                            "slug": getattr(cur_prov, "slug", None),
                            "display_name": getattr(
                                cur_prov, "display_name", None,
                            ),
                            "terminal_id": str(current.id),
                            "terminal_name": current.name,
                        },
                    }
                    # L7 audit — the conflict event is on the terminal
                    # the owner had locked, not on the detection row, so
                    # a future "show me every dispute on this terminal"
                    # query lands the right history.
                    audit_service.record(
                        db=db,
                        user=user,
                        action="terminal_provider_conflict",
                        entity_type="terminal",
                        entity_id=current.id,
                        after={
                            "detected_slug": detection["slug"],
                            "detected_confidence": round(
                                float(detection["confidence"]), 2,
                            ),
                            "current_slug": getattr(cur_prov, "slug", None),
                            "locked_by_owner": True,
                        },
                        ip_address=(
                            request.client.host if request.client else None
                        ),
                    )
            except Exception as e:  # noqa: BLE001
                # L8 graceful — conflict check failure must not block
                # the close. Owner just won't see the warning tag this
                # scan; the silent-link block below still won't fire
                # against a locked terminal because Commit 2 already
                # gates that on provider_id IS NULL.
                logger.warning(
                    "scan-report: conflict check failed (non-fatal): %s", e,
                )

            # Silent link — only when confidence is high enough AND the
            # ambiguity is gone (exactly one unlinked terminal). Two
            # unlinked terminals = we can't pick automatically; Commit 3
            # adds the owner confirm UX for that case.
            if float(detection["confidence"]) >= 0.85:
                unlinked = (
                    db.query(Terminal)
                    .filter(
                        Terminal.user_id == user.id,
                        Terminal.is_deleted.isnot(True),
                        Terminal.provider_id.is_(None),
                    )
                    .all()
                )
                unlinked_count = len(unlinked)
                if unlinked_count == 1:
                    target = unlinked[0]
                    from decimal import Decimal as _Decimal
                    target.provider_id = detection["provider_id"]
                    target.provider_confidence = _Decimal(
                        f"{float(detection['confidence']):.2f}"
                    )
                    audit_service.record(
                        db=db,
                        user=user,
                        action="terminal_provider_auto_linked",
                        entity_type="terminal",
                        entity_id=target.id,
                        after={
                            "provider_slug": detection["slug"],
                            "confidence": round(
                                float(detection["confidence"]), 2,
                            ),
                        },
                        ip_address=(
                            request.client.host if request.client else None
                        ),
                    )

            # Commit the audit + extraction + (possibly) the linked
            # Terminal mutation in one atomic write. Wrap commit too so
            # a DB hiccup at the very end can't crash the close ritual.
            try:
                db.commit()
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "scan-report: detection commit failed: %s", e,
                )
                db.rollback()

            # Chip data — only surfaced when confidence is high enough
            # to be actionable. < 0.60 returns null detection so the
            # frontend skips the chip entirely. Commit 3 adds the
            # provider_id to the payload so the Confirm button can
            # POST link-provider without a separate catalog round-trip.
            if float(detection["confidence"]) >= 0.60:
                parsed["detected_provider"] = {
                    "provider_id": str(detection["provider_id"]),
                    "slug": detection["slug"],
                    "display_name": detection["display_name"],
                    "confidence": round(float(detection["confidence"]), 2),
                    "auto_linked": (
                        float(detection["confidence"]) >= 0.85
                        and unlinked_count == 1
                    ),
                }
    except Exception as e:  # noqa: BLE001
        # L4 fail-soft: any failure in the detection pathway gets logged
        # but never blocks the close. The owner still sees their OCR'd
        # prefill — they just don't get the chip this scan.
        logger.warning(
            "scan-report: provider auto-detect failed (non-fatal): %s", e,
        )
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass

    return parsed


# ─── GET — date-range PDF / CSV export (accountant handoff) ───
#
# These two endpoints aggregate a date range into a single document so
# the owner can hand off a week / month / quarter to the accountant in
# one click. Distinct from /{close_id}/pdf (single close, polished
# receipt) — this is the "weekly review" / "month-end" format with
# totals + averages.
#
# Path order: declared BEFORE /{close_id} so FastAPI matches the
# literal "export.pdf" / "export.csv" path before falling through to
# the parametric close_id.

# Hard ceiling — defense-in-depth above any per-tier cap.
# 366 covers leap years + a comfortable yearly review; anything
# longer should be done in chunks. Per-tier caps below this further
# narrow the window for free / starter tiers.
_MAX_RANGE_DAYS = 366

# Plan labels used in the upgrade prompts surfaced to the user when
# they hit the per-tier cap. Kept here rather than in billing.py
# because the wording is feature-specific (kasserapport context).
# Three purchasable tiers + the trial state — Business was dropped
# May 2026.
_PLAN_LABELS = {
    "free": "Free",
    "starter": "Starter",
    "trial": "Trial (Pro)",
    "pro": "Pro",
}


def _resolve_range(
    from_date: date | None,
    to_date: date | None,
    *,
    user: User | None = None,
) -> tuple[date, date]:
    """Validate + default the (from, to) inputs and enforce plan cap.

    Defaults: today minus 30 days → today.
    Raises 422 if from > to.
    Raises 422 if span exceeds the hard ceiling (_MAX_RANGE_DAYS).
    Raises 402 if span exceeds the user's per-tier cap (Free=7d,
    Starter=31d, Pro=366d) — frontend uses 402 as the trigger to
    show the upgrade CTA distinctly from generic validation errors.
    """
    if not to_date:
        to_date = date.today()
    if not from_date:
        from_date = to_date - timedelta(days=30)
    if from_date > to_date:
        raise HTTPException(
            status_code=422,
            detail="Invalid date range: 'from' must be on or before 'to'.",
        )
    span = (to_date - from_date).days + 1
    if span > _MAX_RANGE_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"Date range too large ({span} days). Max is {_MAX_RANGE_DAYS} days.",
        )

    # Per-tier cap. -1 = unlimited (we still respect _MAX_RANGE_DAYS).
    if user is not None:
        plan = effective_plan(user)
        cap = get_cap(user, "daily_close_export_days")
        if cap > 0 and span > cap:
            tier_label = _PLAN_LABELS.get(plan, plan.title())
            raise HTTPException(
                status_code=402,  # Payment Required — distinct from 422
                detail={
                    "code": "plan_cap_exceeded",
                    "message": (
                        f"{tier_label} plan exports up to {cap} days. "
                        f"Upgrade to Pro to export the full year."
                    ),
                    "cap_days": cap,
                    "requested_days": span,
                    "plan": plan,
                },
            )

    return from_date, to_date


def _fetch_range_closes(
    db: Session, *, user_id, from_date: date, to_date: date,
    branch_id: str | None,
) -> list[DailyClose]:
    """Tenant-scoped fetch of closes in the requested range."""
    q = db.query(DailyClose).filter(
        DailyClose.user_id == user_id,
        DailyClose.is_deleted.isnot(True),
        DailyClose.date >= from_date,
        DailyClose.date <= to_date,
    )
    if branch_id:
        q = q.filter(DailyClose.branch_id == branch_id)
    return q.order_by(DailyClose.date.asc()).all()


@router.get("/export.pdf")
@_limiter.limit("5/minute")
def export_range_pdf(
    request: Request,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Multi-day daily-close PDF for accountant handoff.

    Layered defense (same shape as scan-report):
      L1 auth → L2 input bounds (max 366d) → L3 rate limit (5/min)
      L4 tenant scope (user_id filter) → L5 plan cap (Free=7d /
      Starter=31d / Pro=366d) — returns 402 with upgrade context
      when exceeded. L6 the file is streamed not stored — no audit
      row.
    """
    f, t = _resolve_range(from_date, to_date, user=user)
    closes = _fetch_range_closes(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )

    # Business name for the title page — falls back through profile, user,
    # then a generic label so the PDF always has something readable.
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    business_name = (
        (profile.business_name if profile and profile.business_name else None)
        or getattr(user, "business_name", None)
        or "Daily Close Report"
    )
    currency = user.currency or "DKK"

    pdf_bytes = build_daily_close_range_pdf(
        closes, from_date=f, to_date=t,
        business_name=business_name, currency=currency,
        profile=profile, db=db, user_id=user.id,
    )
    filename = f"daily-close_{f.isoformat()}_to_{t.isoformat()}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/export.csv")
@_limiter.limit("10/minute")
def export_range_csv(
    request: Request,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Multi-day daily-close CSV. UTF-8 + BOM + semicolon delimiter so
    Danish Excel opens it cleanly with Æ/Ø/Å intact. Encoded breakdown
    columns ("food:12400|drinks:5800") so the accountant can re-import
    or pivot in Excel.

    Same plan-cap logic as the PDF endpoint — 402 with upgrade
    context when over-tier."""
    f, t = _resolve_range(from_date, to_date, user=user)
    closes = _fetch_range_closes(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )
    csv_bytes = closes_to_csv_bytes(closes)
    filename = f"daily-close_{f.isoformat()}_to_{t.isoformat()}.csv"
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/export.xlsx")
@_limiter.limit("10/minute")
def export_range_xlsx(
    request: Request,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Multi-day daily-close Excel workbook for accountant handoff.

    Two-sheet workbook:
      • Summary  — business header, period, KPI totals (confirmed only)
      • Daily    — one row per close with typed columns (numbers as
                   numbers, dates as dates), frozen header, totals row
                   built from SUM() formulas so the accountant can edit
                   rows and totals stay correct.

    Accountants strongly prefer XLSX over PDF because they can sort,
    filter, and pivot. We keep PDF + CSV available for the
    "lightweight share" and "raw import" flows respectively.

    Same plan-cap logic as PDF/CSV (Free=7d / Starter=31d / Pro=366d).
    """
    f, t = _resolve_range(from_date, to_date, user=user)
    closes = _fetch_range_closes(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )

    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    business_name = (
        getattr(profile, "company_name", None)
        or getattr(user, "business_name", None)
        or "Daily Close Report"
    )
    currency = user.currency or "DKK"

    xlsx_bytes = build_daily_close_range_xlsx(
        closes, from_date=f, to_date=t,
        business_name=business_name, currency=currency,
        profile=profile, db=db, user_id=user.id,
    )
    filename = f"daily-close_{f.isoformat()}_to_{t.isoformat()}.xlsx"
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


# ─────────────────────── Send-to-accountant ───────────────────────
#
# One-tap email of the daily-close range to the accountant. We
# generate the chosen format server-side, attach it to a Resend email
# addressed to BusinessProfile.accountant_email, set reply_to to the
# user's own email so the accountant can hit Reply and reach the
# owner directly (not noreply@bonbox.dk), and return success/failure.
#
# Falls back to a friendly 400 if the user hasn't set an accountant
# email — the frontend then offers the existing mailto/share path.


class SendToAccountantRequest(BaseModel):
    fmt: str = Field(default="xlsx", pattern="^(pdf|csv|xlsx)$")
    # Optional override — if omitted, we use BusinessProfile.accountant_email
    accountant_email: EmailStr | None = None
    # Free-text message the user wants to include in the email body
    message: str | None = Field(default=None, max_length=2000)
    # cc the user's own email so they have a copy for their records
    cc_self: bool = True


def _accountant_email_body(*, business_name: str, from_iso: str, to_iso: str,
                          n_closes: int, currency: str, total_revenue: float,
                          total_moms: float, fmt: str, message: str | None,
                          is_danish: bool) -> str:
    """Build the HTML body for the accountant email.

    Danish for DKK currency, English otherwise. Includes the two
    numbers that matter most for the accountant (revenue + MOMS) so
    they can verify the attachment lines up before opening it.
    """
    if is_danish:
        greeting = "Hej,"
        intro = (
            f"Vedhæftet finder du kasserapporten for <strong>{business_name}</strong> "
            f"for perioden <strong>{from_iso} → {to_iso}</strong> "
            f"({n_closes} lukninger)."
        )
        kpi_label_rev = "Omsætning"
        kpi_label_moms = "Salgsmoms (25%)"
        footer = (
            "Filen er sendt direkte fra BonBox. "
            "Svar på denne mail for at kontakte ejeren."
        )
        format_note = {
            "pdf":  "Format: PDF (én-sides oversigt).",
            "xlsx": "Format: Excel (sortérbar, filtrérbar — anbefalet til bogføring).",
            "csv":  "Format: CSV (rå data — kan importeres i e-conomic, Dinero, Billy).",
        }[fmt]
    else:
        greeting = "Hello,"
        intro = (
            f"Attached is the daily-close report for <strong>{business_name}</strong> "
            f"for the period <strong>{from_iso} → {to_iso}</strong> "
            f"({n_closes} closes)."
        )
        kpi_label_rev = "Revenue"
        kpi_label_moms = "Output VAT (25%)"
        footer = (
            "Sent directly from BonBox. "
            "Reply to this email to reach the owner."
        )
        format_note = {
            "pdf":  "Format: PDF (one-page summary).",
            "xlsx": "Format: Excel (sortable, filterable — recommended for bookkeeping).",
            "csv":  "Format: CSV (raw data — can be imported into e-conomic / Dinero / Billy).",
        }[fmt]

    def _fmt(v):
        if is_danish:
            return f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        return f"{v:,.2f}"

    user_note_html = ""
    if (message or "").strip():
        # Escape user-provided text — never let it inject HTML
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
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{kpi_label_rev}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>{_fmt(total_revenue)} {currency}</td></tr>"
        f"<tr><td style='padding:4px 16px 4px 0;color:#6b7280;'>{kpi_label_moms}</td>"
        f"<td style='padding:4px 0;font-weight:600;text-align:right;'>{_fmt(total_moms)} {currency}</td></tr>"
        "</table>"
        f"<p style='color:#6b7280;font-size:13px;margin-top:16px;'>{format_note}</p>"
        f"<p style='color:#6b7280;font-size:13px;'>{footer}</p>"
        "</div>"
    )


@router.post("/send-to-accountant")
@_limiter.limit("5/minute")
def send_to_accountant(
    request: Request,
    body: SendToAccountantRequest,
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    branch_id: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Email the daily-close range to the accountant. Starter+ feature.

    Free users hit a structured 402 the frontend uses to render the
    UpgradeNudge dialog. Free users CAN still download Excel/PDF/CSV
    and attach via mailto — only the one-tap server-side Resend send
    is gated. The mailto fallback in the frontend handles them.

    Layered defense (same shape as scan-report + export endpoints):
      L1 auth → L2 input bounds → L3 rate limit (5/min) →
      L4 tenant scope → L5 plan-feature gate → L6 attachment-size cap
    """
    # Tier gate (Polish Pass tier reshuffle — Starter+ killer feature)
    from app.services.billing import has_feature, effective_plan
    if not has_feature(user, "direct_accountant_email"):
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "feature": "direct_accountant_email",
                "required_plan": "starter",
                "current_plan": effective_plan(user),
                "message": (
                    "Direct email to your accountant is on Starter. "
                    "You can still download the file and attach it manually."
                ),
            },
        )

    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()

    # Pick recipient: body override wins, else profile, else 400
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

    # Resolve + fetch closes (reuses the same range-resolution + plan-cap
    # logic as the export endpoints below)
    f, t = _resolve_range(from_date, to_date, user=user)
    closes = _fetch_range_closes(
        db, user_id=user.id, from_date=f, to_date=t, branch_id=branch_id,
    )

    business_name = (
        getattr(profile, "company_name", None)
        or getattr(user, "business_name", None)
        or "Daily Close Report"
    )
    currency = user.currency or "DKK"
    fmt = body.fmt

    # Build the attachment bytes per the chosen format
    if fmt == "pdf":
        attachment = build_daily_close_range_pdf(
            closes, from_date=f, to_date=t,
            business_name=business_name, currency=currency,
            profile=profile, db=db, user_id=user.id,
        )
        mime = "application/pdf"
        ext = "pdf"
    elif fmt == "csv":
        attachment = closes_to_csv_bytes(closes)
        mime = "text/csv; charset=utf-8"
        ext = "csv"
    else:  # xlsx
        attachment = build_daily_close_range_xlsx(
            closes, from_date=f, to_date=t,
            business_name=business_name, currency=currency,
            profile=profile, db=db, user_id=user.id,
        )
        mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ext = "xlsx"

    filename = f"daily-close_{f.isoformat()}_to_{t.isoformat()}.{ext}"

    # Subject + body — confirmed-only totals so what the accountant
    # sees in the email body matches what's in the attachment's totals row.
    confirmed = [c for c in closes if (getattr(c, "status", None) or "confirmed") == "confirmed"]
    n_conf = len(confirmed)
    total_revenue = sum(float(c.revenue_total or 0) for c in confirmed)
    total_moms = sum(float(c.moms_total or 0) for c in confirmed)
    is_danish = (currency == "DKK")

    subject_prefix = "Kasserapport" if is_danish else "Daily Close"
    subject = f"{subject_prefix} {f.isoformat()} → {t.isoformat()} — {business_name}"

    html = _accountant_email_body(
        business_name=business_name,
        from_iso=f.isoformat(), to_iso=t.isoformat(),
        n_closes=n_conf, currency=currency,
        total_revenue=total_revenue, total_moms=total_moms,
        fmt=fmt, message=body.message, is_danish=is_danish,
    )

    # Send via Resend with attachment. reply_to is the user's own email
    # so the accountant can hit Reply and reach the owner directly.
    from app.services.email_service import send_email_with_attachment

    cc = [user.email] if (body.cc_self and user.email) else None
    ok, err = send_email_with_attachment(
        recipient, subject, html,
        attachment_bytes=attachment,
        attachment_filename=filename,
        attachment_mime=mime,
        reply_to=user.email,
        cc=cc,
    )

    if not ok:
        # 503 so the frontend can fall back to the existing mailto flow
        raise HTTPException(
            status_code=503,
            detail={
                "code": "email_send_failed",
                "reason": err or "unknown",
                "message": "Couldn't send email right now. The file is still available to download or share.",
            },
        )

    # Bogføringsloven §10 — record that the period bundle was delivered to a
    # third party. The accountant relationship is auditable; capture WHO got
    # WHAT (recipient, range, totals) so disputes / regulator queries can
    # reconstruct delivery history later.
    audit_service.record(
        db, user=user,
        action="daily_close.send_to_accountant",
        entity_type="daily_close_range",
        entity_id=None,  # range-level action, not single-row
        before=None,
        after={
            "recipient": recipient, "cc_self": bool(cc), "format": fmt,
            "filename": filename, "n_closes": n_conf,
            "from_date": f.isoformat(), "to_date": t.isoformat(),
            "total_revenue": total_revenue, "total_moms": total_moms,
        },
        ip_address=getattr(request.client, "host", None) if request.client else None,
    )
    db.commit()

    return {
        "ok": True,
        "sent_to": recipient,
        "cc_self": bool(cc),
        "filename": filename,
        "format": fmt,
        "n_closes": n_conf,
        "subject": subject,
    }


# ─── GET — single close ───

@router.get("/{close_id}")
def get_daily_close(
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    return _to_response(dc)


# ─── GET — PDF Kasserapport ───

@router.get("/{close_id}/pdf")
def daily_close_pdf(
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Kasserapport PDF — Copenhagen-clean format for accountant handover.

    Layout principles:
      - Generous whitespace (22mm margins)
      - No heavy black header bands; sections separated by hairline rules
      - Helvetica throughout; right-aligned numbers
      - Danish number format (1.234,56)
      - MOMS section explicit so accountant doesn't have to recompute
    """
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")

    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()

    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, HRFlowable,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_RIGHT

    # Copenhagen-clean palette
    INK = colors.HexColor("#171717")
    MUTED = colors.HexColor("#6b7280")
    DIVIDER = colors.HexColor("#e5e7eb")
    DANGER = colors.HexColor("#b91c1c")

    currency = user.currency or "DKK"

    # ── Locale-aware labels ──
    # Danish content for DKK users — that's what the revisor reads, and per
    # Bogføringsloven §8 the "regnskabsmateriale" should be in Danish or
    # English. Other currencies fall back to English.
    DA = (currency == "DKK")
    L = {
        "title":         "KASSERAPPORT",
        "revenue":       "OMSÆTNING" if DA else "REVENUE BREAKDOWN",
        "total_revenue": "Omsætning i alt" if DA else "Total revenue",
        "moms_title":    "MOMS — SALG" if DA else "VAT — SALES",
        "moms_incl":     "Omsætning (inkl. moms)" if DA else "Revenue (incl. VAT)",
        "moms_vat":      "Salgsmoms (25 %)" if DA else "Output VAT",
        "moms_excl":     "Omsætning (ekskl. moms)" if DA else "Revenue (excl. VAT)",
        "moms_manual":   "Moms angivet manuelt af kasseansvarlig." if DA
                         else "VAT entered manually by closer.",
        "payments":      "BETALINGSMETODER" if DA else "PAYMENT METHODS",
        "total_pay":     "Betalinger i alt" if DA else "Total payments",
        "cash":          "KASSEBEHOLDNING" if DA else "CASH DRAWER",
        "cash_expected": "Forventet (fra bilag)" if DA else "Expected (from receipts)",
        "cash_counted":  "Optalt" if DA else "Counted",
        "cash_diff":     "Difference" if DA else "Difference",
        "tips":          "DRIKKEPENGE" if DA else "TIPS",
        "tips_total":    "Drikkepenge i alt" if DA else "Total tips",
        "tips_staff":    "Antal medarbejdere" if DA else "Staff count",
        "tips_pp":       "Pr. medarbejder" if DA else "Per person",
        "tips_note":     ("Drikkepenge skal indberettes via eIndkomst. "
                          "Del med dit lønsystem.") if DA
                         else "Tips must be reported via eIndkomst. Share with your payroll system.",
        "vouchers":      "BILAGSNUMRE" if DA else "VOUCHER NUMBERS",
        "v_sales":       "Salgsbilag" if DA else "Sales vouchers",
        "v_exp":         "Udgiftsbilag" if DA else "Expense vouchers",
        "notes":         "BEMÆRKNINGER" if DA else "NOTES",
        "ready":         "KLAR TIL BOGFØRING" if DA else "READY FOR BOOKKEEPING",
        "ready_sub":     ("Salgsmoms beregnet, kontant afstemt, bilagsnumre i orden.") if DA
                         else "VAT calculated, cash reconciled, voucher numbers in order.",
        "review":        "GENNEMGÅS" if DA else "NEEDS REVIEW",
        "footer_gen":    "Genereret af BonBox" if DA else "Generated by BonBox",
        "footer_use":    ("Anvendes sammen med dit bogføringssystem.") if DA
                         else "Use this report alongside your accounting software.",
    }

    def fmt(v):
        if v is None:
            return "—"
        # Danish number format: 1.234,56 (with thin space before currency)
        formatted = f"{float(v):,.2f}"
        return f"{formatted.replace(',', 'X').replace('.', ',').replace('X', '.')} {currency}"

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=22 * mm, bottomMargin=18 * mm,
        leftMargin=22 * mm, rightMargin=22 * mm,
        title="Kasserapport",
    )
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Title"], fontSize=14, spaceAfter=2,
                        textColor=INK, fontName="Helvetica-Bold")
    h_period = ParagraphStyle("Period", parent=styles["Normal"], fontSize=9,
                              textColor=MUTED, alignment=TA_RIGHT)
    section_title = ParagraphStyle("Sect", parent=styles["Normal"], fontSize=8.5,
                                   textColor=MUTED, fontName="Helvetica-Bold",
                                   leading=12, spaceBefore=10, spaceAfter=4)
    val = ParagraphStyle("Val", parent=styles["Normal"], fontSize=10.5,
                         textColor=INK, fontName="Helvetica", leading=14)
    val_r = ParagraphStyle("ValR", parent=val, alignment=TA_RIGHT)
    val_b = ParagraphStyle("ValB", parent=val, fontName="Helvetica-Bold")
    val_br = ParagraphStyle("ValBR", parent=val_b, alignment=TA_RIGHT)
    foot = ParagraphStyle("Foot", parent=styles["Normal"], fontSize=8,
                          textColor=MUTED, fontName="Helvetica-Oblique", leading=11)

    story = []

    # ─── Header: title + date ───
    # Danish-style date format: "16. maj 2026" for DKK, "16 May 2026" else
    if DA:
        _DA_MONTHS = ["januar", "februar", "marts", "april", "maj", "juni",
                      "juli", "august", "september", "oktober", "november", "december"]
        date_str = f"{dc.date.day}. {_DA_MONTHS[dc.date.month - 1]} {dc.date.year}"
    else:
        date_str = dc.date.strftime("%d %B %Y")
    head_table = Table(
        [[Paragraph(L["title"], h1), Paragraph(date_str, h_period)]],
        colWidths=[100 * mm, 66 * mm],
    )
    head_table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    story.append(head_table)
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=4, spaceAfter=12))

    # ─── Voucher range for the day (Bogføringsloven 2024 audit trail) ───
    # If sales/expenses for this date have voucher_numbers, show min-max range
    # so accountant can cross-check the closes against the bilag list.
    try:
        from app.models.sale import Sale
        from app.models.expense import Expense
        sale_vmin, sale_vmax = (
            db.query(func.min(Sale.voucher_number), func.max(Sale.voucher_number))
            .filter(
                Sale.user_id == user.id,
                Sale.date == dc.date,
                Sale.voucher_number.is_not(None),
                Sale.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
        exp_vmin, exp_vmax = (
            db.query(func.min(Expense.voucher_number), func.max(Expense.voucher_number))
            .filter(
                Expense.user_id == user.id,
                Expense.date == dc.date,
                Expense.voucher_number.is_not(None),
                Expense.is_deleted.isnot(True),
            )
            .one_or_none() or (None, None)
        )
    except Exception:  # noqa: BLE001
        sale_vmin = sale_vmax = exp_vmin = exp_vmax = None

    # ─── Business info ───
    # BusinessProfile uses `company_name` (CVR-style legal entity name);
    # User uses `business_name` (signup-time DBA). Profile wins if both set
    # because that's the legal name an accountant needs on the kasserapport.
    profile_name = getattr(profile, "company_name", None) if profile else None
    biz_name = (profile_name
                or getattr(user, "business_name", None)
                or "—")
    biz_lines = [f"<font name='Helvetica-Bold' size='10.5'>{biz_name}</font>"]
    if profile:
        addr_parts = [p for p in [profile.address,
                                  " ".join(p for p in [getattr(profile, "zipcode", None),
                                                       getattr(profile, "city", None)] if p)]
                      if p]
        if addr_parts:
            biz_lines.append(f"<font color='#6b7280'>{', '.join(addr_parts)}</font>")
        if getattr(profile, "org_number", None):
            biz_lines.append(f"<font color='#6b7280'>CVR {profile.org_number}</font>")
    if dc.closed_by:
        biz_lines.append(f"<font color='#6b7280'>Closed by: {dc.closed_by}</font>")
    story.append(Paragraph("<br/>".join(biz_lines), val))
    story.append(Spacer(1, 6 * mm))

    # ─── Revenue Breakdown ───
    rev = decode_breakdown(dc.revenue_categories)
    if rev:
        story.append(Paragraph(L["revenue"], section_title))
        rows = []
        for k, v in rev.items():
            rows.append([Paragraph(k.title(), val), Paragraph(fmt(v), val_r)])
        rows.append([Paragraph(L["total_revenue"], val_b),
                     Paragraph(fmt(float(dc.revenue_total or 0)), val_br)])
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)

    # ─── MOMS / VAT (added — was missing in old PDF) ───
    if dc.moms_total is not None or dc.revenue_ex_moms is not None:
        story.append(Paragraph(L["moms_title"], section_title))
        moms_rows = [
            [Paragraph(L["moms_incl"], val), Paragraph(fmt(float(dc.revenue_total or 0)), val_r)],
            [Paragraph(L["moms_vat"], val), Paragraph(fmt(float(dc.moms_total or 0)), val_r)],
            [Paragraph(L["moms_excl"], val_b),
             Paragraph(fmt(float(dc.revenue_ex_moms or 0)), val_br)],
        ]
        t = Table(moms_rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)
        if dc.moms_mode == "manual":
            story.append(Spacer(1, 2 * mm))
            story.append(Paragraph(L["moms_manual"], foot))

    # ─── Payment Methods ───
    pay = decode_breakdown(dc.payment_categories)
    if pay:
        story.append(Paragraph(L["payments"], section_title))
        rows = []
        for k, v in pay.items():
            rows.append([Paragraph(k.replace("_", " ").title(), val), Paragraph(fmt(v), val_r)])
        rows.append([Paragraph(L["total_pay"], val_b),
                     Paragraph(fmt(float(dc.payment_total or 0)), val_br)])
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)

    # ─── Cash Drawer ───
    if dc.cash_counted is not None:
        story.append(Paragraph(L["cash"], section_title))
        diff = float(dc.cash_difference or 0)
        diff_style = ParagraphStyle("Diff", parent=val_br,
                                    textColor=DANGER if abs(diff) > 100 else INK)
        rows = [
            [Paragraph(L["cash_expected"], val), Paragraph(fmt(dc.cash_expected), val_r)],
            [Paragraph(L["cash_counted"], val), Paragraph(fmt(dc.cash_counted), val_r)],
            [Paragraph(L["cash_diff"], val_b), Paragraph(fmt(dc.cash_difference), diff_style)],
        ]
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)

    # ─── Tips ───
    if dc.tips_total:
        story.append(Paragraph(L["tips"], section_title))
        rows = [
            [Paragraph(L["tips_total"], val), Paragraph(fmt(dc.tips_total), val_r)],
            [Paragraph(L["tips_staff"], val),
             Paragraph(str(dc.tips_staff_count or "—"), val_r)],
            [Paragraph(L["tips_pp"], val_b), Paragraph(fmt(dc.tips_per_person), val_br)],
        ]
        t = Table(rows, colWidths=[110 * mm, 56 * mm])
        t.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEABOVE", (0, -1), (-1, -1), 0.5, DIVIDER),
        ]))
        story.append(t)
        story.append(Spacer(1, 2 * mm))
        story.append(Paragraph(L["tips_note"], foot))

    # ─── Bilagsnummer audit trail (DK Bogføringsloven 2024) ───
    if currency == "DKK" and (sale_vmin or exp_vmin):
        story.append(Paragraph(L["vouchers"], section_title))
        rows = []
        if sale_vmin and sale_vmax:
            label = (f"S-{dc.date.year}-{sale_vmin:04d} → S-{dc.date.year}-{sale_vmax:04d}"
                     if sale_vmin != sale_vmax
                     else f"S-{dc.date.year}-{sale_vmin:04d}")
            rows.append([Paragraph(L["v_sales"], val), Paragraph(label, val_r)])
        if exp_vmin and exp_vmax:
            label = (f"E-{dc.date.year}-{exp_vmin:04d} → E-{dc.date.year}-{exp_vmax:04d}"
                     if exp_vmin != exp_vmax
                     else f"E-{dc.date.year}-{exp_vmin:04d}")
            rows.append([Paragraph(L["v_exp"], val), Paragraph(label, val_r)])
        if rows:
            t = Table(rows, colWidths=[110 * mm, 56 * mm])
            t.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.append(t)

    # ─── Notes ───
    if dc.notes:
        story.append(Paragraph(L["notes"], section_title))
        story.append(Paragraph(dc.notes, val))

    # ─── Accountant readiness badge ───
    # Three pre-flight checks an accountant cares about:
    #   1. MOMS calculated (or N/A for non-DKK)
    #   2. Cash drawer reconciled within 100 DKK tolerance (or N/A)
    #   3. Status confirmed (not draft)
    moms_ok = (dc.moms_total is not None) or (currency != "DKK")
    cash_ok = (dc.cash_counted is None) or (abs(float(dc.cash_difference or 0)) <= 100)
    status_ok = (dc.status == "confirmed")
    all_ok = moms_ok and cash_ok and status_ok

    story.append(Spacer(1, 10 * mm))
    badge_color = colors.HexColor("#065f46") if all_ok else colors.HexColor("#92400e")
    badge_bg = colors.HexColor("#d1fae5") if all_ok else colors.HexColor("#fef3c7")
    badge_text = L["ready"] if all_ok else L["review"]
    badge_table = Table(
        [[Paragraph(
            f"<font name='Helvetica-Bold' color='{badge_color.hexval()}' size='9.5'>"
            f"{'✓ ' if all_ok else '⚠ '}{badge_text}</font>"
            f"<br/><font color='{MUTED.hexval()}' size='8'>{L['ready_sub']}</font>",
            val,
        )]],
        colWidths=[166 * mm],
    )
    badge_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), badge_bg),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("ROUNDEDCORNERS", [4, 4, 4, 4]),
    ]))
    story.append(badge_table)

    # ─── Footer ───
    story.append(Spacer(1, 6 * mm))
    story.append(HRFlowable(width="100%", thickness=0.5, color=DIVIDER, spaceBefore=2, spaceAfter=4))
    closed_time = dc.closed_at.strftime("%d/%m/%Y %H:%M") if dc.closed_at else "—"
    story.append(Paragraph(
        f"{L['footer_gen']} · {('Lukket' if DA else 'Closed')} {closed_time} · {L['footer_use']}",
        foot,
    ))

    doc.build(story)
    buf.seek(0)
    filename = f"kasserapport_{dc.date.isoformat()}.pdf"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ─── DELETE — soft delete ───

@router.delete("/{close_id}", status_code=204)
def delete_daily_close(
    close_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    dc = db.query(DailyClose).filter(
        DailyClose.id == close_id,
        DailyClose.user_id == user.id,
    ).first()
    if not dc:
        raise HTTPException(status_code=404, detail="Daily close not found")
    dc.is_deleted = True
    dc.deleted_at = utc_now()
    db.commit()
