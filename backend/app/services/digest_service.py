from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.user import User


def get_display_currency(currency: str) -> str:
    if currency and currency.startswith("EUR_"):
        return "EUR"
    return currency or "DKK"


def build_digest_data(user: User, db: Session) -> dict:
    """Build daily digest data for a user."""
    yesterday = date.today() - timedelta(days=1)
    last_week_same_day = yesterday - timedelta(days=7)
    month_start = yesterday.replace(day=1)
    cur = get_display_currency(user.currency)

    # Yesterday's revenue
    yesterday_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date == yesterday, Sale.is_deleted.isnot(True))
        .scalar()
    )

    # Same day last week
    last_week_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date == last_week_same_day, Sale.is_deleted.isnot(True))
        .scalar()
    )

    # Yesterday's expenses
    yesterday_exp = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date == yesterday, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )

    # Profit & margin
    yesterday_profit = yesterday_rev - yesterday_exp
    yesterday_margin = round((yesterday_profit / yesterday_rev) * 100, 1) if yesterday_rev > 0 else 0

    # Week-over-week change
    wow_change = round(((yesterday_rev - last_week_rev) / last_week_rev) * 100, 1) if last_week_rev > 0 else 0

    # Month-to-date revenue
    mtd_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= month_start, Sale.date <= yesterday, Sale.is_deleted.isnot(True))
        .scalar()
    )

    # Top 3 expense categories yesterday
    top_expenses = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date == yesterday, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .group_by(ExpenseCategory.name)
        .order_by(func.sum(Expense.amount).desc())
        .limit(3)
        .all()
    )

    # Low stock items
    low_stock = (
        db.query(InventoryItem.name, InventoryItem.quantity, InventoryItem.unit)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity <= InventoryItem.min_threshold,
        )
        .all()
    )

    return {
        "date": yesterday.strftime("%A, %d %B %Y"),
        "currency": cur,
        "revenue": yesterday_rev,
        "expenses": yesterday_exp,
        "profit": yesterday_profit,
        "margin": yesterday_margin,
        "wow_change": wow_change,
        "mtd_revenue": mtd_rev,
        "top_expenses": [(name, float(total)) for name, total in top_expenses],
        "low_stock": [(name, float(qty), unit) for name, qty, unit in low_stock],
        "business_name": user.business_name or "Your Business",
    }


def build_digest_html(data: dict) -> str:
    """Build HTML email for daily digest."""
    cur = data["currency"]
    wow_color = "#16a34a" if data["wow_change"] >= 0 else "#dc2626"
    wow_arrow = "+" if data["wow_change"] >= 0 else ""
    profit_color = "#16a34a" if data["profit"] >= 0 else "#dc2626"

    # Top expenses rows
    exp_rows = ""
    for name, amt in data["top_expenses"]:
        pct = round(amt / data["expenses"] * 100) if data["expenses"] > 0 else 0
        exp_rows += f"""
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155">{name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:right">{amt:,.0f} {cur}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#94a3b8;text-align:right">{pct}%</td>
        </tr>"""

    # Low stock alerts
    stock_section = ""
    if data["low_stock"]:
        stock_items = ""
        for name, qty, unit in data["low_stock"]:
            stock_items += f'<li style="padding:4px 0;font-size:14px;color:#dc2626">{name}: {qty:.0f} {unit} remaining</li>'
        stock_section = f"""
        <div style="margin-top:24px;padding:16px;background:#fef2f2;border-radius:12px;border:1px solid #fecaca">
          <h3 style="margin:0 0 8px;font-size:16px;color:#991b1b">Low Stock Alerts</h3>
          <ul style="margin:0;padding-left:20px">{stock_items}</ul>
        </div>"""

    return f"""
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:20px">
    <!-- Header -->
    <div style="text-align:center;padding:24px 0">
      <div style="display:inline-block;width:48px;height:48px;background:#3b82f6;border-radius:14px;line-height:48px;text-align:center">
        <span style="color:white;font-size:20px;font-weight:bold">B</span>
      </div>
      <h1 style="margin:12px 0 4px;font-size:22px;color:#1e293b">{data['business_name']}</h1>
      <p style="margin:0;font-size:14px;color:#94a3b8">{data['date']}</p>
    </div>

    <!-- KPI Cards -->
    <div style="background:white;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr>
          <td style="padding:20px;text-align:center;width:25%;border-bottom:1px solid #f1f5f9">
            <p style="margin:0;font-size:12px;color:#94a3b8;text-transform:uppercase">Revenue</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:#1e293b">{data['revenue']:,.0f}</p>
            <p style="margin:2px 0 0;font-size:12px;color:#94a3b8">{cur}</p>
          </td>
          <td style="padding:20px;text-align:center;width:25%;border-bottom:1px solid #f1f5f9;border-left:1px solid #f1f5f9">
            <p style="margin:0;font-size:12px;color:#94a3b8;text-transform:uppercase">Expenses</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:#1e293b">{data['expenses']:,.0f}</p>
            <p style="margin:2px 0 0;font-size:12px;color:#94a3b8">{cur}</p>
          </td>
          <td style="padding:20px;text-align:center;width:25%;border-bottom:1px solid #f1f5f9;border-left:1px solid #f1f5f9">
            <p style="margin:0;font-size:12px;color:#94a3b8;text-transform:uppercase">Profit</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:{profit_color}">{data['profit']:,.0f}</p>
            <p style="margin:2px 0 0;font-size:12px;color:#94a3b8">{data['margin']}% margin</p>
          </td>
          <td style="padding:20px;text-align:center;width:25%;border-bottom:1px solid #f1f5f9;border-left:1px solid #f1f5f9">
            <p style="margin:0;font-size:12px;color:#94a3b8;text-transform:uppercase">vs Last Week</p>
            <p style="margin:4px 0 0;font-size:24px;font-weight:700;color:{wow_color}">{wow_arrow}{data['wow_change']}%</p>
            <p style="margin:2px 0 0;font-size:12px;color:#94a3b8">same day</p>
          </td>
        </tr>
      </table>

      <!-- MTD -->
      <div style="padding:12px 20px;background:#f8fafc;text-align:center">
        <span style="font-size:13px;color:#64748b">Month-to-date revenue: <strong>{data['mtd_revenue']:,.0f} {cur}</strong></span>
      </div>
    </div>

    <!-- Top Expenses -->
    {"" if not data["top_expenses"] else f'''
    <div style="margin-top:24px;background:white;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="padding:16px 20px;border-bottom:1px solid #f1f5f9">
        <h3 style="margin:0;font-size:16px;color:#1e293b">Top Expenses</h3>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr style="background:#f8fafc">
          <td style="padding:8px 12px;font-size:12px;color:#94a3b8;text-transform:uppercase">Category</td>
          <td style="padding:8px 12px;font-size:12px;color:#94a3b8;text-transform:uppercase;text-align:right">Amount</td>
          <td style="padding:8px 12px;font-size:12px;color:#94a3b8;text-transform:uppercase;text-align:right">%</td>
        </tr>
        {exp_rows}
      </table>
    </div>'''}

    {stock_section}

    <!-- CTA -->
    <div style="text-align:center;margin-top:24px">
      <a href="https://bonbox.dk/dashboard" style="display:inline-block;padding:12px 32px;background:#3b82f6;color:white;text-decoration:none;border-radius:10px;font-size:15px;font-weight:600">Open Dashboard</a>
    </div>

    <!-- Footer -->
    <div style="text-align:center;margin-top:32px;padding-top:16px;border-top:1px solid #e2e8f0">
      <p style="margin:0;font-size:12px;color:#94a3b8">You're receiving this because daily digest is enabled in your BonBox settings.</p>
      <p style="margin:4px 0 0;font-size:12px;color:#94a3b8">
        <a href="https://bonbox.dk/profile" style="color:#3b82f6;text-decoration:none">Manage preferences</a>
      </p>
    </div>
  </div>
</body>
</html>"""
