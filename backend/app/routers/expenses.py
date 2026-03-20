from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.expense import Expense, ExpenseCategory
from app.schemas.expense import (
    ExpenseCreate, ExpenseUpdate, ExpenseResponse,
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
    # Prevent duplicates
    existing = db.query(ExpenseCategory).filter(
        ExpenseCategory.user_id == user.id,
        ExpenseCategory.name == data.name,
    ).first()
    if existing:
        return existing

    category = ExpenseCategory(user_id=user.id, **data.model_dump())
    db.add(category)
    db.commit()
    db.refresh(category)
    return category


@router.delete("/categories/{category_id}", status_code=204)
def delete_category(
    category_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cat = db.query(ExpenseCategory).filter(
        ExpenseCategory.id == category_id,
        ExpenseCategory.user_id == user.id,
    ).first()
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")

    # Find another category with same name to reassign expenses
    other = db.query(ExpenseCategory).filter(
        ExpenseCategory.user_id == user.id,
        ExpenseCategory.name == cat.name,
        ExpenseCategory.id != cat.id,
    ).first()

    if other:
        # Move expenses to the other category
        db.query(Expense).filter(Expense.category_id == cat.id).update(
            {"category_id": other.id}
        )
    else:
        # No other category — just delete the expenses too
        db.query(Expense).filter(Expense.category_id == cat.id).delete()

    db.delete(cat)
    db.commit()


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


@router.put("/{expense_id}", response_model=ExpenseResponse)
def update_expense(
    expense_id: str,
    data: ExpenseUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    expense = db.query(Expense).filter(Expense.id == expense_id, Expense.user_id == user.id).first()
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(expense, field, value)
    db.commit()
    db.refresh(expense)
    return expense


@router.delete("/{expense_id}", status_code=204)
def delete_expense(
    expense_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    expense = db.query(Expense).filter(Expense.id == expense_id, Expense.user_id == user.id).first()
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")
    db.delete(expense)
    db.commit()
