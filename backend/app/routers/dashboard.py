import calendar
import logging
from datetime import date, timedelta
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, extract
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.khata import KhataCustomer, KhataTransaction
from app.models.budget import Budget
from app.schemas.dashboard import DashboardSummary, BenchmarkResponse, BenchmarkMetric
from app.services.auth import get_current_user
from app.services.prediction import get_staffing_recommendations

logger = logging.getLogger(__name__)

router = APIRouter()


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# BATCH ENDPOINT — replaces 15 separate API calls with 1
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast"

# WMO weather code -> condition (duplicated from weather router to avoid import)
_WMO_MAP = {
    0: "clear", 1: "clear", 2: "cloudy", 3: "cloudy",
    45: "fog", 48: "fog",
    51: "drizzle", 53: "drizzle", 55: "drizzle", 56: "drizzle", 57: "drizzle",
    61: "rain", 63: "rain", 65: "rain", 66: "rain", 67: "rain",
    71: "snow", 73: "snow", 75: "snow", 77: "snow",
    80: "rain", 81: "rain", 82: "rain",
    85: "snow", 86: "snow",
    95: "storm", 96: "storm", 99: "storm",
}


@router.get("/batch")
def get_dashboard_batch(
    period: str = Query("month"),
    year: Optional[int] = Query(None),
    month: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Single endpoint returning ALL data the dashboard needs.

    Replaces 15 separate API calls with one DB-session-efficient request.
    Optional fields (weather, staffing, budgets) return null on failure.
    """
    today = date.today()
    yesterday = today - timedelta(days=1)
    target_year = year or today.year
    target_month = month or today.month
    month_start = date(target_year, target_month, 1)
    _, last_day = calendar.monthrange(target_year, target_month)
    month_end = date(target_year, target_month, last_day)

    # ── 1. SUMMARY (from /dashboard/summary) ─────────────────────
    today_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date == today, Sale.is_deleted.isnot(True))
        .scalar()
    )
    yesterday_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date == yesterday, Sale.is_deleted.isnot(True))
        .scalar()
    )
    today_change = 0.0
    if yesterday_rev > 0:
        raw_change = ((today_rev - yesterday_rev) / yesterday_rev) * 100
        today_change = round(max(-500, min(500, raw_change)), 1)

    month_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= month_start, Sale.date <= month_end, Sale.is_deleted.isnot(True))
        .scalar()
    )
    month_exp = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= month_start, Expense.date <= month_end,
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )
    month_profit = month_rev - month_exp
    profit_margin = round((month_profit / month_rev) * 100, 1) if month_rev > 0 else 0.0

    top_cat = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date >= month_start, Expense.date <= month_end,
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .group_by(ExpenseCategory.name)
        .order_by(func.sum(Expense.amount).desc())
        .first()
    )
    alert_count = (
        db.query(func.count(InventoryItem.id))
        .filter(InventoryItem.user_id == user.id,
                InventoryItem.quantity <= InventoryItem.min_threshold)
        .scalar()
    )
    total_sales = (
        db.query(func.count(Sale.id))
        .filter(Sale.user_id == user.id, Sale.is_deleted.isnot(True))
        .scalar()
    )
    has_expense_categories = (
        db.query(ExpenseCategory.id)
        .filter(ExpenseCategory.user_id == user.id)
        .first()
    ) is not None
    has_inventory_items = (
        db.query(InventoryItem.id)
        .filter(InventoryItem.user_id == user.id)
        .first()
    ) is not None

    khata_recv_raw = (
        db.query(
            func.sum(KhataTransaction.purchase_amount) - func.sum(KhataTransaction.paid_amount)
        ).join(KhataCustomer, KhataTransaction.customer_id == KhataCustomer.id)
        .filter(KhataTransaction.user_id == user.id, KhataCustomer.is_deleted == False)
        .scalar()
    )
    khata_receivable = max(float(khata_recv_raw) if khata_recv_raw is not None else 0.0, 0)

    summary = {
        "today_revenue": today_rev,
        "today_revenue_change": today_change,
        "month_revenue": month_rev,
        "month_expenses": month_exp,
        "month_profit": month_profit,
        "profit_margin": profit_margin,
        "top_expense_category": top_cat[0] if top_cat else None,
        "top_expense_amount": float(top_cat[1]) if top_cat else 0,
        "inventory_alerts": alert_count,
        "total_sales": total_sales,
        "has_expense_categories": has_expense_categories,
        "has_inventory_items": has_inventory_items,
        "khata_receivable": khata_receivable,
    }

    # ── 2. MONTHLY REPORT (from /reports/monthly) ────────────────
    monthly_total_revenue = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date.between(month_start, month_end),
                Sale.is_deleted.isnot(True))
        .scalar()
    )
    monthly_total_expenses = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date.between(month_start, month_end),
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )
    expense_breakdown = (
        db.query(ExpenseCategory.name, ExpenseCategory.color, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date.between(month_start, month_end),
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .group_by(ExpenseCategory.name, ExpenseCategory.color)
        .order_by(func.sum(Expense.amount).desc())
        .all()
    )
    daily_revenue = (
        db.query(Sale.date, func.sum(Sale.amount).label("total"))
        .filter(Sale.user_id == user.id, Sale.date.between(month_start, month_end),
                Sale.is_deleted.isnot(True))
        .group_by(Sale.date)
        .order_by(Sale.date)
        .all()
    )
    best_day = max(daily_revenue, key=lambda r: r.total, default=None)
    worst_day = min(daily_revenue, key=lambda r: r.total, default=None)
    days_with_sales = len(daily_revenue)
    avg_daily_sales = round(monthly_total_revenue / days_with_sales, 2) if days_with_sales > 0 else 0
    sale_count = (
        db.query(func.count(Sale.id))
        .filter(Sale.user_id == user.id, Sale.date.between(month_start, month_end),
                Sale.is_deleted.isnot(True))
        .scalar()
    )
    avg_per_sale = round(monthly_total_revenue / sale_count, 2) if sale_count > 0 else 0

    monthly = {
        "month": target_month,
        "year": target_year,
        "total_revenue": monthly_total_revenue,
        "total_expenses": monthly_total_expenses,
        "net_profit": monthly_total_revenue - monthly_total_expenses,
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

    # ── 3. LATEST SALE (from /sales/latest) ──────────────────────
    latest_sale_obj = (
        db.query(Sale)
        .filter(Sale.user_id == user.id, Sale.is_deleted.isnot(True))
        .order_by(Sale.date.desc(), Sale.created_at.desc())
        .first()
    )
    latest_sales = None
    if latest_sale_obj:
        latest_sales = {
            "id": str(latest_sale_obj.id),
            "date": str(latest_sale_obj.date),
            "amount": float(latest_sale_obj.amount),
            "payment_method": latest_sale_obj.payment_method,
            "description": latest_sale_obj.description if hasattr(latest_sale_obj, "description") else None,
            "item_name": latest_sale_obj.item_name if hasattr(latest_sale_obj, "item_name") else None,
            "notes": latest_sale_obj.notes if hasattr(latest_sale_obj, "notes") else None,
        }

    # ── 4. RECEIPTS (from /sales/receipts) ───────────────────────
    receipt_sales = (
        db.query(Sale)
        .filter(Sale.user_id == user.id, Sale.receipt_photo.isnot(None),
                Sale.is_deleted.isnot(True))
        .order_by(Sale.date.desc(), Sale.created_at.desc())
        .limit(20)
        .all()
    )
    receipts = [
        {
            "id": str(s.id),
            "date": str(s.date),
            "amount": float(s.amount),
            "payment_method": s.payment_method,
            "receipt_photo": s.receipt_photo,
        }
        for s in receipt_sales
    ]

    # ── 5. FORECAST (from /reports/forecast) ─────────────────────
    lookback_start = today - timedelta(days=56)
    history = (
        db.query(Sale.date, func.sum(Sale.amount).label("total"))
        .filter(Sale.user_id == user.id, Sale.date.between(lookback_start, today),
                Sale.is_deleted.isnot(True))
        .group_by(Sale.date)
        .order_by(Sale.date)
        .all()
    )

    if len(history) < 7:
        forecast = {
            "forecast": [],
            "method": "insufficient_data",
            "message": "Need at least 7 days of sales data for forecasting",
            "confidence": 0,
        }
    else:
        weekday_revenues = {i: [] for i in range(7)}
        for d, total in history:
            weekday_revenues[d.weekday()].append(float(total))

        weekday_avg = {}
        for wday, amounts in weekday_revenues.items():
            if amounts:
                weights = [1 + i * 0.5 for i in range(len(amounts))]
                weighted_sum = sum(a * w for a, w in zip(amounts, weights))
                weight_total = sum(weights)
                weekday_avg[wday] = round(weighted_sum / weight_total)
            else:
                all_amounts = [float(t) for _, t in history]
                weekday_avg[wday] = round(sum(all_amounts) / len(all_amounts)) if all_amounts else 0

        two_weeks_ago = today - timedelta(days=14)
        four_weeks_ago = today - timedelta(days=28)
        recent_days = [(d, float(t)) for d, t in history if d > two_weeks_ago]
        older_days = [(d, float(t)) for d, t in history if four_weeks_ago < d <= two_weeks_ago]
        recent_avg = sum(t for _, t in recent_days) / len(recent_days) if recent_days else 0
        older_avg = sum(t for _, t in older_days) / len(older_days) if older_days else 0
        trend_factor = 1.0
        if older_avg > 0:
            trend_factor = min(max(recent_avg / older_avg, 0.7), 1.3)

        day_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        forecast_days = 7
        forecast_list = []
        for i in range(1, forecast_days + 1):
            future_date = today + timedelta(days=i)
            wday = future_date.weekday()
            base = weekday_avg.get(wday, 0)
            predicted = round(base * trend_factor)
            data_points = len(weekday_revenues.get(wday, []))
            confidence = min(round(data_points / 8 * 100), 95)
            forecast_list.append({
                "date": str(future_date),
                "day": day_names[wday],
                "predicted_revenue": predicted,
                "confidence": confidence,
                "trend": "up" if trend_factor > 1.05 else ("down" if trend_factor < 0.95 else "stable"),
            })

        total_predicted = sum(f["predicted_revenue"] for f in forecast_list)
        avg_confidence = round(sum(f["confidence"] for f in forecast_list) / len(forecast_list)) if forecast_list else 0
        forecast = {
            "forecast": forecast_list,
            "total_predicted": total_predicted,
            "avg_daily_predicted": round(total_predicted / len(forecast_list)) if forecast_list else 0,
            "trend_factor": round(trend_factor, 3),
            "trend_direction": "up" if trend_factor > 1.05 else ("down" if trend_factor < 0.95 else "stable"),
            "method": "weighted_moving_average",
            "confidence": avg_confidence,
            "data_points_used": len(history),
        }

    # ── 6. EXPENSE CATEGORIES (from /expenses/categories) ────────
    expense_categories = [
        {"id": str(c.id), "name": c.name, "color": c.color}
        for c in db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id).all()
    ]

    # ── 7. BENCHMARKS (from /dashboard/benchmarks) ───────────────
    btype = user.business_type or "restaurant"
    bench = BENCHMARKS.get(btype, BENCHMARKS["restaurant"])

    bench_expense_rows = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date >= month_start, Expense.date <= month_end,
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .group_by(ExpenseCategory.name)
        .all()
    )
    food_total = labor_total = rent_total = bench_total_expenses = 0.0
    for cat_name, amount in bench_expense_rows:
        amt = float(amount)
        bench_total_expenses += amt
        lower = cat_name.lower()
        if any(k in lower for k in INGREDIENT_KEYWORDS):
            food_total += amt
        elif any(k in lower for k in LABOR_KEYWORDS):
            labor_total += amt
        elif any(k in lower for k in RENT_KEYWORDS):
            rent_total += amt

    def _pct(val):
        return round((val / month_rev) * 100, 1) if month_rev > 0 else 0.0

    food_pct = _pct(food_total)
    labor_pct = _pct(labor_total)
    rent_pct = _pct(rent_total)
    bench_profit_pct = round(((month_rev - bench_total_expenses) / month_rev) * 100, 1) if month_rev > 0 else 0.0

    def _bench_status(value, bench_info, is_profit=False):
        good_low, good_high = bench_info["good"]
        avg_low, avg_high = bench_info["avg"]
        if is_profit:
            if value >= good_low:
                return "good"
            elif value >= avg_low:
                return "average"
            return "attention"
        if value <= good_high:
            return "good"
        elif value <= avg_high:
            return "average"
        return "attention"

    def _bench_tip(status, bench_info):
        if status == "good":
            return "You're on track!"
        elif status == "average":
            return "Within industry range"
        good_low, good_high = bench_info["good"]
        return f"Industry target: {good_low}-{good_high}%"

    bench_metrics = []
    for key, value, is_profit in [
        ("food_cost", food_pct, False),
        ("labor_cost", labor_pct, False),
        ("profit_margin", bench_profit_pct, True),
        ("rent_cost", rent_pct, False),
    ]:
        info = bench[key]
        st = _bench_status(value, info, is_profit)
        bench_metrics.append({
            "name": key,
            "label": info["label"],
            "user_value": value,
            "range_low": info["avg"][0],
            "range_high": info["avg"][1],
            "good_low": info["good"][0],
            "good_high": info["good"][1],
            "status": st,
            "tip": _bench_tip(st, info),
        })

    benchmarks = {
        "metrics": bench_metrics,
        "business_type": btype,
        "period": month_start.strftime("%B %Y"),
    }

    # ── 8. INVENTORY (from /inventory, limit 50) ─────────────────
    inventory_items = (
        db.query(InventoryItem)
        .filter(InventoryItem.user_id == user.id)
        .order_by(
            # Low stock first, then most recently added
            (InventoryItem.quantity <= InventoryItem.min_threshold).desc(),
            InventoryItem.created_at.desc(),
        )
        .limit(50)
        .all()
    )
    inventory = [
        {
            "id": str(item.id),
            "name": item.name,
            "quantity": float(item.quantity),
            "unit": item.unit,
            "min_threshold": float(item.min_threshold) if item.min_threshold else 0,
            "cost_per_unit": float(item.cost_per_unit) if item.cost_per_unit else 0,
            "sell_price": float(item.sell_price) if hasattr(item, "sell_price") and item.sell_price else None,
            "category": item.category,
            "expiry_date": str(item.expiry_date) if item.expiry_date else None,
        }
        for item in inventory_items
    ]

    # ── 9. TOP SELLERS (from /dashboard/top-sellers) ─────────────
    since_30d = today - timedelta(days=30)
    top_rows = (
        db.query(
            Sale.item_name,
            func.count(Sale.id).label("sale_count"),
            func.sum(Sale.amount).label("total_revenue"),
            func.sum(Sale.quantity_sold).label("total_qty"),
        )
        .filter(
            Sale.user_id == user.id,
            Sale.date >= since_30d,
            Sale.is_deleted.isnot(True),
            Sale.item_name.isnot(None),
            Sale.item_name != "",
        )
        .group_by(Sale.item_name)
        .order_by(func.sum(Sale.amount).desc())
        .limit(10)
        .all()
    )
    top_sellers = [
        {
            "name": r.item_name,
            "sales": r.sale_count,
            "revenue": round(float(r.total_revenue), 2),
            "quantity": round(float(r.total_qty), 2) if r.total_qty else r.sale_count,
        }
        for r in top_rows
    ]

    # ── 10. ACTION ITEMS (from /dashboard/action-items) ──────────
    action_items_list = []

    # Low stock
    low_stock = (
        db.query(InventoryItem.name, InventoryItem.quantity, InventoryItem.min_threshold)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity > 0,
            InventoryItem.quantity <= InventoryItem.min_threshold,
            InventoryItem.min_threshold > 0,
        )
        .order_by(InventoryItem.quantity.asc())
        .limit(5)
        .all()
    )
    for item in low_stock:
        action_items_list.append({
            "type": "restock",
            "priority": "high",
            "title": f"Restock: {item.name}",
            "detail": f"{float(item.quantity):.0f} left (min: {float(item.min_threshold):.0f})",
        })

    # Expiring items
    expiring = (
        db.query(InventoryItem.name, InventoryItem.expiry_date)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.expiry_date.isnot(None),
            InventoryItem.expiry_date <= today + timedelta(days=7),
            InventoryItem.expiry_date >= today,
        )
        .order_by(InventoryItem.expiry_date.asc())
        .limit(5)
        .all()
    )
    for item in expiring:
        days_left = (item.expiry_date - today).days
        action_items_list.append({
            "type": "expiring",
            "priority": "high" if days_left <= 2 else "medium",
            "title": f"Expiring: {item.name}",
            "detail": "Today!" if days_left == 0 else f"In {days_left} day{'s' if days_left != 1 else ''}",
        })

    # Pending returns
    try:
        pending_returns = (
            db.query(func.count(Sale.id))
            .filter(Sale.user_id == user.id, Sale.status == "return-pending",
                    Sale.is_deleted.isnot(True))
            .scalar()
        )
        if pending_returns and pending_returns > 0:
            action_items_list.append({
                "type": "return",
                "priority": "high",
                "title": f"{pending_returns} return{'s' if pending_returns > 1 else ''} pending",
                "detail": "Customer returns need your action \u2014 refund, replace, or restock",
            })
    except Exception:
        pass

    # No sales today
    today_sales = (
        db.query(func.count(Sale.id))
        .filter(Sale.user_id == user.id, Sale.date == today, Sale.is_deleted.isnot(True))
        .scalar()
    )
    if today_sales == 0:
        action_items_list.append({
            "type": "reminder",
            "priority": "low",
            "title": "No sales logged today",
            "detail": "Log your first sale to keep tracking accurate",
        })

    # High expense ratio
    if month_rev > 0:
        exp_ratio = round((month_exp / month_rev) * 100)
        if exp_ratio > 70:
            action_items_list.append({
                "type": "cost", "priority": "high",
                "title": f"Expenses are {exp_ratio}% of revenue",
                "detail": "Review your biggest expense categories to cut costs",
            })
        elif exp_ratio > 50:
            action_items_list.append({
                "type": "cost", "priority": "medium",
                "title": f"Expenses are {exp_ratio}% of revenue",
                "detail": "Good, but there may be room to improve margins",
            })

    # ── 11. WEEK COMPARISON (from /dashboard/week-comparison) ────
    weekday = today.weekday()
    this_monday = today - timedelta(days=weekday)
    last_monday = this_monday - timedelta(days=7)
    last_sunday = this_monday - timedelta(days=1)

    this_week_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= this_monday, Sale.date <= today,
                Sale.is_deleted.isnot(True))
        .scalar()
    )
    last_week_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= last_monday, Sale.date <= last_sunday,
                Sale.is_deleted.isnot(True))
        .scalar()
    )
    this_week_exp = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= this_monday, Expense.date <= today,
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )
    last_week_exp = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= last_monday, Expense.date <= last_sunday,
                Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )
    wk_change_pct = 0.0
    if last_week_rev > 0:
        wk_change_pct = round(((this_week_rev - last_week_rev) / last_week_rev) * 100, 1)

    week_comparison = {
        "this_week_revenue": round(this_week_rev, 2),
        "last_week_revenue": round(last_week_rev, 2),
        "change_pct": wk_change_pct,
        "this_week_expenses": round(this_week_exp, 2),
        "last_week_expenses": round(last_week_exp, 2),
        "this_week_profit": round(this_week_rev - this_week_exp, 2),
        "last_week_profit": round(last_week_rev - last_week_exp, 2),
    }

    # ── 12. PAYMENT BREAKDOWN (from /dashboard/payment-breakdown)─
    pay_rows = (
        db.query(
            Sale.payment_method,
            func.sum(Sale.amount).label("total"),
            func.count(Sale.id).label("cnt"),
        )
        .filter(Sale.user_id == user.id, Sale.date >= month_start, Sale.date <= month_end,
                Sale.is_deleted.isnot(True))
        .group_by(Sale.payment_method)
        .all()
    )
    payment_breakdown = [
        {
            "method": (r.payment_method or "other").lower(),
            "amount": round(float(r.total), 2),
            "count": r.cnt,
        }
        for r in pay_rows
    ]

    # ── 13. WEATHER FORECAST (optional) ──────────────────────────
    weather_data = None
    try:
        lat = getattr(user, "latitude", None)
        lon = getattr(user, "longitude", None)
        if lat and lon:
            resp = httpx.get(OPEN_METEO_FORECAST, params={
                "latitude": lat, "longitude": lon,
                "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,precipitation",
                "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,wind_speed_10m_max",
                "timezone": "auto",
            }, timeout=5)
            if resp.status_code == 200:
                body = resp.json()
                w_data = body["daily"]
                current_data = body.get("current", {})
                current = None
                if current_data:
                    cwmo = current_data.get("weather_code", 0)
                    current = {
                        "temperature": current_data.get("temperature_2m"),
                        "feels_like": current_data.get("apparent_temperature"),
                        "humidity": current_data.get("relative_humidity_2m"),
                        "wind_speed": current_data.get("wind_speed_10m"),
                        "precipitation": current_data.get("precipitation"),
                        "weather_code": cwmo,
                        "condition": _WMO_MAP.get(cwmo, "cloudy"),
                    }
                days = []
                for i in range(len(w_data["time"])):
                    wmo = w_data["weather_code"][i]
                    days.append({
                        "date": w_data["time"][i],
                        "temp_max": w_data["temperature_2m_max"][i],
                        "temp_min": w_data["temperature_2m_min"][i],
                        "precipitation": w_data["precipitation_sum"][i],
                        "wind_speed": w_data["wind_speed_10m_max"][i],
                        "weather_code": wmo,
                        "condition": _WMO_MAP.get(wmo, "cloudy"),
                    })
                weather_data = {"current": current, "days": days, "timezone": body.get("timezone", "UTC")}
    except Exception as exc:
        logger.warning("Batch: weather fetch failed: %s", exc)

    # ── 14. STAFFING FORECAST (optional) ─────────────────────────
    staffing_forecast = None
    try:
        result = get_staffing_recommendations(db, str(user.id), 14)
        staffing_forecast = {
            "recommendations": result["recommendations"],
            "patterns": result["patterns"],
        }
    except Exception as exc:
        logger.warning("Batch: staffing forecast failed: %s", exc)

    # ── 15. BUDGET SUMMARY (optional) ────────────────────────────
    budget_summary = None
    try:
        bud_month = f"{target_year}-{str(target_month).zfill(2)}"
        budget_rows = db.query(Budget).filter(
            Budget.user_id == user.id, Budget.month == bud_month,
        ).all()

        budget_map = {}
        total_budget = 0.0
        for b in budget_rows:
            if b.category == "__TOTAL__":
                total_budget = float(b.limit_amount)
            else:
                budget_map[b.category] = float(b.limit_amount)

        spending_rows = (
            db.query(ExpenseCategory.name, func.sum(Expense.amount))
            .join(ExpenseCategory, Expense.category_id == ExpenseCategory.id)
            .filter(
                Expense.user_id == user.id,
                Expense.is_personal == False,
                Expense.is_deleted == False,
                extract("year", Expense.date) == target_year,
                extract("month", Expense.date) == target_month,
            )
            .group_by(ExpenseCategory.name)
            .all()
        )
        spending_map = {name: float(total) for name, total in spending_rows}
        total_spent = sum(spending_map.values())

        income_cats = {"Salary", "Freelance", "Side Income", "Gift Received", "Borrowed"}
        all_cats = set(list(budget_map.keys()) + list(spending_map.keys())) - income_cats

        bud_categories = []
        for cat in sorted(all_cats):
            limit = budget_map.get(cat, 0)
            spent = spending_map.get(cat, 0)
            pct = round((spent / limit) * 100) if limit > 0 else 0
            status = "red" if (limit > 0 and spent > limit) else "yellow" if (limit > 0 and pct >= 80) else "green"
            bud_categories.append({
                "category": cat, "limit_amount": limit, "spent": spent, "pct": pct, "status": status,
            })

        total_pct = round((total_spent / total_budget) * 100) if total_budget > 0 else 0
        budget_summary = {
            "month": bud_month,
            "total_budget": total_budget,
            "total_spent": total_spent,
            "total_pct": total_pct,
            "categories": bud_categories,
        }
    except Exception as exc:
        logger.warning("Batch: budget summary failed: %s", exc)

    # ── ASSEMBLE RESPONSE ────────────────────────────────────────
    return {
        "summary": summary,
        "monthly": monthly,
        "latest_sales": latest_sales,
        "receipts": receipts,
        "forecast": forecast,
        "expense_categories": expense_categories,
        "benchmarks": benchmarks,
        "inventory": inventory,
        "top_sellers": top_sellers,
        "action_items": action_items_list,
        "week_comparison": week_comparison,
        "payment_breakdown": payment_breakdown,
        "weather": weather_data,
        "staffing_forecast": staffing_forecast,
        "budget_summary": budget_summary,
    }


# Industry benchmarks by business type
BENCHMARKS = {
    "restaurant": {
        "food_cost": {"label": "Food Cost % of Revenue", "good": (25, 30), "avg": (30, 35), "attention": 35},
        "labor_cost": {"label": "Labor Cost % of Revenue", "good": (25, 30), "avg": (30, 38), "attention": 38},
        "profit_margin": {"label": "Net Profit Margin", "good": (15, 100), "avg": (8, 15), "attention": 8},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 10), "avg": (10, 15), "attention": 15},
    },
    "cafe": {
        "food_cost": {"label": "Food & Beverage Cost", "good": (20, 28), "avg": (28, 35), "attention": 35},
        "labor_cost": {"label": "Labor Cost % of Revenue", "good": (25, 32), "avg": (32, 40), "attention": 40},
        "profit_margin": {"label": "Net Profit Margin", "good": (12, 100), "avg": (6, 12), "attention": 6},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 12), "avg": (12, 18), "attention": 18},
    },
    "bar": {
        "food_cost": {"label": "Beverage Cost % of Revenue", "good": (18, 24), "avg": (24, 30), "attention": 30},
        "labor_cost": {"label": "Labor Cost % of Revenue", "good": (20, 28), "avg": (28, 35), "attention": 35},
        "profit_margin": {"label": "Net Profit Margin", "good": (15, 100), "avg": (8, 15), "attention": 8},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 10), "avg": (10, 15), "attention": 15},
    },
    "bakery": {
        "food_cost": {"label": "Ingredient Cost % of Revenue", "good": (25, 32), "avg": (32, 38), "attention": 38},
        "labor_cost": {"label": "Labor Cost % of Revenue", "good": (25, 30), "avg": (30, 38), "attention": 38},
        "profit_margin": {"label": "Net Profit Margin", "good": (10, 100), "avg": (5, 10), "attention": 5},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 10), "avg": (10, 15), "attention": 15},
    },
    "retail": {
        "food_cost": {"label": "COGS % of Revenue", "good": (40, 55), "avg": (55, 65), "attention": 65},
        "labor_cost": {"label": "Labor Cost % of Revenue", "good": (10, 18), "avg": (18, 25), "attention": 25},
        "profit_margin": {"label": "Net Profit Margin", "good": (10, 100), "avg": (4, 10), "attention": 4},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 8), "avg": (8, 14), "attention": 14},
    },
    "wholesale": {
        "food_cost": {"label": "COGS % of Revenue", "good": (60, 72), "avg": (72, 80), "attention": 80},
        "labor_cost": {"label": "Labor Cost % of Revenue", "good": (5, 12), "avg": (12, 18), "attention": 18},
        "profit_margin": {"label": "Net Profit Margin", "good": (5, 100), "avg": (2, 5), "attention": 2},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 5), "avg": (5, 10), "attention": 10},
    },
    "clothing": {
        "food_cost": {"label": "COGS % of Revenue", "good": (40, 55), "avg": (55, 65), "attention": 65},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (10, 18), "avg": (18, 25), "attention": 25},
        "profit_margin": {"label": "Net Profit Margin", "good": (12, 100), "avg": (5, 12), "attention": 5},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 10), "avg": (10, 18), "attention": 18},
    },
    "grocery": {
        "food_cost": {"label": "COGS % of Revenue", "good": (65, 75), "avg": (75, 82), "attention": 82},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (8, 14), "avg": (14, 20), "attention": 20},
        "profit_margin": {"label": "Net Profit Margin", "good": (5, 100), "avg": (2, 5), "attention": 2},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 6), "avg": (6, 12), "attention": 12},
    },
    "veggie_shop": {
        "food_cost": {"label": "Purchase Cost % of Revenue", "good": (55, 65), "avg": (65, 75), "attention": 75},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (5, 12), "avg": (12, 18), "attention": 18},
        "profit_margin": {"label": "Net Profit Margin", "good": (8, 100), "avg": (3, 8), "attention": 3},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 8), "avg": (8, 14), "attention": 14},
    },
    "pharmacy": {
        "food_cost": {"label": "Drug Cost % of Revenue", "good": (55, 68), "avg": (68, 76), "attention": 76},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (10, 16), "avg": (16, 22), "attention": 22},
        "profit_margin": {"label": "Net Profit Margin", "good": (8, 100), "avg": (3, 8), "attention": 3},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 8), "avg": (8, 14), "attention": 14},
    },
    "electronics": {
        "food_cost": {"label": "COGS % of Revenue", "good": (50, 62), "avg": (62, 72), "attention": 72},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (8, 15), "avg": (15, 22), "attention": 22},
        "profit_margin": {"label": "Net Profit Margin", "good": (10, 100), "avg": (4, 10), "attention": 4},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 8), "avg": (8, 14), "attention": 14},
    },
    "kiosk": {
        "food_cost": {"label": "COGS % of Revenue", "good": (55, 65), "avg": (65, 75), "attention": 75},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (10, 18), "avg": (18, 25), "attention": 25},
        "profit_margin": {"label": "Net Profit Margin", "good": (8, 100), "avg": (3, 8), "attention": 3},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 10), "avg": (10, 16), "attention": 16},
    },
    "online_clothing": {
        "food_cost": {"label": "Product Cost % of Revenue", "good": (35, 50), "avg": (50, 60), "attention": 60},
        "labor_cost": {"label": "Shipping & Ops Cost", "good": (5, 12), "avg": (12, 20), "attention": 20},
        "profit_margin": {"label": "Net Profit Margin", "good": (15, 100), "avg": (8, 15), "attention": 8},
        "rent_cost": {"label": "Platform/Ads % of Revenue", "good": (0, 10), "avg": (10, 20), "attention": 20},
    },
    "tea_shop": {
        "food_cost": {"label": "Ingredient Cost % of Revenue", "good": (20, 30), "avg": (30, 40), "attention": 40},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (15, 25), "avg": (25, 35), "attention": 35},
        "profit_margin": {"label": "Net Profit Margin", "good": (15, 100), "avg": (8, 15), "attention": 8},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 12), "avg": (12, 20), "attention": 20},
    },
    "cosmetics": {
        "food_cost": {"label": "Product Cost % of Revenue", "good": (40, 55), "avg": (55, 65), "attention": 65},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (10, 18), "avg": (18, 25), "attention": 25},
        "profit_margin": {"label": "Net Profit Margin", "good": (12, 100), "avg": (5, 12), "attention": 5},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 10), "avg": (10, 16), "attention": 16},
    },
    "stationery": {
        "food_cost": {"label": "COGS % of Revenue", "good": (50, 62), "avg": (62, 72), "attention": 72},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (8, 15), "avg": (15, 22), "attention": 22},
        "profit_margin": {"label": "Net Profit Margin", "good": (8, 100), "avg": (3, 8), "attention": 3},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 8), "avg": (8, 14), "attention": 14},
    },
    "hardware": {
        "food_cost": {"label": "COGS % of Revenue", "good": (60, 72), "avg": (72, 80), "attention": 80},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (5, 12), "avg": (12, 18), "attention": 18},
        "profit_margin": {"label": "Net Profit Margin", "good": (5, 100), "avg": (2, 5), "attention": 2},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 6), "avg": (6, 12), "attention": 12},
    },
    "flower_shop": {
        "food_cost": {"label": "Flower Cost % of Revenue", "good": (30, 42), "avg": (42, 55), "attention": 55},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (15, 22), "avg": (22, 30), "attention": 30},
        "profit_margin": {"label": "Net Profit Margin", "good": (12, 100), "avg": (5, 12), "attention": 5},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 12), "avg": (12, 18), "attention": 18},
    },
    "jewelry": {
        "food_cost": {"label": "Material Cost % of Revenue", "good": (40, 55), "avg": (55, 68), "attention": 68},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (8, 15), "avg": (15, 22), "attention": 22},
        "profit_margin": {"label": "Net Profit Margin", "good": (15, 100), "avg": (8, 15), "attention": 8},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 8), "avg": (8, 14), "attention": 14},
    },
    "mobile_repair": {
        "food_cost": {"label": "Parts Cost % of Revenue", "good": (25, 38), "avg": (38, 50), "attention": 50},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (15, 25), "avg": (25, 35), "attention": 35},
        "profit_margin": {"label": "Net Profit Margin", "good": (20, 100), "avg": (10, 20), "attention": 10},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 10), "avg": (10, 16), "attention": 16},
    },
    "salon": {
        "food_cost": {"label": "Product Cost % of Revenue", "good": (5, 12), "avg": (12, 18), "attention": 18},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (35, 45), "avg": (45, 55), "attention": 55},
        "profit_margin": {"label": "Net Profit Margin", "good": (15, 100), "avg": (8, 15), "attention": 8},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 13), "avg": (13, 20), "attention": 20},
    },
    "laundry": {
        "food_cost": {"label": "Supply Cost % of Revenue", "good": (15, 25), "avg": (25, 35), "attention": 35},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (25, 35), "avg": (35, 45), "attention": 45},
        "profit_margin": {"label": "Net Profit Margin", "good": (15, 100), "avg": (8, 15), "attention": 8},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 12), "avg": (12, 18), "attention": 18},
    },
    "thrift": {
        "food_cost": {"label": "Purchase Cost % of Revenue", "good": (20, 35), "avg": (35, 50), "attention": 50},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (10, 18), "avg": (18, 25), "attention": 25},
        "profit_margin": {"label": "Net Profit Margin", "good": (20, 100), "avg": (10, 20), "attention": 10},
        "rent_cost": {"label": "Rent % of Revenue", "good": (0, 12), "avg": (12, 18), "attention": 18},
    },
    "food_truck": {
        "food_cost": {"label": "Food Cost % of Revenue", "good": (25, 32), "avg": (32, 40), "attention": 40},
        "labor_cost": {"label": "Staff Cost % of Revenue", "good": (20, 28), "avg": (28, 35), "attention": 35},
        "profit_margin": {"label": "Net Profit Margin", "good": (12, 100), "avg": (5, 12), "attention": 5},
        "rent_cost": {"label": "Parking/License % of Revenue", "good": (0, 8), "avg": (8, 14), "attention": 14},
    },
}

# Category keywords to detect expense types
INGREDIENT_KEYWORDS = {"ingredients", "food", "beverage", "groceries", "supplies", "inventory", "råvarer", "ingredienser"}
LABOR_KEYWORDS = {"wages", "salary", "staff", "labor", "løn", "personale"}
RENT_KEYWORDS = {"rent", "lease", "husleje", "leje"}


@router.get("/summary", response_model=DashboardSummary)
def get_summary(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    today = date.today()
    yesterday = today - timedelta(days=1)
    month_start = today.replace(day=1)

    # Today's revenue
    today_rev = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date == today, Sale.is_deleted.isnot(True))
        .scalar()
    )

    # Yesterday's revenue (for % change)
    yesterday_rev = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date == yesterday, Sale.is_deleted.isnot(True))
        .scalar()
    )

    today_change = 0.0
    if yesterday_rev > 0:
        raw_change = ((float(today_rev) - float(yesterday_rev)) / float(yesterday_rev)) * 100
        today_change = round(max(-500, min(500, raw_change)), 1)

    # This month's revenue
    month_rev = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= month_start, Sale.is_deleted.isnot(True))
        .scalar()
    )

    # This month's expenses (exclude personal and deleted)
    month_exp = (
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= month_start, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )

    month_profit = float(month_rev) - float(month_exp)
    profit_margin = round((month_profit / float(month_rev)) * 100, 1) if float(month_rev) > 0 else 0.0

    # Top expense category this month
    top_cat = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date >= month_start, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .group_by(ExpenseCategory.name)
        .order_by(func.sum(Expense.amount).desc())
        .first()
    )

    # Inventory alerts
    alert_count = (
        db.query(func.count(InventoryItem.id))
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity <= InventoryItem.min_threshold,
        )
        .scalar()
    )

    # Onboarding helpers
    total_sales = (
        db.query(func.count(Sale.id))
        .filter(Sale.user_id == user.id, Sale.is_deleted.isnot(True))
        .scalar()
    )

    has_expense_categories = (
        db.query(ExpenseCategory.id)
        .filter(ExpenseCategory.user_id == user.id)
        .first()
    ) is not None

    has_inventory_items = (
        db.query(InventoryItem.id)
        .filter(InventoryItem.user_id == user.id)
        .first()
    ) is not None

    # Khata receivable (total outstanding credit, excluding deleted customers)
    khata_recv_raw = (
        db.query(
            func.sum(KhataTransaction.purchase_amount) - func.sum(KhataTransaction.paid_amount)
        ).join(KhataCustomer, KhataTransaction.customer_id == KhataCustomer.id)
        .filter(
            KhataTransaction.user_id == user.id,
            KhataCustomer.is_deleted == False,
        ).scalar()
    )
    khata_receivable = float(khata_recv_raw) if khata_recv_raw is not None else 0.0

    return DashboardSummary(
        today_revenue=float(today_rev),
        today_revenue_change=today_change,
        month_revenue=float(month_rev),
        month_expenses=float(month_exp),
        month_profit=month_profit,
        profit_margin=profit_margin,
        top_expense_category=top_cat[0] if top_cat else None,
        top_expense_amount=float(top_cat[1]) if top_cat else 0,
        inventory_alerts=alert_count,
        total_sales=total_sales,
        has_expense_categories=has_expense_categories,
        has_inventory_items=has_inventory_items,
        khata_receivable=max(khata_receivable, 0),
    )


@router.get("/top-sellers")
def get_top_sellers(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    days: int = 30,
):
    """Top selling items by revenue and quantity in the last N days."""
    since = date.today() - timedelta(days=days)

    rows = (
        db.query(
            Sale.item_name,
            func.count(Sale.id).label("sale_count"),
            func.sum(Sale.amount).label("total_revenue"),
            func.sum(Sale.quantity_sold).label("total_qty"),
        )
        .filter(
            Sale.user_id == user.id,
            Sale.date >= since,
            Sale.is_deleted.isnot(True),
            Sale.item_name.isnot(None),
            Sale.item_name != "",
        )
        .group_by(Sale.item_name)
        .order_by(func.sum(Sale.amount).desc())
        .limit(10)
        .all()
    )

    return [
        {
            "name": r.item_name,
            "sales": r.sale_count,
            "revenue": round(float(r.total_revenue), 2),
            "quantity": round(float(r.total_qty), 2) if r.total_qty else r.sale_count,
        }
        for r in rows
    ]


@router.get("/action-items")
def get_action_items(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Actionable insights for the business owner."""
    today = date.today()
    month_start = today.replace(day=1)
    items = []

    # 1. Low stock items
    low_stock = (
        db.query(InventoryItem.name, InventoryItem.quantity, InventoryItem.min_threshold)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity > 0,
            InventoryItem.quantity <= InventoryItem.min_threshold,
            InventoryItem.min_threshold > 0,
        )
        .order_by(InventoryItem.quantity.asc())
        .limit(5)
        .all()
    )
    for item in low_stock:
        items.append({
            "type": "restock",
            "priority": "high",
            "title": f"Restock: {item.name}",
            "detail": f"{float(item.quantity):.0f} left (min: {float(item.min_threshold):.0f})",
        })

    # 2. Expiring items (within 7 days)
    expiring = (
        db.query(InventoryItem.name, InventoryItem.expiry_date)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.expiry_date.isnot(None),
            InventoryItem.expiry_date <= today + timedelta(days=7),
            InventoryItem.expiry_date >= today,
        )
        .order_by(InventoryItem.expiry_date.asc())
        .limit(5)
        .all()
    )
    for item in expiring:
        days_left = (item.expiry_date - today).days
        items.append({
            "type": "expiring",
            "priority": "high" if days_left <= 2 else "medium",
            "title": f"Expiring: {item.name}",
            "detail": "Today!" if days_left == 0 else f"In {days_left} day{'s' if days_left != 1 else ''}"
        })

    # 3. Pending returns
    try:
        pending_returns = (
            db.query(func.count(Sale.id))
            .filter(Sale.user_id == user.id, Sale.status == "return-pending", Sale.is_deleted.isnot(True))
            .scalar()
        )
        if pending_returns and pending_returns > 0:
            items.append({
                "type": "return",
                "priority": "high",
                "title": f"{pending_returns} return{'s' if pending_returns > 1 else ''} pending",
                "detail": "Customer returns need your action — refund, replace, or restock",
            })
    except Exception:
        pass  # status column may not exist yet

    # 4. No sales today
    today_sales = (
        db.query(func.count(Sale.id))
        .filter(Sale.user_id == user.id, Sale.date == today, Sale.is_deleted.isnot(True))
        .scalar()
    )
    if today_sales == 0:
        items.append({
            "type": "reminder",
            "priority": "low",
            "title": "No sales logged today",
            "detail": "Log your first sale to keep tracking accurate",
        })

    # 4. High expense ratio
    month_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= month_start, Sale.is_deleted.isnot(True))
        .scalar()
    )
    month_exp = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= month_start, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )
    if month_rev > 0:
        exp_ratio = round((month_exp / month_rev) * 100)
        if exp_ratio > 70:
            items.append({
                "type": "cost",
                "priority": "high",
                "title": f"Expenses are {exp_ratio}% of revenue",
                "detail": "Review your biggest expense categories to cut costs",
            })
        elif exp_ratio > 50:
            items.append({
                "type": "cost",
                "priority": "medium",
                "title": f"Expenses are {exp_ratio}% of revenue",
                "detail": "Good, but there may be room to improve margins",
            })

    return items


@router.get("/benchmarks", response_model=BenchmarkResponse)
def get_benchmarks(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    today = date.today()
    month_start = today.replace(day=1)
    btype = user.business_type or "restaurant"

    # Use matching benchmarks or fall back to restaurant
    bench = BENCHMARKS.get(btype, BENCHMARKS["restaurant"])

    # This month's revenue
    month_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= month_start, Sale.is_deleted.isnot(True))
        .scalar()
    )

    # Get all expenses with category names this month
    expense_rows = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(
            Expense.user_id == user.id,
            Expense.date >= month_start,
            Expense.is_personal.isnot(True),
            Expense.is_deleted.isnot(True),
        )
        .group_by(ExpenseCategory.name)
        .all()
    )

    # Classify expenses into food/labor/rent/other
    food_total = 0.0
    labor_total = 0.0
    rent_total = 0.0
    total_expenses = 0.0

    for cat_name, amount in expense_rows:
        amt = float(amount)
        total_expenses += amt
        lower = cat_name.lower()
        if any(k in lower for k in INGREDIENT_KEYWORDS):
            food_total += amt
        elif any(k in lower for k in LABOR_KEYWORDS):
            labor_total += amt
        elif any(k in lower for k in RENT_KEYWORDS):
            rent_total += amt

    # Calculate percentages
    def pct(val):
        return round((val / month_rev) * 100, 1) if month_rev > 0 else 0.0

    food_pct = pct(food_total)
    labor_pct = pct(labor_total)
    rent_pct = pct(rent_total)
    profit_pct = round(((month_rev - total_expenses) / month_rev) * 100, 1) if month_rev > 0 else 0.0

    def get_status(value, bench_info):
        good_low, good_high = bench_info["good"]
        avg_low, avg_high = bench_info["avg"]
        # For profit_margin, higher is better
        if bench_info is bench.get("profit_margin"):
            if value >= good_low:
                return "good"
            elif value >= avg_low:
                return "average"
            return "attention"
        # For costs, lower is better
        if value <= good_high:
            return "good"
        elif value <= avg_high:
            return "average"
        return "attention"

    def make_tip(status, value, bench_info):
        if status == "good":
            return "You're on track!"
        elif status == "average":
            return "Within industry range"
        else:
            good_low, good_high = bench_info["good"]
            return f"Industry target: {good_low}-{good_high}%"

    metrics = []
    metric_data = [
        ("food_cost", food_pct),
        ("labor_cost", labor_pct),
        ("profit_margin", profit_pct),
        ("rent_cost", rent_pct),
    ]

    for key, value in metric_data:
        info = bench[key]
        status = get_status(value, info)
        metrics.append(BenchmarkMetric(
            name=key,
            label=info["label"],
            user_value=value,
            range_low=info["avg"][0],
            range_high=info["avg"][1],
            good_low=info["good"][0],
            good_high=info["good"][1],
            status=status,
            tip=make_tip(status, value, info),
        ))

    period_label = today.strftime("%B %Y")

    return BenchmarkResponse(
        metrics=metrics,
        business_type=btype,
        period=period_label,
    )


@router.get("/week-comparison")
def get_week_comparison(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Compare this week vs last week (Monday-based weeks)."""
    today = date.today()
    weekday = today.weekday()  # Monday=0
    this_monday = today - timedelta(days=weekday)
    last_monday = this_monday - timedelta(days=7)
    last_sunday = this_monday - timedelta(days=1)

    # This week revenue
    this_week_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= this_monday, Sale.date <= today, Sale.is_deleted.isnot(True))
        .scalar()
    )

    # Last week revenue
    last_week_rev = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= last_monday, Sale.date <= last_sunday, Sale.is_deleted.isnot(True))
        .scalar()
    )

    # This week expenses
    this_week_exp = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= this_monday, Expense.date <= today, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )

    # Last week expenses
    last_week_exp = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= last_monday, Expense.date <= last_sunday, Expense.is_personal.isnot(True), Expense.is_deleted.isnot(True))
        .scalar()
    )

    this_week_profit = this_week_rev - this_week_exp
    last_week_profit = last_week_rev - last_week_exp

    change_pct = 0.0
    if last_week_rev > 0:
        change_pct = round(((this_week_rev - last_week_rev) / last_week_rev) * 100, 1)

    return {
        "this_week_revenue": round(this_week_rev, 2),
        "last_week_revenue": round(last_week_rev, 2),
        "change_pct": change_pct,
        "this_week_expenses": round(this_week_exp, 2),
        "last_week_expenses": round(last_week_exp, 2),
        "this_week_profit": round(this_week_profit, 2),
        "last_week_profit": round(last_week_profit, 2),
    }


@router.get("/payment-breakdown")
def get_payment_breakdown(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Payment method totals for the current month."""
    today = date.today()
    month_start = today.replace(day=1)

    rows = (
        db.query(
            Sale.payment_method,
            func.sum(Sale.amount).label("total"),
            func.count(Sale.id).label("cnt"),
        )
        .filter(
            Sale.user_id == user.id,
            Sale.date >= month_start,
            Sale.is_deleted.isnot(True),
        )
        .group_by(Sale.payment_method)
        .all()
    )

    results = []
    for r in rows:
        method = r.payment_method or "other"
        results.append({
            "method": method.lower(),
            "amount": round(float(r.total), 2),
            "count": r.cnt,
        })

    return results
