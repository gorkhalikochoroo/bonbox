from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.schemas.dashboard import DashboardSummary
from app.services.auth import get_current_user

router = APIRouter()


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
        .filter(Sale.user_id == user.id, Sale.date == today)
        .scalar()
    )

    # Yesterday's revenue (for % change)
    yesterday_rev = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date == yesterday)
        .scalar()
    )

    today_change = 0.0
    if yesterday_rev > 0:
        today_change = round(((float(today_rev) - float(yesterday_rev)) / float(yesterday_rev)) * 100, 1)

    # This month's revenue
    month_rev = (
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.date >= month_start)
        .scalar()
    )

    # This month's expenses (exclude personal)
    month_exp = (
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.date >= month_start, Expense.is_personal.isnot(True))
        .scalar()
    )

    month_profit = float(month_rev) - float(month_exp)
    profit_margin = round((month_profit / float(month_rev)) * 100, 1) if float(month_rev) > 0 else 0.0

    # Top expense category this month
    top_cat = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount).label("total"))
        .join(Expense, Expense.category_id == ExpenseCategory.id)
        .filter(Expense.user_id == user.id, Expense.date >= month_start, Expense.is_personal.isnot(True))
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
        .filter(Sale.user_id == user.id)
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
