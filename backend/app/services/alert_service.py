from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.expense import Expense, ExpenseCategory
from app.models.user import User


def get_display_currency(currency: str) -> str:
    if currency and currency.startswith("EUR_"):
        return "EUR"
    return currency or "DKK"


def detect_expense_alerts(user: User, db: Session) -> list[dict]:
    """Detect expense category spikes vs 4-week rolling average."""
    today = date.today()
    week_start = today - timedelta(days=7)
    alerts = []
    cur = get_display_currency(user.currency)

    # Get all expense categories for this user
    categories = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id).all()

    for cat in categories:
        # This week's total for this category
        this_week = float(
            db.query(func.coalesce(func.sum(Expense.amount), 0))
            .filter(
                Expense.user_id == user.id,
                Expense.category_id == cat.id,
                Expense.date >= week_start,
                Expense.date <= today,
                Expense.is_personal.isnot(True),
                Expense.is_deleted.isnot(True),
            )
            .scalar()
        )

        if this_week == 0:
            continue

        # Get weekly totals for the previous 4 weeks
        weekly_totals = []
        for w in range(1, 5):
            w_start = today - timedelta(days=7 * (w + 1))
            w_end = today - timedelta(days=7 * w)
            total = float(
                db.query(func.coalesce(func.sum(Expense.amount), 0))
                .filter(
                    Expense.user_id == user.id,
                    Expense.category_id == cat.id,
                    Expense.date >= w_start,
                    Expense.date < w_end,
                    Expense.is_personal.isnot(True),
                    Expense.is_deleted.isnot(True),
                )
                .scalar()
            )
            weekly_totals.append(total)

        avg_4_weeks = sum(weekly_totals) / len(weekly_totals) if weekly_totals else 0

        if avg_4_weeks <= 0:
            continue

        pct_increase = round(((this_week - avg_4_weeks) / avg_4_weeks) * 100, 1)

        if pct_increase > 25:
            alerts.append({
                "type": "category_spike",
                "category": cat.name,
                "this_week": this_week,
                "avg_4_weeks": round(avg_4_weeks),
                "pct_increase": pct_increase,
                "currency": cur,
                "message": f"{cat.name} costs jumped {pct_increase}% this week ({this_week:,.0f} {cur} vs avg {avg_4_weeks:,.0f} {cur})",
            })

    # Check for unusually large single transactions (>2x daily average)
    daily_avg = float(
        db.query(func.coalesce(func.avg(Expense.amount), 0))
        .filter(
            Expense.user_id == user.id,
            Expense.date >= today - timedelta(days=30),
            Expense.is_personal.isnot(True),
            Expense.is_deleted.isnot(True),
        )
        .scalar()
    )

    if daily_avg > 0:
        large_txns = (
            db.query(Expense)
            .filter(
                Expense.user_id == user.id,
                Expense.date >= week_start,
                Expense.amount > daily_avg * 2,
                Expense.is_personal.isnot(True),
                Expense.is_deleted.isnot(True),
            )
            .all()
        )
        for txn in large_txns[:3]:  # Max 3 large transaction alerts
            alerts.append({
                "type": "large_transaction",
                "amount": float(txn.amount),
                "description": txn.description,
                "date": str(txn.date),
                "currency": cur,
                "message": f"Large expense: {txn.description} ({float(txn.amount):,.0f} {cur}) - {2 if float(txn.amount) > daily_avg * 3 else ''}x your daily average",
            })

    return alerts


def build_alert_html(alerts: list[dict], business_name: str) -> str:
    """Build HTML email for expense alerts."""
    if not alerts:
        return ""

    alert_rows = ""
    for a in alerts:
        if a["type"] == "category_spike":
            icon = "📈"
            color = "#dc2626"
            bg = "#fef2f2"
        else:
            icon = "💰"
            color = "#ea580c"
            bg = "#fff7ed"

        alert_rows += f"""
        <div style="padding:16px;background:{bg};border-radius:12px;margin-bottom:12px;border-left:4px solid {color}">
          <p style="margin:0;font-size:15px;color:#1e293b"><strong>{icon} {a['message']}</strong></p>
        </div>"""

    return f"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:20px">
    <div style="text-align:center;padding:24px 0">
      <div style="display:inline-block;width:48px;height:48px;background:#dc2626;border-radius:14px;line-height:48px;text-align:center">
        <span style="color:white;font-size:24px">⚠️</span>
      </div>
      <h1 style="margin:12px 0 4px;font-size:20px;color:#1e293b">Expense Alert - {business_name}</h1>
      <p style="margin:0;font-size:14px;color:#94a3b8">{len(alerts)} alert(s) need your attention</p>
    </div>

    {alert_rows}

    <div style="text-align:center;margin-top:24px">
      <a href="https://bonbox.dk/expenses" style="display:inline-block;padding:12px 32px;background:#dc2626;color:white;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600">Review Expenses</a>
    </div>

    <div style="text-align:center;margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:12px;color:#94a3b8">
        <a href="https://bonbox.dk/profile" style="color:#3b82f6;text-decoration:none">Manage alert preferences</a>
      </p>
    </div>
  </div>
</body>
</html>"""
