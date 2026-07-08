"""Bank CSV Import — upload, preview, and confirm bank transactions."""
import re
import uuid
from datetime import date as date_type, datetime

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from sqlalchemy.orm import Session

from app.database import get_db
from app.utils.client_ip import client_ip
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.services.auth import get_current_user
from app.services.bank_csv_parser import parse_bank_csv, get_supported_banks
from app.services.cash_sync import sync_cash_in_for_sale, sync_cash_out_for_expense
from app.services import bank_reconciliation
from app.services.billing import enforce_feature
from app.schemas.bank_import import (
    BankImportPreviewResponse,
    BankImportConfirmRequest,
    BankImportConfirmResponse,
    BankReconcileSuggestionsResponse,
    BankReconcileConfirmRequest,
    BankReconcileConfirmResponse,
    MatchSuggestion as MatchSuggestionSchema,
    TransactionWithSuggestions,
)

# Reuse categorization from expenses router
from app.routers.expenses import suggest_category_for, learn_category

router = APIRouter()

# Whitelist of acceptable characters in `import_id` path segments. The
# value is forwarded into a SQL LIKE prefix, so even though SQLAlchemy
# bind-params would prevent injection on its own, we belt-and-brace.
_IMPORT_ID_PATTERN = re.compile(r"^[a-z0-9_-]{1,32}$")


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

    # Lazy-import voucher allocator so bank import keeps working even if
    # voucher_service has issues. Multi-layer defense.
    try:
        from app.services.voucher_service import allocate_voucher
    except Exception:  # noqa: BLE001
        allocate_voucher = None

    def _allocate(kind: str, year: int) -> int | None:
        if not allocate_voucher:
            return None
        try:
            return allocate_voucher(db, user.id, kind, year)
        except Exception:  # noqa: BLE001
            return None

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
                voucher_number=_allocate("sale", txn_date.year),
            )
            db.add(sale)
            db.flush()
            # Auto-sync to cashbook
            if txn.payment_method in ("cash", "mixed"):
                sync_cash_in_for_sale(db, sale)
            # Auto-match incoming amount to an open faktura (Starter+ feature).
            # Tries to find one unambiguous open invoice with the same
            # total_gross within ±2 kr; flips it to paid if found. Never
            # raises — bank import is the source of truth.
            try:
                from app.services.payment_match_service import try_match_sale_to_invoice
                try_match_sale_to_invoice(db, sale)
            except Exception:
                # Defense-in-depth: even if the import fails, the sale is in.
                pass
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
                voucher_number=_allocate("expense", txn_date.year),
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


# ─── Reconciliation: list match suggestions ──────────────────────────
#
# After a CSV import populates Sale + Expense rows, Starter+ users get
# a value-add review screen: ranked candidates per bank transaction so
# they can mark fakturaer paid + link expenses in one bulk action.
# Free users get 402 plan_required and the UI shows UpgradeNudge.
#
# The `import_id` path segment is a flexible cursor:
#   • "latest" — surface all unmatched bank-imported rows in the
#                lookback window. Most common path from the UI.
#   • a bank id ("danske_bank", "nordea", ...) — scope to that bank
#                only. Useful when the owner imports from multiple
#                banks (Lunar for cards + Danske for the main account).

def _validate_import_id(import_id: str) -> str:
    """Reject anything that wouldn't fit the bank-id format. Defense
    layer 4 (input bounds) of the multi-layer model — even though the
    service layer also whitelists chars, we fail loud here so a bad
    client sees a clean 400 instead of an empty result."""
    if import_id == "latest":
        return import_id
    if not _IMPORT_ID_PATTERN.match(import_id):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "invalid_import_id",
                "message": "import_id must be 'latest' or a-z0-9_-",
            },
        )
    return import_id


@router.get("/{import_id}/suggestions", response_model=BankReconcileSuggestionsResponse)
def list_match_suggestions(
    import_id: str,
    lookback_days: int = Query(90, ge=7, le=366),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Surface ranked match suggestions for all unmatched bank-imported
    rows. Starter+. Returns suggestions but never mutates state.

    Tenant scope: every query inside match_transactions filters by
    user.id; the user is resolved server-side via auth. A client can
    pass any import_id (including one for another tenant's bank) and
    they will still see only their own rows.
    """
    # Layer 2 (tier) — Free users get 402 plan_required.
    enforce_feature(user, "bank_auto_reconcile")
    # Layer 4 (input bounds)
    import_id = _validate_import_id(import_id)

    rows = bank_reconciliation.match_transactions(
        db, user.id, import_id=import_id, lookback_days=lookback_days,
    )

    counts = {"high": 0, "medium": 0, "low": 0, "none": 0}
    txns_out: list[TransactionWithSuggestions] = []
    for r in rows:
        if not r.suggestions:
            counts["none"] += 1
        else:
            counts[r.suggestions[0].confidence] += 1
        txns_out.append(TransactionWithSuggestions(
            txn_id=r.txn_id,
            txn_type=r.txn_type,
            date=r.txn_date.isoformat(),
            amount=r.amount,
            description=r.description,
            already_matched=r.already_matched,
            suggestions=[
                MatchSuggestionSchema(
                    txn_id=s.txn_id,
                    txn_type=s.txn_type,
                    target_type=s.target_type,
                    target_id=s.target_id,
                    target_label=s.target_label,
                    confidence=s.confidence,
                    amount_diff=s.amount_diff,
                    days_diff=s.days_diff,
                    reason=s.reason,
                )
                for s in r.suggestions
            ],
        ))

    return BankReconcileSuggestionsResponse(
        import_id=import_id,
        transactions=txns_out,
        counts=counts,
    )


# ─── Reconciliation: bulk confirm matches ─────────────────────────────
#
# The owner reviews the suggestions and accepts any subset (often all
# high-confidence ones via the bulk button). Each confirmation flips an
# invoice to 'paid' or links a bank expense to a pre-recorded expense,
# and writes an audit_logs row.


@router.post("/{import_id}/confirm-matches", response_model=BankReconcileConfirmResponse)
def confirm_match_batch(
    import_id: str,
    body: BankReconcileConfirmRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Apply a batch of owner-confirmed matches.

    Defensive layers:
      1. auth      — get_current_user
      2. tier      — enforce_feature("bank_auto_reconcile") → 402
      3. tenant    — every txn/target re-fetched with user.id filter
      4. bounds    — body capped at 500 items via the Pydantic schema
      5. integrity — InvoiceService.mark_paid runs the state-machine
                     validation (status must be sent/overdue); idempotent
                     re-marking is a no-op
    """
    enforce_feature(user, "bank_auto_reconcile")
    _validate_import_id(import_id)

    ip = client_ip(request) if request else None
    result = bank_reconciliation.confirm_matches(
        db, user,
        matches=[m.model_dump() for m in body.matches],
        ip_address=ip,
    )
    db.commit()

    return BankReconcileConfirmResponse(
        confirmed=result["confirmed"],
        skipped=result["skipped"],
        errors=result["errors"],
    )
