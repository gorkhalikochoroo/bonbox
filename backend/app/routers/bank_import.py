"""Bank CSV Import — upload, preview, and confirm bank transactions."""
import uuid
from datetime import date as date_type, datetime

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.services.auth import get_current_user
from app.services.bank_csv_parser import parse_bank_csv, get_supported_banks
from app.services.cash_sync import sync_cash_in_for_sale, sync_cash_out_for_expense
from app.schemas.bank_import import (
    BankImportPreviewResponse,
    BankImportConfirmRequest,
    BankImportConfirmResponse,
)

# Reuse categorization from expenses router
from app.routers.expenses import suggest_category_for, learn_category

router = APIRouter()


# ── Supported banks ──────────────────────────────────────
@router.get("/formats")
def list_formats():
    """Return supported bank CSV formats."""
    return get_supported_banks()


# ── Preview (parse without saving) ───────────────────────
@router.post("/preview", response_model=BankImportPreviewResponse)
async def preview_csv(
    file: UploadFile = File(...),
    bank: str | None = Query(None, description="Override auto-detection"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a bank CSV and get a preview of detected transactions."""
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Please upload a .csv file")

    # Read file content (try multiple encodings)
    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:  # 5MB limit
        raise HTTPException(400, "File too large (max 5MB)")

    # Parse
    result = parse_bank_csv(raw, bank_format=bank)
    if not result["bank"]:
        raise HTTPException(
            400,
            "Could not detect bank format. Try selecting your bank manually.",
        )

    # Auto-categorize each transaction
    for txn in result["transactions"]:
        if txn["type"] == "expense":
            suggestion = suggest_category_for(txn["description"], user.id, db)
            if suggestion:
                txn["suggested_category"] = suggestion["category_name"]
                txn["confidence"] = suggestion["confidence"]
            else:
                txn["suggested_category"] = "Other"
                txn["confidence"] = 0.0
        else:
            txn["suggested_category"] = "Sales"
            txn["confidence"] = 1.0

    return result


# ── Confirm import ───────────────────────────────────────
@router.post("/confirm", response_model=BankImportConfirmResponse)
def confirm_import(
    body: BankImportConfirmRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Save confirmed transactions as Sales and Expenses."""
    imported = 0
    skipped = 0
    errors = []

    for txn in body.transactions:
        ref_id = f"bank_{body.bank}_{txn.ref_hash}"

        try:
            txn_date = date_type.fromisoformat(txn.date)
        except ValueError:
            errors.append(f"Invalid date: {txn.date}")
            continue

        if txn.type == "income":
            # Check duplicate
            exists = db.query(Sale.id).filter(
                Sale.user_id == user.id,
                Sale.reference_id == ref_id,
            ).first()
            if exists:
                skipped += 1
                continue

            sale = Sale(
                id=uuid.uuid4(),
                user_id=user.id,
                date=txn_date,
                amount=abs(txn.amount),
                payment_method=txn.payment_method,
                notes=txn.description,
                reference_id=ref_id,
                status="completed",
            )
            db.add(sale)
            db.flush()
            # Auto-sync to cashbook
            if txn.payment_method in ("cash", "mixed"):
                sync_cash_in_for_sale(db, sale)
            imported += 1

        elif txn.type == "expense":
            # Check duplicate
            exists = db.query(Expense.id).filter(
                Expense.user_id == user.id,
                Expense.reference_id == ref_id,
            ).first()
            if exists:
                skipped += 1
                continue

            # Resolve category
            cat_name = txn.category_name or "Other"
            category = db.query(ExpenseCategory).filter(
                ExpenseCategory.user_id == user.id,
                ExpenseCategory.name == cat_name,
            ).first()
            if not category:
                # Create category on the fly
                category = ExpenseCategory(
                    id=uuid.uuid4(),
                    user_id=user.id,
                    name=cat_name,
                )
                db.add(category)
                db.flush()

            expense = Expense(
                id=uuid.uuid4(),
                user_id=user.id,
                date=txn_date,
                amount=abs(txn.amount),
                description=txn.description,
                category_id=category.id,
                payment_method=txn.payment_method,
                reference_id=ref_id,
            )
            db.add(expense)
            db.flush()
            # Auto-sync to cashbook
            sync_cash_out_for_expense(db, expense, category_name=cat_name)
            # Learn this categorization for future
            learn_category(txn.description, cat_name, user.id, db)
            imported += 1

    db.commit()

    return BankImportConfirmResponse(
        imported=imported,
        skipped=skipped,
        errors=errors,
    )
