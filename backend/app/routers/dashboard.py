from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.khata import KhataCustomer, KhataTransaction
from app.schemas.dashboard import DashboardSummary, BenchmarkResponse, BenchmarkMetric
from app.services.auth import get_current_user

router = APIRouter()

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

    # 3. No sales today
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
