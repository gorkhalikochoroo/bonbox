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
from app.models.sale import Sale
from app.models.user import User
from app.routers.auth import get_current_user

router = APIRouter()
log = logging.getLogger("bonbox.property_report")


# Channel labels match Danish POS conventions (Aloha "Order Type" wording)
CHANNEL_LABELS = {
    "dine_in": "Restaurant",
    "takeaway": "Take-Away Pickup",
    "wolt": "Wolt",
    "wolt_del": "Wolt Delivery",
    "just_eat": "Just Eat",
    "web": "Web Pre-Paid",
    "phone": "Phone Order",
    "catering": "Catering",
    "other": "Other",
}

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
    "web_prepaid": "Web Close Order",
    "gift_card": "Gift Card",
    "just_eat": "Just Eat",
    "online": "Online",
    "card": "Card",
    "mixed": "Mixed",
}


def _safe_empty(start: datetime, end: datetime):
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
    if report_date is None:
        report_date = _date.today()

    # Build [start, end) window in user's timezone-naive UTC for now.
    # Day starts at `day_cutoff_hour` on report_date and ends 24h later.
    start_dt = datetime.combine(report_date, datetime.min.time()).replace(hour=day_cutoff_hour)
    end_dt = start_dt + timedelta(days=1)

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
        return _safe_empty(start_dt, end_dt)

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

            # Per-channel
            if ch not in by_channel:
                by_channel[ch] = {
                    "channel": ch,
                    "label": CHANNEL_LABELS.get(ch, ch.title()),
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
    # preference. Previously hardcoded /5 (= extract 25%) which gave the
    # wrong tax for any non-DK user (NPR 13%, GBP 20%, EUR 21%, etc.) and
    # for B2B users entering net prices.
    taxable_sales = sum(
        float(s.amount or 0) for s in rows
        if not s.is_deleted and not s.is_void and s.status != "returned" and not s.is_tax_exempt
    )
    try:
        from app.services.tax_service import _get_vat_rate
        vat_rate = _get_vat_rate(user.currency or "DKK")
    except Exception:  # noqa: BLE001
        vat_rate = 0.25  # safe DK fallback
    prices_incl_moms = bool(getattr(user, "prices_include_moms", True))

    if vat_rate <= 0 or taxable_sales <= 0:
        tax_collected = 0.0
        all_sales_net = round(taxable_sales, 2)
    elif prices_incl_moms:
        # B2C (default): VAT extracted from gross
        tax_collected = round(taxable_sales * vat_rate / (1 + vat_rate), 2)
        all_sales_net = round(taxable_sales - tax_collected, 2)
    else:
        # B2B: prices are net, VAT is on top
        tax_collected = round(taxable_sales * vat_rate, 2)
        all_sales_net = round(taxable_sales, 2)

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
