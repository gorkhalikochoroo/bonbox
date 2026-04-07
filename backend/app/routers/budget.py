from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func, extract

from app.database import get_db
from app.models.user import User
from app.models.budget import Budget
from app.models.expense import Expense, ExpenseCategory
from app.schemas.budget import (
    BudgetBulkUpsert, BudgetResponse, BudgetSummaryResponse, BudgetCategorySummary,
)
from app.services.auth import get_current_user

router = APIRouter()


@router.get("", response_model=list[BudgetResponse])
def list_budgets(
    month: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = db.query(Budget).filter(Budget.user_id == user.id)
    if month:
        q = q.filter(Budget.month == month)
    return q.order_by(Budget.category).all()


@router.put("")
def upsert_budgets(
    data: BudgetBulkUpsert,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Bulk upsert budgets for a given month."""
    for item in data.budgets:
        existing = db.query(Budget).filter(
            Budget.user_id == user.id,
            Budget.month == data.month,
            Budget.category == item.category,
        ).first()
        if existing:
            existing.limit_amount = item.limit_amount
        else:
            db.add(Budget(
                user_id=user.id,
                month=data.month,
                category=item.category,
                limit_amount=item.limit_amount,
            ))
    db.commit()
    return {"status": "ok"}


@router.get("/summary", response_model=BudgetSummaryResponse)
def get_budget_summary(
    month: str,
    mode: str = "personal",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get budget vs actual spending for a month. mode=personal|business"""
    # Get budgets for this month
    budget_rows = db.query(Budget).filter(
        Budget.user_id == user.id,
        Budget.month == month,
    ).all()

    budget_map = {}
    total_budget = 0.0
    for b in budget_rows:
        if b.category == "__TOTAL__":
            total_budget = float(b.limit_amount)
        else:
            budget_map[b.category] = float(b.limit_amount)

    # Get spending by category for this month
    year, mo = month.split("-")
    personal_filter = Expense.is_personal == True if mode == "personal" else Expense.is_personal == False
    spending_rows = (
        db.query(ExpenseCategory.name, func.sum(Expense.amount))
        .join(ExpenseCategory, Expense.category_id == ExpenseCategory.id)
        .filter(
            Expense.user_id == user.id,
            personal_filter,
            Expense.is_deleted == False,
            extract("year", Expense.date) == int(year),
            extract("month", Expense.date) == int(mo),
        )
        .group_by(ExpenseCategory.name)
        .all()
    )

    spending_map = {name: float(total) for name, total in spending_rows}
    total_spent = sum(spending_map.values())

    # Build category summaries
    all_cats = set(list(budget_map.keys()) + list(spending_map.keys()))
    # Exclude income categories from budget tracking
    income_cats = {"Salary", "Freelance", "Side Income", "Gift Received", "Borrowed"}
    all_cats -= income_cats

    categories = []
    for cat in sorted(all_cats):
        limit = budget_map.get(cat, 0)
        spent = spending_map.get(cat, 0)
        pct = round((spent / limit) * 100) if limit > 0 else 0
        status = "red" if (limit > 0 and spent > limit) else "yellow" if (limit > 0 and pct >= 80) else "green"
        categories.append(BudgetCategorySummary(
            category=cat, limit_amount=limit, spent=spent, pct=pct, status=status,
        ))

    total_pct = round((total_spent / total_budget) * 100) if total_budget > 0 else 0

    return BudgetSummaryResponse(
        month=month,
        total_budget=total_budget,
        total_spent=total_spent,
        total_pct=total_pct,
        categories=categories,
    )
