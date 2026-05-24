"""
Property Financial Report — the daily close report Danish restaurants already
get from Aloha / Restwave / Pos+. Modeled directly on the Sticks'n'Sushi
closing report so a sales conversation can show:

    "BonBox produces the same daily close you're already used to, plus
     AI insights on top — same numbers, half the chaos."

Endpoint: GET /api/property-report?date=YYYY-MM-DD&day_cutoff_hour=6

Returns the full structured report as JSON. The frontend renders it as a
PDF-style page that mirrors the POS printout.

Multi-layer defense applied: heavy aggregation, wrap in try/except, return
shape-stable empty on failure with _error flag.
"""

from __future__ import annotations

import logging
from datetime import date as _date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.business_profile import BusinessProfile
from app.models.order_channel_config import OrderChannelConfig
from app.models.sale import Sale
from app.models.user import User
from app.routers.auth import get_current_user
from app.services import audit_service
from app.services.channel_defaults import channel_label_map
from app.services.tax_service import _get_vat_rate
from app.services.tz_utils import business_day_window, business_today_local

router = APIRouter()
log = logging.getLogger("bonbox.property_report")


def _resolve_channel_labels(db: Session, user_id) -> dict[str, str]:
    """Build the slug → label map for THIS user.

    Reads the user's OrderChannelConfig rows and merges them on top of
    SYSTEM_CHANNELS. Falls back to a SYSTEM_CHANNELS-only view if the
    query fails so a momentary DB hiccup doesn't break label rendering.
    """
    try:
        user_rows = (
            db.query(OrderChannelConfig)
            .filter(OrderChannelConfig.user_id == user_id)
            .all()
        )
    except Exception as e:  # noqa: BLE001 — defensive; non-fatal
        log.warning("property_report: channel-label query failed for user=%s: %s", user_id, e)
        user_rows = []
    return channel_label_map(user_rows)


# Payment method labels — exactly match what's printed on the receipt
TENDER_LABELS = {
    "dankort": "Dankort",
    "dankort_offline": "Dankort Offline",
    "mastercard": "Mastercard",
    "mastercard_offline": "Mastercard Offline",
    "visa": "Visa",
    "mobilepay": "MobilePay",
    "cash": "Cash",
    "kontant": "Kontant",
    "wolt": "Wolt",
    "uber_eats": "Uber Eats",
    "foodora": "Foodora",
    "web_prepaid": "Web Close Order",
    "gift_card": "Gift Card",
    "just_eat": "Just Eat (closed)",  # legacy DK channel
    "online": "Online",
    "card": "Card",
    "mixed": "Mixed",
}


def _safe_empty(start: datetime, end: datetime, currency: str = "DKK"):
    """Shape-stable empty payload for the error/degraded path.

    The empty-state `moms_rate_pct` is derived from the user's currency
    (via `_get_vat_rate`) instead of being hardcoded to 25% — so a
    Nepali (NPR 13%) or British (GBP 20%) user hitting the degraded
    path doesn't see a "25%" cell on their otherwise-blank report.
    Single source of truth for the rate lives in `tax_service` per #148.
    """
    try:
        rate_pct = round(_get_vat_rate(currency or "DKK") * 100)
    except Exception:  # noqa: BLE001
        rate_pct = 25
    return {
        "report_date": start.date().isoformat(),
        "start_time": start.isoformat(),
        "end_time": end.isoformat(),
        "totals": {
            "total_revenue": 0,
            "service_charge": 0,
            "gross_after_discount": 0,
            "discount": 0,
            "gross_before_discount": 0,
            "voids_count": 0,
            "voids_amount": 0,
            "returns_count": 0,
            "returns_amount": 0,
            "rounding_total": 0,
            "training_total": 0,
            "taxable_sales": 0,
            "tax_collected": 0,
            "all_sales_net": 0,
            "gross_sales": 0,
            "moms_mode": "none",
            "moms_rate_pct": rate_pct,
        },
        "exceptions": {
            "voids": 0,
            "manager_voids": 0,
            "error_correct": 0,
            "cancels": 0,
            "no_sale": 0,
        },
        "order_channels": [],
        "tender_media": [],
        "_error": "Could not build property report. Please try again.",
        "_recoverable": True,
    }


@router.get("")
def property_financial_report(
    report_date: Optional[_date] = Query(None, alias="date"),
    day_cutoff_hour: int = Query(6, ge=0, le=23, description="Day boundary (default 6am — Danish restaurant convention)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a Sticks'n'Sushi-style Property Financial Report for one
    business day.

    Default boundaries: 06:00 → 06:00 next day (Danish restaurant convention,
    avoids splitting late-night service across two reports).
    """
    # Resolve cutoff from BusinessProfile when the caller didn't pass one
    # explicitly. The Query param defaults to 6 (Danish restaurant
    # convention) — same default the helper falls back to — but if the
    # owner has saved a custom cutoff in their profile we honour it.
    # This keeps the property report internally consistent with
    # DailyClose prefill and LiveKpisToday (all three now derive from
    # the same BusinessProfile field via the same helper).
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    if profile is not None and profile.day_cutoff_hour is not None:
        # Explicit Query override wins — but if the request didn't carry
        # a cutoff, FastAPI fills in the default (6). To detect "the
        # caller really wanted 6" vs "the caller didn't say", we treat
        # the Query as advisory and prefer the stored profile when it
        # exists. The query param remains in the signature for backward
        # compatibility with external clients.
        user.day_cutoff_hour = profile.day_cutoff_hour
    else:
        user.day_cutoff_hour = day_cutoff_hour

    if report_date is None:
        report_date = business_today_local(user)

    # UTC [start, end) for the user's business day. Timezone-aware now —
    # the previous timezone-naive `datetime.combine(...).replace(hour=…)`
    # treated 06:00 as "wall clock 06:00 whatever timezone the server
    # happens to be in", which drifted between Render's UTC clock and
    # Copenhagen's CEST by 1-2 hours. `business_day_window` builds the
    # window in the user's TZ + cutoff and converts to UTC, so a 02:00
    # CEST sale on report_date=2026-05-24 + cutoff=6 correctly falls in
    # the 2026-05-23 window.
    start_dt, end_dt = business_day_window(user, report_date)

    try:
        # All sales for this user touching the [start, end) window.
        # Use date filter on the date column (which is just a date, not timestamp)
        # PLUS exclude soft-deletes — never returns wrong totals.
        rows = (
            db.query(Sale)
            .filter(
                Sale.user_id == user.id,
                Sale.date >= start_dt.date(),
                Sale.date <= end_dt.date(),
                Sale.is_deleted.isnot(True),
            )
            .all()
        )
    except Exception as e:
        log.exception("property_report: query failed for user=%s: %s", user.id, e)
        return _safe_empty(start_dt, end_dt, currency=user.currency or "DKK")

    # ── Totals ──
    total_revenue = 0.0
    service_charge = 0.0
    discount_total = 0.0
    voids_amount = 0.0
    voids_count = 0
    returns_count = 0
    returns_amount = 0.0
    error_correct = 0
    manager_voids = 0
    no_sale = 0  # placeholder — would need a separate event log to track
    cancels = 0  # ditto

    # Channel + tender aggregations
    by_channel: dict[str, dict] = {}
    by_tender: dict[str, dict] = {}

    # Resolve user-customised channel labels. Falls through to
    # SYSTEM_CHANNELS labels if the user hasn't added/overridden anything;
    # falls through again to title-cased slug if a sale references a
    # never-configured channel (e.g. legacy import).
    channel_labels = _resolve_channel_labels(db, user.id)

    # CRIT-5 fix (Report Coherence audit #148): previously `total_revenue`
    # was computed in this loop with one filter set, while `taxable_sales`
    # was a SEPARATE comprehension below with a DIFFERENT filter set —
    # which meant a soft-deleted void row could contribute to one and not
    # the other, so MOMS never reconciled cleanly with revenue. Now BOTH
    # sums are derived from the same single pass, sharing the same
    # void/return/delete rules. The only legitimate divergence is
    # `is_tax_exempt` — see comment at the assignment below.
    taxable_sales = 0.0
    for s in rows:
        try:
            amt = float(s.amount or 0)
            sc = float(s.service_charge_amount or 0)
            disc = float(s.discount_amount or 0)
            ch = (s.order_channel or "dine_in").lower()
            tm = (s.payment_method or "mixed").lower()

            # Skip voided rows from revenue but count their amount
            if s.is_void:
                voids_count += 1
                voids_amount += amt
                if s.is_manager_void:
                    manager_voids += 1
                if s.is_error_correct:
                    error_correct += 1
                continue

            if s.status == "returned":
                returns_count += 1
                returns_amount += float(s.return_amount or amt)
                continue

            total_revenue += amt
            service_charge += sc
            discount_total += disc

            # MOMS basis — same universe as revenue MINUS tax-exempt
            # rows. A gift-card sale or a B2B reverse-charge sale shows
            # up in revenue (the cash hit the till) but contributes zero
            # to the MOMS the owner owes SKAT, so it MUST be excluded
            # here. This is the ONLY documented divergence between
            # `total_revenue` and `taxable_sales`. Note `is_deleted` is
            # not re-checked because the SQL filter at line 168 already
            # excludes deleted rows — and re-checking it here would
            # silently mask any future query-shape regression.
            if not s.is_tax_exempt:
                taxable_sales += amt

            # Per-channel
            if ch not in by_channel:
                by_channel[ch] = {
                    "channel": ch,
                    "label": channel_labels.get(ch) or ch.replace("_", " ").title(),
                    "guests": 0,
                    "checks": 0,
                    "amount": 0.0,
                    "tables": 0,  # checks where guest_count > 0 are "tables"
                }
            by_channel[ch]["amount"] += amt
            by_channel[ch]["checks"] += 1
            if s.guest_count and s.guest_count > 0:
                by_channel[ch]["guests"] += int(s.guest_count)
                by_channel[ch]["tables"] += 1

            # Per-tender
            if tm not in by_tender:
                by_tender[tm] = {
                    "method": tm,
                    "label": TENDER_LABELS.get(tm, tm.replace("_", " ").title()),
                    "count": 0,
                    "amount": 0.0,
                }
            by_tender[tm]["count"] += 1
            by_tender[tm]["amount"] += amt
        except Exception as e:
            # Don't let one bad row poison the whole report
            log.warning("property_report: row %s aggregation failed: %s", getattr(s, "id", "?"), e)
            continue

    gross_before = total_revenue + discount_total
    gross_after_discount = total_revenue
    # MOMS / VAT — derived from user's currency AND prices_include_moms
    # preference. Centralized: single source of truth for the rate lives
    # in `tax_service._get_vat_rate` (#148 MEDIUM-13). Per-currency rates:
    # DKK 25%, NPR 13%, GBP 20%, EUR_DE 19%, EUR_FR 20%, etc. The safe
    # 0.25 fallback below only runs if `_get_vat_rate` itself raises —
    # we never re-hardcode a rate as the primary source.
    try:
        vat_rate = _get_vat_rate(user.currency or "DKK")
    except Exception:  # noqa: BLE001
        vat_rate = 0.25  # safe DK fallback if tax_service load fails
    prices_incl_moms = bool(getattr(user, "prices_include_moms", True))

    # Distinguish "0% rate" (genuine tax-free jurisdiction) from "no sales
    # yet" — collapsing both into moms_mode="none" produced misleading copy
    # like "rate is 0% in your jurisdiction" for 25% MOMS users who simply
    # hadn't logged a sale on the chosen date.
    if taxable_sales <= 0:
        tax_collected = 0.0
        all_sales_net = round(taxable_sales, 2)
        gross_sales = round(taxable_sales, 2)
        # Preserve the user's intent (incl/excl) so the empty state can hint
        # at the right VAT mode once data arrives.
        moms_mode = "no_sales"
    elif vat_rate <= 0:
        tax_collected = 0.0
        all_sales_net = round(taxable_sales, 2)
        gross_sales = round(taxable_sales, 2)
        moms_mode = "none"  # truly 0% jurisdiction
    elif prices_incl_moms:
        # B2C (default): VAT extracted from gross
        # taxable_sales here is the gross amount the customer paid
        tax_collected = round(taxable_sales * vat_rate / (1 + vat_rate), 2)
        all_sales_net = round(taxable_sales - tax_collected, 2)
        gross_sales = round(taxable_sales, 2)
        moms_mode = "incl"   # prices entered include Moms
    else:
        # B2B: prices entered are net, VAT is added on top
        # taxable_sales here is the net amount the seller keeps
        tax_collected = round(taxable_sales * vat_rate, 2)
        all_sales_net = round(taxable_sales, 2)
        gross_sales = round(taxable_sales + tax_collected, 2)  # what customer paid
        moms_mode = "excl"   # prices entered exclude Moms

    # ── Sort + compute averages ──
    channels_out = []
    for ch_data in by_channel.values():
        guests = ch_data["guests"]
        checks = ch_data["checks"]
        tables = ch_data["tables"]
        ch_data["avg_per_guest"] = round(ch_data["amount"] / guests, 2) if guests > 0 else 0
        ch_data["avg_per_check"] = round(ch_data["amount"] / checks, 2) if checks > 0 else 0
        ch_data["avg_per_table"] = round(ch_data["amount"] / tables, 2) if tables > 0 else 0
        ch_data["amount"] = round(ch_data["amount"], 2)
        channels_out.append(ch_data)
    channels_out.sort(key=lambda x: x["amount"], reverse=True)

    tenders_out = []
    for tm_data in by_tender.values():
        tm_data["amount"] = round(tm_data["amount"], 2)
        tenders_out.append(tm_data)
    tenders_out.sort(key=lambda x: x["amount"], reverse=True)

    return {
        "report_date": report_date.isoformat(),
        "start_time": start_dt.isoformat(),
        "end_time": end_dt.isoformat(),
        "currency": user.currency or "DKK",
        "business_name": user.business_name,
        "totals": {
            "total_revenue": round(total_revenue, 2),
            "service_charge": round(service_charge, 2),
            "gross_after_discount": round(gross_after_discount, 2),
            "discount": round(discount_total, 2),
            "gross_before_discount": round(gross_before, 2),
            "voids_count": voids_count,
            "voids_amount": round(voids_amount, 2),
            "returns_count": returns_count,
            "returns_amount": round(returns_amount, 2),
            "rounding_total": 0,  # placeholder
            "training_total": 0,  # placeholder
            "taxable_sales": round(taxable_sales, 2),
            "tax_collected": tax_collected,
            "all_sales_net": all_sales_net,
            "gross_sales": gross_sales,        # gross customer-paid total
            "moms_mode": moms_mode,            # "incl" | "excl" | "none"
            "moms_rate_pct": round(vat_rate * 100, 0),  # 25 / 21 / 13 etc.
        },
        "exceptions": {
            "voids": voids_count,
            "manager_voids": manager_voids,
            "error_correct": error_correct,
            "cancels": cancels,
            "no_sale": no_sale,
        },
        "order_channels": channels_out,
        "tender_media": tenders_out,
    }


# ─── Copenhagen-clean PDF export ──────────────────────────────────────
#
# Replaces the old "window.print() screenshot" approach. The frontend
# Save-as-PDF button now downloads this rendered PDF directly so the
# accountant gets a properly formatted A4 document instead of a
# print-from-browser of the web page.
#
# Same plan-cap logic as daily-close exports doesn't apply here —
# this is a single-day report (not a date range), so it's free for
# every tier. Rate-limited to protect against abuse.

from fastapi import HTTPException, Request, Response

from app.models.business_profile import BusinessProfile


@router.get("/pdf")  # final URL: /api/property-report/pdf
def property_report_pdf(
    request: Request,
    report_date: Optional[_date] = Query(None, alias="date"),
    day_cutoff_hour: int = Query(6, ge=0, le=23),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Render the daily property report as a Copenhagen-clean A4 PDF.

    Layered defense: auth (get_current_user), tenant-scoped data fetch.
    Each step is wrapped in try/except so a failure surfaces with a
    meaningful error message instead of a vague 500/503 — the previous
    version was returning Render-level 503 when reportlab/data fetch
    threw and the global handler couldn't catch it cleanly.
    """
    # Step 1: build the report data (reuse the JSON endpoint's logic).
    try:
        report = property_financial_report(
            report_date=report_date,
            day_cutoff_hour=day_cutoff_hour,
            db=db, user=user,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("PDF: report data build failed for user=%s: %s", user.id, e)
        raise HTTPException(
            status_code=500,
            detail=f"Could not build report data: {type(e).__name__}",
        )

    # Step 2: best-effort BusinessProfile fetch for the header. NEVER
    # fail the PDF on this — the renderer can produce a clean PDF
    # without a profile (uses the user.business_name fallback).
    profile_dict = None
    try:
        profile = db.query(BusinessProfile).filter(
            BusinessProfile.user_id == user.id,
        ).first()
        if profile:
            profile_dict = {
                "company_name": profile.company_name,
                "address": profile.address,
                "city": profile.city,
                "zipcode": profile.zipcode,
                "org_number": profile.org_number,
            }
    except Exception as e:  # noqa: BLE001
        log.warning("PDF: business profile fetch failed (non-fatal): %s", e)

    # Step 3: render the PDF. This is where reportlab runs.
    try:
        from app.services.property_report_pdf import build_property_report_pdf
        pdf_bytes = build_property_report_pdf(
            report,
            profile=profile_dict,
            business_name=getattr(user, "business_name", "") or "",
            closer_name=None,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("PDF: reportlab render failed for user=%s: %s", user.id, e)
        raise HTTPException(
            status_code=500,
            detail=f"PDF render failed: {type(e).__name__}",
        )

    fname = f"daily-report_{report.get('report_date') or _date.today().isoformat()}.pdf"

    # Audit log — Bogføringsloven §10: track every property-report PDF
    # generation so the operator has a delivery trail (same shape as
    # tax.py:307). Audit failure must NEVER block the PDF download —
    # mirrors the tax.py try/except pattern (multi-barrier: audit is
    # observability, not gating).
    try:
        totals = report.get("totals") or {}
        audit_service.record(
            db, user=user,
            action="reports.property_report_pdf_generated",
            entity_type="property_report",
            entity_id=None,
            before=None,
            after={
                "period": report.get("report_date"),
                "currency": report.get("currency") or (user.currency or "DKK"),
                "total_revenue": totals.get("total_revenue", 0),
                "taxable_sales": totals.get("taxable_sales", 0),
                "moms_total": totals.get("tax_collected", 0),
                "pdf_size_bytes": len(pdf_bytes),
            },
            ip_address=getattr(request.client, "host", None) if request.client else None,
        )
        db.commit()
    except Exception as e:  # noqa: BLE001
        # Audit write must never break the download — log and proceed.
        log.warning("reports.property_report_pdf_generated audit log failed: %s", e)

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
            "Cache-Control": "private, no-store",
        },
    )
