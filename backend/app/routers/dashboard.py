from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
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
        today_change = round(((float(today_rev) - float(yesterday_rev)) / float(yesterday_rev)) * 100, 1)

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
    )


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
