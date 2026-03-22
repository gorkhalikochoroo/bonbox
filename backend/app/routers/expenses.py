import uuid
from datetime import date, datetime

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
from app.services.cash_sync import sync_cash_out_for_expense, delete_cash_entry_by_ref, update_cash_entry_for_ref

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
        # No other category — clean up cash entries for cash expenses, then delete them
        cash_expenses = db.query(Expense).filter(
            Expense.category_id == cat.id,
            Expense.payment_method == "cash",
        ).all()
        for exp in cash_expenses:
            delete_cash_entry_by_ref(db, f"expense_{exp.id}", user.id)
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
    query = db.query(Expense).filter(Expense.user_id == user.id).filter(Expense.is_deleted.isnot(True))
    if from_date:
        query = query.filter(Expense.date >= from_date)
    if to_date:
        query = query.filter(Expense.date <= to_date)
    return query.order_by(Expense.date.desc(), Expense.created_at.desc()).all()


@router.get("/recently-deleted", response_model=list[ExpenseResponse])
def list_deleted_expenses(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    return db.query(Expense).filter(Expense.user_id == user.id, Expense.is_deleted == True).order_by(Expense.deleted_at.desc()).all()


@router.put("/{expense_id}/restore", response_model=ExpenseResponse)
def restore_expense(
    expense_id: uuid.UUID,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    expense = db.query(Expense).filter(Expense.id == expense_id, Expense.user_id == user.id, Expense.is_deleted == True).first()
    if not expense:
        raise HTTPException(status_code=404, detail="Deleted expense not found")
    expense.is_deleted = False
    expense.deleted_at = None
    if expense.payment_method == "cash" and not expense.is_personal:
        sync_cash_out_for_expense(db, expense)
    db.commit()
    db.refresh(expense)
    return expense


@router.delete("/{expense_id}/permanent", status_code=204)
def permanent_delete_expense(
    expense_id: uuid.UUID,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    expense = db.query(Expense).filter(Expense.id == expense_id, Expense.user_id == user.id, Expense.is_deleted == True).first()
    if not expense:
        raise HTTPException(status_code=404, detail="Deleted expense not found")
    db.delete(expense)
    db.commit()


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
    if expense.payment_method == "cash" and not expense.is_personal:
        sync_cash_out_for_expense(db, expense)
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
    old_method = expense.payment_method
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(expense, field, value)
    ref_id = f"expense_{expense.id}"
    if not expense.is_personal:
        if old_method == "cash" and expense.payment_method != "cash":
            delete_cash_entry_by_ref(db, ref_id, user.id)
        elif old_method != "cash" and expense.payment_method == "cash":
            sync_cash_out_for_expense(db, expense)
        elif expense.payment_method == "cash":
            update_cash_entry_for_ref(db, ref_id, user.id, amount=float(expense.amount), date=expense.date)
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
    if expense.payment_method == "cash" and not expense.is_personal:
        delete_cash_entry_by_ref(db, f"expense_{expense.id}", user.id)
    expense.is_deleted = True
    expense.deleted_at = datetime.utcnow()
    db.commit()
