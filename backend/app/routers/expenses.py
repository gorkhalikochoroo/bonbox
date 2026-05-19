import re
import uuid
import tempfile
import logging
from datetime import date, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
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
from app.services.receipt_ocr import parse_expense_receipt
from app.services.billing import get_cap, effective_plan
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

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
    "wolt": "Food & Dining", "uber eats": "Food & Dining", "ubereats": "Food & Dining",
    "foodora": "Food & Dining", "too good to go": "Food & Dining",
    "just eat": "Food & Dining",  # legacy — Just Eat closed DK 2024
    "deliveroo": "Food & Dining",
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


# Multi-layer defense for the OCR endpoint:
#   L1 auth (get_current_user)
#   L2 input-size cap (8MB) — receipts are tiny, anything larger is abuse
#   L3 monthly tier cap — Free=30/mo, Starter+=unlimited
#   L4 best-effort OCR — never raises, returns confidence="none" if it fails
#   L5 tenant-scoped usage counter (Expense.receipt_photo set this month)
_RECEIPT_OCR_MAX_BYTES = 8 * 1024 * 1024  # 8MB


def _count_receipt_scans_this_month(db: Session, user_id) -> int:
    """Estimate this-month OCR usage by counting expenses whose
    receipt_photo was set this calendar month. Cheap proxy that doesn't
    need a separate usage table — every successful scan creates an
    expense row, so the count is roughly correct (we under-count by the
    number of scans the owner abandoned before saving, which is a
    user-friendly direction)."""
    first_of_month = date.today().replace(day=1)
    return (
        db.query(func.count(Expense.id))
        .filter(
            Expense.user_id == user_id,
            Expense.date >= first_of_month,
            Expense.receipt_photo.isnot(None),
            Expense.is_deleted.isnot(True),
        )
        .scalar()
        or 0
    )


@router.post("/parse-receipt", status_code=200)
async def parse_receipt(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Parse an uploaded expense receipt photo and return suggested
    vendor / amount / date / category.

    No DB write — pure parsing. The frontend pre-fills the expense
    create form with the result and the owner confirms before saving.
    The actual receipt_photo upload happens at /expenses POST when the
    owner submits, so failed/abandoned scans don't pollute storage.
    """
    # Tier cap
    cap = get_cap(user, "expense_receipt_scans_per_month")
    if cap >= 0:  # -1 means unlimited
        used = _count_receipt_scans_this_month(db, user.id)
        if used >= cap:
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "plan_required",
                    "feature": "expense_receipt_scans",
                    "required_plan": "starter",
                    "current_plan": effective_plan(user),
                    "used_this_month": used,
                    "monthly_cap": cap,
                    "message": (
                        f"You've used your {cap} receipt scans this month. "
                        "Upgrade to Starter for unlimited."
                    ),
                },
            )

    # Read + size-cap the upload before touching disk
    body = await file.read()
    if len(body) > _RECEIPT_OCR_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Receipt photo too large (max 8MB).",
        )
    if not body:
        raise HTTPException(status_code=400, detail="Empty upload.")

    # Write to a temp file so OCR services that need a file path work.
    # NamedTemporaryFile auto-deletes on close in the finally block.
    suffix = Path(file.filename or "").suffix.lower() or ".jpg"
    if suffix not in {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp"}:
        suffix = ".jpg"

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(body)
            tmp_path = tmp.name
        result = parse_expense_receipt(tmp_path)
    except Exception as e:  # noqa: BLE001 — OCR must never crash the API
        logger.warning("parse-receipt failed for user=%s: %s", user.id, e)
        result = {
            "vendor": None, "amount": None, "date": None, "currency": "DKK",
            "raw_text": "", "ocr_available": False, "confidence": "none",
        }
    finally:
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                pass

    # Best-effort category suggestion based on parsed vendor name
    suggested_category = None
    if result.get("vendor"):
        cat_hit = suggest_category_for(result["vendor"], user.id, db)
        if cat_hit:
            cat = (
                db.query(ExpenseCategory)
                .filter(
                    ExpenseCategory.user_id == user.id,
                    ExpenseCategory.name == cat_hit["category_name"],
                )
                .first()
            )
            if cat:
                suggested_category = {
                    "category_id": str(cat.id),
                    "category_name": cat_hit["category_name"],
                    "confidence": cat_hit["confidence"],
                }

    return {
        **result,
        "suggested_category": suggested_category,
        "usage": {
            "used_this_month": _count_receipt_scans_this_month(db, user.id),
            "monthly_cap": cap,
            "unlimited": cap == -1,
        },
    }


@router.post("", response_model=ExpenseResponse, status_code=201)
def create_expense(
    data: ExpenseCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    expense = Expense(user_id=user.id, **data.model_dump())
    # Allocate bilagsnummer (DK Bogføringsloven 2024). Year from expense.date
    # so back-dated entries land in the correct fiscal year sequence.
    try:
        from app.services.voucher_service import allocate_voucher
        expense.voucher_number = allocate_voucher(db, user.id, "expense", expense.date.year)
    except Exception:  # noqa: BLE001
        expense.voucher_number = None
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
    expense.deleted_at = utc_now()
    db.commit()


# ── Receipt OCR for Expenses ────────────────────────────
@router.post("/upload-receipt")
async def upload_expense_receipt(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Upload a receipt image and OCR-extract vendor + amount + date + category
    for expense creation.

    Defense layers:
      1. content_type must be image/*
      2. body capped at 5 MB
      3. PIL.verify() inside save_receipt_photo rejects non-images
         (raises ValueError → 400 here)
      4. Monthly tier cap — Free=30/mo, Starter+=unlimited

    May 2026 — was previously amount-only via extract_amount_from_image.
    Now also runs parse_expense_receipt to extract vendor name, date, and
    suggest a category, so the create-expense form can pre-fill three more
    fields. The owner still confirms before saving — OCR errors don't
    silently corrupt the books.
    """
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "Please upload an image file")
    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(400, "Image too large (max 5 MB)")

    # Tier cap — same monthly meter as /parse-receipt below
    cap = get_cap(user, "expense_receipt_scans_per_month")
    if cap >= 0:
        used = _count_receipt_scans_this_month(db, user.id)
        if used >= cap:
            raise HTTPException(
                status_code=402,
                detail={
                    "code": "plan_required",
                    "feature": "expense_receipt_scans",
                    "required_plan": "starter",
                    "current_plan": effective_plan(user),
                    "used_this_month": used,
                    "monthly_cap": cap,
                    "message": (
                        f"You've used your {cap} receipt scans this month. "
                        "Upgrade to Starter for unlimited."
                    ),
                },
            )

    from app.services.receipt_ocr import save_receipt_photo, extract_amount_from_image, parse_expense_receipt
    try:
        stored_path = save_receipt_photo(raw, file.filename, str(user.id), kind="expense")
    except ValueError as e:
        raise HTTPException(400, str(e))

    # OCR needs local file — find the most recent local match for this user
    import glob, os as _os
    local_files = sorted(
        glob.glob(f"uploads/receipts/{user.id}_*"),
        key=_os.path.getmtime,
        reverse=True,
    )
    local_path = local_files[0] if local_files else stored_path

    # Try the richer parse first (vendor + amount + date), fall back to
    # amount-only on any failure. Both wrap their internal exceptions —
    # OCR must NEVER crash the upload (owner already has the photo
    # saved; we just lose the auto-fill assist).
    parsed = {"vendor": None, "amount": None, "date": None, "currency": "DKK", "confidence": "none", "raw_text": ""}
    try:
        parsed = parse_expense_receipt(local_path)
    except Exception as e:  # noqa: BLE001
        logger.warning("upload-receipt: parse_expense_receipt failed user=%s: %s", user.id, e)

    # Fallback amount detection if parse_expense_receipt didn't get one
    try:
        amount_block = extract_amount_from_image(local_path)
    except Exception as e:  # noqa: BLE001
        logger.warning("upload-receipt: extract_amount_from_image failed user=%s: %s", user.id, e)
        amount_block = {"suggested_amount": None, "all_amounts_found": [], "ocr_available": False, "raw_text": ""}

    # Best amount = parse result if confident, else fall back to amount-only
    amount = parsed.get("amount") or amount_block.get("suggested_amount")

    # Best-effort category suggestion from the parsed vendor
    suggested_category = None
    if parsed.get("vendor"):
        cat_hit = suggest_category_for(parsed["vendor"], user.id, db)
        if cat_hit:
            cat = (
                db.query(ExpenseCategory)
                .filter(
                    ExpenseCategory.user_id == user.id,
                    ExpenseCategory.name == cat_hit["category_name"],
                )
                .first()
            )
            if cat:
                suggested_category = {
                    "category_id": str(cat.id),
                    "category_name": cat_hit["category_name"],
                    "confidence": cat_hit["confidence"],
                }

    return {
        "filepath": stored_path,
        "suggested_amount": amount,
        "suggested_vendor": parsed.get("vendor"),
        "suggested_date": parsed.get("date"),
        "suggested_currency": parsed.get("currency") or "DKK",
        "suggested_category": suggested_category,
        "all_amounts_found": amount_block.get("all_amounts_found", []),
        "ocr_available": parsed.get("ocr_available") or amount_block.get("ocr_available", False),
        "confidence": parsed.get("confidence", "low"),
        "raw_text": parsed.get("raw_text") or amount_block.get("raw_text", ""),
        "usage": {
            "used_this_month": _count_receipt_scans_this_month(db, user.id),
            "monthly_cap": cap,
            "unlimited": cap == -1,
        },
    }


@router.post("/from-receipt", response_model=ExpenseResponse, status_code=201)
def create_expense_from_receipt(
    data: ExpenseCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create an expense from a confirmed receipt scan."""
    expense = Expense(user_id=user.id, **data.model_dump())
    db.add(expense)
    db.commit()
    db.refresh(expense)
    if expense.payment_method == "cash" and not expense.is_personal:
        sync_cash_out_for_expense(db, expense)
        db.commit()
        db.refresh(expense)
    if expense.description and expense.category_id:
        cat = db.query(ExpenseCategory).filter(ExpenseCategory.id == expense.category_id).first()
        if cat:
            try:
                learn_category(expense.description, cat.name, user.id, db)
                db.commit()
            except Exception:
                db.rollback()
    return expense
