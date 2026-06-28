import io
import logging
from datetime import date, timedelta
import calendar

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer,
    HRFlowable, KeepTogether,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.graphics import renderPDF

from app.database import get_db
from app.models.audit_log import AuditLog
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.waste import WasteLog
from app.models.khata import KhataCustomer, KhataTransaction
from app.models.cashbook import CashTransaction
from app.models.staffing import StaffingRule
from app.models.business_profile import BusinessProfile
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import effective_plan, get_cap
from app.services.tax_filing_pdf import (
    build_moms_filing_pdf, compute_filing_data, make_bilagsnummer,
)
from pydantic import BaseModel
from typing import List

log = logging.getLogger(__name__)


def _client_ip(request: Request) -> str | None:
    """Best-effort client IP for audit rows. Mirrors the pattern used in
    tax.py / smart_scan.py."""
    try:
        return request.client.host if request.client else None
    except Exception:  # noqa: BLE001
        return None


def _count_moms_pdf_exports_this_month(db: Session, user_id) -> int:
    """Count how many MOMS PDF exports the user has generated in the
    current calendar month. Source is the `audit_logs` rows written by
    `vat_export_pdf` (action == reports.vat_export_pdf_generated, added
    in commit 707f2cb). Using audit rows as the counter means:
      • One source of truth — the same rows the accountant trail relies on
      • No separate usage-tracking table to keep in sync
      • A failed PDF that never wrote its audit row is naturally not
        counted, which is the user-friendly direction.
    """
    first_of_month = date.today().replace(day=1)
    return (
        db.query(func.count(AuditLog.id))
        .filter(
            AuditLog.user_id == user_id,
            AuditLog.action == "reports.vat_export_pdf_generated",
            AuditLog.created_at >= first_of_month,
        )
        .scalar()
        or 0
    )


def _get_business_profile(db: Session, user_id) -> dict:
    """Fetch business profile for PDF headers. Returns dict with company details."""
    bp = db.query(BusinessProfile).filter(BusinessProfile.user_id == user_id).first()
    if not bp:
        return {}
    return {
        "company_name": bp.company_name or "",
        "org_number": bp.org_number or "",
        "vat_number": bp.vat_number or "",
        "address": bp.address or "",
        "city": bp.city or "",
        "zipcode": bp.zipcode or "",
        "country": bp.country or "",
        "phone": bp.phone or "",
        "email": bp.email or "",
        "industry": bp.industry or "",
    }


def _pdf_business_header(elements, bp: dict, user, title_style, subtitle_style, small_style, report_title: str, period_label: str, extra_line: str = ""):
    """Build a professional PDF header block with business profile info."""
    biz_name = bp.get("company_name") or user.business_name or "My Business"
    elements.append(Paragraph(biz_name, title_style))
    elements.append(Paragraph(report_title + f" &mdash; {period_label}", subtitle_style))

    # Business registration details line
    details_parts = []
    if bp.get("org_number"):
        # Show localized label based on country
        reg_labels = {"DK": "CVR", "NO": "Org.nr", "GB": "Company No.", "SE": "Org.nr"}
        label = reg_labels.get(bp.get("country", ""), "Reg. No.")
        details_parts.append(f"{label}: {bp['org_number']}")
    if bp.get("address"):
        addr = bp["address"]
        addr_lc = addr.lower().rstrip(" ,.")
        zip_str = (bp.get("zipcode") or "").strip()
        city_str = (bp.get("city") or "").strip()
        # Only append zip / city when the stored address doesn't already end
        # with them (case-insensitive) — owners often type the full address
        # incl. "2500 Valby", and naive appending produced "2500 Valby, 2500
        # Valby". Check the most-specific combined suffix first.
        combined = f"{zip_str} {city_str}".strip().lower()
        if combined and addr_lc.endswith(combined):
            pass  # address already carries zip + city
        elif city_str and addr_lc.endswith(city_str.lower()):
            # City present (maybe without zip) — prepend the zip only if missing.
            if zip_str and zip_str.lower() not in addr_lc:
                addr += f", {zip_str}"
        else:
            if zip_str:
                addr += f", {zip_str}"
            if city_str:
                addr += f" {city_str}"
        details_parts.append(addr)
    if bp.get("phone"):
        details_parts.append(f"Tel: {bp['phone']}")

    if details_parts:
        elements.append(Paragraph(" | ".join(details_parts), small_style))
    if extra_line:
        elements.append(Paragraph(extra_line, small_style))

router = APIRouter()

# VAT rates by currency (standard rates)
VAT_RATES = {
    "DKK": 0.25,       # Denmark 25%
    "SEK": 0.25,       # Sweden 25%
    "NOK": 0.25,       # Norway 25%
    "EUR": 0.21,       # EU average ~21%
    "EUR_PT": 0.23,    # Portugal IVA 23%
    "EUR_DE": 0.19,    # Germany 19%
    "EUR_FR": 0.20,    # France 20%
    "EUR_ES": 0.21,    # Spain 21%
    "EUR_IT": 0.22,    # Italy 22%
    "EUR_NL": 0.21,    # Netherlands 21%
    "GBP": 0.20,       # UK 20%
    "USD": 0.0,        # US has no federal VAT (sales tax varies by state)
    "NPR": 0.13,       # Nepal 13%
    "INR": 0.18,       # India GST 18%
    "JPY": 0.10,       # Japan 10%
    "AUD": 0.10,       # Australia GST 10%
    "CAD": 0.05,       # Canada GST 5%
    "CHF": 0.081,      # Switzerland 8.1%
}


def get_vat_rate(currency: str) -> float:
    return VAT_RATES.get(currency, 0.13)


# Localized VAT terminology by currency
VAT_TERMS = {
    "DKK": {"name": "Moms", "output": "Udgående moms (Salgsmoms)", "input": "Indgående moms (Købsmoms)",
             "net": "Moms til betaling", "owe": "Du skylder SKAT dette beløb", "refund": "SKAT skylder dig en tilbagebetaling",
             "authority": "SKAT", "report": "Momsopgørelse",
             "sales_incl": "Salg inkl. moms", "sales_excl": "Salg ekskl. moms",
             "exp_incl": "Udgifter inkl. moms", "exp_excl": "Udgifter ekskl. moms"},
    "SEK": {"name": "Moms", "output": "Utgående moms", "input": "Ingående moms",
             "net": "Moms att betala", "owe": "Att betala till Skatteverket", "refund": "Återbetalning från Skatteverket",
             "authority": "Skatteverket", "report": "Momsredovisning",
             "sales_incl": "Försäljning inkl. moms", "sales_excl": "Försäljning exkl. moms",
             "exp_incl": "Utgifter inkl. moms", "exp_excl": "Utgifter exkl. moms"},
    "NOK": {"name": "MVA", "output": "Utgående MVA", "input": "Inngående MVA",
             "net": "MVA å betale", "owe": "Beløp å betale til Skatteetaten", "refund": "Tilgode fra Skatteetaten",
             "authority": "Skatteetaten", "report": "MVA-oppgave",
             "sales_incl": "Salg inkl. MVA", "sales_excl": "Salg ekskl. MVA",
             "exp_incl": "Utgifter inkl. MVA", "exp_excl": "Utgifter ekskl. MVA"},
    "EUR_DE": {"name": "MwSt", "output": "Umsatzsteuer", "input": "Vorsteuer",
             "net": "MwSt-Zahllast", "owe": "An das Finanzamt zu zahlen", "refund": "Erstattung vom Finanzamt",
             "authority": "Finanzamt", "report": "Umsatzsteuererklärung",
             "sales_incl": "Umsätze inkl. MwSt", "sales_excl": "Umsätze exkl. MwSt",
             "exp_incl": "Ausgaben inkl. MwSt", "exp_excl": "Ausgaben exkl. MwSt"},
    "EUR_FR": {"name": "TVA", "output": "TVA collectée", "input": "TVA déductible",
             "net": "TVA à payer", "owe": "Montant à payer aux impôts", "refund": "Crédit de TVA",
             "authority": "DGFiP", "report": "Déclaration de TVA",
             "sales_incl": "Ventes TTC", "sales_excl": "Ventes HT",
             "exp_incl": "Dépenses TTC", "exp_excl": "Dépenses HT"},
    "EUR_ES": {"name": "IVA", "output": "IVA repercutido", "input": "IVA soportado",
             "net": "IVA a pagar", "owe": "A ingresar en Hacienda", "refund": "A devolver por Hacienda",
             "authority": "Hacienda", "report": "Declaración de IVA",
             "sales_incl": "Ventas con IVA", "sales_excl": "Ventas sin IVA",
             "exp_incl": "Gastos con IVA", "exp_excl": "Gastos sin IVA"},
    "EUR_PT": {"name": "IVA", "output": "IVA liquidado", "input": "IVA dedutível",
             "net": "IVA a pagar", "owe": "Montante a pagar à AT", "refund": "Reembolso da AT",
             "authority": "AT", "report": "Declaração de IVA",
             "sales_incl": "Vendas com IVA", "sales_excl": "Vendas sem IVA",
             "exp_incl": "Despesas com IVA", "exp_excl": "Despesas sem IVA"},
    "EUR_IT": {"name": "IVA", "output": "IVA a debito", "input": "IVA a credito",
             "net": "IVA da versare", "owe": "Da versare all'Agenzia delle Entrate", "refund": "Credito dall'Agenzia delle Entrate",
             "authority": "Agenzia delle Entrate", "report": "Dichiarazione IVA",
             "sales_incl": "Vendite IVA inclusa", "sales_excl": "Vendite IVA esclusa",
             "exp_incl": "Spese IVA inclusa", "exp_excl": "Spese IVA esclusa"},
    "EUR_NL": {"name": "BTW", "output": "Verschuldigde BTW", "input": "Voorbelasting",
             "net": "Te betalen BTW", "owe": "Te betalen aan de Belastingdienst", "refund": "Terug te ontvangen van de Belastingdienst",
             "authority": "Belastingdienst", "report": "BTW-aangifte",
             "sales_incl": "Verkoop incl. BTW", "sales_excl": "Verkoop excl. BTW",
             "exp_incl": "Uitgaven incl. BTW", "exp_excl": "Uitgaven excl. BTW"},
    "NPR": {"name": "VAT", "output": "Output VAT", "input": "Input VAT",
             "net": "VAT Payable", "owe": "Amount payable to IRD Nepal", "refund": "Refund from IRD Nepal",
             "authority": "IRD", "report": "VAT Return",
             "sales_incl": "Sales incl. VAT", "sales_excl": "Sales excl. VAT",
             "exp_incl": "Expenses incl. VAT", "exp_excl": "Expenses excl. VAT"},
    "GBP": {"name": "VAT", "output": "Output VAT", "input": "Input VAT",
             "net": "VAT Payable", "owe": "Amount payable to HMRC", "refund": "Refund from HMRC",
             "authority": "HMRC", "report": "VAT Return",
             "sales_incl": "Sales incl. VAT", "sales_excl": "Sales excl. VAT",
             "exp_incl": "Expenses incl. VAT", "exp_excl": "Expenses excl. VAT"},
    "INR": {"name": "GST", "output": "Output GST", "input": "Input GST",
             "net": "GST Payable", "owe": "Amount payable to GST Council", "refund": "GST refund",
             "authority": "GST Council", "report": "GST Return",
             "sales_incl": "Sales incl. GST", "sales_excl": "Sales excl. GST",
             "exp_incl": "Expenses incl. GST", "exp_excl": "Expenses excl. GST"},
    "AUD": {"name": "GST", "output": "GST on Sales", "input": "GST on Purchases",
             "net": "GST Payable", "owe": "Amount payable to ATO", "refund": "Refund from ATO",
             "authority": "ATO", "report": "GST Report",
             "sales_incl": "Sales incl. GST", "sales_excl": "Sales excl. GST",
             "exp_incl": "Expenses incl. GST", "exp_excl": "Expenses excl. GST"},
    "CHF": {"name": "MWST", "output": "Geschuldete MWST", "input": "Vorsteuer",
             "net": "MWST-Zahllast", "owe": "An die ESTV zu zahlen", "refund": "Rückerstattung von der ESTV",
             "authority": "ESTV", "report": "MWST-Abrechnung",
             "sales_incl": "Umsätze inkl. MWST", "sales_excl": "Umsätze exkl. MWST",
             "exp_incl": "Ausgaben inkl. MWST", "exp_excl": "Ausgaben exkl. MWST"},
}

# Default English fallback
_DEFAULT_TERMS = {"name": "Tax", "output": "Output Tax", "input": "Input Tax",
                  "net": "Tax Payable", "owe": "You owe this amount", "refund": "Tax refund due",
                  "authority": "Tax Authority", "report": "Tax Report",
                  "sales_incl": "Sales incl. Tax", "sales_excl": "Sales excl. Tax",
                  "exp_incl": "Expenses incl. Tax", "exp_excl": "Expenses excl. Tax"}


def get_vat_terms(currency: str) -> dict:
    return VAT_TERMS.get(currency, _DEFAULT_TERMS)


def get_display_currency(currency: str) -> str:
    """EUR_PT -> EUR, EUR_DE -> EUR, etc."""
    if currency.startswith("EUR_"):
        return "EUR"
    return currency


@router.get("/daily-kasserapport")
def daily_kasserapport(
    report_date: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    d = date.fromisoformat(report_date) if report_date else date.today()
    currency = user.currency or "DKK"
    vat_rate = get_vat_rate(currency)
    vat_terms = get_vat_terms(currency)
    display_cur = get_display_currency(currency)

    # Sales for the day (not deleted)
    sales = (
        db.query(Sale)
        .filter(Sale.user_id == user.id, Sale.date == d, Sale.is_deleted.isnot(True))
        .all()
    )

    # Payment breakdown
    payment_totals = {}
    for s in sales:
        m = (s.payment_method or "mixed").lower()
        payment_totals[m] = payment_totals.get(m, 0) + float(s.amount)

    total_revenue = sum(float(s.amount) for s in sales)
    subtotal = round(total_revenue / (1 + vat_rate), 2) if vat_rate > 0 else total_revenue
    vat_amount = round(total_revenue - subtotal, 2)

    # Expenses for the day
    total_expenses = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date == d, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )

    # Cash transactions
    cash_in = float(
        db.query(func.coalesce(func.sum(CashTransaction.amount), 0))
        .filter(CashTransaction.user_id == user.id, CashTransaction.date == d, CashTransaction.type == "cash_in", CashTransaction.is_deleted.isnot(True))
        .scalar()
    )
    cash_out = float(
        db.query(func.coalesce(func.sum(CashTransaction.amount), 0))
        .filter(CashTransaction.user_id == user.id, CashTransaction.date == d, CashTransaction.type == "cash_out", CashTransaction.is_deleted.isnot(True))
        .scalar()
    )

    # Business profile for header info
    bp = _get_business_profile(db, user.id)

    return {
        "date": d.isoformat(),
        "business_name": bp.get("company_name") or user.business_name or "BonBox",
        "org_number": bp.get("org_number", ""),
        "vat_number": bp.get("vat_number", ""),
        "business_address": bp.get("address", ""),
        "business_city": bp.get("city", ""),
        "business_zipcode": bp.get("zipcode", ""),
        "business_phone": bp.get("phone", ""),
        "business_country": bp.get("country", ""),
        "currency": display_cur,
        "transaction_count": len(sales),
        "subtotal": subtotal,
        "vat_rate": round(vat_rate * 100, 1),
        "vat_name": vat_terms["name"],
        "vat_amount": vat_amount,
        "total": total_revenue,
        "payment_breakdown": payment_totals,
        "expenses_total": total_expenses,
        "cash_in": cash_in,
        "cash_out": cash_out,
        "net_cash": round(total_revenue - total_expenses, 2),
    }


@router.get("/monthly")
def monthly_report(
    month: int = Query(..., ge=1, le=12),
    year: int = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if year is None:
        year = date.today().year

    _, last_day = calendar.monthrange(year, month)
    start = date(year, month, 1)
    end = date(year, month, last_day)

    # Total revenue
    total_revenue = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .scalar()
    )

    # Total expenses (exclude personal and deleted)
    total_expenses = (
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )

    # Expense breakdown by category (exclude personal and deleted)
    expense_breakdown = (
        db.query(ExpenseCategory.name, ExpenseCategory.color, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .group_by(ExpenseCategory.name, ExpenseCategory.color)
        .order_by(func.sum(Expense.amount).desc())
        .all()
    )

    # Daily revenue for the month
    daily_revenue = (
        db.query(Sale.date, func.sum(Sale.amount).label("total"))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .group_by(Sale.date)
        .order_by(Sale.date)
        .all()
    )

    # Best and worst revenue days
    best_day = max(daily_revenue, key=lambda r: r.total, default=None)
    worst_day = min(daily_revenue, key=lambda r: r.total, default=None)

    # Average daily sales (based on days with sales)
    days_with_sales = len(daily_revenue)
    avg_daily_sales = round(float(total_revenue) / days_with_sales, 2) if days_with_sales > 0 else 0

    # Sale count for average per sale
    sale_count = (
        db.query(func.count(Sale.id))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .scalar()
    )
    avg_per_sale = round(float(total_revenue) / sale_count, 2) if sale_count > 0 else 0

    return {
        "month": month,
        "year": year,
        "total_revenue": float(total_revenue),
        "total_expenses": float(total_expenses),
        "net_profit": float(total_revenue) - float(total_expenses),
        "sale_count": sale_count,
        "avg_daily_sales": avg_daily_sales,
        "avg_per_sale": avg_per_sale,
        "days_with_sales": days_with_sales,
        "expense_breakdown": [
            {"category": name, "color": color, "amount": float(total)}
            for name, color, total in expense_breakdown
        ],
        "daily_revenue": [
            {"date": str(d), "amount": float(t)} for d, t in daily_revenue
        ],
        "best_day": {"date": str(best_day.date), "amount": float(best_day.total)} if best_day else None,
        "worst_day": {"date": str(worst_day.date), "amount": float(worst_day.total)} if worst_day else None,
    }


# ---------------------------------------------------------------------------
# Helpers for the PDF
# ---------------------------------------------------------------------------
BLUE = colors.HexColor("#3b82f6")
DARK = colors.HexColor("#1e293b")
LIGHT_BG = colors.HexColor("#f8fafc")
BORDER = colors.HexColor("#e2e8f0")
GREEN = colors.HexColor("#16a34a")
RED = colors.HexColor("#dc2626")
ORANGE = colors.HexColor("#ea580c")
PURPLE = colors.HexColor("#7c3aed")

# Danish month + weekday names. The custom Ledelsesrapport is a DK-only
# document (Danish CVR, single Danish audience), so dates render in Danish
# rather than via locale (which isn't guaranteed installed on the host).
# Index 1..12 for months (0 left blank to mirror calendar.month_name).
_DA_MONTHS = [
    "", "januar", "februar", "marts", "april", "maj", "juni",
    "juli", "august", "september", "oktober", "november", "december",
]
# Indexed by date.weekday() (0=Monday .. 6=Sunday).
_DA_WEEKDAYS = [
    "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag",
]
_DA_WEEKDAYS_ABBR = ["man", "tir", "ons", "tor", "fre", "lør", "søn"]


def _da_month(month: int) -> str:
    """Danish full month name for a 1..12 month number."""
    return _DA_MONTHS[month] if 1 <= month <= 12 else ""


def _da_weekday(d) -> str:
    """Danish full weekday name for a date."""
    return _DA_WEEKDAYS[d.weekday()]


def _da_date_short(d) -> str:
    """'2. apr' — DK short date: no leading zero, period after the day,
    Danish abbreviated month."""
    return f"{d.day}. {_DA_MONTHS[d.month][:3]}"


def _da_money(value, *, decimals: int = 0) -> str:
    """da-DK money string with 'kr.' suffix.

    Period thousands-separator, comma decimal, e.g.:
      35834       -> '35.834 kr.'
      7166.80, 2  -> '7.166,80 kr.'
    `decimals=0` for operational tables, `decimals=2` (øre) only in the
    Informativ momsoversigt VAT block — same figure must never render with
    two different precisions across tables. Normalises a negative zero so a
    rounded-to-zero value never shows a leading minus.
    """
    v = float(value)
    if v == 0:  # collapse -0.0 → 0.0 so we never print "- 0,00"
        v = 0.0
    s = f"{v:,.{decimals}f}"                  # en-US grouping: 35,834 / 7,166.80
    s = s.replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{s} kr."


# Stored payment_method values → Danish display labels. Unknown values fall
# back to Title-case so an unexpected method never crashes or leaks a raw slug.
_PAYMENT_LABELS_DA = {
    "cash": "Kontant",
    "mixed": "Blandet",
    "card": "Kort",
    "mobilepay": "MobilePay",  # keep brand casing
}


def _da_payment_label(method: str) -> str:
    if method is None:
        return "Ukendt"
    return _PAYMENT_LABELS_DA.get(str(method).lower(), str(method).title())


def _header_table_style():
    return TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BLUE),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("PADDING", (0, 0), (-1, -1), 6),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ])


def _mini_bar_chart(data_pairs, width=160 * mm, height=60 * mm, bar_color=BLUE,
                    value_formatter=None):
    """Create a simple horizontal bar chart as a Drawing.

    `value_formatter` lets a caller localise the numeric labels (the DK
    Ledelsesrapport passes a da-DK formatter). Defaults to en-US grouping so
    existing callers are unaffected.
    """
    if not data_pairs:
        return Spacer(1, 5 * mm)
    if value_formatter is None:
        value_formatter = lambda v: f"{v:,.0f}"  # noqa: E731

    d = Drawing(width, height)
    max_val = max(v for _, v in data_pairs) if data_pairs else 1
    bar_h = min(12, (height - 10) / len(data_pairs))
    label_w = 60

    for i, (label, val) in enumerate(data_pairs):
        y = height - (i + 1) * (bar_h + 3)
        bar_w = ((val / max_val) * (width - label_w - 20)) if max_val > 0 else 0

        d.add(String(0, y + 2, str(label)[:20], fontSize=7, fontName="Helvetica"))
        d.add(Rect(label_w, y, bar_w, bar_h - 1, fillColor=bar_color, strokeColor=None))
        d.add(String(label_w + bar_w + 3, y + 2, value_formatter(val), fontSize=7, fontName="Helvetica"))

    return d


@router.get("/monthly/pdf")
def monthly_report_pdf(
    month: int = Query(..., ge=1, le=12),
    year: int = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a comprehensive, professional PDF monthly report."""
    if year is None:
        year = date.today().year

    _, last_day = calendar.monthrange(year, month)
    start = date(year, month, 1)
    end = date(year, month, last_day)
    month_name = _da_month(month)  # Danish month name (DK-only Ledelsesrapport)
    # Currency renders da-DK as "kr." via _da_money — no currency code printed.
    vat_terms = get_vat_terms(user.currency or "DKK")

    # ---- Gather all data ----
    total_revenue = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .scalar()
    )
    total_expenses = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )
    # Previous month for comparison
    if month == 1:
        prev_start = date(year - 1, 12, 1)
        prev_end = date(year - 1, 12, 31)
    else:
        _, prev_last = calendar.monthrange(year, month - 1)
        prev_start = date(year, month - 1, 1)
        prev_end = date(year, month - 1, prev_last)

    prev_revenue = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date.between(prev_start, prev_end), Sale.is_deleted.isnot(True))
        .scalar()
    )
    prev_expenses = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date.between(prev_start, prev_end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )
    rev_change = round(((total_revenue - prev_revenue) / prev_revenue) * 100, 1) if prev_revenue > 0 else 0
    exp_change = round(((total_expenses - prev_expenses) / prev_expenses) * 100, 1) if prev_expenses > 0 else 0

    expense_breakdown = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .group_by(ExpenseCategory.name)
        .order_by(func.sum(Expense.amount).desc())
        .all()
    )

    daily_revenue = (
        db.query(Sale.date, func.sum(Sale.amount).label("total"))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .group_by(Sale.date)
        .order_by(Sale.date)
        .all()
    )

    # Payment method breakdown
    payment_breakdown = (
        db.query(Sale.payment_method, func.count(Sale.id), func.sum(Sale.amount))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .group_by(Sale.payment_method)
        .order_by(func.sum(Sale.amount).desc())
        .all()
    )

    # Waste data
    waste_total = float(
        db.query(func.coalesce(func.sum(WasteLog.estimated_cost), 0))
        .filter(WasteLog.user_id == user.id, WasteLog.date.between(start, end))
        .scalar()
    )
    waste_by_reason = (
        db.query(WasteLog.reason, func.count(WasteLog.id), func.sum(WasteLog.estimated_cost))
        .filter(WasteLog.user_id == user.id, WasteLog.date.between(start, end))
        .group_by(WasteLog.reason)
        .all()
    )

    # Inventory alerts
    low_stock = (
        db.query(InventoryItem.name, InventoryItem.quantity, InventoryItem.unit, InventoryItem.min_threshold)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity <= InventoryItem.min_threshold,
        )
        .all()
    )

    # VAT summary (dynamic based on user's currency)
    vat_rate = get_vat_rate(user.currency)
    # MOMS via compute_filing_data → _calc_vat: the SAME engine as the official
    # MOMS-angivelse, so this report never disagrees with the filing (excludes
    # is_tax_exempt; includes the close + faktura revenue streams). `end` is the
    # inclusive month-end, which compute_filing_data expects. Do NOT re-derive
    # MOMS from a naive gross*rate/(1+rate) on total_revenue — that counts exempt.
    _fd = compute_filing_data(db, user, start, end)
    output_vat = _fd["moms_af_salg"]
    input_vat = _fd["moms_af_kob"]
    vat_payable = _fd["moms_til_skat"]

    # HONESTY: a resultatopgørelse states omsætning EKSKL moms. `total_revenue`
    # is GROSS (moms-inclusive). The output/sales VAT to strip is the SAME figure
    # the filing uses (moms_af_salg via compute_filing_data) — NOT a naive ÷1.25,
    # so this never disagrees with the MOMS-angivelse engine. Net profit / margin
    # are derived from the ex-moms figure, never the gross. Margin is suppressed
    # when no expenses are recorded (revenue-as-profit at "100% margin" is a lie).
    revenue_excl_vat = total_revenue - output_vat
    net_profit = revenue_excl_vat - total_expenses
    has_expenses = total_expenses > 0
    margin = round((net_profit / revenue_excl_vat) * 100, 1) if (has_expenses and revenue_excl_vat > 0) else None

    # Best/worst days
    best_day = max(daily_revenue, key=lambda r: r.total, default=None)
    worst_day = min(daily_revenue, key=lambda r: r.total, default=None)

    # Avg daily revenue
    days_with_sales = len(daily_revenue)
    avg_daily = round(total_revenue / days_with_sales, 2) if days_with_sales > 0 else 0

    # Weekday analysis (Danish weekday names — DK-only document)
    weekday_totals = {}
    weekday_counts = {}
    for d, total in daily_revenue:
        wday = _da_weekday(d)
        weekday_totals[wday] = weekday_totals.get(wday, 0) + float(total)
        weekday_counts[wday] = weekday_counts.get(wday, 0) + 1
    weekday_avg = {
        day: round(weekday_totals[day] / weekday_counts[day])
        for day in weekday_totals
    }

    # ---- Build PDF ----
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=15 * mm, bottomMargin=15 * mm,
        leftMargin=15 * mm, rightMargin=15 * mm,
    )
    styles = getSampleStyleSheet()

    # Custom styles
    title_style = ParagraphStyle("ReportTitle", parent=styles["Title"], fontSize=19, spaceAfter=2, textColor=DARK)
    subtitle_style = ParagraphStyle("ReportSub", parent=styles["Normal"], fontSize=11, textColor=colors.grey, spaceAfter=4)
    section_style = ParagraphStyle("ReportSection", parent=styles["Heading2"], fontSize=14, spaceBefore=16, spaceAfter=8, textColor=DARK)
    subsection_style = ParagraphStyle("ReportSubSec", parent=styles["Normal"], fontSize=10, textColor=colors.grey, spaceAfter=4)
    body_style = ParagraphStyle("ReportBody", parent=styles["Normal"], fontSize=9, leading=13)
    small_style = ParagraphStyle("ReportSmall", parent=styles["Normal"], fontSize=8, textColor=colors.grey)

    def _neutral_header():
        # ONE neutral dark header for every table (locked design system:
        # gray-900-ish primary; color reserved for genuine status, never
        # rainbow section tints).
        return TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), DARK),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("PADDING", (0, 0), (-1, -1), 6),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ])

    elements = []

    # ============================================================
    # HEADER (with business profile)
    # ============================================================
    bp = _get_business_profile(db, user.id)
    _pdf_business_header(
        elements, bp, user, title_style, subtitle_style, small_style,
        # Reframe: this is an internal MANAGEMENT report, NOT a momsangivelse.
        # DK terms (momsangivelse/SKAT/revisor) stay Danish per translation-scope.
        "Ledelsesrapport — internt overblik", f"{month_name} {year}",
        extra_line=(
            f"Genereret {date.today().day:02d}. "
            f"{_da_month(date.today().month)} {date.today().year}"
        ),
    )
    elements.append(Spacer(1, 3 * mm))

    # DISCLAIMER BANNER — neutral status box, not a tax document. The MOMS block
    # below carries a real momstilsvar figure, so this report must NOT read as
    # fileable: SKAT indberetning goes through Skat Autopilot or the revisor.
    disclaimer_style = ParagraphStyle(
        "ReportDisclaimer", parent=body_style, fontSize=8.5, leading=12, textColor=DARK,
    )
    disclaimer_tbl = Table(
        [[Paragraph(
            "<b>Dette er ikke en momsangivelse.</b> "
            "Brug Skat Autopilot eller send til revisor for indberetning til SKAT.",
            disclaimer_style,
        )]],
        colWidths=[180 * mm],
    )
    disclaimer_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fff7ed")),
        ("BOX", (0, 0), (-1, -1), 0.75, ORANGE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    elements.append(disclaimer_tbl)
    elements.append(Spacer(1, 3 * mm))
    elements.append(HRFlowable(width="100%", thickness=1, color=DARK, spaceAfter=8))

    # ============================================================
    # OVERSIGT (KPI table — honest, da-DK)
    # ============================================================
    elements.append(Paragraph("Oversigt", section_style))

    rev_arrow = "+" if rev_change >= 0 else ""
    exp_arrow = "+" if exp_change >= 0 else ""

    # Two revenue lines: gross (inkl. moms) AND ex-moms (the basis for profit).
    # A resultatopgørelse states omsætning EKSKL moms — Resultat / Resultatgrad
    # derive from the ex-moms figure, never the gross. Margin is suppressed when
    # no expenses exist (don't dress revenue up as "Resultat" at "100% margin").
    # All amounts da-DK, 0 decimals (operational table).
    waste_pct = round(waste_total / total_revenue * 100, 1) if total_revenue > 0 else 0
    summary_data = [
        ["Nøgletal", "Denne måned", "ift. sidste måned"],
        [vat_terms["sales_incl"], _da_money(total_revenue), f"{rev_arrow}{rev_change}%"],
        [vat_terms["sales_excl"], _da_money(revenue_excl_vat), ""],
        ["Udgifter", _da_money(total_expenses), f"{exp_arrow}{exp_change}%"],
    ]
    if has_expenses:
        summary_data.append([
            "Resultat (ekskl. moms)", _da_money(net_profit),
            f"{margin:.1f}% resultatgrad" if margin is not None else "—",
        ])
    summary_data.append([
        "Gns. daglig omsætning", _da_money(avg_daily),
        f"{days_with_sales} dage registreret",
    ])
    summary_data.append([
        "Spildomkostning", _da_money(waste_total), f"{waste_pct}% af omsætning",
    ])
    t = Table(summary_data, colWidths=[55 * mm, 55 * mm, 55 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), DARK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (1, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("PADDING", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ]))
    elements.append(t)
    if not has_expenses:
        elements.append(Spacer(1, 2 * mm))
        elements.append(Paragraph(
            "Ingen udgifter registreret for perioden — resultat og resultatgrad kan ikke beregnes.",
            small_style,
        ))

    # Highlight best/worst (Danish weekday + short date)
    if best_day or worst_day:
        elements.append(Spacer(1, 3 * mm))
        highlights = []
        if best_day:
            highlights.append(f"Bedste dag: {_da_weekday(best_day.date)} {_da_date_short(best_day.date)} ({_da_money(float(best_day.total))})")
        if worst_day:
            highlights.append(f"Stille dag: {_da_weekday(worst_day.date)} {_da_date_short(worst_day.date)} ({_da_money(float(worst_day.total))})")
        elements.append(Paragraph(" &bull; ".join(highlights), body_style))

    # ============================================================
    # UDGIFTER FORDELT
    # ============================================================
    if expense_breakdown:
        elements.append(Paragraph("Udgifter fordelt", section_style))
        exp_data = [["Kategori", "Beløb", "% af udgifter", "% af omsætning"]]
        for name, total in expense_breakdown:
            amt = float(total)
            pct_exp = round(amt / total_expenses * 100, 1) if total_expenses > 0 else 0
            pct_rev = round(amt / total_revenue * 100, 1) if total_revenue > 0 else 0
            exp_data.append([name, _da_money(amt), f"{pct_exp}%", f"{pct_rev}%"])
        exp_data.append(["I ALT", _da_money(total_expenses), "100%", f"{round(total_expenses/total_revenue*100, 1) if total_revenue > 0 else 0}%"])

        t2 = Table(exp_data, colWidths=[50 * mm, 40 * mm, 35 * mm, 35 * mm])
        t2.setStyle(_neutral_header())
        # Bold the total row
        t2.setStyle(TableStyle([
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
        ]))
        elements.append(t2)

        # Mini bar chart of expenses — neutral ink (red is reserved for genuine
        # negative/overdue status, not decoration). da-DK value labels.
        expense_pairs = [(name, float(total)) for name, total in expense_breakdown[:8]]
        elements.append(Spacer(1, 3 * mm))
        elements.append(_mini_bar_chart(
            expense_pairs, bar_color=DARK,
            value_formatter=lambda v: _da_money(v).removesuffix(" kr."),
        ))

    # ============================================================
    # BETALINGSMETODER
    # ============================================================
    if payment_breakdown:
        elements.append(Paragraph("Betalingsmetoder", section_style))
        pay_data = [["Metode", "Transaktioner", "Beløb i alt", "% af omsætning"]]
        for method, count, total in payment_breakdown:
            amt = float(total)
            pct = round(amt / total_revenue * 100, 1) if total_revenue > 0 else 0
            pay_data.append([_da_payment_label(method), str(count), _da_money(amt), f"{pct}%"])
        t_pay = Table(pay_data, colWidths=[40 * mm, 35 * mm, 40 * mm, 35 * mm])
        t_pay.setStyle(_neutral_header())
        elements.append(t_pay)

    # ============================================================
    # OMSÆTNING PR. UGEDAG
    # ============================================================
    if weekday_avg:
        # Keep heading + subtitle + bars on the same page (avoid orphaning).
        # Neutral ink bars; da-DK value labels (grouped, no 'kr.' on the chart).
        ordered_days = list(_DA_WEEKDAYS)
        weekday_pairs = [(d, weekday_avg.get(d, 0)) for d in ordered_days if d in weekday_avg]
        elements.append(KeepTogether([
            Paragraph("Omsætning pr. ugedag", section_style),
            Paragraph("Gennemsnitlig omsætning pr. ugedag baseret på denne måneds data", subsection_style),
            _mini_bar_chart(
                weekday_pairs, bar_color=DARK,
                value_formatter=lambda v: _da_money(v).removesuffix(" kr."),
            ),
        ]))

    # ============================================================
    # DAGLIG OMSÆTNING
    # ============================================================
    if daily_revenue:
        elements.append(Paragraph("Daglig omsætning", section_style))
        day_data = [["Dato", "Dag", "Omsætning", "ift. gns."]]
        for d, total in daily_revenue:
            amt = float(total)
            vs_avg = round(((amt - avg_daily) / avg_daily) * 100, 1) if avg_daily > 0 else 0
            vs_str = f"+{vs_avg}%" if vs_avg >= 0 else f"{vs_avg}%"
            day_data.append([
                _da_date_short(d),
                _da_weekday(d),
                _da_money(amt),
                vs_str,
            ])
        day_data.append(["", "I ALT", _da_money(total_revenue), ""])

        t3 = Table(day_data, colWidths=[30 * mm, 35 * mm, 40 * mm, 30 * mm])
        t3.setStyle(_neutral_header())
        t3.setStyle(TableStyle([
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
        ]))
        elements.append(t3)

    # ============================================================
    # WASTE REPORT
    # ============================================================
    if waste_by_reason:
        elements.append(Paragraph("Spild", section_style))
        waste_data = [["Årsag", "Antal", "Omkostning", "% af spild"]]
        for reason, count, cost in waste_by_reason:
            c = float(cost) if cost else 0
            pct = round(c / waste_total * 100, 1) if waste_total > 0 else 0
            waste_data.append([reason.title(), str(count), _da_money(c), f"{pct}%"])
        waste_data.append(["I ALT", "", _da_money(waste_total), "100%"])

        tw = Table(waste_data, colWidths=[40 * mm, 30 * mm, 35 * mm, 30 * mm])
        tw.setStyle(_neutral_header())
        tw.setStyle(TableStyle([
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
        ]))
        elements.append(tw)

    # ============================================================
    # LAVT LAGER (INVENTORY ALERTS)
    # ============================================================
    if low_stock:
        elements.append(Paragraph("Lavt lager", section_style))
        elements.append(Paragraph(f"{len(low_stock)} vare(r) under minimumsgrænse", subsection_style))
        inv_data = [["Vare", "Aktuelt antal", "Enhed", "Min. krævet"]]
        for name, qty, unit, threshold in low_stock:
            inv_data.append([name, f"{float(qty):.1f}", unit, f"{float(threshold):.1f}"])
        ti = Table(inv_data, colWidths=[55 * mm, 30 * mm, 25 * mm, 30 * mm])
        ti.setStyle(_neutral_header())
        # Red is reserved for genuine status — these rows ARE the alert.
        ti.setStyle(TableStyle([
            ("TEXTCOLOR", (0, 1), (-1, -1), RED),
        ]))
        elements.append(ti)

    # ============================================================
    # INFORMATIV MOMSOVERSIGT (NOT a momsangivelse)
    # ============================================================
    elements.append(Paragraph("Informativ momsoversigt", section_style))
    # Banner: this block is informational, NOT the official filing. The figures
    # follow the SAME engine as the angivelse (compute_filing_data) but this
    # document can't be indberettet — so it carries no standalone fileable number.
    vat_banner = Table(
        [[Paragraph(
            "<b>Informativ momsoversigt — ikke en momsangivelse.</b> "
            "Tallene følger samme beregning som angivelsen, men dette "
            "dokument kan ikke indberettes til SKAT.",
            disclaimer_style,
        )]],
        colWidths=[180 * mm],
    )
    vat_banner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fff7ed")),
        ("BOX", (0, 0), (-1, -1), 0.75, ORANGE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    elements.append(vat_banner)
    elements.append(Spacer(1, 2 * mm))
    elements.append(Paragraph(f"Momssats: {vat_rate * 100:.0f}%", subsection_style))
    # All amounts da-DK, 2 decimals (VAT block precision). Net row is an
    # informational "beregnet moms" line, NOT a fileable momstilsvar — the
    # disclaimer + footer make clear this can't be indberettet.
    vat_data = [
        ["", vat_terms["sales_incl"], vat_terms["sales_excl"], f"{vat_terms['name']}-beløb"],
        [vat_terms["output"], _da_money(_fd['salg_med_moms'], decimals=2), _da_money(_fd['salg_med_moms'] - output_vat, decimals=2), _da_money(output_vat, decimals=2)],
        [vat_terms["input"], _da_money(_fd['kob_med_moms'], decimals=2), _da_money(_fd['kob_med_moms'] - input_vat, decimals=2), _da_money(input_vat, decimals=2)],
        ["Beregnet moms (vejledende)", "", "", _da_money(vat_payable, decimals=2)],
    ]
    tv = Table(vat_data, colWidths=[50 * mm, 40 * mm, 40 * mm, 40 * mm])
    tv.setStyle(_neutral_header())
    tv.setStyle(TableStyle([
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
    ]))
    elements.append(tv)
    elements.append(Spacer(1, 2 * mm))
    elements.append(Paragraph(
        "Beregnet moms er vejledende og bekræftes i din momsangivelse.",
        small_style,
    ))

    # ============================================================
    # CLOSING NOTE (flows with content) + PER-PAGE FOOTER (canvas)
    # ============================================================
    elements.append(Spacer(1, 10 * mm))
    elements.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
    elements.append(Spacer(1, 3 * mm))
    elements.append(Paragraph(
        f"Ledelsesrapport genereret af BonBox &mdash; internt overblik, "
        f"<b>ikke en momsangivelse</b>. "
        f"Data dækker 1.&ndash;{last_day}. {month_name} {year}. Alle beløb i kr. "
        f"Til indberetning til SKAT: brug Skat Autopilot eller send til din revisor.",
        small_style,
    ))

    # Per-page footer drawn on the canvas → renders on EVERY page with the true
    # total page count ('Side X af Y'), via the numbered-canvas replay.
    from reportlab.pdfgen import canvas as _rl_canvas

    def _draw_footer(canvas, page_num, total_pages):
        canvas.saveState()
        page_w, _ = A4
        y = 10 * mm
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(15 * mm, y + 5 * mm, page_w - 15 * mm, y + 5 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.grey)
        canvas.drawString(15 * mm, y, f"Side {page_num} af {total_pages}")
        canvas.drawRightString(page_w - 15 * mm, y, "bonbox.dk · ikke en momsangivelse")
        canvas.restoreState()

    class _NumberedCanvas(_rl_canvas.Canvas):
        """Buffers each page, then on save() replays them with the true total
        page count so the footer can print 'Side X af Y'."""
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self._saved_states = []

        def showPage(self):
            self._saved_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_states)
            for page_num, state in enumerate(self._saved_states, start=1):
                self.__dict__.update(state)
                _draw_footer(self, page_num, total)
                super().showPage()
            super().save()

    doc.build(elements, canvasmaker=_NumberedCanvas)
    buf.seek(0)
    filename = f"BonBox_Ledelsesrapport_{month_name}_{year}.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ===========================================================================
# FORECASTING ENDPOINT — Revenue prediction using weighted moving averages
# ===========================================================================
@router.get("/forecast")
def revenue_forecast(
    days: int = Query(7, ge=1, le=30),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Predict future revenue using weighted moving average + day-of-week patterns.

    This is a simple but effective forecasting method:
    1. Calculate average revenue per weekday from the last 8 weeks
    2. Apply a trend factor (are revenues going up or down?)
    3. Return predicted daily revenue for the next N days
    """
    today = date.today()
    lookback_start = today - timedelta(days=56)  # 8 weeks of history

    # Get historical daily revenue
    history = (
        db.query(Sale.date, func.sum(Sale.amount).label("total"))
        .filter(Sale.user_id == user.id, Sale.date.between(lookback_start, today), Sale.is_deleted.isnot(True))
        .group_by(Sale.date)
        .order_by(Sale.date)
        .all()
    )

    if len(history) < 7:
        return {
            "forecast": [],
            "method": "insufficient_data",
            "message": "Need at least 7 days of sales data for forecasting",
            "confidence": 0,
        }

    # Build weekday averages (weighted: recent weeks matter more)
    weekday_revenues = {i: [] for i in range(7)}  # 0=Monday ... 6=Sunday
    for d, total in history:
        weekday_revenues[d.weekday()].append(float(total))

    weekday_avg = {}
    for wday, amounts in weekday_revenues.items():
        if amounts:
            # Weighted average: more recent data gets higher weight
            weights = [1 + i * 0.5 for i in range(len(amounts))]
            weighted_sum = sum(a * w for a, w in zip(amounts, weights))
            weight_total = sum(weights)
            weekday_avg[wday] = round(weighted_sum / weight_total)
        else:
            # Fallback: overall average
            all_amounts = [float(t) for _, t in history]
            weekday_avg[wday] = round(sum(all_amounts) / len(all_amounts)) if all_amounts else 0

    # Calculate trend (last 2 weeks vs previous 2 weeks)
    two_weeks_ago = today - timedelta(days=14)
    four_weeks_ago = today - timedelta(days=28)

    recent_avg = 0
    older_avg = 0
    recent_days = [(d, float(t)) for d, t in history if d > two_weeks_ago]
    older_days = [(d, float(t)) for d, t in history if four_weeks_ago < d <= two_weeks_ago]

    if recent_days:
        recent_avg = sum(t for _, t in recent_days) / len(recent_days)
    if older_days:
        older_avg = sum(t for _, t in older_days) / len(older_days)

    trend_factor = 1.0
    if older_avg > 0:
        trend_factor = min(max(recent_avg / older_avg, 0.7), 1.3)  # Cap at +/-30%

    # Generate predictions
    forecast = []
    day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

    for i in range(1, days + 1):
        future_date = today + timedelta(days=i)
        wday = future_date.weekday()
        base = weekday_avg.get(wday, 0)
        predicted = round(base * trend_factor)

        # Confidence based on how much data we have for this weekday
        data_points = len(weekday_revenues.get(wday, []))
        confidence = min(round(data_points / 8 * 100), 95)  # Max 95% (never 100%)

        forecast.append({
            "date": str(future_date),
            "day": day_names[wday],
            "predicted_revenue": predicted,
            "confidence": confidence,
            "trend": "up" if trend_factor > 1.05 else ("down" if trend_factor < 0.95 else "stable"),
        })

    # Overall stats
    total_predicted = sum(f["predicted_revenue"] for f in forecast)
    avg_confidence = round(sum(f["confidence"] for f in forecast) / len(forecast)) if forecast else 0

    return {
        "forecast": forecast,
        "total_predicted": total_predicted,
        "avg_daily_predicted": round(total_predicted / len(forecast)) if forecast else 0,
        "trend_factor": round(trend_factor, 3),
        "trend_direction": "up" if trend_factor > 1.05 else ("down" if trend_factor < 0.95 else "stable"),
        "method": "weighted_moving_average",
        "confidence": avg_confidence,
        "data_points_used": len(history),
    }


def _get_vat_data(db, user, start, end):
    """Shared helper to calculate VAT data for a period."""
    sales_total = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= start, Sale.date < end, Sale.is_deleted.isnot(True), Sale.is_tax_exempt.isnot(True))
        .scalar()
    )
    expenses_total = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= start, Expense.date < end, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True), Expense.is_tax_exempt.isnot(True))
        .scalar()
    )
    # Expense breakdown by category
    expense_breakdown = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date >= start, Expense.date < end, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True), Expense.is_tax_exempt.isnot(True))
        .group_by(ExpenseCategory.name)
        .order_by(func.sum(Expense.amount).desc())
        .all()
    )

    vat_rate = get_vat_rate(user.currency)
    # MOMS via the filing engine so this VAT summary matches the official
    # MOMS-angivelse (excludes exempt; includes close + faktura). `end` is
    # exclusive here (Sale.date < end); compute_filing_data wants inclusive.
    _fd = compute_filing_data(db, user, start, end - timedelta(days=1))
    output_vat = _fd["moms_af_salg"]
    input_vat = _fd["moms_af_kob"]
    vat_payable = _fd["moms_til_skat"]

    # Include business profile for VAT report headers
    bp = _get_business_profile(db, user.id)

    return {
        "vat_rate": vat_rate,
        "vat_rate_pct": round(vat_rate * 100, 1),
        "sales_incl_vat": _fd["salg_med_moms"],
        "sales_excl_vat": round(_fd["salg_med_moms"] - output_vat, 2),
        "output_vat": output_vat,
        "expenses_incl_vat": _fd["kob_med_moms"],
        "expenses_excl_vat": round(_fd["kob_med_moms"] - input_vat, 2),
        "input_vat": input_vat,
        "vat_payable": vat_payable,
        "currency": get_display_currency(user.currency),
        "business_name": bp.get("company_name") or user.business_name,
        "org_number": bp.get("org_number", ""),
        "vat_number": bp.get("vat_number", ""),
        "business_address": bp.get("address", ""),
        "business_city": bp.get("city", ""),
        "business_zipcode": bp.get("zipcode", ""),
        "expense_breakdown": [(name, float(total)) for name, total in expense_breakdown],
    }


@router.get("/vat-export")
def vat_export(
    request: Request,
    month: int = Query(None),
    year: int = Query(...),
    quarter: int = Query(None, ge=1, le=4),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Monthly or quarterly VAT/moms summary formatted for SKAT reporting."""
    if quarter:
        q_months = {1: (1, 3), 2: (4, 6), 3: (7, 9), 4: (10, 12)}
        m_start, m_end = q_months[quarter]
        start = date(year, m_start, 1)
        if m_end == 12:
            end = date(year + 1, 1, 1)
        else:
            end = date(year, m_end + 1, 1)
        period_label = f"Q{quarter} {year}"
    elif month:
        start = date(year, month, 1)
        end = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
        period_label = f"{year}-{month:02d}"
    else:
        start = date(year, 1, 1)
        end = date(year + 1, 1, 1)
        period_label = str(year)

    data = _get_vat_data(db, user, start, end)
    data["period"] = period_label

    # Audit log — Bogføringsloven §10 expects a trail on every financial-
    # data egress. Mirrors the tax.py:307 pattern. Failure must NEVER
    # block the response (the user has a legitimate right to view their
    # own MOMS data — audit is a side channel).
    try:
        audit_service.record(
            db, user=user,
            action="reports.vat_export_viewed",
            entity_type="vat_export",
            entity_id=None,
            before=None,
            after={
                "period": period_label,
                "period_start": start.isoformat(),
                "period_end": end.isoformat(),
                "currency": data.get("currency"),
                "vat_rate_pct": data.get("vat_rate_pct"),
                "output_vat": float(data.get("output_vat") or 0),
                "input_vat": float(data.get("input_vat") or 0),
                "vat_payable": float(data.get("vat_payable") or 0),
                "format": "json",
            },
            ip_address=_client_ip(request),
        )
        db.commit()
    except Exception as e:  # noqa: BLE001
        log.warning("reports.vat_export_viewed audit log failed: %s", e)
        db.rollback()

    return data


@router.get("/vat-export/pdf")
def vat_export_pdf(
    request: Request,
    month: int = Query(None),
    year: int = Query(...),
    quarter: int = Query(None, ge=1, le=4),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate the MOMS-angivelse PDF for a chosen period.

    **Accountant-grade output** — this endpoint now delegates the
    rendering to `build_moms_filing_pdf` (the SAME builder used by
    the Pro `/tax/filing-pdf` SKAT-ready endpoint). Both surfaces
    emit byte-identical PDFs for the same period, eliminating
    drift between the Free-tier "view-any-period" PDF and the
    Pro "filing PDF". The single source of truth for the MOMS
    math is `_calc_vat()` in tax_service.py (same function the
    Tax Autopilot overview consumes).

    Differentiation by tier is NOT in the rendered PDF itself —
    it's in the monthly cap (Free=2, Starter=100, Pro+Trial=-1)
    and in the gated endpoint `/tax/filing-pdf` (Pro-only,
    pre-fills the user's current filing period). A Free user
    generating a Q1 MOMS view here gets the same accountant-grade
    bilagsnummer + Doc-hash + signature line + Bogføringsloven
    §10 retention notice + source reconciliation that the Pro
    endpoint produces.

    Per Manoj's mandate ("we reducing accountant hrs saving
    money"): every MOMS PDF leaving BonBox must be usable by a
    revisor. Anything less makes the accountant-hours-saved
    claim hollow.

    Tier cap (commit efd26ac): Free=2/mo, Starter=100/mo,
    Pro+Trial=unlimited. Counter = audit_logs rows of
    `reports.vat_export_pdf_generated` for current calendar
    month. The JSON sibling `/vat-export` stays uncapped.
    """
    # ── Tier cap — count this month's audit rows, deny at the cap ──
    cap = get_cap(user, "moms_pdf_exports_per_month")
    if cap >= 0:  # -1 means unlimited
        used = _count_moms_pdf_exports_this_month(db, user.id)
        if used >= cap:
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "plan_required",
                    "feature": "moms_pdf_exports",
                    "required_plan": "starter",
                    "current_plan": effective_plan(user),
                    "used_this_month": used,
                    "monthly_cap": cap,
                    # DK-first phrasing — the surface is jurisdiction-
                    # locked (MOMS / kr stay Danish even on EN UI).
                    "message": (
                        f"Du har brugt dine {cap} MOMS PDF-eksporter "
                        f"denne måned. Opgrader til Starter for 100/md."
                    ),
                    "message_en": (
                        f"You've used your {cap} MOMS PDF exports this "
                        f"month. Upgrade to Starter for 100 / month."
                    ),
                },
            )

    # ── Period resolution — convert query params to (inclusive_start,
    # inclusive_end). build_moms_filing_pdf accepts inclusive end. The
    # old code used exclusive end internally so we subtract one day
    # before delegating.
    if quarter:
        q_months = {1: (1, 3), 2: (4, 6), 3: (7, 9), 4: (10, 12)}
        m_start, m_end = q_months[quarter]
        p_start = date(year, m_start, 1)
        next_first = date(year + 1, 1, 1) if m_end == 12 else date(year, m_end + 1, 1)
        p_end = next_first - timedelta(days=1)
    elif month:
        p_start = date(year, month, 1)
        next_first = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
        p_end = next_first - timedelta(days=1)
    else:
        p_start = date(year, 1, 1)
        p_end = date(year, 12, 31)

    # ── BusinessProfile + display name (matches tax.py:tax_filing_pdf) ──
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    business_name = (
        (getattr(profile, "company_name", None) if profile else None)
        or getattr(user, "business_name", None)
        or "MOMS-angivelse"
    )

    # ── L4 — fail soft on render failure (never raise to user) ────
    try:
        pdf_bytes = build_moms_filing_pdf(
            db, user, p_start, p_end,
            profile=profile, business_name=business_name,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("vat_export_pdf build failed for user=%s: %s", user.id, e)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "pdf_generation_failed",
                "message": "Kunne ikke generere MOMS-PDF'en. Prøv igen.",
                "message_en": "Could not generate the MOMS PDF. Please try again.",
            },
        )

    # ── Filename: align with the Pro filing PDF convention
    # (MA-YYYYMMDD-YYYYMMDD.pdf). A revisor receiving a folder of these
    # can sort by name and see them in chronological order.
    bilagsnummer = make_bilagsnummer(p_start, p_end)
    filename = f"{bilagsnummer}.pdf"

    # ── L7 — Bogføringsloven §10 audit log ────────────────────────
    # Pull totals from the canonical computer (same source the PDF
    # rendered) so the audit row reconciles to the øre with the PDF
    # the user just downloaded. NEVER blocks the response.
    try:
        data = compute_filing_data(db, user, p_start, p_end)
        audit_service.record(
            db, user=user,
            action="reports.vat_export_pdf_generated",
            entity_type="vat_export",
            entity_id=None,
            before=None,
            after={
                "bilagsnummer": bilagsnummer,
                "period_start": p_start.isoformat(),
                "period_end": p_end.isoformat(),
                "currency": data["currency"],
                "vat_rate_pct": data["vat_rate_pct"],
                "moms_af_salg": data["moms_af_salg"],
                "moms_af_kob": data["moms_af_kob"],
                "moms_til_skat": data["moms_til_skat"],
                "sales_count": data["sales_count"],
                "expense_count": data["expense_count"],
                "filename": filename,
                "pdf_size_bytes": len(pdf_bytes),
                "format": "pdf",
            },
            ip_address=_client_ip(request),
        )
        db.commit()
    except Exception as e:  # noqa: BLE001
        log.warning("reports.vat_export_pdf_generated audit log failed: %s", e)
        db.rollback()

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(pdf_bytes)),
        },
    )


# ===========================================================================
# REPORT BUILDER — Overview metrics + Custom PDF
# ===========================================================================

# Defense-in-depth bound on the overview period span. Mirrors
# tax.py:_MAX_FILING_PERIOD_DAYS so the Pulse tax bundle and the official
# filing share the same ceiling (annual = 366 days; quarterly = 92,
# half-yearly = 184). The Danish period presets (Monthly/Kvartal/Halvår/
# 9 months) all fall under this cap; the Custom picker is the only path
# that can approach it, so we validate it server-side too.
_MAX_OVERVIEW_PERIOD_DAYS = 366


@router.get("/overview")
def report_overview(
    month: int = Query(None, ge=1, le=12),
    year: int = Query(None),
    period_start: date | None = Query(None, description="Inclusive ISO date (period preset start)"),
    period_end: date | None = Query(None, description="Inclusive ISO date (period preset end)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Return overview metrics for a period (used by the Pulse tax-bundle cards).

    Callers pass EITHER a Danish period preset (period_start + period_end,
    both inclusive ISO dates — Monthly / Kvartal / Halvår / 9-months /
    Custom) OR the legacy month/year pair. If a period is supplied it wins;
    otherwise we fall back to the month/year branch exactly as before so
    existing callers keep working.
    """
    if period_start or period_end:
        # Both endpoints required if either is supplied (avoid half-spec),
        # end >= start, span <= 366 days. Mirrors tax.py:_resolve_filing_period
        # so the overview and the filing reject the same out-of-bounds ranges.
        if not (period_start and period_end):
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "incomplete_period",
                    "message": "Provide both period_start and period_end, or neither.",
                },
            )
        if period_end < period_start:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "invalid_period",
                    "message": "period_end must be on or after period_start",
                },
            )
        span_days = (period_end - period_start).days
        if span_days > _MAX_OVERVIEW_PERIOD_DAYS:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "period_too_long",
                    "message": (
                        f"Report period is limited to {_MAX_OVERVIEW_PERIOD_DAYS} days. "
                        "Use a shorter range."
                    ),
                    "max_days": _MAX_OVERVIEW_PERIOD_DAYS,
                    "got_days": span_days,
                },
            )
        start = period_start
        end = period_end
        # Echo the month/year of the period start for backward-compat callers
        # that still read those keys; the period_start/period_end echo below is
        # the authoritative range.
        month = start.month
        year = start.year
    else:
        if month is None:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "missing_period",
                    "message": "Provide month (with optional year) or period_start + period_end.",
                },
            )
        if year is None:
            year = date.today().year
        _, last_day = calendar.monthrange(year, month)
        start = date(year, month, 1)
        end = date(year, month, last_day)

    cur = get_display_currency(user.currency or "DKK")

    # Revenue
    total_revenue = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .scalar()
    )

    # Expenses (exclude personal and deleted)
    total_expenses = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )

    net_profit = total_revenue - total_expenses

    # VAT
    vat_rate = get_vat_rate(user.currency or "DKK")
    # MOMS via the filing engine (excludes exempt; 3-stream) so the overview's
    # MOMS matches the official angivelse. `end` is the inclusive month-end.
    vat_payable = compute_filing_data(db, user, start, end)["moms_til_skat"]
    vat_terms_data = get_vat_terms(user.currency or "DKK")

    # Inventory value & low stock
    inventory_rows = (
        db.query(InventoryItem.quantity, InventoryItem.cost_per_unit, InventoryItem.min_threshold)
        .filter(InventoryItem.user_id == user.id)
        .all()
    )
    inventory_value = sum(float(r.quantity) * float(r.cost_per_unit) for r in inventory_rows)
    low_stock_count = sum(1 for r in inventory_rows if float(r.quantity) <= float(r.min_threshold))

    # Khata outstanding (cumulative, not filtered by date)
    khata_outstanding = float(
        db.query(
            func.coalesce(func.sum(KhataTransaction.purchase_amount - KhataTransaction.paid_amount), 0)
        )
        .join(KhataCustomer, KhataTransaction.customer_id == KhataCustomer.id)
        .filter(KhataTransaction.user_id == user.id, KhataCustomer.is_deleted.isnot(True))
        .scalar()
    )

    # Cash in / out for the month
    cash_in = float(
        db.query(func.coalesce(func.sum(CashTransaction.amount), 0))
        .filter(CashTransaction.user_id == user.id, CashTransaction.date.between(start, end),
                CashTransaction.type == "cash_in", CashTransaction.is_deleted.isnot(True))
        .scalar()
    )
    cash_out = float(
        db.query(func.coalesce(func.sum(CashTransaction.amount), 0))
        .filter(CashTransaction.user_id == user.id, CashTransaction.date.between(start, end),
                CashTransaction.type == "cash_out", CashTransaction.is_deleted.isnot(True))
        .scalar()
    )

    # Counts
    total_sales_count = (
        db.query(func.count(Sale.id))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .scalar()
    )
    total_expense_count = (
        db.query(func.count(Expense.id))
        .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )

    # Average sales
    avg_per_sale = round(total_revenue / total_sales_count, 2) if total_sales_count > 0 else 0
    # Days with sales for daily average
    days_with_sales = (
        db.query(func.count(func.distinct(Sale.date)))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .scalar()
    )
    avg_daily_sales = round(total_revenue / days_with_sales, 2) if days_with_sales > 0 else 0

    return {
        "month": month,
        "year": year,
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "revenue": round(total_revenue, 2),
        "expenses": round(total_expenses, 2),
        "net_profit": round(net_profit, 2),
        "vat_payable": vat_payable,
        "vat_name": vat_terms_data["name"],
        "inventory_value": round(inventory_value, 2),
        "low_stock_count": low_stock_count,
        "khata_outstanding": round(khata_outstanding, 2),
        "cash_in": round(cash_in, 2),
        "cash_out": round(cash_out, 2),
        "currency": cur,
        "total_sales_count": total_sales_count,
        "total_expense_count": total_expense_count,
        "avg_per_sale": avg_per_sale,
        "avg_daily_sales": avg_daily_sales,
        "days_with_sales": days_with_sales,
    }


# ---------------------------------------------------------------------------
# Custom PDF Report Builder
# ---------------------------------------------------------------------------

class CustomReportRequest(BaseModel):
    year: int
    month: int
    sections: List[str]


@router.post("/custom-pdf")
def custom_report_pdf(
    req: CustomReportRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a combined PDF with user-selected sections."""
    year = req.year
    month = req.month
    sections = req.sections

    _, last_day = calendar.monthrange(year, month)
    start = date(year, month, 1)
    end = date(year, month, last_day)
    month_name = _da_month(month)  # Danish month name for the DK Ledelsesrapport
    # Currency is always rendered da-DK as "kr." via _da_money — no currency
    # code is printed in this DK-only Ledelsesrapport.

    # ---- Common data ----
    total_revenue = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
        .scalar()
    )
    total_expenses = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )
    vat_rate = get_vat_rate(user.currency or "DKK")
    # MOMS via compute_filing_data → _calc_vat: same engine as the official
    # MOMS-angivelse so this report matches the filing (excludes is_tax_exempt;
    # includes close + faktura). `end` is the inclusive month-end.
    _fd = compute_filing_data(db, user, start, end)
    output_vat = _fd["moms_af_salg"]
    input_vat = _fd["moms_af_kob"]
    vat_payable = _fd["moms_til_skat"]
    vat_terms = get_vat_terms(user.currency or "DKK")

    # HONESTY: a resultatopgørelse states omsætning EKSKL moms. `total_revenue`
    # is GROSS (moms-inclusive). The output/sales VAT to strip is the SAME
    # figure the filing uses (moms_af_salg via compute_filing_data) — NOT a
    # naive ÷1.25, so this never disagrees with the MOMS-angivelse engine.
    revenue_excl_vat = total_revenue - output_vat
    net_profit = revenue_excl_vat - total_expenses
    has_expenses = total_expenses > 0
    margin = round((net_profit / revenue_excl_vat) * 100, 1) if (has_expenses and revenue_excl_vat > 0) else None

    # ---- Build PDF ----
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=15 * mm, bottomMargin=15 * mm,
        leftMargin=15 * mm, rightMargin=15 * mm,
    )
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle("CRTitle", parent=styles["Title"], fontSize=19, spaceAfter=2, textColor=DARK)
    subtitle_style = ParagraphStyle("CRSub", parent=styles["Normal"], fontSize=11, textColor=colors.grey, spaceAfter=4)
    section_style = ParagraphStyle("CRSection", parent=styles["Heading2"], fontSize=14, spaceBefore=16, spaceAfter=8, textColor=DARK)
    subsection_style = ParagraphStyle("CRSubSec", parent=styles["Normal"], fontSize=10, textColor=colors.grey, spaceAfter=4)
    body_style = ParagraphStyle("CRBody", parent=styles["Normal"], fontSize=9, leading=13)
    small_style = ParagraphStyle("CRSmall", parent=styles["Normal"], fontSize=8, textColor=colors.grey)

    def _neutral_header():
        # ONE neutral dark header for every table in this report (locked design
        # system: gray-900-ish primary; color reserved for genuine status, never
        # rainbow section tints).
        return TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), DARK),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("PADDING", (0, 0), (-1, -1), 6),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ])

    elements = []

    # ================================================================
    # HEADER + OVERVIEW SUMMARY (always included, with business profile)
    # ================================================================
    bp = _get_business_profile(db, user.id)
    _pdf_business_header(
        elements, bp, user, title_style, subtitle_style, small_style,
        # Reframe: this is an internal MANAGEMENT report, NOT a momsangivelse.
        # DK terms (momsangivelse/SKAT/revisor) stay Danish per translation-scope.
        "Ledelsesrapport — internt overblik", f"{month_name} {year}",
        extra_line=(
            f"Genereret {date.today().day:02d}. "
            f"{_da_month(date.today().month)} {date.today().year}"
        ),
    )
    # The "ikke en momsangivelse" honesty cue lives in the boxed disclaimer
    # below and the per-page footer — no parenthetical under the date (it was
    # redundant and over-stated the header).
    elements.append(Spacer(1, 3 * mm))

    # DISCLAIMER BANNER — neutral status box, not a tax document.
    disclaimer_style = ParagraphStyle(
        "CRDisclaimer", parent=body_style, fontSize=8.5, leading=12, textColor=DARK,
    )
    disclaimer_tbl = Table(
        [[Paragraph(
            "<b>Dette er ikke en momsangivelse.</b> "
            "Brug Skat Autopilot eller send til revisor for indberetning til SKAT.",
            disclaimer_style,
        )]],
        colWidths=[170 * mm],
    )
    disclaimer_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fff7ed")),
        ("BOX", (0, 0), (-1, -1), 0.75, ORANGE),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    elements.append(disclaimer_tbl)
    elements.append(Spacer(1, 3 * mm))
    elements.append(HRFlowable(width="100%", thickness=1, color=DARK, spaceAfter=8))

    elements.append(Paragraph("Oversigt", section_style))

    # Two revenue lines: gross (inkl. moms) AND ex-moms (the basis for profit).
    # A resultatopgørelse states omsætning EKSKL moms — net profit / margin are
    # derived from the ex-moms figure, never the gross. NO standalone
    # momstilsvar row here (a non-filing report carries no momsangivelse number).
    # All amounts da-DK, 0 decimals (operational table).
    summary_data = [
        ["Nøgletal", "Beløb"],
        [vat_terms["sales_incl"], _da_money(total_revenue)],
        [vat_terms["sales_excl"], _da_money(revenue_excl_vat)],
        ["Udgifter", _da_money(total_expenses)],
    ]
    if has_expenses:
        # Real costs exist → an honest Resultat + Resultatgrad.
        summary_data.append(["Resultat (ekskl. moms)", _da_money(net_profit)])
        summary_data.append(["Resultatgrad", f"{margin:.1f}%" if margin is not None else "—"])
    else:
        # No expenses recorded — don't dress revenue up as "Resultat" and don't
        # print an empty Resultatgrad row. Relabel the ex-moms line instead.
        summary_data[2] = ["Omsætning ekskl. moms", _da_money(revenue_excl_vat)]
    t_sum = Table(summary_data, colWidths=[80 * mm, 80 * mm])
    t_sum.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), DARK),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (1, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("PADDING", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ]))
    elements.append(t_sum)
    if not has_expenses:
        elements.append(Spacer(1, 2 * mm))
        elements.append(Paragraph(
            "Ingen udgifter registreret for perioden — resultatgrad kan ikke beregnes.",
            small_style,
        ))

    # ================================================================
    # SALES BREAKDOWN
    # ================================================================
    if "sales_breakdown" in sections:
        # Payment methods
        payment_breakdown = (
            db.query(Sale.payment_method, func.count(Sale.id), func.sum(Sale.amount))
            .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
            .group_by(Sale.payment_method)
            .order_by(func.sum(Sale.amount).desc())
            .all()
        )
        if payment_breakdown:
            elements.append(Paragraph("Betalingsmetoder", section_style))
            pay_data = [["Metode", "Transaktioner", "Beløb i alt", "% af omsætning"]]
            for method, count, total in payment_breakdown:
                amt = float(total)
                pct = round(amt / total_revenue * 100, 1) if total_revenue > 0 else 0
                pay_data.append([_da_payment_label(method), str(count), _da_money(amt), f"{pct}%"])
            t_pay = Table(pay_data, colWidths=[40 * mm, 35 * mm, 40 * mm, 35 * mm])
            t_pay.setStyle(_neutral_header())
            elements.append(t_pay)

        # Daily revenue
        daily_revenue = (
            db.query(Sale.date, func.sum(Sale.amount).label("total"))
            .filter(Sale.user_id == user.id, Sale.date.between(start, end), Sale.is_deleted.isnot(True))
            .group_by(Sale.date)
            .order_by(Sale.date)
            .all()
        )
        days_with_sales = len(daily_revenue)
        avg_daily = round(total_revenue / days_with_sales, 2) if days_with_sales > 0 else 0

        if daily_revenue:
            elements.append(Paragraph("Daglig omsætning", section_style))
            day_data = [["Dato", "Dag", "Omsætning", "ift. gns."]]
            for d, total in daily_revenue:
                amt = float(total)
                vs_avg = round(((amt - avg_daily) / avg_daily) * 100, 1) if avg_daily > 0 else 0
                vs_str = f"+{vs_avg}%" if vs_avg >= 0 else f"{vs_avg}%"
                day_data.append([
                    _da_date_short(d),
                    _da_weekday(d),
                    _da_money(amt),
                    vs_str,
                ])
            day_data.append(["", "I ALT", _da_money(total_revenue), ""])
            t3 = Table(day_data, colWidths=[30 * mm, 35 * mm, 40 * mm, 30 * mm])
            t3.setStyle(_neutral_header())
            t3.setStyle(TableStyle([
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
            ]))
            elements.append(t3)

        # Weekday chart
        if daily_revenue:
            weekday_totals = {}
            weekday_counts = {}
            for d, total in daily_revenue:
                wday = _da_weekday(d)
                weekday_totals[wday] = weekday_totals.get(wday, 0) + float(total)
                weekday_counts[wday] = weekday_counts.get(wday, 0) + 1
            weekday_avg = {
                day: round(weekday_totals[day] / weekday_counts[day])
                for day in weekday_totals
            }
            ordered_days = list(_DA_WEEKDAYS)
            weekday_pairs = [(d, weekday_avg.get(d, 0)) for d in ordered_days if d in weekday_avg]
            # Keep heading + subtitle + bars on the same page (was orphaned:
            # heading on p1, bars on p2). Neutral ink bars; da-DK value labels
            # (grouped, no 'kr.' suffix on the compact chart).
            elements.append(KeepTogether([
                Paragraph("Omsætning pr. ugedag", section_style),
                Paragraph("Gennemsnitlig omsætning pr. ugedag baseret på denne måneds data", subsection_style),
                _mini_bar_chart(
                    weekday_pairs, bar_color=DARK,
                    value_formatter=lambda v: _da_money(v).removesuffix(" kr."),
                ),
            ]))

    # ================================================================
    # EXPENSE BREAKDOWN
    # ================================================================
    if "expense_breakdown" in sections:
        expense_breakdown = (
            db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
            .join(Expense, Expense.category_id == ExpenseCategory.id)
            .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
            .group_by(ExpenseCategory.name)
            .order_by(func.sum(Expense.amount).desc())
            .all()
        )
        if expense_breakdown:
            elements.append(Paragraph("Udgifter fordelt", section_style))
            exp_data = [["Kategori", "Beløb", "% af udgifter", "% af omsætning"]]
            for name, total in expense_breakdown:
                amt = float(total)
                pct_exp = round(amt / total_expenses * 100, 1) if total_expenses > 0 else 0
                pct_rev = round(amt / total_revenue * 100, 1) if total_revenue > 0 else 0
                exp_data.append([name, _da_money(amt), f"{pct_exp}%", f"{pct_rev}%"])
            exp_data.append(["I ALT", _da_money(total_expenses), "100%", f"{round(total_expenses/total_revenue*100, 1) if total_revenue > 0 else 0}%"])

            t2 = Table(exp_data, colWidths=[50 * mm, 40 * mm, 35 * mm, 35 * mm])
            t2.setStyle(_neutral_header())
            t2.setStyle(TableStyle([
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
            ]))
            elements.append(t2)

            # Mini bar chart of expenses — neutral ink (red is reserved for
            # genuine negative/overdue status, not decoration).
            expense_pairs = [(name, float(total)) for name, total in expense_breakdown[:8]]
            elements.append(Spacer(1, 3 * mm))
            elements.append(_mini_bar_chart(
                expense_pairs, bar_color=DARK,
                value_formatter=lambda v: _da_money(v).removesuffix(" kr."),
            ))

    # ================================================================
    # INVENTORY
    # ================================================================
    if "inventory" in sections:
        inv_items = (
            db.query(
                InventoryItem.name, InventoryItem.quantity, InventoryItem.unit,
                InventoryItem.cost_per_unit, InventoryItem.sell_price, InventoryItem.min_threshold,
            )
            .filter(InventoryItem.user_id == user.id)
            .order_by(InventoryItem.name)
            .all()
        )
        if inv_items:
            elements.append(Paragraph("Varelager", section_style))
            inv_data = [["Vare", "Antal", "Enhed", "Kostpris", "Salgspris", "Lagerværdi"]]
            total_stock_value = 0
            low_stock_items = []
            for name, qty, unit, cost, sell_price, min_thresh in inv_items:
                q = float(qty)
                c = float(cost)
                sp = float(sell_price) if sell_price else 0
                stock_val = q * c
                total_stock_value += stock_val
                row = [name, f"{q:.1f}", unit, _da_money(c), _da_money(sp), _da_money(stock_val)]
                inv_data.append(row)
                if q <= float(min_thresh):
                    low_stock_items.append((name, q, unit, float(min_thresh)))

        # Guard the empty dump: when NO item carries a kostpris, every row
        # would print "0 kr" — useless noise. Show one honest line instead.
        if inv_items and total_stock_value <= 0:
            elements.append(Paragraph(
                "Ingen kostpriser registreret — lagerværdi ikke opgjort.",
                body_style,
            ))
        elif inv_items:
            inv_data.append(["I ALT", "", "", "", "", _da_money(total_stock_value)])

            t_inv = Table(inv_data, colWidths=[40 * mm, 20 * mm, 20 * mm, 25 * mm, 25 * mm, 30 * mm])
            t_inv.setStyle(_neutral_header())
            t_inv.setStyle(TableStyle([
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
            ]))
            # Highlight low stock rows in the table
            for idx, (name, qty, unit, cost, sell_price, min_thresh) in enumerate(inv_items):
                if float(qty) <= float(min_thresh):
                    t_inv.setStyle(TableStyle([
                        ("BACKGROUND", (0, idx + 1), (-1, idx + 1), colors.HexColor("#fef2f2")),
                        ("TEXTCOLOR", (0, idx + 1), (-1, idx + 1), RED),
                    ]))
            elements.append(t_inv)

            # Low stock alerts
            if low_stock_items:
                elements.append(Spacer(1, 3 * mm))
                elements.append(Paragraph(f"Lavt lager &mdash; {len(low_stock_items)} vare(r) under grænse", subsection_style))
                ls_data = [["Vare", "Aktuelt antal", "Enhed", "Min. krævet"]]
                for name, qty, unit, thresh in low_stock_items:
                    ls_data.append([name, f"{qty:.1f}", unit, f"{thresh:.1f}"])
                t_ls = Table(ls_data, colWidths=[55 * mm, 30 * mm, 25 * mm, 30 * mm])
                t_ls.setStyle(_neutral_header())
                t_ls.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), RED),
                ]))
                elements.append(t_ls)

    # ================================================================
    # VAT DETAIL
    # ================================================================
    if "vat_detail" in sections:
        elements.append(Paragraph("Informativ momsoversigt", section_style))
        # Banner: this block is informational, NOT the official filing.
        vat_banner = Table(
            [[Paragraph(
                "<b>Informativ momsoversigt — ikke en momsangivelse.</b> "
                "Tallene følger samme beregning som angivelsen, men dette "
                "dokument kan ikke indberettes til SKAT.",
                disclaimer_style,
            )]],
            colWidths=[170 * mm],
        )
        vat_banner.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#fff7ed")),
            ("BOX", (0, 0), (-1, -1), 0.75, ORANGE),
            ("LEFTPADDING", (0, 0), (-1, -1), 10),
            ("RIGHTPADDING", (0, 0), (-1, -1), 10),
            ("TOPPADDING", (0, 0), (-1, -1), 7),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ]))
        elements.append(vat_banner)
        elements.append(Spacer(1, 2 * mm))
        elements.append(Paragraph(f"Momssats: {vat_rate * 100:.0f}%", subsection_style))

        # Sales VAT (Output)
        elements.append(Paragraph(vat_terms["output"], ParagraphStyle("VDOut", parent=styles["Heading3"], fontSize=12, spaceBefore=8, spaceAfter=4, textColor=DARK)))
        sales_vat_data = [
            ["", "Beløb"],
            [vat_terms["sales_incl"], _da_money(_fd['salg_med_moms'], decimals=2)],
            [vat_terms["sales_excl"], _da_money(_fd['salg_med_moms'] - output_vat, decimals=2)],
            [vat_terms["output"], _da_money(output_vat, decimals=2)],
        ]
        t_sv = Table(sales_vat_data, colWidths=[95 * mm, 70 * mm])
        t_sv.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), DARK),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 10),
            ("PADDING", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
        ]))
        elements.append(t_sv)

        # Expenses VAT (Input)
        elements.append(Paragraph(vat_terms["input"], ParagraphStyle("VDIn", parent=styles["Heading3"], fontSize=12, spaceBefore=8, spaceAfter=4, textColor=DARK)))
        exp_vat_data = [
            ["", "Beløb"],
            [vat_terms["exp_incl"], _da_money(_fd['kob_med_moms'], decimals=2)],
            [vat_terms["exp_excl"], _da_money(_fd['kob_med_moms'] - input_vat, decimals=2)],
            [vat_terms["input"], _da_money(input_vat, decimals=2)],
        ]
        t_ev = Table(exp_vat_data, colWidths=[95 * mm, 70 * mm])
        t_ev.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), DARK),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 10),
            ("PADDING", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
        ]))
        elements.append(t_ev)

        # Expense breakdown by category with VAT
        expense_breakdown_vat = (
            db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
            .join(Expense, Expense.category_id == ExpenseCategory.id)
            .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True), Expense.is_tax_exempt.isnot(True))
            .group_by(ExpenseCategory.name)
            .order_by(func.sum(Expense.amount).desc())
            .all()
        )
        if expense_breakdown_vat:
            elements.append(Paragraph("Udgifter fordelt på kategori", ParagraphStyle("VDCat", parent=styles["Heading3"], fontSize=12, spaceBefore=8, spaceAfter=4, textColor=DARK)))
            bd = [["Kategori", f"Inkl. {vat_terms['name'].lower()}", f"{vat_terms['name']}-beløb"]]
            for name, total in expense_breakdown_vat:
                # Match _calc_vat's extraction so per-category rows sum to the
                # filing input_vat TOTAL: B2C (incl) = gross*rate/(1+rate);
                # B2B (excl) = net*rate.
                cat_vat = round(float(total) * (vat_rate if not _fd["prices_include_moms"] else vat_rate / (1 + vat_rate)), 2) if vat_rate > 0 else 0
                bd.append([name, _da_money(float(total), decimals=2), _da_money(cat_vat, decimals=2)])
            bd.append(["I ALT", _da_money(_fd['kob_med_moms'], decimals=2), _da_money(input_vat, decimals=2)])
            tb = Table(bd, colWidths=[65 * mm, 50 * mm, 50 * mm])
            tb.setStyle(_neutral_header())
            tb.setStyle(TableStyle([
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
            ]))
            elements.append(tb)

        # Net VAT payable
        elements.append(Spacer(1, 5 * mm))
        elements.append(Paragraph(vat_terms["net"], ParagraphStyle("VDNet", parent=styles["Heading3"], fontSize=12, spaceBefore=8, spaceAfter=4, textColor=DARK)))
        payable_color = RED if vat_payable >= 0 else GREEN
        # The input line is a subtraction — show a leading minus ONLY when there
        # is actually input moms to subtract (never "- 0,00 kr.").
        input_cell = _da_money(input_vat, decimals=2)
        if input_vat > 0:
            input_cell = f"- {input_cell}"
        net_data = [
            [vat_terms["output"], _da_money(output_vat, decimals=2)],
            [vat_terms["input"], input_cell],
            [vat_terms["net"].upper(), _da_money(vat_payable, decimals=2)],
        ]
        tn = Table(net_data, colWidths=[95 * mm, 70 * mm])
        tn.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 11),
            ("FONTSIZE", (0, -1), (-1, -1), 13),
            ("PADDING", (0, 0), (-1, -1), 10),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#fef2f2") if vat_payable >= 0 else colors.HexColor("#f0fdf4")),
            ("TEXTCOLOR", (1, -1), (1, -1), payable_color),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ]))
        elements.append(tn)

        # Advisory, not imperative: this is an internal estimate, the real
        # number is confirmed in the momsangivelse. Neutral ink (not a red
        # "you owe" alarm) for the to-pay case.
        if vat_payable >= 0:
            status_text = "Beregnet moms at afregne (vejledende) — bekræftes i din momsangivelse"
            status_color = DARK
        else:
            status_text = vat_terms["refund"]
            status_color = payable_color
        elements.append(Spacer(1, 2 * mm))
        elements.append(Paragraph(f"<b>{status_text}</b>", ParagraphStyle("VDStatus", parent=small_style, fontSize=10, textColor=status_color)))

    # ================================================================
    # STAFF COSTS
    # ================================================================
    if "staff_costs" in sections:
        staffing_rules = (
            db.query(StaffingRule.label, StaffingRule.revenue_min, StaffingRule.revenue_max, StaffingRule.recommended_staff)
            .filter(StaffingRule.user_id == user.id)
            .order_by(StaffingRule.revenue_min)
            .all()
        )
        elements.append(Paragraph("Bemandingsregler", section_style))
        if staffing_rules:
            staff_data = [["Navn", "Omsætning min.", "Omsætning maks.", "Anbefalet bemanding"]]
            for label, rev_min, rev_max, rec_staff in staffing_rules:
                staff_data.append([label, _da_money(float(rev_min)), _da_money(float(rev_max)), str(rec_staff)])
            t_staff = Table(staff_data, colWidths=[40 * mm, 40 * mm, 40 * mm, 40 * mm])
            t_staff.setStyle(_neutral_header())
            elements.append(t_staff)
        else:
            elements.append(Paragraph("Ingen bemandingsregler opsat.", body_style))

    # ================================================================
    # KHATA SUMMARY
    # ================================================================
    if "khata_summary" in sections:
        khata_data_rows = (
            db.query(
                KhataCustomer.name,
                func.coalesce(func.sum(KhataTransaction.purchase_amount), 0).label("total_purchases"),
                func.coalesce(func.sum(KhataTransaction.paid_amount), 0).label("total_paid"),
            )
            .outerjoin(KhataTransaction, KhataTransaction.customer_id == KhataCustomer.id)
            .filter(KhataCustomer.user_id == user.id, KhataCustomer.is_deleted.isnot(True))
            .group_by(KhataCustomer.id, KhataCustomer.name)
            .all()
        )
        elements.append(Paragraph("Tilgodehavender", section_style))
        elements.append(Paragraph("Udestående saldi pr. kunde (akkumuleret)", subsection_style))
        if khata_data_rows:
            # Sort by balance descending (biggest debtors first)
            khata_sorted = sorted(khata_data_rows, key=lambda r: float(r.total_purchases) - float(r.total_paid), reverse=True)
            kh_data = [["Kunde", "Køb i alt", "Betalt i alt", "Saldo"]]
            total_balance = 0
            for name, purchases, paid in khata_sorted:
                p = float(purchases)
                pd = float(paid)
                balance = p - pd
                total_balance += balance
                kh_data.append([name, _da_money(p), _da_money(pd), _da_money(balance)])
            kh_data.append(["I ALT", "", "", _da_money(total_balance)])

            t_kh = Table(kh_data, colWidths=[50 * mm, 35 * mm, 35 * mm, 35 * mm])
            t_kh.setStyle(_neutral_header())
            t_kh.setStyle(TableStyle([
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
            ]))
            elements.append(t_kh)
        else:
            elements.append(Paragraph("Ingen kunder med tilgodehavende fundet.", body_style))

    # ================================================================
    # CASH FLOW
    # ================================================================
    if "cash_flow" in sections:
        cash_in_total = float(
            db.query(func.coalesce(func.sum(CashTransaction.amount), 0))
            .filter(CashTransaction.user_id == user.id, CashTransaction.date.between(start, end),
                    CashTransaction.type == "cash_in", CashTransaction.is_deleted.isnot(True))
            .scalar()
        )
        cash_out_total = float(
            db.query(func.coalesce(func.sum(CashTransaction.amount), 0))
            .filter(CashTransaction.user_id == user.id, CashTransaction.date.between(start, end),
                    CashTransaction.type == "cash_out", CashTransaction.is_deleted.isnot(True))
            .scalar()
        )
        net_cash_flow = cash_in_total - cash_out_total

        elements.append(Paragraph("Pengestrøm", section_style))
        elements.append(Paragraph(f"{month_name} {year}", subsection_style))

        cf_data = [
            ["", "Beløb"],
            ["Indbetalinger i alt", _da_money(cash_in_total)],
            ["Udbetalinger i alt", _da_money(cash_out_total)],
            ["Netto pengestrøm", _da_money(net_cash_flow)],
        ]
        t_cf = Table(cf_data, colWidths=[80 * mm, 80 * mm])
        t_cf.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), DARK),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 10),
            ("PADDING", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("TEXTCOLOR", (1, -1), (1, -1), GREEN if net_cash_flow >= 0 else RED),
        ]))
        elements.append(t_cf)

        # Breakdown by category
        cash_by_cat = (
            db.query(CashTransaction.type, CashTransaction.category, func.sum(CashTransaction.amount).label("total"))
            .filter(CashTransaction.user_id == user.id, CashTransaction.date.between(start, end), CashTransaction.is_deleted.isnot(True))
            .group_by(CashTransaction.type, CashTransaction.category)
            .order_by(CashTransaction.type, func.sum(CashTransaction.amount).desc())
            .all()
        )
        if cash_by_cat:
            elements.append(Spacer(1, 3 * mm))
            elements.append(Paragraph("Pengestrøm pr. kategori", subsection_style))
            cat_data = [["Type", "Kategori", "Beløb"]]
            _cash_type_da = {"cash_in": "Indbetaling", "cash_out": "Udbetaling"}
            for txn_type, category, total in cash_by_cat:
                cat_label = category if category else "Uden kategori"
                type_label = _cash_type_da.get(txn_type, txn_type.replace("_", " ").title())
                cat_data.append([type_label, cat_label, _da_money(float(total))])
            t_cat = Table(cat_data, colWidths=[40 * mm, 60 * mm, 60 * mm])
            t_cat.setStyle(_neutral_header())
            elements.append(t_cat)

    # ================================================================
    # WASTE
    # ================================================================
    if "waste" in sections:
        waste_total = float(
            db.query(func.coalesce(func.sum(WasteLog.estimated_cost), 0))
            .filter(WasteLog.user_id == user.id, WasteLog.date.between(start, end))
            .scalar()
        )
        waste_by_reason = (
            db.query(WasteLog.reason, func.count(WasteLog.id), func.sum(WasteLog.estimated_cost))
            .filter(WasteLog.user_id == user.id, WasteLog.date.between(start, end))
            .group_by(WasteLog.reason)
            .all()
        )
        if waste_by_reason:
            elements.append(Paragraph("Spild", section_style))
            waste_data = [["Årsag", "Antal", "Omkostning", "% af spild"]]
            for reason, count, cost in waste_by_reason:
                c = float(cost) if cost else 0
                pct = round(c / waste_total * 100, 1) if waste_total > 0 else 0
                waste_data.append([reason.title(), str(count), _da_money(c), f"{pct}%"])
            waste_data.append(["I ALT", "", _da_money(waste_total), "100%"])

            tw = Table(waste_data, colWidths=[40 * mm, 30 * mm, 35 * mm, 30 * mm])
            tw.setStyle(_neutral_header())
            tw.setStyle(TableStyle([
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
            ]))
            elements.append(tw)

    # ================================================================
    # CLOSING NOTE (flows with content) + PER-PAGE FOOTER (canvas)
    # ================================================================
    elements.append(Spacer(1, 10 * mm))
    elements.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
    elements.append(Spacer(1, 3 * mm))
    elements.append(Paragraph(
        f"Ledelsesrapport genereret af BonBox &mdash; internt overblik, "
        f"<b>ikke en momsangivelse</b>. "
        f"Data dækker 1.&ndash;{last_day}. {month_name} {year}. Alle beløb i kr. "
        f"Til indberetning til SKAT: brug Skat Autopilot eller send til din revisor.",
        small_style,
    ))

    # Per-page footer drawn on the canvas → renders on EVERY page (the old
    # flowable footer only appeared on the last page). Drawn during the
    # numbered-canvas replay so "Side X af Y" knows the real total.
    from reportlab.pdfgen import canvas as _rl_canvas

    def _draw_footer(canvas, page_num, total_pages):
        canvas.saveState()
        page_w, _ = A4
        y = 10 * mm
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.5)
        canvas.line(15 * mm, y + 5 * mm, page_w - 15 * mm, y + 5 * mm)
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.grey)
        canvas.drawString(15 * mm, y, f"Side {page_num} af {total_pages}")
        canvas.drawRightString(page_w - 15 * mm, y, "bonbox.dk · ikke en momsangivelse")
        canvas.restoreState()

    class _NumberedCanvas(_rl_canvas.Canvas):
        """Buffers each page, then on save() replays them with the true total
        page count so the footer can print 'Side X af Y'."""
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self._saved_states = []

        def showPage(self):
            self._saved_states.append(dict(self.__dict__))
            self._startPage()

        def save(self):
            total = len(self._saved_states)
            for page_num, state in enumerate(self._saved_states, start=1):
                self.__dict__.update(state)
                _draw_footer(self, page_num, total)
                super().showPage()
            super().save()

    doc.build(elements, canvasmaker=_NumberedCanvas)
    buf.seek(0)
    filename = f"BonBox_Ledelsesrapport_{month_name}_{year}.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )