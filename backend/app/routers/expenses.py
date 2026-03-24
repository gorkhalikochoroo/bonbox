import re
import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models.user import User
from app.models.expense import Expense, ExpenseCategory
from app.models.category_mapping import CategoryMapping
from app.schemas.expense import (
    ExpenseCreate, ExpenseUpdate, ExpenseResponse,
    ExpenseCategoryCreate, ExpenseCategoryResponse,
)
from app.services.auth import get_current_user
from app.services.cash_sync import sync_cash_out_for_expense, delete_cash_entry_by_ref, update_cash_entry_for_ref

router = APIRouter()

# Default keyword map for Danish/international market
DEFAULT_KEYWORDS = {
    # Groceries / Ingredients
    "nemlig": "Ingredients", "netto": "Ingredients", "føtex": "Ingredients", "fotex": "Ingredients",
    "rema": "Ingredients", "aldi": "Ingredients", "lidl": "Ingredients", "irma": "Ingredients",
    "meny": "Ingredients", "bilka": "Ingredients", "coop": "Ingredients", "spar": "Ingredients",
    "fakta": "Ingredients", "grønt": "Ingredients", "torvehallerne": "Ingredients",
    "grøntsager": "Ingredients", "kød": "Ingredients", "fisk": "Ingredients",
    "biedronka": "Ingredients", "tesco": "Ingredients", "carrefour": "Ingredients",
    "tomatoes": "Ingredients", "chicken": "Ingredients", "meat": "Ingredients",
    "vegetables": "Ingredients", "flour": "Ingredients", "milk": "Ingredients",
    "ingredients": "Ingredients", "råvarer": "Ingredients",
    # Food & Dining
    "wolt": "Food & Dining", "just eat": "Food & Dining", "too good to go": "Food & Dining",
    "uber eats": "Food & Dining", "deliveroo": "Food & Dining",
    "restaurant": "Food & Dining", "café": "Food & Dining", "cafe": "Food & Dining",
    "pizza": "Food & Dining", "burger": "Food & Dining", "sushi": "Food & Dining",
    # Transport
    "rejsekort": "Transport", "dsb": "Transport", "metro": "Transport",
    "bus": "Transport", "taxi": "Transport", "uber": "Transport", "bolt": "Transport",
    "benzin": "Transport", "petrol": "Transport", "diesel": "Transport", "parkering": "Transport",
    "parking": "Transport", "flyv": "Transport", "flight": "Transport",
    # Utilities
    "el": "Utilities", "vand": "Utilities", "varme": "Utilities",
    "norlys": "Utilities", "ørsted": "Utilities", "orsted": "Utilities", "ewii": "Utilities",
    "radius": "Utilities", "electricity": "Utilities", "heating": "Utilities",
    "water": "Utilities", "gas": "Utilities", "internet": "Utilities", "wifi": "Utilities",
    # Rent
    "husleje": "Rent", "leje": "Rent", "rent": "Rent", "lease": "Rent",
    # Wages / Salary
    "løn": "Wages", "salary": "Wages", "wage": "Wages", "personale": "Wages",
    "staff": "Wages", "medarbejder": "Wages",
    # Insurance
    "forsikring": "Insurance", "tryg": "Insurance", "topdanmark": "Insurance",
    "alm brand": "Insurance", "insurance": "Insurance",
    # Subscriptions
    "netflix": "Subscriptions", "spotify": "Subscriptions", "apple": "Subscriptions",
    "google": "Subscriptions", "microsoft": "Subscriptions", "adobe": "Subscriptions",
    "abonnement": "Subscriptions", "subscription": "Subscriptions",
    # Equipment
    "maskine": "Equipment", "machine": "Equipment", "computer": "Equipment",
    "printer": "Equipment", "equipment": "Equipment", "udstyr": "Equipment",
    # Supplies
    "rengøring": "Supplies", "cleaning": "Supplies", "papir": "Supplies",
    "paper": "Supplies", "supplies": "Supplies", "emballage": "Supplies", "packaging": "Supplies",
    # Marketing
    "reklame": "Marketing", "facebook ads": "Marketing", "google ads": "Marketing",
    "marketing": "Marketing", "annonce": "Marketing", "flyer": "Marketing",
}


# --- Auto-Categorization ---

def extract_keywords(text: str) -> list[str]:
    """Extract meaningful keywords from description, strip numbers and short words."""
    text = text.lower().strip()
    # Remove numbers and currency
    text = re.sub(r"[\d.,]+\s*(kr|dkk|eur|usd|nok|sek|gbp|npr|inr)?", "", text)
    words = text.split()
    # Return individual words and bigrams for multi-word matches
    keywords = [w for w in words if len(w) >= 2]
    bigrams = [f"{words[i]} {words[i+1]}" for i in range(len(words) - 1)]
    return keywords + bigrams


def suggest_category_for(description: str, user_id, db: Session) -> dict | None:
    """Suggest a category based on user history and default keywords."""
    keywords = extract_keywords(description)
    if not keywords:
        return None

    # 1. Check user-specific mappings first (highest priority)
    for kw in keywords:
        mapping = (
            db.query(CategoryMapping)
            .filter(CategoryMapping.user_id == user_id, CategoryMapping.keyword == kw)
            .order_by(CategoryMapping.usage_count.desc())
            .first()
        )
        if mapping:
            return {"category_name": mapping.category_name, "confidence": 0.9, "source": "history"}

    # 2. Check global/default keyword map
    for kw in keywords:
        if kw in DEFAULT_KEYWORDS:
            return {"category_name": DEFAULT_KEYWORDS[kw], "confidence": 0.7, "source": "default"}

    # 3. Check user's most recent expense with similar description
    for kw in keywords:
        if len(kw) < 3:
            continue
        recent = (
            db.query(Expense, ExpenseCategory.name)
            .join(ExpenseCategory, Expense.category_id == ExpenseCategory.id)
            .filter(
                Expense.user_id == user_id,
                Expense.description.ilike(f"%{kw}%"),
                Expense.is_deleted.isnot(True),
            )
            .order_by(Expense.created_at.desc())
            .first()
        )
        if recent:
            return {"category_name": recent[1], "confidence": 0.6, "source": "similar"}

    return None


def learn_category(description: str, category_name: str, user_id, db: Session):
    """Update category mappings when user confirms/selects a category."""
    keywords = extract_keywords(description)
    for kw in keywords:
        if len(kw) < 3:
            continue
        existing = db.query(CategoryMapping).filter(
            CategoryMapping.user_id == user_id,
            CategoryMapping.keyword == kw,
            CategoryMapping.category_name == category_name,
        ).first()
        if existing:
            existing.usage_count += 1
        else:
            db.add(CategoryMapping(
                user_id=user_id,
                keyword=kw,
                category_name=category_name,
            ))


@router.get("/suggest-category")
def suggest_category(
    q: str = Query("", description="Expense description to suggest category for"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not q.strip():
        return {"suggestion": None}
    result = suggest_category_for(q, user.id, db)
    if result:
        # Find the category ID for this user
        cat = db.query(ExpenseCategory).filter(
            ExpenseCategory.user_id == user.id,
            ExpenseCategory.name == result["category_name"],
        ).first()
        if cat:
            return {
                "suggestion": {
                    "category_id": str(cat.id),
                    "category_name": result["category_name"],
                    "confidence": result["confidence"],
                    "source": result["source"],
                }
            }
    return {"suggestion": None}


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
    is_personal: bool = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(Expense).filter(Expense.user_id == user.id).filter(Expense.is_deleted.isnot(True))
    if is_personal is not None:
        query = query.filter(Expense.is_personal == is_personal)
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
    # Auto-learn: map description keywords to selected category
    if expense.description and expense.category_id:
        cat = db.query(ExpenseCategory).filter(ExpenseCategory.id == expense.category_id).first()
        if cat:
            try:
                learn_category(expense.description, cat.name, user.id, db)
                db.commit()
            except Exception:
                db.rollback()
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
