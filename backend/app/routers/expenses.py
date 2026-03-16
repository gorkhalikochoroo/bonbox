from datetime import date

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.expense import Expense, ExpenseCategory
from app.schemas.expense import (
    ExpenseCreate, ExpenseResponse,
    ExpenseCategoryCreate, ExpenseCategoryResponse,
)
from app.services.auth import get_current_user

router = APIRouter()


# --- Categories ---

@router.get("/categories", response_model=list[ExpenseCategoryResponse])
def list_categories(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return db.query(ExpenseCategory).filter(ExpenseCategory.user_id == user.id).all()


@router.post("/categories", response_model=ExpenseCategoryResponse, status_code=201)
def create_category(
    data: ExpenseCategoryCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    category = ExpenseCategory(user_id=user.id, **data.model_dump())
    db.add(category)
    db.commit()
    db.refresh(category)
    return category


# --- Expenses ---

@router.get("", response_model=list[ExpenseResponse])
def list_expenses(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(Expense).filter(Expense.user_id == user.id)
    if from_date:
        query = query.filter(Expense.date >= from_date)
    if to_date:
        query = query.filter(Expense.date <= to_date)
    return query.order_by(Expense.date.desc()).all()


@router.post("", response_model=ExpenseResponse, status_code=201)
def create_expense(
    data: ExpenseCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    expense = Expense(user_id=user.id, **data.model_dump())
    db.add(expense)
    db.commit()
    db.refresh(expense)
    return expense
