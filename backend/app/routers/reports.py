import io
from datetime import date
import calendar

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import func
from sqlalchemy.orm import Session
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.services.auth import get_current_user

router = APIRouter()


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
        .filter(Sale.user_id == user.id, Sale.date.between(start, end))
        .scalar()
    )

    # Total expenses
    total_expenses = (
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date.between(start, end))
        .scalar()
    )

    # Expense breakdown by category
    expense_breakdown = (
        db.query(ExpenseCategory.name, ExpenseCategory.color, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date.between(start, end))
        .group_by(ExpenseCategory.name, ExpenseCategory.color)
        .order_by(func.sum(Expense.amount).desc())
        .all()
    )

    # Daily revenue for the month
    daily_revenue = (
        db.query(Sale.date, func.sum(Sale.amount).label("total"))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end))
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


@router.get("/monthly/pdf")
def monthly_report_pdf(
    month: int = Query(..., ge=1, le=12),
    year: int = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Generate a downloadable PDF monthly report."""
    if year is None:
        year = date.today().year

    _, last_day = calendar.monthrange(year, month)
    start = date(year, month, 1)
    end = date(year, month, last_day)
    month_name = calendar.month_name[month]

    total_revenue = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end))
        .scalar()
    )
    total_expenses = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date.between(start, end))
        .scalar()
    )
    net_profit = total_revenue - total_expenses
    margin = round((net_profit / total_revenue) * 100, 1) if total_revenue > 0 else 0

    expense_breakdown = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date.between(start, end))
        .group_by(ExpenseCategory.name)
        .order_by(func.sum(Expense.amount).desc())
        .all()
    )

    daily_revenue = (
        db.query(Sale.date, func.sum(Sale.amount).label("total"))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end))
        .group_by(Sale.date)
        .order_by(Sale.date)
        .all()
    )

    # Build PDF
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=20 * mm, bottomMargin=20 * mm)
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("Title2", parent=styles["Title"], fontSize=18, spaceAfter=6)
    subtitle_style = ParagraphStyle("Sub", parent=styles["Normal"], fontSize=11, textColor=colors.grey)
    section_style = ParagraphStyle("Section", parent=styles["Heading2"], fontSize=13, spaceBefore=14, spaceAfter=6)

    elements = []

    # Header
    elements.append(Paragraph(f"{user.business_name}", title_style))
    elements.append(Paragraph(f"Monthly Report — {month_name} {year}", subtitle_style))
    elements.append(Spacer(1, 10 * mm))

    # Summary table
    summary_data = [
        ["Total Revenue", f"{total_revenue:,.2f} {user.currency}"],
        ["Total Expenses", f"{total_expenses:,.2f} {user.currency}"],
        ["Net Profit", f"{net_profit:,.2f} {user.currency}"],
        ["Profit Margin", f"{margin}%"],
    ]
    t = Table(summary_data, colWidths=[70 * mm, 70 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#f1f5f9")),
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
        ("FONTSIZE", (0, 0), (-1, -1), 11),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("PADDING", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
    ]))
    elements.append(t)

    # Expense breakdown
    if expense_breakdown:
        elements.append(Paragraph("Expense Breakdown", section_style))
        exp_data = [["Category", "Amount"]]
        for name, total in expense_breakdown:
            exp_data.append([name, f"{float(total):,.2f} {user.currency}"])
        t2 = Table(exp_data, colWidths=[90 * mm, 50 * mm])
        t2.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#3b82f6")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), 10),
            ("PADDING", (0, 0), (-1, -1), 6),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
        ]))
        elements.append(t2)

    # Daily revenue
    if daily_revenue:
        elements.append(Paragraph("Daily Revenue", section_style))
        day_data = [["Date", "Revenue"]]
        for d, total in daily_revenue:
            day_data.append([str(d), f"{float(total):,.2f} {user.currency}"])
        t3 = Table(day_data, colWidths=[70 * mm, 70 * mm])
        t3.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#3b82f6")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
            ("FONTSIZE", (0, 0), (-1, -1), 10),
            ("PADDING", (0, 0), (-1, -1), 6),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
        ]))
        elements.append(t3)

    doc.build(elements)
    buf.seek(0)
    filename = f"report_{month_name}_{year}.pdf"
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/vat-export")
def vat_export(
    month: int = Query(...),
    year: int = Query(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Monthly VAT/moms summary formatted for Danish SKAT reporting."""
    start = date(year, month, 1)
    if month == 12:
        end = date(year + 1, 1, 1)
    else:
        end = date(year, month + 1, 1)

    sales_total = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= start, Sale.date < end)
        .scalar()
    )

    expenses_total = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= start, Expense.date < end)
        .scalar()
    )

    vat_rate = 0.25
    output_vat = round(sales_total * vat_rate / (1 + vat_rate), 2)  # moms af salg
    input_vat = round(expenses_total * vat_rate / (1 + vat_rate), 2)  # moms af indkøb
    vat_payable = round(output_vat - input_vat, 2)

    return {
        "period": f"{year}-{month:02d}",
        "sales_incl_vat": sales_total,
        "sales_excl_vat": round(sales_total / (1 + vat_rate), 2),
        "output_vat": output_vat,  # Udgående moms (salgsmoms)
        "expenses_incl_vat": expenses_total,
        "expenses_excl_vat": round(expenses_total / (1 + vat_rate), 2),
        "input_vat": input_vat,  # Indgående moms (købsmoms)
        "vat_payable": vat_payable,  # Moms til betaling
        "currency": user.currency,
        "business_name": user.business_name,
    }
