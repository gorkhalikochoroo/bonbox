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

# How many months a single filing period covers, by frequency.
# (DK monthly: needed for businesses with revenue > 50M kr — rare for our market
# but supported for completeness.)
PERIOD_MONTHS = {
    "monthly": 1,
    "bimonthly": 2,
    "quarterly": 3,
    "half_yearly": 6,
}

# Tax authority + filing config, per currency. Each entry can have multiple
# filing frequencies; the user (or default) picks one. Deadlines are
# (month, day) tuples in the year FOLLOWING the period — e.g. for DK
# half-yearly H1 (Jan–Jun) is reported by Sep 1 of the SAME year.
#
# Important: deadlines list a YEAR-AGNOSTIC pattern. The period that each
# deadline reports is derived dynamically from (deadline - period_months)
# in `_derive_period`, NOT from a separate quarter_map. The previous
# quarter_map approach silently mapped wrong periods to deadlines (e.g.
# Mar 1 → "Q1 of same year", which is impossible because Q1 isn't done by
# Mar 1). This was the root of "Tax Autopilot shows wrong amounts".
TAX_CONFIG = {
    "DKK": {
        "tax_name": "Moms",
        "authority": "SKAT (skat.dk)",
        "rate": 0.25,
        # Default frequency for new DK signups. SMBs with rev < 5M kr are
        # required to file half-yearly; quarterly is the legal threshold band
        # 5M–50M kr. We default to half_yearly because BonBox targets SMBs.
        "default_frequency": "half_yearly",
        "frequencies": {
            # Half-yearly: H1 (Jan–Jun) due Sep 1, H2 (Jul–Dec) due Mar 1 next year.
            "half_yearly": [(3, 1), (9, 1)],
            # Quarterly: Q4 prev → Mar 1, Q1 → Jun 1, Q2 → Sep 1, Q3 → Dec 1.
            "quarterly":  [(3, 1), (6, 1), (9, 1), (12, 1)],
            # Monthly: 25th of following month (rare for DK; large enterprises only).
            "monthly":    "25th",
        },
    },
    "SEK": {
        "tax_name": "Moms",
        "authority": "Skatteverket",
        "rate": 0.25,
        "default_frequency": "quarterly",
        "frequencies": {
            "quarterly": [(2, 12), (5, 12), (8, 17), (11, 12)],
        },
    },
    "NOK": {
        "tax_name": "MVA",
        "authority": "Skatteetaten",
        "rate": 0.25,
        "default_frequency": "bimonthly",
        "frequencies": {
            "bimonthly": [(4, 10), (6, 10), (8, 31), (10, 10), (12, 10), (2, 10)],
        },
    },
    "NPR": {
        "tax_name": "VAT",
        "authority": "IRD Nepal",
        "rate": 0.13,
        "default_frequency": "monthly",
        "frequencies": {"monthly": "25th"},
    },
    "INR": {
        "tax_name": "GST",
        "authority": "GSTN",
        "rate": 0.18,
        "default_frequency": "monthly",
        "frequencies": {"monthly": "20th"},
    },
    "GBP": {
        "tax_name": "VAT",
        "authority": "HMRC",
        "rate": 0.20,
        "default_frequency": "quarterly",
        "frequencies": {
            "quarterly": [(5, 7), (8, 7), (11, 7), (2, 7)],
        },
    },
}


def _get_vat_rate(currency: str) -> float:
    return VAT_RATES.get(currency, 0.13)


def _last_day_of_month(yr: int, m: int) -> date:
    """Return the last calendar day of (year, month)."""
    first_of_next = date(yr, m, 1) + relativedelta(months=1)
    return first_of_next - timedelta(days=1)


def _is_period_boundary_month(month: int, frequency: str) -> bool:
    """True if `month` is the last month of a filing period for this frequency."""
    if frequency == "monthly":
        return True
    if frequency == "bimonthly":
        return month % 2 == 0  # Feb, Apr, Jun, Aug, Oct, Dec
    if frequency == "quarterly":
        return month in (3, 6, 9, 12)
    if frequency == "half_yearly":
        return month in (6, 12)
    return False


def _derive_period(deadline: date, frequency: str) -> tuple[date, date, str]:
    """
    Given a deadline date and the filing frequency, compute the (period_start,
    period_end, label) that the deadline reports.

    Rule: walk back month-by-month from the deadline and stop at the first
    period-boundary month. The period ends on the LAST day of that month,
    and starts (period_months - 1) months earlier. This handles every
    jurisdiction's buffer (DK ~2 months, NPR ~25 days, NOK ~40 days)
    without hardcoding offsets — boundaries are universal.

    Examples (DK):
      Mar 1 2026 quarterly  → period Q4 2025 (Oct 1 → Dec 31, 2025)
      Jun 1 2026 quarterly  → Q1 2026 (Jan 1 → Mar 31)
      Sep 1 2026 half_yearly → H1 2026 (Jan 1 → Jun 30)
      Mar 1 2026 half_yearly → H2 2025 (Jul 1 → Dec 31, 2025)
    """
    months = PERIOD_MONTHS.get(frequency, 3)
    # Walk back from deadline until we find a period boundary that's strictly
    # before the deadline. Cap at 14 months to avoid infinite loops on
    # malformed input.
    cur = date(deadline.year, deadline.month, 1)
    for _ in range(14):
        cur = cur - relativedelta(months=1)
        if not _is_period_boundary_month(cur.month, frequency):
            continue
        candidate_end = _last_day_of_month(cur.year, cur.month)
        if candidate_end < deadline:
            period_end = candidate_end
            period_start = date(cur.year, cur.month, 1) - relativedelta(months=months - 1)
            break
    else:
        # Shouldn't happen but degrade gracefully
        period_end = deadline - timedelta(days=1)
        period_start = period_end - relativedelta(months=months) + timedelta(days=1)

    # Label
    if months == 1:
        label = period_start.strftime("%B %Y")
    elif months == 6 and period_start.month in (1, 7):
        h = "H1" if period_start.month == 1 else "H2"
        label = f"{h} {period_start.year}"
    elif months == 3 and period_start.month in (1, 4, 7, 10):
        q = (period_start.month - 1) // 3 + 1
        label = f"Q{q} {period_start.year}"
    else:
        label = f"{period_start.strftime('%b')}–{period_end.strftime('%b %Y')}"
    return period_start, period_end, label


def _resolve_frequency(user, config: dict) -> str:
    """Pick filing frequency: explicit user override, else currency default."""
    explicit = getattr(user, "tax_filing_frequency", None)
    if explicit and explicit in (config.get("frequencies") or {}):
        return explicit
    return config.get("default_frequency", "quarterly")


def _calc_vat(db: Session, user_id, start_date: date, end_date: date,
              vat_rate: float, prices_include_moms: bool = True) -> dict:
    """
    Calculate VAT for a period.

    prices_include_moms determines the extraction formula:
      - True  (B2C — café, retail; the customer's receipt amount):
              VAT = gross * rate / (1 + rate)
              Net = gross / (1 + rate)
      - False (B2B — net invoicing; price excludes VAT):
              VAT = net * rate
              Gross = net * (1 + rate)

    Picking the wrong mode silently shifts every number by 25% (DK), which
    is the third bug we fixed today (with BUG 1 = period mapping shift,
    BUG 2 = no half-yearly option).
    """
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

    if vat_rate <= 0:
        output_vat = input_vat = 0.0
    elif prices_include_moms:
        # Gross-input mode (B2C default): extract VAT from total
        output_vat = round(sales_total * vat_rate / (1 + vat_rate), 2)
        input_vat = round(expenses_total * vat_rate / (1 + vat_rate), 2)
    else:
        # Net-input mode (B2B): VAT is rate * net
        output_vat = round(sales_total * vat_rate, 2)
        input_vat = round(expenses_total * vat_rate, 2)

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


def _get_next_deadlines(currency: str, frequency: str | None = None,
                        count: int = 4) -> list[dict]:
    """
    Get next N upcoming filing deadlines for this currency + frequency.

    Period derivation is via _derive_period (frequency-aware). The previous
    quarter_map approach miscomputed periods for DK quarterly — see the
    docstring on _derive_period for examples.
    """
    config = TAX_CONFIG.get(currency)
    if not config:
        return []

    freq = frequency or config.get("default_frequency", "quarterly")
    freq_data = (config.get("frequencies") or {}).get(freq)
    if freq_data is None:
        return []

    today = date.today()
    deadlines: list[dict] = []

    if freq == "monthly":
        # Monthly: Nth-of-month string like "25th"; period is the month BEFORE the deadline month
        day_num = int("".join(c for c in freq_data if c.isdigit()) or "25")
        for i in range(count + 2):
            d = today + relativedelta(months=i)
            try:
                deadline = d.replace(day=day_num)
            except ValueError:
                deadline = _last_day_of_month(d.year, d.month)
            if deadline > today:
                p_start, p_end, label = _derive_period(deadline, freq)
                deadlines.append({
                    "deadline": deadline,
                    "period_start": p_start,
                    "period_end": p_end,
                    "period_label": label,
                })
            if len(deadlines) >= count:
                break
    else:
        # List of fixed (month, day) deadlines repeating yearly
        for year_offset in range(3):  # check next 3 years to fill `count`
            for (m, d) in freq_data:
                yr = today.year + year_offset
                try:
                    deadline = date(yr, m, d)
                except ValueError:
                    deadline = _last_day_of_month(yr, m)
                if deadline <= today:
                    continue
                p_start, p_end, label = _derive_period(deadline, freq)
                deadlines.append({
                    "deadline": deadline,
                    "period_start": p_start,
                    "period_end": p_end,
                    "period_label": label,
                })
                if len(deadlines) >= count:
                    break
            if len(deadlines) >= count:
                break

    # Sort by deadline ascending (in case configs aren't strictly ordered)
    deadlines.sort(key=lambda x: x["deadline"])
    return deadlines[:count]


def _payroll_deadlines(count: int = 3) -> list[dict]:
    """
    A-skat + AM-bidrag deadlines for DK employers — both due 10th of the
    following month (or next business day). We don't compute amounts here
    (that needs payroll-module data — coming next pass); just surface the
    deadlines so users with employees aren't blindsided.
    """
    today = date.today()
    out = []
    for i in range(count + 1):
        d = today + relativedelta(months=i)
        try:
            deadline = d.replace(day=10)
        except ValueError:
            deadline = _last_day_of_month(d.year, d.month)
        if deadline <= today:
            continue
        period_anchor = date(deadline.year, deadline.month, 1) - relativedelta(months=1)
        period_start = date(period_anchor.year, period_anchor.month, 1)
        period_end = _last_day_of_month(period_anchor.year, period_anchor.month)
        out.append({
            "tax_name": "A-skat + AM-bidrag",
            "authority": "SKAT (skat.dk)",
            "deadline": deadline,
            "period_start": period_start,
            "period_end": period_end,
            "period_label": period_start.strftime("%B %Y"),
            "days_until": (deadline - today).days,
        })
        if len(out) >= count:
            break
    return out


def get_tax_overview(user: User, db: Session) -> dict:
    """
    Full tax autopilot overview:
    - Upcoming deadlines with estimated amounts (frequency = user.tax_filing_frequency
      or currency default — DK SMBs default to half_yearly)
    - Current period progress
    - Daily Close reconciliation
    - A-skat / AM-bidrag deadlines if user.has_employees (DK only for now)
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
            "default_frequency": "quarterly",
            "frequencies": {},
        }

    today = date.today()
    frequency = _resolve_frequency(user, config)
    prices_incl_moms = bool(getattr(user, "prices_include_moms", True))

    # Get upcoming deadlines
    deadlines = _get_next_deadlines(currency, frequency=frequency, count=4)

    # Calculate estimated amounts for each deadline
    upcoming = []
    for dl in deadlines:
        vat_data = _calc_vat(db, user.id, dl["period_start"],
                             dl["period_end"] + timedelta(days=1), vat_rate, prices_incl_moms)
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
    current_period = _calc_vat(db, user.id, month_start, month_end, vat_rate, prices_incl_moms)

    # YTD calc
    year_start = date(today.year, 1, 1)
    ytd = _calc_vat(db, user.id, year_start, today + timedelta(days=1), vat_rate, prices_incl_moms)

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

    # A-skat + AM-bidrag deadlines for DK employers (10th of next month)
    payroll = []
    if currency == "DKK" and bool(getattr(user, "has_employees", False)):
        for p in _payroll_deadlines(count=3):
            p["deadline"] = str(p["deadline"])
            p["period_start"] = str(p["period_start"])
            p["period_end"] = str(p["period_end"])
            payroll.append(p)

    return {
        "tax_name": config["tax_name"],
        "authority": config["authority"],
        "rate": vat_rate,
        "rate_pct": round(vat_rate * 100, 1),
        "frequency": frequency,
        "available_frequencies": list((config.get("frequencies") or {}).keys()),
        "prices_include_moms": prices_incl_moms,
        "currency": currency,
        "upcoming_deadlines": upcoming,
        "payroll_deadlines": payroll,
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
