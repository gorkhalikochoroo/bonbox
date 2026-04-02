import io
from datetime import date, timedelta
import calendar

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
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
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.waste import WasteLog
from app.models.khata import KhataCustomer, KhataTransaction
from app.models.cashbook import CashTransaction
from app.models.staffing import StaffingRule
from app.services.auth import get_current_user
from pydantic import BaseModel
from typing import List

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
        .filter(CashTransaction.user_id == user.id, CashTransaction.date == d, CashTransaction.type == "in", CashTransaction.is_deleted.isnot(True))
        .scalar()
    )
    cash_out = float(
        db.query(func.coalesce(func.sum(CashTransaction.amount), 0))
        .filter(CashTransaction.user_id == user.id, CashTransaction.date == d, CashTransaction.type == "out", CashTransaction.is_deleted.isnot(True))
        .scalar()
    )

    return {
        "date": d.isoformat(),
        "business_name": user.business_name or "BonBox",
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

    return {
        "month": month,
        "year": year,
        "total_revenue": float(total_revenue),
        "total_expenses": float(total_expenses),
        "net_profit": float(total_revenue) - float(total_expenses),
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


def _mini_bar_chart(data_pairs, width=160 * mm, height=60 * mm, bar_color=BLUE):
    """Create a simple horizontal bar chart as a Drawing."""
    if not data_pairs:
        return Spacer(1, 5 * mm)

    d = Drawing(width, height)
    max_val = max(v for _, v in data_pairs) if data_pairs else 1
    bar_h = min(12, (height - 10) / len(data_pairs))
    label_w = 60

    for i, (label, val) in enumerate(data_pairs):
        y = height - (i + 1) * (bar_h + 3)
        bar_w = ((val / max_val) * (width - label_w - 20)) if max_val > 0 else 0

        d.add(String(0, y + 2, str(label)[:20], fontSize=7, fontName="Helvetica"))
        d.add(Rect(label_w, y, bar_w, bar_h - 1, fillColor=bar_color, strokeColor=None))
        d.add(String(label_w + bar_w + 3, y + 2, f"{val:,.0f}", fontSize=7, fontName="Helvetica"))

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
    month_name = calendar.month_name[month]
    cur = get_display_currency(user.currency or "DKK")

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
    net_profit = total_revenue - total_expenses
    margin = round((net_profit / total_revenue) * 100, 1) if total_revenue > 0 else 0

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
    output_vat = round(total_revenue * vat_rate / (1 + vat_rate), 2) if vat_rate > 0 else 0
    input_vat = round(total_expenses * vat_rate / (1 + vat_rate), 2) if vat_rate > 0 else 0
    vat_payable = round(output_vat - input_vat, 2)

    # Best/worst days
    best_day = max(daily_revenue, key=lambda r: r.total, default=None)
    worst_day = min(daily_revenue, key=lambda r: r.total, default=None)

    # Avg daily revenue
    days_with_sales = len(daily_revenue)
    avg_daily = round(total_revenue / days_with_sales, 2) if days_with_sales > 0 else 0

    # Weekday analysis
    weekday_totals = {}
    weekday_counts = {}
    for d, total in daily_revenue:
        wday = d.strftime("%A")
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
    title_style = ParagraphStyle("ReportTitle", parent=styles["Title"], fontSize=22, spaceAfter=2, textColor=DARK)
    subtitle_style = ParagraphStyle("ReportSub", parent=styles["Normal"], fontSize=11, textColor=colors.grey, spaceAfter=4)
    section_style = ParagraphStyle("ReportSection", parent=styles["Heading2"], fontSize=14, spaceBefore=16, spaceAfter=8, textColor=DARK)
    subsection_style = ParagraphStyle("ReportSubSec", parent=styles["Normal"], fontSize=10, textColor=colors.grey, spaceAfter=4)
    body_style = ParagraphStyle("ReportBody", parent=styles["Normal"], fontSize=9, leading=13)
    small_style = ParagraphStyle("ReportSmall", parent=styles["Normal"], fontSize=8, textColor=colors.grey)

    elements = []

    # ============================================================
    # HEADER
    # ============================================================
    elements.append(Paragraph(f"{user.business_name or 'My Business'}", title_style))
    elements.append(Paragraph(f"Monthly Financial Report &mdash; {month_name} {year}", subtitle_style))
    elements.append(Paragraph(f"Generated on {date.today().strftime('%d %B %Y')}", small_style))
    elements.append(Spacer(1, 3 * mm))
    elements.append(HRFlowable(width="100%", thickness=1, color=BLUE, spaceAfter=8))

    # ============================================================
    # FINANCIAL SUMMARY (KPI Cards as table)
    # ============================================================
    elements.append(Paragraph("Financial Summary", section_style))

    rev_arrow = "+" if rev_change >= 0 else ""
    exp_arrow = "+" if exp_change >= 0 else ""
    profit_color = "#16a34a" if net_profit >= 0 else "#dc2626"

    summary_data = [
        ["", "This Month", "vs Last Month"],
        ["Total Revenue", f"{total_revenue:,.0f} {cur}", f"{rev_arrow}{rev_change}%"],
        ["Total Expenses", f"{total_expenses:,.0f} {cur}", f"{exp_arrow}{exp_change}%"],
        ["Net Profit", f"{net_profit:,.0f} {cur}", f"{margin}% margin"],
        ["Avg Daily Revenue", f"{avg_daily:,.0f} {cur}", f"{days_with_sales} days recorded"],
        ["Waste Cost", f"{waste_total:,.0f} {cur}", f"{round(waste_total/total_revenue*100, 1) if total_revenue > 0 else 0}% of revenue"],
    ]
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

    # Highlight best/worst
    if best_day or worst_day:
        elements.append(Spacer(1, 3 * mm))
        highlights = []
        if best_day:
            highlights.append(f"Best day: {best_day.date.strftime('%A %d %b')} ({float(best_day.total):,.0f} {cur})")
        if worst_day:
            highlights.append(f"Slowest day: {worst_day.date.strftime('%A %d %b')} ({float(worst_day.total):,.0f} {cur})")
        elements.append(Paragraph(" &bull; ".join(highlights), body_style))

    # ============================================================
    # EXPENSE BREAKDOWN
    # ============================================================
    if expense_breakdown:
        elements.append(Paragraph("Expense Breakdown", section_style))
        exp_data = [["Category", "Amount", "% of Expenses", "% of Revenue"]]
        for name, total in expense_breakdown:
            amt = float(total)
            pct_exp = round(amt / total_expenses * 100, 1) if total_expenses > 0 else 0
            pct_rev = round(amt / total_revenue * 100, 1) if total_revenue > 0 else 0
            exp_data.append([name, f"{amt:,.0f} {cur}", f"{pct_exp}%", f"{pct_rev}%"])
        exp_data.append(["TOTAL", f"{total_expenses:,.0f} {cur}", "100%", f"{round(total_expenses/total_revenue*100, 1) if total_revenue > 0 else 0}%"])

        t2 = Table(exp_data, colWidths=[50 * mm, 40 * mm, 35 * mm, 35 * mm])
        t2.setStyle(_header_table_style())
        # Bold the total row
        t2.setStyle(TableStyle([
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
        ]))
        elements.append(t2)

        # Mini bar chart of expenses
        expense_pairs = [(name, float(total)) for name, total in expense_breakdown[:8]]
        elements.append(Spacer(1, 3 * mm))
        elements.append(_mini_bar_chart(expense_pairs, bar_color=colors.HexColor("#ef4444")))

    # ============================================================
    # PAYMENT METHODS
    # ============================================================
    if payment_breakdown:
        elements.append(Paragraph("Payment Methods", section_style))
        pay_data = [["Method", "Transactions", "Total Amount", "% of Revenue"]]
        for method, count, total in payment_breakdown:
            amt = float(total)
            pct = round(amt / total_revenue * 100, 1) if total_revenue > 0 else 0
            pay_data.append([method.title(), str(count), f"{amt:,.0f} {cur}", f"{pct}%"])
        t_pay = Table(pay_data, colWidths=[40 * mm, 35 * mm, 40 * mm, 35 * mm])
        t_pay.setStyle(_header_table_style())
        elements.append(t_pay)

    # ============================================================
    # WEEKDAY ANALYSIS
    # ============================================================
    if weekday_avg:
        elements.append(Paragraph("Revenue by Day of Week", section_style))
        elements.append(Paragraph("Average revenue per weekday based on this month's data", subsection_style))
        ordered_days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        weekday_pairs = [(d, weekday_avg.get(d, 0)) for d in ordered_days if d in weekday_avg]
        elements.append(_mini_bar_chart(weekday_pairs, bar_color=BLUE))

    # ============================================================
    # DAILY REVENUE TABLE
    # ============================================================
    if daily_revenue:
        elements.append(Paragraph("Daily Revenue Log", section_style))
        day_data = [["Date", "Day", "Revenue", "vs Avg"]]
        for d, total in daily_revenue:
            amt = float(total)
            vs_avg = round(((amt - avg_daily) / avg_daily) * 100, 1) if avg_daily > 0 else 0
            vs_str = f"+{vs_avg}%" if vs_avg >= 0 else f"{vs_avg}%"
            day_data.append([
                d.strftime("%d %b"),
                d.strftime("%A"),
                f"{amt:,.0f} {cur}",
                vs_str,
            ])
        day_data.append(["", "TOTAL", f"{total_revenue:,.0f} {cur}", ""])

        t3 = Table(day_data, colWidths=[30 * mm, 35 * mm, 40 * mm, 30 * mm])
        t3.setStyle(_header_table_style())
        t3.setStyle(TableStyle([
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
        ]))
        elements.append(t3)

    # ============================================================
    # WASTE REPORT
    # ============================================================
    if waste_by_reason:
        elements.append(Paragraph("Waste Report", section_style))
        waste_data = [["Reason", "Items", "Cost", "% of Waste"]]
        for reason, count, cost in waste_by_reason:
            c = float(cost) if cost else 0
            pct = round(c / waste_total * 100, 1) if waste_total > 0 else 0
            waste_data.append([reason.title(), str(count), f"{c:,.0f} {cur}", f"{pct}%"])
        waste_data.append(["TOTAL", "", f"{waste_total:,.0f} {cur}", "100%"])

        tw = Table(waste_data, colWidths=[40 * mm, 30 * mm, 35 * mm, 30 * mm])
        tw.setStyle(_header_table_style())
        tw.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), ORANGE),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#fff7ed")),
        ]))
        elements.append(tw)

    # ============================================================
    # INVENTORY ALERTS
    # ============================================================
    if low_stock:
        elements.append(Paragraph("Inventory Alerts — Low Stock", section_style))
        elements.append(Paragraph(f"{len(low_stock)} item(s) below minimum threshold", subsection_style))
        inv_data = [["Item", "Current Qty", "Unit", "Min Required"]]
        for name, qty, unit, threshold in low_stock:
            inv_data.append([name, f"{float(qty):.1f}", unit, f"{float(threshold):.1f}"])
        ti = Table(inv_data, colWidths=[55 * mm, 30 * mm, 25 * mm, 30 * mm])
        ti.setStyle(_header_table_style())
        ti.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), RED),
        ]))
        elements.append(ti)

    # ============================================================
    # VAT SUMMARY
    # ============================================================
    mterms = get_vat_terms(user.currency or "DKK")
    elements.append(Paragraph(f"{mterms['name']} Summary", section_style))
    elements.append(Paragraph(f"{mterms['name']} rate: {vat_rate * 100:.0f}% ({user.currency}) (for accountant reference)", subsection_style))
    vat_data = [
        ["", f"Incl. {mterms['name']}", f"Excl. {mterms['name']}", f"{mterms['name']} Amount"],
        [mterms["output"], f"{total_revenue:,.0f}", f"{total_revenue / (1 + vat_rate):,.0f}", f"{output_vat:,.0f}"],
        [mterms["input"], f"{total_expenses:,.0f}", f"{total_expenses / (1 + vat_rate):,.0f}", f"{input_vat:,.0f}"],
        [mterms["net"], "", "", f"{vat_payable:,.0f} {cur}"],
    ]
    tv = Table(vat_data, colWidths=[45 * mm, 35 * mm, 35 * mm, 40 * mm])
    tv.setStyle(_header_table_style())
    tv.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PURPLE),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f5f3ff")),
    ]))
    elements.append(tv)

    # ============================================================
    # FOOTER
    # ============================================================
    elements.append(Spacer(1, 10 * mm))
    elements.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
    elements.append(Spacer(1, 3 * mm))
    elements.append(Paragraph(
        f"This report was generated by BonBox &mdash; Smart Business Analytics for {user.business_name or 'your business'}. "
        f"Data covers {month_name} 1&ndash;{last_day}, {year}. All amounts in {cur}.",
        small_style,
    ))
    elements.append(Paragraph("bonbox.dk", ParagraphStyle("Footer", parent=small_style, textColor=BLUE)))

    doc.build(elements)
    buf.seek(0)
    filename = f"BonBox_Report_{month_name}_{year}.pdf"
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
    output_vat = round(sales_total * vat_rate / (1 + vat_rate), 2) if vat_rate > 0 else 0
    input_vat = round(expenses_total * vat_rate / (1 + vat_rate), 2) if vat_rate > 0 else 0
    vat_payable = round(output_vat - input_vat, 2)

    return {
        "vat_rate": vat_rate,
        "vat_rate_pct": round(vat_rate * 100, 1),
        "sales_incl_vat": sales_total,
        "sales_excl_vat": round(sales_total / (1 + vat_rate), 2) if vat_rate > 0 else sales_total,
        "output_vat": output_vat,
        "expenses_incl_vat": expenses_total,
        "expenses_excl_vat": round(expenses_total / (1 + vat_rate), 2) if vat_rate > 0 else expenses_total,
        "input_vat": input_vat,
        "vat_payable": vat_payable,
        "currency": get_display_currency(user.currency),
        "business_name": user.business_name,
        "expense_breakdown": [(name, float(total)) for name, total in expense_breakdown],
    }


@router.get("/vat-export")
def vat_export(
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
    return data


@router.get("/vat-export/pdf")
def vat_export_pdf(
    month: int = Query(None),
    year: int = Query(...),
    quarter: int = Query(None, ge=1, le=4),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate localized VAT/Tax PDF report."""
    tax_name = get_vat_terms(user.currency or "DKK")["name"]
    if quarter:
        q_months = {1: (1, 3), 2: (4, 6), 3: (7, 9), 4: (10, 12)}
        m_start, m_end = q_months[quarter]
        start = date(year, m_start, 1)
        end = date(year + 1, 1, 1) if m_end == 12 else date(year, m_end + 1, 1)
        period_label = f"Q{quarter} {year} ({calendar.month_abbr[m_start]}-{calendar.month_abbr[m_end]})"
        filename = f"{tax_name}_Q{quarter}_{year}.pdf"
    elif month:
        start = date(year, month, 1)
        end = date(year + 1, 1, 1) if month == 12 else date(year, month + 1, 1)
        period_label = f"{calendar.month_name[month]} {year}"
        filename = f"{tax_name}_{calendar.month_name[month]}_{year}.pdf"
    else:
        start = date(year, 1, 1)
        end = date(year + 1, 1, 1)
        period_label = str(year)
        filename = f"{tax_name}_{year}.pdf"

    data = _get_vat_data(db, user, start, end)
    cur = data["currency"]
    vat_rate = data["vat_rate"]
    terms = get_vat_terms(user.currency or "DKK")

    # Build PDF
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=15 * mm, bottomMargin=15 * mm, leftMargin=15 * mm, rightMargin=15 * mm)
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle("VTitle", parent=styles["Title"], fontSize=22, spaceAfter=2, textColor=DARK)
    subtitle_style = ParagraphStyle("VSub", parent=styles["Normal"], fontSize=11, textColor=colors.grey, spaceAfter=4)
    section_style = ParagraphStyle("VSection", parent=styles["Heading2"], fontSize=14, spaceBefore=16, spaceAfter=8, textColor=DARK)
    small_style = ParagraphStyle("VSmall", parent=styles["Normal"], fontSize=8, textColor=colors.grey)

    elements = []

    # Header
    elements.append(Paragraph(f"{data['business_name'] or 'My Business'}", title_style))
    elements.append(Paragraph(f"{terms['report']} &mdash; {period_label}", subtitle_style))
    elements.append(Paragraph(f"{terms['name']} Rate: {data['vat_rate_pct']}% | Currency: {cur} | Generated: {date.today().strftime('%d %B %Y')}", small_style))
    elements.append(Spacer(1, 3 * mm))
    elements.append(HRFlowable(width="100%", thickness=1.5, color=PURPLE, spaceAfter=10))

    # Sales VAT (Output)
    elements.append(Paragraph(terms["output"], section_style))
    sales_data = [
        ["", "Amount"],
        [terms["sales_incl"], f"{data['sales_incl_vat']:,.2f} {cur}"],
        [terms["sales_excl"], f"{data['sales_excl_vat']:,.2f} {cur}"],
        [terms["output"], f"{data['output_vat']:,.2f} {cur}"],
    ]
    t = Table(sales_data, colWidths=[95 * mm, 70 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), BLUE),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("PADDING", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#eff6ff")),
    ]))
    elements.append(t)

    # Expenses VAT (Input)
    elements.append(Paragraph(terms["input"], section_style))
    exp_data = [
        ["", "Amount"],
        [terms["exp_incl"], f"{data['expenses_incl_vat']:,.2f} {cur}"],
        [terms["exp_excl"], f"{data['expenses_excl_vat']:,.2f} {cur}"],
        [terms["input"], f"{data['input_vat']:,.2f} {cur}"],
    ]
    t2 = Table(exp_data, colWidths=[95 * mm, 70 * mm])
    t2.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GREEN),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("PADDING", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f0fdf4")),
    ]))
    elements.append(t2)

    # Expense breakdown
    if data["expense_breakdown"]:
        elements.append(Paragraph("Expense Breakdown by Category", section_style))
        bd = [["Category", "Incl. VAT", "VAT Amount"]]
        for name, total in data["expense_breakdown"]:
            cat_vat = round(total * vat_rate / (1 + vat_rate), 2) if vat_rate > 0 else 0
            bd.append([name, f"{total:,.2f} {cur}", f"{cat_vat:,.2f} {cur}"])
        bd.append(["TOTAL", f"{data['expenses_incl_vat']:,.2f} {cur}", f"{data['input_vat']:,.2f} {cur}"])
        tb = Table(bd, colWidths=[65 * mm, 50 * mm, 50 * mm])
        tb.setStyle(_header_table_style())
        tb.setStyle(TableStyle([
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
        ]))
        elements.append(tb)

    # NET VAT PAYABLE
    elements.append(Spacer(1, 5 * mm))
    elements.append(Paragraph(terms["net"], section_style))
    payable_color = RED if data["vat_payable"] >= 0 else GREEN
    net_data = [
        [terms["output"], f"{data['output_vat']:,.2f} {cur}"],
        [terms["input"], f"- {data['input_vat']:,.2f} {cur}"],
        [terms["net"].upper(), f"{data['vat_payable']:,.2f} {cur}"],
    ]
    tn = Table(net_data, colWidths=[95 * mm, 70 * mm])
    tn.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 11),
        ("FONTSIZE", (0, -1), (-1, -1), 13),
        ("PADDING", (0, 0), (-1, -1), 10),
        ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#fef2f2") if data["vat_payable"] >= 0 else colors.HexColor("#f0fdf4")),
        ("TEXTCOLOR", (1, -1), (1, -1), payable_color),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
    ]))
    elements.append(tn)

    status_text = terms["owe"] if data["vat_payable"] >= 0 else terms["refund"]
    elements.append(Spacer(1, 2 * mm))
    elements.append(Paragraph(f"<b>{status_text}</b>", ParagraphStyle("VStatus", parent=small_style, fontSize=10, textColor=payable_color)))

    # Disclaimer
    elements.append(Spacer(1, 10 * mm))
    elements.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
    elements.append(Spacer(1, 3 * mm))
    elements.append(Paragraph(
        f"<b>Disclaimer:</b> This report is generated by BonBox for informational purposes only. "
        f"It is NOT official tax documentation. Always consult your accountant "
        f"before submitting to {terms['authority']}. BonBox is not responsible for any errors in tax filings.",
        ParagraphStyle("VDisclaim", parent=small_style, fontSize=7, textColor=colors.grey),
    ))
    elements.append(Paragraph("bonbox.dk", ParagraphStyle("VFoot", parent=small_style, textColor=PURPLE)))

    doc.build(elements)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ===========================================================================
# REPORT BUILDER — Overview metrics + Custom PDF
# ===========================================================================

@router.get("/overview")
def report_overview(
    month: int = Query(..., ge=1, le=12),
    year: int = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Return overview metrics for the selected month/year (used by Report Builder cards)."""
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
    vat_payable = round(total_revenue * vat_rate / (1 + vat_rate) - total_expenses * vat_rate / (1 + vat_rate), 2) if vat_rate > 0 else 0
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

    return {
        "month": month,
        "year": year,
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
    month_name = calendar.month_name[month]
    cur = get_display_currency(user.currency or "DKK")

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
    net_profit = total_revenue - total_expenses
    margin = round((net_profit / total_revenue) * 100, 1) if total_revenue > 0 else 0

    vat_rate = get_vat_rate(user.currency or "DKK")
    output_vat = round(total_revenue * vat_rate / (1 + vat_rate), 2) if vat_rate > 0 else 0
    input_vat = round(total_expenses * vat_rate / (1 + vat_rate), 2) if vat_rate > 0 else 0
    vat_payable = round(output_vat - input_vat, 2)
    vat_terms = get_vat_terms(user.currency or "DKK")

    # ---- Build PDF ----
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=15 * mm, bottomMargin=15 * mm,
        leftMargin=15 * mm, rightMargin=15 * mm,
    )
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle("CRTitle", parent=styles["Title"], fontSize=22, spaceAfter=2, textColor=DARK)
    subtitle_style = ParagraphStyle("CRSub", parent=styles["Normal"], fontSize=11, textColor=colors.grey, spaceAfter=4)
    section_style = ParagraphStyle("CRSection", parent=styles["Heading2"], fontSize=14, spaceBefore=16, spaceAfter=8, textColor=DARK)
    subsection_style = ParagraphStyle("CRSubSec", parent=styles["Normal"], fontSize=10, textColor=colors.grey, spaceAfter=4)
    body_style = ParagraphStyle("CRBody", parent=styles["Normal"], fontSize=9, leading=13)
    small_style = ParagraphStyle("CRSmall", parent=styles["Normal"], fontSize=8, textColor=colors.grey)

    elements = []

    # ================================================================
    # HEADER + OVERVIEW SUMMARY (always included)
    # ================================================================
    elements.append(Paragraph(f"{user.business_name or 'My Business'}", title_style))
    elements.append(Paragraph(f"Custom Report &mdash; {month_name} {year}", subtitle_style))
    elements.append(Paragraph(f"Generated on {date.today().strftime('%d %B %Y')}", small_style))
    elements.append(Spacer(1, 3 * mm))
    elements.append(HRFlowable(width="100%", thickness=1, color=BLUE, spaceAfter=8))

    elements.append(Paragraph("Overview Summary", section_style))

    summary_data = [
        ["Metric", "Value"],
        ["Total Revenue", f"{total_revenue:,.0f} {cur}"],
        ["Total Expenses", f"{total_expenses:,.0f} {cur}"],
        ["Net Profit", f"{net_profit:,.0f} {cur}"],
        ["Profit Margin", f"{margin}%"],
        [f"{vat_terms['name']} Payable", f"{vat_payable:,.2f} {cur}"],
    ]
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
            elements.append(Paragraph("Payment Methods", section_style))
            pay_data = [["Method", "Transactions", "Total Amount", "% of Revenue"]]
            for method, count, total in payment_breakdown:
                amt = float(total)
                pct = round(amt / total_revenue * 100, 1) if total_revenue > 0 else 0
                pay_data.append([method.title(), str(count), f"{amt:,.0f} {cur}", f"{pct}%"])
            t_pay = Table(pay_data, colWidths=[40 * mm, 35 * mm, 40 * mm, 35 * mm])
            t_pay.setStyle(_header_table_style())
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
            elements.append(Paragraph("Daily Revenue Log", section_style))
            day_data = [["Date", "Day", "Revenue", "vs Avg"]]
            for d, total in daily_revenue:
                amt = float(total)
                vs_avg = round(((amt - avg_daily) / avg_daily) * 100, 1) if avg_daily > 0 else 0
                vs_str = f"+{vs_avg}%" if vs_avg >= 0 else f"{vs_avg}%"
                day_data.append([
                    d.strftime("%d %b"),
                    d.strftime("%A"),
                    f"{amt:,.0f} {cur}",
                    vs_str,
                ])
            day_data.append(["", "TOTAL", f"{total_revenue:,.0f} {cur}", ""])
            t3 = Table(day_data, colWidths=[30 * mm, 35 * mm, 40 * mm, 30 * mm])
            t3.setStyle(_header_table_style())
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
                wday = d.strftime("%A")
                weekday_totals[wday] = weekday_totals.get(wday, 0) + float(total)
                weekday_counts[wday] = weekday_counts.get(wday, 0) + 1
            weekday_avg = {
                day: round(weekday_totals[day] / weekday_counts[day])
                for day in weekday_totals
            }
            elements.append(Paragraph("Revenue by Day of Week", section_style))
            elements.append(Paragraph("Average revenue per weekday based on this month's data", subsection_style))
            ordered_days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
            weekday_pairs = [(d, weekday_avg.get(d, 0)) for d in ordered_days if d in weekday_avg]
            elements.append(_mini_bar_chart(weekday_pairs, bar_color=BLUE))

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
            elements.append(Paragraph("Expense Breakdown", section_style))
            exp_data = [["Category", "Amount", "% of Expenses", "% of Revenue"]]
            for name, total in expense_breakdown:
                amt = float(total)
                pct_exp = round(amt / total_expenses * 100, 1) if total_expenses > 0 else 0
                pct_rev = round(amt / total_revenue * 100, 1) if total_revenue > 0 else 0
                exp_data.append([name, f"{amt:,.0f} {cur}", f"{pct_exp}%", f"{pct_rev}%"])
            exp_data.append(["TOTAL", f"{total_expenses:,.0f} {cur}", "100%", f"{round(total_expenses/total_revenue*100, 1) if total_revenue > 0 else 0}%"])

            t2 = Table(exp_data, colWidths=[50 * mm, 40 * mm, 35 * mm, 35 * mm])
            t2.setStyle(_header_table_style())
            t2.setStyle(TableStyle([
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
            ]))
            elements.append(t2)

            # Mini bar chart of expenses
            expense_pairs = [(name, float(total)) for name, total in expense_breakdown[:8]]
            elements.append(Spacer(1, 3 * mm))
            elements.append(_mini_bar_chart(expense_pairs, bar_color=colors.HexColor("#ef4444")))

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
            elements.append(Paragraph("Inventory", section_style))
            inv_data = [["Item", "Qty", "Unit", "Cost", "Sell Price", "Stock Value"]]
            total_stock_value = 0
            low_stock_items = []
            for name, qty, unit, cost, sell_price, min_thresh in inv_items:
                q = float(qty)
                c = float(cost)
                sp = float(sell_price) if sell_price else 0
                stock_val = q * c
                total_stock_value += stock_val
                row = [name, f"{q:.1f}", unit, f"{c:,.0f} {cur}", f"{sp:,.0f} {cur}", f"{stock_val:,.0f} {cur}"]
                inv_data.append(row)
                if q <= float(min_thresh):
                    low_stock_items.append((name, q, unit, float(min_thresh)))
            inv_data.append(["TOTAL", "", "", "", "", f"{total_stock_value:,.0f} {cur}"])

            t_inv = Table(inv_data, colWidths=[40 * mm, 20 * mm, 20 * mm, 25 * mm, 25 * mm, 30 * mm])
            t_inv.setStyle(_header_table_style())
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
                elements.append(Paragraph(f"Low Stock Alert &mdash; {len(low_stock_items)} item(s) below threshold", subsection_style))
                ls_data = [["Item", "Current Qty", "Unit", "Min Required"]]
                for name, qty, unit, thresh in low_stock_items:
                    ls_data.append([name, f"{qty:.1f}", unit, f"{thresh:.1f}"])
                t_ls = Table(ls_data, colWidths=[55 * mm, 30 * mm, 25 * mm, 30 * mm])
                t_ls.setStyle(_header_table_style())
                t_ls.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), RED),
                ]))
                elements.append(t_ls)

    # ================================================================
    # VAT DETAIL
    # ================================================================
    if "vat_detail" in sections:
        elements.append(Paragraph(f"{vat_terms['name']} Report", section_style))
        elements.append(Paragraph(f"{vat_terms['name']} Rate: {vat_rate * 100:.0f}% ({user.currency})", subsection_style))

        # Sales VAT (Output)
        elements.append(Paragraph(vat_terms["output"], ParagraphStyle("VDOut", parent=styles["Heading3"], fontSize=12, spaceBefore=8, spaceAfter=4, textColor=DARK)))
        sales_vat_data = [
            ["", "Amount"],
            [vat_terms["sales_incl"], f"{total_revenue:,.2f} {cur}"],
            [vat_terms["sales_excl"], f"{total_revenue / (1 + vat_rate):,.2f} {cur}" if vat_rate > 0 else f"{total_revenue:,.2f} {cur}"],
            [vat_terms["output"], f"{output_vat:,.2f} {cur}"],
        ]
        t_sv = Table(sales_vat_data, colWidths=[95 * mm, 70 * mm])
        t_sv.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), BLUE),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 10),
            ("PADDING", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#eff6ff")),
        ]))
        elements.append(t_sv)

        # Expenses VAT (Input)
        elements.append(Paragraph(vat_terms["input"], ParagraphStyle("VDIn", parent=styles["Heading3"], fontSize=12, spaceBefore=8, spaceAfter=4, textColor=DARK)))
        exp_vat_data = [
            ["", "Amount"],
            [vat_terms["exp_incl"], f"{total_expenses:,.2f} {cur}"],
            [vat_terms["exp_excl"], f"{total_expenses / (1 + vat_rate):,.2f} {cur}" if vat_rate > 0 else f"{total_expenses:,.2f} {cur}"],
            [vat_terms["input"], f"{input_vat:,.2f} {cur}"],
        ]
        t_ev = Table(exp_vat_data, colWidths=[95 * mm, 70 * mm])
        t_ev.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), GREEN),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 10),
            ("PADDING", (0, 0), (-1, -1), 8),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, LIGHT_BG]),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f0fdf4")),
        ]))
        elements.append(t_ev)

        # Expense breakdown by category with VAT
        expense_breakdown_vat = (
            db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
            .join(Expense, Expense.category_id == ExpenseCategory.id)
            .filter(Expense.user_id == user.id, Expense.date.between(start, end), Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
            .group_by(ExpenseCategory.name)
            .order_by(func.sum(Expense.amount).desc())
            .all()
        )
        if expense_breakdown_vat:
            elements.append(Paragraph("Expense Breakdown by Category", ParagraphStyle("VDCat", parent=styles["Heading3"], fontSize=12, spaceBefore=8, spaceAfter=4, textColor=DARK)))
            bd = [["Category", f"Incl. {vat_terms['name']}", f"{vat_terms['name']} Amount"]]
            for name, total in expense_breakdown_vat:
                cat_vat = round(float(total) * vat_rate / (1 + vat_rate), 2) if vat_rate > 0 else 0
                bd.append([name, f"{float(total):,.2f} {cur}", f"{cat_vat:,.2f} {cur}"])
            bd.append(["TOTAL", f"{total_expenses:,.2f} {cur}", f"{input_vat:,.2f} {cur}"])
            tb = Table(bd, colWidths=[65 * mm, 50 * mm, 50 * mm])
            tb.setStyle(_header_table_style())
            tb.setStyle(TableStyle([
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#f1f5f9")),
            ]))
            elements.append(tb)

        # Net VAT payable
        elements.append(Spacer(1, 5 * mm))
        elements.append(Paragraph(vat_terms["net"], ParagraphStyle("VDNet", parent=styles["Heading3"], fontSize=12, spaceBefore=8, spaceAfter=4, textColor=DARK)))
        payable_color = RED if vat_payable >= 0 else GREEN
        net_data = [
            [vat_terms["output"], f"{output_vat:,.2f} {cur}"],
            [vat_terms["input"], f"- {input_vat:,.2f} {cur}"],
            [vat_terms["net"].upper(), f"{vat_payable:,.2f} {cur}"],
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

        status_text = vat_terms["owe"] if vat_payable >= 0 else vat_terms["refund"]
        elements.append(Spacer(1, 2 * mm))
        elements.append(Paragraph(f"<b>{status_text}</b>", ParagraphStyle("VDStatus", parent=small_style, fontSize=10, textColor=payable_color)))

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
        elements.append(Paragraph("Staffing Rules", section_style))
        if staffing_rules:
            staff_data = [["Label", "Revenue Min", "Revenue Max", "Recommended Staff"]]
            for label, rev_min, rev_max, rec_staff in staffing_rules:
                staff_data.append([label, f"{float(rev_min):,.0f} {cur}", f"{float(rev_max):,.0f} {cur}", str(rec_staff)])
            t_staff = Table(staff_data, colWidths=[40 * mm, 40 * mm, 40 * mm, 40 * mm])
            t_staff.setStyle(_header_table_style())
            t_staff.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), PURPLE),
            ]))
            elements.append(t_staff)
        else:
            elements.append(Paragraph("No staffing rules configured.", body_style))

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
        elements.append(Paragraph("Khata Summary", section_style))
        elements.append(Paragraph("Outstanding balances by customer (cumulative)", subsection_style))
        if khata_data_rows:
            # Sort by balance descending (biggest debtors first)
            khata_sorted = sorted(khata_data_rows, key=lambda r: float(r.total_purchases) - float(r.total_paid), reverse=True)
            kh_data = [["Customer", "Total Purchases", "Total Paid", "Balance"]]
            total_balance = 0
            for name, purchases, paid in khata_sorted:
                p = float(purchases)
                pd = float(paid)
                balance = p - pd
                total_balance += balance
                kh_data.append([name, f"{p:,.0f} {cur}", f"{pd:,.0f} {cur}", f"{balance:,.0f} {cur}"])
            kh_data.append(["TOTAL", "", "", f"{total_balance:,.0f} {cur}"])

            t_kh = Table(kh_data, colWidths=[50 * mm, 35 * mm, 35 * mm, 35 * mm])
            t_kh.setStyle(_header_table_style())
            t_kh.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), ORANGE),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#fff7ed")),
            ]))
            elements.append(t_kh)
        else:
            elements.append(Paragraph("No khata customers found.", body_style))

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

        elements.append(Paragraph("Cash Flow", section_style))
        elements.append(Paragraph(f"{month_name} {year}", subsection_style))

        cf_data = [
            ["", "Amount"],
            ["Total Cash In", f"{cash_in_total:,.0f} {cur}"],
            ["Total Cash Out", f"{cash_out_total:,.0f} {cur}"],
            ["Net Cash Flow", f"{net_cash_flow:,.0f} {cur}"],
        ]
        t_cf = Table(cf_data, colWidths=[80 * mm, 80 * mm])
        t_cf.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), GREEN),
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
            elements.append(Paragraph("Cash Flow by Category", subsection_style))
            cat_data = [["Type", "Category", "Amount"]]
            for txn_type, category, total in cash_by_cat:
                cat_label = category if category else "Uncategorized"
                cat_data.append([txn_type.replace("_", " ").title(), cat_label, f"{float(total):,.0f} {cur}"])
            t_cat = Table(cat_data, colWidths=[40 * mm, 60 * mm, 60 * mm])
            t_cat.setStyle(_header_table_style())
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
            elements.append(Paragraph("Waste Report", section_style))
            waste_data = [["Reason", "Items", "Cost", "% of Waste"]]
            for reason, count, cost in waste_by_reason:
                c = float(cost) if cost else 0
                pct = round(c / waste_total * 100, 1) if waste_total > 0 else 0
                waste_data.append([reason.title(), str(count), f"{c:,.0f} {cur}", f"{pct}%"])
            waste_data.append(["TOTAL", "", f"{waste_total:,.0f} {cur}", "100%"])

            tw = Table(waste_data, colWidths=[40 * mm, 30 * mm, 35 * mm, 30 * mm])
            tw.setStyle(_header_table_style())
            tw.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), ORANGE),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#fff7ed")),
            ]))
            elements.append(tw)

    # ================================================================
    # FOOTER
    # ================================================================
    elements.append(Spacer(1, 10 * mm))
    elements.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
    elements.append(Spacer(1, 3 * mm))
    elements.append(Paragraph(
        f"This report was generated by BonBox. "
        f"Data covers {month_name} 1&ndash;{last_day}, {year}. All amounts in {cur}.",
        small_style,
    ))
    elements.append(Paragraph("bonbox.dk", ParagraphStyle("CRFoot", parent=small_style, textColor=BLUE)))

    doc.build(elements)
    buf.seek(0)
    filename = f"BonBox_Custom_Report_{month_name}_{year}.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )