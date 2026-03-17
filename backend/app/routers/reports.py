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
    cur = user.currency or "DKK"

    # ---- Gather all data ----
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
        .filter(Sale.user_id == user.id, Sale.date.between(prev_start, prev_end))
        .scalar()
    )
    prev_expenses = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date.between(prev_start, prev_end))
        .scalar()
    )
    rev_change = round(((total_revenue - prev_revenue) / prev_revenue) * 100, 1) if prev_revenue > 0 else 0
    exp_change = round(((total_expenses - prev_expenses) / prev_expenses) * 100, 1) if prev_expenses > 0 else 0

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

    # Payment method breakdown
    payment_breakdown = (
        db.query(Sale.payment_method, func.count(Sale.id), func.sum(Sale.amount))
        .filter(Sale.user_id == user.id, Sale.date.between(start, end))
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

    # VAT summary
    vat_rate = 0.25
    output_vat = round(total_revenue * vat_rate / (1 + vat_rate), 2)
    input_vat = round(total_expenses * vat_rate / (1 + vat_rate), 2)
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
    elements.append(Paragraph("VAT / Moms Summary", section_style))
    elements.append(Paragraph("Danish VAT rate: 25% (for accountant reference)", subsection_style))
    vat_data = [
        ["", "Incl. VAT", "Excl. VAT", "VAT Amount"],
        ["Sales (Salg)", f"{total_revenue:,.0f}", f"{total_revenue / (1 + vat_rate):,.0f}", f"{output_vat:,.0f}"],
        ["Expenses (Udgifter)", f"{total_expenses:,.0f}", f"{total_expenses / (1 + vat_rate):,.0f}", f"{input_vat:,.0f}"],
        ["VAT Payable (Moms)", "", "", f"{vat_payable:,.0f} {cur}"],
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
        .filter(Sale.user_id == user.id, Sale.date.between(lookback_start, today))
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
        .filter(Expense.user_id == user.id, Expense.date >= start, Sale.date < end)
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
