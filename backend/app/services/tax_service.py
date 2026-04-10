"""
Tax Autopilot Service — track deadlines, estimate amounts, generate reminders.

Uses country/currency to determine tax type, rates, and filing schedule.
Calculates estimated VAT/GST payable from actual sales & expense data.
"""

import logging
from datetime import date, timedelta
from dateutil.relativedelta import relativedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense
from app.models.daily_close import DailyClose

logger = logging.getLogger(__name__)


# ─── Tax Calendar by Currency ───────────────────────────────────
# Each entry: { tax_type, name, rate, frequency, deadlines_func }

VAT_RATES = {
    "DKK": 0.25, "SEK": 0.25, "NOK": 0.25, "EUR": 0.21,
    "GBP": 0.20, "NPR": 0.13, "INR": 0.18, "JPY": 0.10,
    "AUD": 0.10, "CAD": 0.05, "CHF": 0.081,
}

TAX_CONFIG = {
    "DKK": {
        "tax_name": "Moms",
        "authority": "SKAT",
        "rate": 0.25,
        "frequency": "quarterly",
        "deadlines": [  # (month, day) — Q1:Mar1, Q2:Jun1, Q3:Sep1, Q4:Dec1
            (3, 1), (6, 1), (9, 1), (12, 1),
        ],
        "quarter_map": {1: (1, 3), 2: (4, 6), 3: (7, 9), 4: (10, 12)},
    },
    "SEK": {
        "tax_name": "Moms",
        "authority": "Skatteverket",
        "rate": 0.25,
        "frequency": "quarterly",
        "deadlines": [(2, 12), (5, 12), (8, 17), (11, 12)],
        "quarter_map": {1: (1, 3), 2: (4, 6), 3: (7, 9), 4: (10, 12)},
    },
    "NOK": {
        "tax_name": "MVA",
        "authority": "Skatteetaten",
        "rate": 0.25,
        "frequency": "bimonthly",
        "deadlines": [(4, 10), (6, 10), (8, 10), (10, 10), (12, 10), (2, 10)],
        "quarter_map": {1: (1, 2), 2: (3, 4), 3: (5, 6), 4: (7, 8), 5: (9, 10), 6: (11, 12)},
    },
    "NPR": {
        "tax_name": "VAT",
        "authority": "IRD Nepal",
        "rate": 0.13,
        "frequency": "monthly",
        "deadlines": "25th",  # 25th of following month
        "quarter_map": None,
    },
    "INR": {
        "tax_name": "GST",
        "authority": "GSTN",
        "rate": 0.18,
        "frequency": "monthly",
        "deadlines": "20th",  # GSTR-3B due 20th of following month
        "quarter_map": None,
    },
    "GBP": {
        "tax_name": "VAT",
        "authority": "HMRC",
        "rate": 0.20,
        "frequency": "quarterly",
        "deadlines": [(5, 7), (8, 7), (11, 7), (2, 7)],
        "quarter_map": {1: (1, 3), 2: (4, 6), 3: (7, 9), 4: (10, 12)},
    },
}


def _get_vat_rate(currency: str) -> float:
    return VAT_RATES.get(currency, 0.13)


def _calc_vat(db: Session, user_id, start_date: date, end_date: date, vat_rate: float) -> dict:
    """Calculate VAT for a period."""
    sales_total = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user_id, Sale.date >= start_date, Sale.date < end_date,
                Sale.is_deleted.isnot(True), Sale.is_tax_exempt.isnot(True))
        .scalar()
    )
    expenses_total = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user_id, Expense.date >= start_date, Expense.date < end_date,
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True),
                Expense.is_tax_exempt.isnot(True))
        .scalar()
    )

    if vat_rate > 0:
        output_vat = round(sales_total * vat_rate / (1 + vat_rate), 2)
        input_vat = round(expenses_total * vat_rate / (1 + vat_rate), 2)
    else:
        output_vat = input_vat = 0

    return {
        "sales_total": round(sales_total, 2),
        "expenses_total": round(expenses_total, 2),
        "output_vat": output_vat,
        "input_vat": input_vat,
        "vat_payable": round(output_vat - input_vat, 2),
    }


def _calc_daily_close_vat(db: Session, user_id, start_date: date, end_date: date) -> dict:
    """Sum MOMS/VAT from confirmed daily closes in a date range."""
    closes = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user_id,
            DailyClose.date >= start_date,
            DailyClose.date <= end_date,
            DailyClose.is_deleted.isnot(True),
        )
        .all()
    )

    confirmed = 0
    drafts = 0
    total_moms = 0.0
    total_revenue = 0.0
    total_rev_ex = 0.0
    manual_count = 0

    for dc in closes:
        status = getattr(dc, "status", None) or "confirmed"
        if status == "confirmed":
            confirmed += 1
            if dc.moms_total is not None:
                total_moms += float(dc.moms_total)
            if dc.revenue_total:
                total_revenue += float(dc.revenue_total)
            if dc.revenue_ex_moms is not None:
                total_rev_ex += float(dc.revenue_ex_moms)
            if getattr(dc, "moms_mode", None) == "manual":
                manual_count += 1
        else:
            drafts += 1

    return {
        "total_moms": round(total_moms, 2),
        "total_revenue": round(total_revenue, 2),
        "total_revenue_ex_moms": round(total_rev_ex, 2),
        "confirmed_count": confirmed,
        "draft_count": drafts,
        "manual_count": manual_count,
    }


def _get_next_deadlines(currency: str, count: int = 4) -> list[dict]:
    """Get next N upcoming tax deadlines for this currency."""
    config = TAX_CONFIG.get(currency)
    if not config:
        return []

    today = date.today()
    deadlines = []

    if config["frequency"] == "monthly":
        # Monthly: Nth of following month
        day_num = int(config["deadlines"].replace("th", "").replace("st", "").replace("nd", "").replace("rd", ""))
        for i in range(count + 2):
            d = today + relativedelta(months=i)
            try:
                deadline = d.replace(day=day_num)
            except ValueError:
                deadline = d.replace(day=28)
            if deadline > today:
                # Period: previous month
                period_end = deadline.replace(day=1)
                period_start = period_end - relativedelta(months=1)
                deadlines.append({
                    "deadline": deadline,
                    "period_start": period_start,
                    "period_end": period_end - timedelta(days=1),
                    "period_label": period_start.strftime("%B %Y"),
                })
            if len(deadlines) >= count:
                break

    elif isinstance(config["deadlines"], list):
        # Fixed dates (quarterly/bimonthly)
        qmap = config.get("quarter_map", {})
        for year_offset in range(2):
            for i, (m, d) in enumerate(config["deadlines"]):
                yr = today.year + year_offset
                try:
                    deadline = date(yr, m, d)
                except ValueError:
                    deadline = date(yr, m, 28)
                if deadline > today:
                    # Determine period from quarter_map
                    q_idx = i + 1
                    if qmap and q_idx in qmap:
                        pm_start, pm_end = qmap[q_idx]
                        # Period is in the same year or previous year for early deadlines
                        p_year = yr if pm_start < m or (pm_start == m and d > 1) else yr - 1
                        if pm_start > pm_end:
                            p_year = yr - 1
                        period_start = date(p_year, pm_start, 1)
                        period_end = date(p_year if pm_end >= pm_start else yr, pm_end, 1) + relativedelta(months=1) - timedelta(days=1)
                        label = f"{period_start.strftime('%b')}–{period_end.strftime('%b %Y')}"
                    else:
                        period_start = deadline - relativedelta(months=3)
                        period_end = deadline - timedelta(days=1)
                        label = f"Q{q_idx} {yr}"

                    deadlines.append({
                        "deadline": deadline,
                        "period_start": period_start,
                        "period_end": period_end,
                        "period_label": label,
                    })
                if len(deadlines) >= count:
                    break
            if len(deadlines) >= count:
                break

    return deadlines[:count]


def get_tax_overview(user: User, db: Session) -> dict:
    """
    Full tax autopilot overview:
    - Upcoming deadlines with estimated amounts
    - Current period progress
    - Alerts and reminders
    """
    currency = user.currency or "DKK"
    config = TAX_CONFIG.get(currency)
    vat_rate = _get_vat_rate(currency)

    if not config:
        # Fallback for unsupported currencies
        config = {
            "tax_name": "VAT/Tax",
            "authority": "Tax Authority",
            "rate": vat_rate,
            "frequency": "quarterly",
        }

    today = date.today()

    # Get upcoming deadlines
    deadlines = _get_next_deadlines(currency, count=4)

    # Calculate estimated amounts for each deadline
    upcoming = []
    for dl in deadlines:
        vat_data = _calc_vat(db, user.id, dl["period_start"], dl["period_end"] + timedelta(days=1), vat_rate)
        days_until = (dl["deadline"] - today).days

        status = "upcoming"
        if days_until < 0:
            status = "overdue"
        elif days_until <= 3:
            status = "urgent"
        elif days_until <= 7:
            status = "soon"
        elif days_until <= 14:
            status = "approaching"

        upcoming.append({
            "deadline": str(dl["deadline"]),
            "period_label": dl["period_label"],
            "period_start": str(dl["period_start"]),
            "period_end": str(dl["period_end"]),
            "days_until": days_until,
            "status": status,
            "estimated_amount": vat_data["vat_payable"],
            "output_vat": vat_data["output_vat"],
            "input_vat": vat_data["input_vat"],
            "sales_total": vat_data["sales_total"],
            "expenses_total": vat_data["expenses_total"],
        })

    # Current period calc (this month)
    month_start = today.replace(day=1)
    month_end = month_start + relativedelta(months=1)
    current_period = _calc_vat(db, user.id, month_start, month_end, vat_rate)

    # YTD calc
    year_start = date(today.year, 1, 1)
    ytd = _calc_vat(db, user.id, year_start, today + timedelta(days=1), vat_rate)

    # ── Daily Close reconciliation ──
    dc_month = _calc_daily_close_vat(db, user.id, month_start, today)
    dc_ytd = _calc_daily_close_vat(db, user.id, year_start, today)

    discrepancy = None
    disc_pct = None
    recon_status = "no_data"

    if dc_month["confirmed_count"] > 0:
        discrepancy = round(dc_month["total_moms"] - current_period["output_vat"], 2)
        if current_period["output_vat"] > 0:
            disc_pct = round(abs(discrepancy) / current_period["output_vat"] * 100, 1)
        elif dc_month["total_moms"] == 0:
            disc_pct = 0.0
        else:
            disc_pct = 100.0

        if disc_pct is not None and disc_pct <= 2:
            recon_status = "matched"
        elif disc_pct is not None and disc_pct <= 10:
            recon_status = "minor_discrepancy"
        else:
            recon_status = "major_discrepancy"

    daily_close_recon = {
        "current_month": {
            "moms_from_closes": dc_month["total_moms"],
            "moms_from_sales": current_period["output_vat"],
            "closes_count": dc_month["confirmed_count"],
            "drafts_count": dc_month["draft_count"],
            "manual_count": dc_month["manual_count"],
            "revenue_from_closes": dc_month["total_revenue"],
            "discrepancy": discrepancy,
            "discrepancy_pct": disc_pct,
            "status": recon_status,
        },
        "ytd": {
            "moms_from_closes": dc_ytd["total_moms"],
            "moms_from_sales": ytd["output_vat"],
            "closes_count": dc_ytd["confirmed_count"],
            "revenue_from_closes": dc_ytd["total_revenue"],
        },
    }

    # Generate alerts (with reconciliation context)
    alerts = _generate_tax_alerts(upcoming, config, currency, ytd, daily_close_recon)

    return {
        "tax_name": config["tax_name"],
        "authority": config["authority"],
        "rate": vat_rate,
        "rate_pct": round(vat_rate * 100, 1),
        "frequency": config.get("frequency", "quarterly"),
        "currency": currency,
        "upcoming_deadlines": upcoming,
        "current_month": {
            **current_period,
            "month": today.strftime("%B %Y"),
        },
        "ytd": {
            **ytd,
            "year": today.year,
        },
        "alerts": alerts,
        "daily_close_reconciliation": daily_close_recon,
    }


def _generate_tax_alerts(upcoming, config, currency, ytd, recon=None) -> list[dict]:
    """Generate tax-related alerts."""
    alerts = []
    tax_name = config["tax_name"]

    for dl in upcoming[:2]:  # Only alert for next 2 deadlines
        days = dl["days_until"]
        amt = dl["estimated_amount"]

        if dl["status"] == "overdue":
            alerts.append({
                "type": "overdue",
                "severity": "critical",
                "icon": "🚨",
                "title": f"{tax_name} filing OVERDUE! ({dl['period_label']})",
                "detail": f"Deadline was {dl['deadline']}. Estimated: {round(amt):,}. File immediately to avoid penalties.",
                "action": f"File your {tax_name} return with {config['authority']} today.",
            })
        elif dl["status"] == "urgent":
            alerts.append({
                "type": "urgent",
                "severity": "critical",
                "icon": "⏰",
                "title": f"{tax_name} due in {days} days! ({dl['period_label']})",
                "detail": f"Deadline: {dl['deadline']}. Estimated amount: {round(amt):,}.",
                "action": f"Prepare and file your {tax_name} return now.",
            })
        elif dl["status"] == "soon":
            alerts.append({
                "type": "soon",
                "severity": "warning",
                "icon": "📅",
                "title": f"{tax_name} due in {days} days ({dl['period_label']})",
                "detail": f"Deadline: {dl['deadline']}. Estimated: {round(amt):,}. Make sure your books are up to date.",
                "action": "Review and categorize any uncategorized expenses.",
            })
        elif dl["status"] == "approaching":
            alerts.append({
                "type": "approaching",
                "severity": "info",
                "icon": "📋",
                "title": f"{tax_name} filing in {days} days",
                "detail": f"For {dl['period_label']}. Current estimate: {round(amt):,}.",
                "action": None,
            })

    # YTD insight
    if ytd["vat_payable"] > 0:
        alerts.append({
            "type": "ytd_summary",
            "severity": "info",
            "icon": "📊",
            "title": f"Year-to-date {tax_name}: {round(ytd['vat_payable']):,}",
            "detail": f"Output: {round(ytd['output_vat']):,} on {round(ytd['sales_total']):,} sales. Input: {round(ytd['input_vat']):,} on {round(ytd['expenses_total']):,} expenses.",
            "action": None,
        })

    # Daily Close reconciliation alert
    if recon:
        cm = recon.get("current_month", {})
        if cm.get("status") == "major_discrepancy":
            diff = cm.get("discrepancy", 0)
            alerts.append({
                "type": "reconciliation",
                "severity": "warning",
                "icon": "\U0001f50d",
                "title": f"Daily Close vs Sales {tax_name} mismatch: {round(diff):+,}",
                "detail": (
                    f"Daily closes show {round(cm['moms_from_closes']):,} in {tax_name} this month, "
                    f"but sales records show {round(cm['moms_from_sales']):,}. "
                    "Review both sources before filing."
                ),
                "action": "Open Daily Close \u2192 History to compare with your sales register.",
            })
        elif cm.get("status") == "matched" and cm.get("closes_count", 0) >= 5:
            alerts.append({
                "type": "reconciliation_ok",
                "severity": "positive",
                "icon": "\u2705",
                "title": f"Daily Close {tax_name} matches sales records",
                "detail": (
                    f"{cm['closes_count']} confirmed closes this month. "
                    f"{tax_name} from receipts and sales are aligned."
                ),
                "action": None,
            })

    if not alerts:
        alerts.append({
            "type": "all_clear",
            "severity": "positive",
            "icon": "\u2705",
            "title": f"No urgent {tax_name} deadlines",
            "detail": "Your tax filings are up to date.",
            "action": None,
        })

    return alerts
