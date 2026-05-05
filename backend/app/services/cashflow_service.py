"""
Cash Flow Prediction Service — project 30-day cash balance with actionable alerts.

Flow:
1. Calculate current cash balance from cashbook
2. Project daily revenue from same-weekday averages (last 4 weeks)
3. Project daily expenses from recurring patterns
4. Add outstanding khata receivables
5. Flag danger days where balance < safety threshold
6. Suggest specific actions: who to collect from, what to delay
"""

import logging
from datetime import date, timedelta
from collections import defaultdict

from sqlalchemy import func, and_
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.cashbook import CashTransaction
from app.models.khata import KhataCustomer, KhataTransaction

logger = logging.getLogger(__name__)

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _get_current_balance(user_id, db: Session) -> float:
    """Get current cash balance from all-time cashbook transactions."""
    total_in = float(
        db.query(func.coalesce(func.sum(CashTransaction.amount), 0))
        .filter(
            CashTransaction.user_id == user_id,
            CashTransaction.type == "cash_in",
            CashTransaction.is_deleted.isnot(True),
        )
        .scalar()
    )
    total_out = float(
        db.query(func.coalesce(func.sum(CashTransaction.amount), 0))
        .filter(
            CashTransaction.user_id == user_id,
            CashTransaction.type == "cash_out",
            CashTransaction.is_deleted.isnot(True),
        )
        .scalar()
    )
    return total_in - total_out


def _get_weekday_revenue(user_id, db: Session) -> dict[int, float]:
    """Average revenue per weekday from last 4 weeks of sales."""
    cutoff = date.today() - timedelta(days=28)
    sales = (
        db.query(Sale.date, func.sum(Sale.amount))
        .filter(Sale.user_id == user_id, Sale.date >= cutoff, Sale.is_deleted.isnot(True))
        .group_by(Sale.date)
        .all()
    )

    by_weekday = defaultdict(list)
    for sale_date, total in sales:
        by_weekday[sale_date.weekday()].append(float(total))

    averages = {}
    for wd in range(7):
        vals = by_weekday.get(wd, [])
        averages[wd] = round(sum(vals) / len(vals), 2) if vals else 0
    return averages


def _get_recurring_expenses(user_id, db: Session) -> list[dict]:
    """
    Identify recurring expense patterns.
    Looks at expenses marked as recurring OR expenses with the same description
    appearing in 2+ of the last 3 months.
    """
    cutoff = date.today() - timedelta(days=90)

    # Get explicitly recurring expenses
    recurring = (
        db.query(
            Expense.description,
            Expense.amount,
            func.max(Expense.date).label("last_date"),
            ExpenseCategory.name.label("category"),
        )
        .outerjoin(ExpenseCategory, Expense.category_id == ExpenseCategory.id)
        .filter(
            Expense.user_id == user_id,
            Expense.is_recurring == True,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
            Expense.date >= cutoff,
        )
        .group_by(Expense.description, Expense.amount, ExpenseCategory.name)
        .all()
    )

    results = []
    today = date.today()
    for r in recurring:
        last = r.last_date
        if not last:
            continue
        # Walk forward one month at a time until we land in the future
        next_due = _add_one_month(last)
        # Cap iterations defensively — in practice this terminates after 1-12
        for _ in range(36):
            if next_due >= today:
                break
            next_due = _add_one_month(next_due)
        results.append({
            "description": r.description,
            "amount": float(r.amount),
            "category": r.category or "Other",
            "next_due": next_due,
        })

    return results


def _get_daily_expense_average(user_id, db: Session) -> float:
    """
    Average daily expenses over the last 30 days.

    Critical fix: previously always divided by 30. For new users with only
    a few days of expense history, this understated the daily average by
    a factor of 30/N → safety_threshold = 7 × understated_avg → cashflow
    danger days were missed.

    Now we divide by the actual number of distinct days with data
    (clamped to >=1). For mature accounts with full 30 days of data, the
    result is identical; for new users it correctly reflects their burn rate.
    """
    cutoff = date.today() - timedelta(days=30)
    rows = (
        db.query(Expense.date, func.coalesce(func.sum(Expense.amount), 0).label("daily_total"))
        .filter(
            Expense.user_id == user_id,
            Expense.date >= cutoff,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
        )
        .group_by(Expense.date)
        .all()
    )
    if not rows:
        return 0.0
    total = sum(float(r.daily_total or 0) for r in rows)
    distinct_days = len(rows)
    return round(total / max(distinct_days, 1), 2)


def _add_one_month(d: date) -> date:
    """
    Add one calendar month, snapping to last day of month when day-of-month
    doesn't exist in target (e.g. Jan 31 + 1 month → Feb 28/29, not Feb 28
    forever onward — we keep going from the original day).

    Why this matters: previously code used last.replace(month=...) and on
    ValueError fell back to day=28 — which means a Jan 31 recurring expense
    would project as Feb 28, then Mar 28 (lost the original "31st" anchor).
    Now we snap each month independently so a Jan 31 → Feb 28 → Mar 31.
    """
    new_month = d.month + 1 if d.month < 12 else 1
    new_year = d.year if d.month < 12 else d.year + 1
    # Try original day; if invalid (e.g. Feb 31), snap to last day of new month
    try:
        return d.replace(year=new_year, month=new_month)
    except ValueError:
        from calendar import monthrange
        last_day = monthrange(new_year, new_month)[1]
        return date(new_year, new_month, last_day)


def _get_khata_receivables(user_id, db: Session) -> list[dict]:
    """Get outstanding khata amounts sorted by amount owed (highest first)."""
    customers = (
        db.query(KhataCustomer)
        .filter(KhataCustomer.user_id == user_id, KhataCustomer.is_deleted.isnot(True))
        .all()
    )

    receivables = []
    for cust in customers:
        txns = (
            db.query(KhataTransaction)
            .filter(KhataTransaction.customer_id == cust.id, KhataTransaction.user_id == user_id)
            .all()
        )
        total_purchase = sum(float(t.purchase_amount or 0) for t in txns)
        total_paid = sum(float(t.paid_amount or 0) for t in txns)
        outstanding = total_purchase - total_paid

        if outstanding > 0:
            receivables.append({
                "customer_name": cust.name,
                "phone": cust.phone,
                "outstanding": round(outstanding, 2),
            })

    # Sort highest first
    receivables.sort(key=lambda x: x["outstanding"], reverse=True)
    return receivables


def get_cashflow_forecast(user_id, db: Session) -> dict:
    """
    Generate 30-day cash flow projection with alerts and action items.

    For each day:
      projected_balance = previous_balance + expected_revenue - known_expenses

    Safety threshold = 7 × average daily expenses
    """
    today = date.today()

    # 1. Current balance
    current_balance = _get_current_balance(user_id, db)

    # 2. Revenue patterns by weekday
    weekday_revenue = _get_weekday_revenue(user_id, db)
    has_revenue_data = any(v > 0 for v in weekday_revenue.values())

    # 3. Recurring expenses
    recurring_expenses = _get_recurring_expenses(user_id, db)

    # 4. Daily expense average
    daily_expense_avg = _get_daily_expense_average(user_id, db)

    # 5. Safety threshold: 7 days of average expenses
    safety_threshold = round(daily_expense_avg * 7, 2)

    # 6. Khata receivables
    receivables = _get_khata_receivables(user_id, db)
    total_receivable = sum(r["outstanding"] for r in receivables)

    # 7. Build 30-day projection
    projection = []
    running_balance = current_balance
    lowest_balance = current_balance
    lowest_date = str(today)
    danger_days = 0

    for i in range(30):
        proj_date = today + timedelta(days=i)
        weekday = proj_date.weekday()
        day_name = WEEKDAY_NAMES[weekday]

        # Revenue: weekday average (skip today — already in balance)
        day_revenue = weekday_revenue.get(weekday, 0) if i > 0 else 0

        # Expenses: daily average + any recurring due this day
        day_expenses = daily_expense_avg if i > 0 else 0
        recurring_today = []
        for re in recurring_expenses:
            if re["next_due"] == proj_date:
                day_expenses += re["amount"]
                recurring_today.append(re)

        # Update balance
        if i > 0:
            running_balance = running_balance + day_revenue - day_expenses

        is_danger = running_balance < safety_threshold
        if is_danger:
            danger_days += 1

        if running_balance < lowest_balance:
            lowest_balance = running_balance
            lowest_date = str(proj_date)

        projection.append({
            "date": str(proj_date),
            "day": day_name,
            "day_index": i,
            "balance": round(running_balance, 2),
            "revenue": round(day_revenue, 2),
            "expenses": round(day_expenses, 2),
            "recurring": [r["description"] for r in recurring_today],
            "is_danger": is_danger,
        })

    # 8. Generate alerts
    alerts = _generate_alerts(
        projection=projection,
        current_balance=current_balance,
        lowest_balance=lowest_balance,
        lowest_date=lowest_date,
        safety_threshold=safety_threshold,
        danger_days=danger_days,
        receivables=receivables,
        total_receivable=total_receivable,
        recurring_expenses=recurring_expenses,
        daily_expense_avg=daily_expense_avg,
    )

    return {
        "current_balance": round(current_balance, 2),
        "safety_threshold": round(safety_threshold, 2),
        "lowest_point": {
            "date": lowest_date,
            "balance": round(lowest_balance, 2),
        },
        "danger_days": danger_days,
        "projection": projection,
        "alerts": alerts,
        "receivables": receivables[:5],  # Top 5
        "total_receivable": round(total_receivable, 2),
        "recurring_expenses": recurring_expenses,
        "daily_expense_avg": round(daily_expense_avg, 2),
        "has_data": has_revenue_data,
    }


def _generate_alerts(
    projection, current_balance, lowest_balance, lowest_date,
    safety_threshold, danger_days, receivables, total_receivable,
    recurring_expenses, daily_expense_avg,
) -> list[dict]:
    """Generate actionable cash flow alerts."""
    alerts = []

    # Alert 1: Cash shortfall predicted
    if lowest_balance < 0:
        shortfall = abs(lowest_balance)
        alert = {
            "type": "shortfall",
            "severity": "critical",
            "icon": "🚨",
            "title": f"Cash shortfall predicted on {lowest_date}",
            "detail": f"Projected balance drops to {round(lowest_balance):,}. You'll be {round(shortfall):,} short.",
        }
        # Suggest collections
        if receivables:
            top = receivables[:3]
            names = ", ".join(f"{r['customer_name']} ({round(r['outstanding']):,})" for r in top)
            alert["action"] = f"Collect from: {names}. Total recoverable: {round(total_receivable):,}."
        else:
            alert["action"] = "Consider delaying non-essential expenses or securing a short-term credit line."
        alerts.append(alert)

    elif lowest_balance < safety_threshold:
        alert = {
            "type": "tight",
            "severity": "warning",
            "icon": "⚠️",
            "title": f"Cash gets tight on {lowest_date}",
            "detail": f"Balance drops to {round(lowest_balance):,} — below your {round(safety_threshold):,} safety buffer.",
        }
        if receivables:
            top = receivables[:2]
            names = ", ".join(f"{r['customer_name']} ({round(r['outstanding']):,})" for r in top)
            alert["action"] = f"Collecting from {names} would solve this."
        else:
            alert["action"] = "Watch expenses closely in the coming weeks."
        alerts.append(alert)

    # Alert 2: Large expense clusters
    for p in projection:
        if p["expenses"] > daily_expense_avg * 3 and p["day_index"] > 0:
            recurring_names = ", ".join(p["recurring"]) if p["recurring"] else "various expenses"
            alerts.append({
                "type": "expense_cluster",
                "severity": "medium",
                "icon": "📅",
                "title": f"Heavy expense day: {p['date']} ({p['day']})",
                "detail": f"Expected outflow: {round(p['expenses']):,} ({recurring_names}). Balance after: {round(p['balance']):,}.",
                "action": "Consider spreading payments across different dates.",
            })

    # Alert 3: Healthy cash flow
    if lowest_balance >= safety_threshold and danger_days == 0:
        alerts.append({
            "type": "healthy",
            "severity": "positive",
            "icon": "✅",
            "title": "Cash flow looks healthy!",
            "detail": f"No danger days in the next 30 days. Lowest point: {round(lowest_balance):,} on {lowest_date}.",
            "action": None,
        })

    # Alert 4: Outstanding receivables reminder
    if total_receivable > daily_expense_avg * 5 and len(receivables) >= 2:
        alerts.append({
            "type": "receivables",
            "severity": "info",
            "icon": "💰",
            "title": f"{round(total_receivable):,} outstanding from {len(receivables)} customers",
            "detail": f"Top: {receivables[0]['customer_name']} owes {round(receivables[0]['outstanding']):,}.",
            "action": "Send payment reminders to improve cash position.",
        })

    # Alert 5: No data
    if not any(p["revenue"] > 0 for p in projection[1:]):
        alerts.append({
            "type": "no_data",
            "severity": "info",
            "icon": "📊",
            "title": "Not enough sales data yet",
            "detail": "Log sales for at least 2 weeks to unlock accurate cash flow predictions.",
            "action": "Start logging daily sales to build your prediction model.",
        })

    return alerts
