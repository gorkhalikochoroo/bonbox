import re
import uuid
import tempfile
import logging
from datetime import date, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip

# Per-IP rate limiter for OCR endpoints below. slowapi attaches itself
# to the FastAPI app via main.py app.state.limiter wiring; this module-
# local Limiter is just the decorator-target. key_func = remote_address
# so the limits apply per IP, not per user — defends against same-IP
# multi-account abuse (one machine creating 10 free accounts and
# round-robining OCR calls to drain cost).
_limiter = Limiter(key_func=client_ip)

from app.database import get_db
from app.models.user import User
from app.models.expense import Expense, ExpenseCategory
from app.services.vendor_identity import canonical_vendor_key, display_name_for
from app.services.vendor_memory import recall as vendor_recall, record_signal
from app.services.category_match import resolve_category, preferred_name_for
from app.services.expense_dedup import fingerprint as dedup_fingerprint, find_recent_replay
from app.models.category_mapping import CategoryMapping
from app.schemas.expense import (
    ExpenseCreate, ExpenseUpdate, ExpenseResponse,
    ExpenseCategoryCreate, ExpenseCategoryResponse, ExpenseApproveBatch,
)
from app.services.auth import get_current_user
from app.services.cash_sync import sync_cash_out_for_expense, delete_cash_entry_by_ref, update_cash_entry_for_ref
from app.services.expense_status import not_pending
from app.services.receipt_ocr import parse_expense_receipt
from app.services.billing import get_cap, effective_plan
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

# Categories the SERVER may choose on the owner's behalf. Never learned:
# replaying our own fallback as "what you usually do here" would be a
# claim about the owner that the owner never made.
_UNLEARNABLE_CATEGORIES = {"Andet", "Ukategoriseret"}

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
        cat = resolve_category(result["category_name"], user.id, db)
        if cat:
            return {
                "suggestion": {
                    "category_id": str(cat.id),
                    "category_name": cat.name,
                    "confidence": result["confidence"],
                    "source": result["source"],
                }
            }
        return {
            "suggestion": {
                "category_id": None,
                "category_name": preferred_name_for(result["category_name"]),
                "confidence": result["confidence"],
                "source": result["source"],
                "needs_create": True,
            }
        }
    return {"suggestion": None}


# --- Categories ---

@router.get("/categories", response_model=list[ExpenseCategoryResponse])
def list_categories(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Lazily ensure the three §42-limited DK categories exist (Restaurantbesøg
    # /Hotel/Repræsentation) so the owner can tag meals + gifts at their correct
    # Momsloven §42 fradrag — without them the reduction can never fire and
    # købsmoms is over-claimed at 100%. Additive + forward-only; idempotent.
    from app.services.expense_categories import ensure_fradrag_categories
    ensure_fradrag_categories(db, user.id)
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
        # NEVER hard-delete filed bilag (Bogføringsloven §10) — that silently
        # loses receipts that feed §42 fradrag + the P&L. Move any orphaned
        # expenses to an "Andet" fallback category (get-or-create) so they stay
        # recoverable, exactly like the same-name-sibling branch above.
        fallback = db.query(ExpenseCategory).filter(
            ExpenseCategory.user_id == user.id,
            ExpenseCategory.name == "Andet",
            ExpenseCategory.id != cat.id,
        ).first()
        if not fallback:
            fallback = ExpenseCategory(user_id=user.id, name="Andet")
            db.add(fallback)
            db.flush()
        db.query(Expense).filter(Expense.category_id == cat.id).update(
            {"category_id": fallback.id}
        )

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
    # Default list shows only posted (approved) expenses — unapproved Godkend-kø
    # drafts are fetched separately by the queue, never mixed into the books.
    query = db.query(Expense).filter(Expense.user_id == user.id).filter(Expense.is_deleted.isnot(True)).filter(not_pending())
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
    user-friendly direction).

    receipt_source == 'attach' rows are EXCLUDED: those are bilag stapled
    onto an existing expense via /{id}/attach-receipt, which runs no OCR.
    Counting them would let the compliant act of attaching evidence silently
    drain the owner's scan cap (Free=10/mo). NULL still counts (legacy +
    scan-created rows), so existing behaviour is unchanged."""
    first_of_month = date.today().replace(day=1)
    return (
        db.query(func.count(Expense.id))
        .filter(
            Expense.user_id == user_id,
            Expense.date >= first_of_month,
            Expense.receipt_photo.isnot(None),
            func.coalesce(Expense.receipt_source, "") != "attach",
            Expense.is_deleted.isnot(True),
        )
        .scalar()
        or 0
    )


@router.post("/parse-receipt", status_code=200)
# Per-IP rate limit added 2026-05-28 with the Opus 4.7 OCR upgrade
# (~5x Sonnet cost). Was previously unrate-limited — gap that let one
# IP across multiple accounts drain API spend. 6/min ceiling matches
# legitimate OCR latency (Opus ~10-15s/call); 80/day is the slow-and-
# steady defense. Per-USER monthly cap (PLAN_CAPS) enforces the tier
# limit independently below.
@_limiter.limit("6/minute;80/day")
async def parse_receipt(
    request: Request,
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
                        "Upgrade to Starter for 200 / month."
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
            cat = resolve_category(cat_hit["category_name"], user.id, db)
            if cat:
                suggested_category = {
                    "category_id": str(cat.id),
                    "category_name": cat.name,
                    "confidence": cat_hit["confidence"],
                }
            else:
                suggested_category = {
                    "category_id": None,
                    "category_name": preferred_name_for(cat_hit["category_name"]),
                    "confidence": cat_hit["confidence"],
                    "needs_create": True,
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
    payload = data.model_dump()

    # ── L2 — Category resolution + tenant check ───────────────────────
    # A submitted category must belong to THIS user — an id from another
    # tenant would otherwise be persisted verbatim and leak that tenant's
    # category name into this owner's reports.
    #
    # An OMITTED category is not an error: the receipt-scan flow can't
    # always guess one, and losing a scanned expense (real amount, real
    # photo, real MOMS) because the guess missed is the worse outcome.
    # Those land in "Andet" (get-or-create), visible and re-categorisable
    # from the list.
    cat_id = payload.get("category_id")
    # Remember whether the OWNER chose this, before the fallback below
    # may substitute one. Only an owner-chosen category is evidence.
    submitted_category_id = cat_id
    if cat_id is not None:
        owned = (
            db.query(ExpenseCategory)
            .filter(ExpenseCategory.id == cat_id, ExpenseCategory.user_id == user.id)
            .first()
        )
        if not owned:
            raise HTTPException(status_code=404, detail="Expense category not found")
    else:
        fallback = (
            db.query(ExpenseCategory)
            .filter(
                ExpenseCategory.user_id == user.id,
                ExpenseCategory.name == "Andet",
            )
            .first()
        )
        if not fallback:
            fallback = ExpenseCategory(user_id=user.id, name="Andet")
            db.add(fallback)
            db.flush()
        payload["category_id"] = fallback.id

    # ── L2 — Foreign-currency validation (Bogføringsloven §10) ─────────
    # `amount` is the DKK-equivalent (account currency) figure that all
    # downstream MOMS / dashboard / bilag logic consumes — keeping it
    # there is non-negotiable. The three FX fields are an audit trail.
    # Enforce the all-or-nothing rule so we never persist a half-filled
    # foreign-currency row that the revisor can't reconcile.
    account_ccy = (user.currency or "DKK").upper()
    submitted_ccy = (payload.get("currency") or "").upper() or None
    fx_rate = payload.get("fx_rate")
    original_amount = payload.get("original_amount")

    is_foreign = bool(submitted_ccy) and submitted_ccy != account_ccy
    if is_foreign:
        # When the user explicitly logged a foreign-currency expense
        # we require BOTH the original amount and the FX rate.
        if fx_rate is None or original_amount is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Foreign-currency expense requires both fx_rate and "
                    "original_amount (Bogføringsloven §10 cross-border)."
                ),
            )
    else:
        # Same-currency or null-currency entry — strip the FX trail so
        # the row stays clean. Keeping `currency` null preserves the
        # backward-compat semantics for every existing report path.
        payload["currency"] = None
        payload["fx_rate"] = None
        payload["original_amount"] = None

    # Canonical supplier key — set ONCE here, never re-derived later, so a
    # later description edit can't silently re-point the row at a different
    # vendor. `vendor_hint` is the OCR's raw vendor line when the row came
    # from a scan; typed rows fall back to the description.
    # An explicitly-sent vendor_hint is authoritative — including "" for
    # "this scan identified no supplier". Only the manual/typed path,
    # which sends no hint at all, falls back to the description.
    hint = payload.pop("vendor_hint", None)
    vendor_raw = hint if "vendor_hint" in data.model_fields_set else (hint or payload.get("description"))
    payload.pop("autofill", None)  # client-side provenance, not a column
    vendor_key = canonical_vendor_key(vendor_raw)
    vendor_display = display_name_for(vendor_raw, vendor_key)

    # ── Replay guard ─────────────────────────────────────────────────
    # An identical payload arriving seconds after the first is one intent
    # delivered twice — a retried POST whose response was lost, or a
    # second tap during a slow save. Return the row we already made
    # rather than booking the cost twice and double-claiming its MOMS.
    #
    # Fingerprint covers everything the owner could have changed, so a
    # genuinely different expense can never collide. `allow_duplicate`
    # is the owner's explicit "no, I really did buy that twice".
    allow_dup = payload.pop("allow_duplicate", False)
    # vat_source is SERVER-stamped, never client-supplied: a figure is
    # only "from the receipt" if it arrived with the scan. Letting the
    # client assert its own provenance would make the cross-check
    # meaningless.
    payload["vat_source"] = "receipt" if payload.get("vat_amount") is not None else None
    fp = dedup_fingerprint(
        user_id=user.id,
        amount=payload.get("amount"),
        date=payload.get("date"),
        description=payload.get("description"),
        payment_method=payload.get("payment_method"),
        category_id=payload.get("category_id"),
    )
    if not allow_dup:
        prior = find_recent_replay(db, user.id, fp)
        if prior is not None:
            logger.info(
                "expense replay collapsed user=%s expense=%s", user.id, prior.id
            )
            return prior

    expense = Expense(
        user_id=user.id, vendor_key=vendor_key, dedup_fingerprint=fp, **payload
    )
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

    # ── Per-vendor memory ─────────────────────────────────────────────
    # What the owner actually saved is the ground truth for this vendor.
    # A pre-save OVERRIDE is a correction, not a confirmation: the client
    # tells us what we proposed via `autofill`, and recording an override
    # as agreement is precisely how a streak gets poisoned into
    # auto-filling a value the owner keeps changing.
    # Only ASSERTED values are evidence. A field the client never sent is
    # not a decision — ExpenseCreate.payment_method no longer defaults to
    # "card" precisely so an unsent method also isn't STORED as one, but
    # the assertion check stays: a caller may send a method it inferred
    # rather than asked for. Counting that would let the app later say
    # "kort — som de sidste 3 gange hos Netto" about a choice the owner
    # never made, and accepting that prefill on a cash receipt skips the
    # cash-out sync and overstates kassebeholdning. Same for the "Andet"
    # category: we pick that so a scan isn't lost, so it is our fallback,
    # not a habit.
    if expense.vendor_key:
        proposed = data.autofill or {}
        method_asserted = "payment_method" in data.model_fields_set
        category_asserted = submitted_category_id is not None
        try:
            if expense.payment_method and method_asserted:
                prior = proposed.get("payment_method")
                changed = bool(prior) and prior != expense.payment_method
                record_signal(
                    db, user.id, expense.vendor_key, "payment_method",
                    expense.payment_method,
                    kind="correction" if changed else "confirm",
                    previous_value=prior if changed else None,
                    display_name=vendor_display,
                )
            cat_row = db.query(ExpenseCategory).filter(
                ExpenseCategory.id == expense.category_id
            ).first() if category_asserted else None
            if cat_row and cat_row.name not in _UNLEARNABLE_CATEGORIES:
                prior_cat = proposed.get("category_name")
                changed_cat = bool(prior_cat) and prior_cat != cat_row.name
                record_signal(
                    db, user.id, expense.vendor_key, "category_name", cat_row.name,
                    kind="correction" if changed_cat else "confirm",
                    previous_value=prior_cat if changed_cat else None,
                    display_name=vendor_display,
                )
            db.commit()
        except Exception:  # noqa: BLE001 — memory must never break a save
            logger.warning("vendor memory write failed on create", exc_info=True)
            db.rollback()

    # ── L7 — Audit row for foreign-currency entries ────────────────────
    # The DKK figure (`amount`) is what bookkeeping sees; the original
    # currency, rate, and raw foreign amount get captured into the
    # immutable audit log so even if the row is later edited/deleted the
    # original cross-border record survives for Bogføringsloven §9.
    # Defensive — audit failures NEVER block the create path.
    if is_foreign:
        try:
            from app.services.audit_service import record as audit_record
            audit_record(
                db,
                user,
                "expense.created_foreign_currency",
                "expense",
                entity_id=expense.id,
                after={
                    "expense_id": str(expense.id),
                    "account_currency": account_ccy,
                    "original_currency": submitted_ccy,
                    "original_amount": float(original_amount),
                    "fx_rate": float(fx_rate),
                    "amount_account_ccy": float(expense.amount),
                    "date": expense.date.isoformat(),
                    "voucher_number": expense.voucher_number,
                },
            )
            db.commit()
        except Exception:  # noqa: BLE001 — audit write must never break create
            logger.exception("audit.expense.created_foreign_currency failed")

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
    old_category_id = expense.category_id
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

    # ── The correction loop ───────────────────────────────────────────
    # Re-categorising or re-paying an expense is the owner telling us we
    # were wrong. Nothing listened here before: learn_category was never
    # called from this path, so a wrong mapping kept its usage_count and
    # the right answer was never learned from an edit.
    #
    # Runs AFTER the commit above, in its own transaction, so a learning
    # failure can never roll back or 500 the owner's actual edit.
    #
    # Keyed on the STORED expense.vendor_key, never re-derived from the
    # (owner-editable) description — a correction has to land on the same
    # key that produced the suggestion, or we teach a name that never
    # made the guess.
    # A PENDING draft is not a decision yet. The Godkend-kø answers a
    # missing method and then approves — two HTTP calls for one owner
    # decision — and _promote_to_approved records it at approval. Writing
    # here too would mint two agreements for one tap and inflate the very
    # count the app quotes back ("som de sidste N gange").
    if expense.vendor_key and expense.status != "pending":
        try:
            if expense.payment_method and expense.payment_method != old_method:
                # Filling a BLANK field is an answer, not a disagreement.
                # record_signal resets streak to 1 on a correction, so
                # calling every change a correction meant each pile answer
                # wiped the streak and BAND_PREFILL (agree>=3 AND
                # streak>=3) was unreachable through the pile — the
                # "second time it already knows" claim could never fire.
                # create_expense already guards this with `bool(prior)`.
                corrected = bool(old_method)
                record_signal(
                    db, user.id, expense.vendor_key, "payment_method",
                    expense.payment_method,
                    kind="correction" if corrected else "confirm",
                    previous_value=old_method if corrected else None,
                )
            if expense.category_id != old_category_id:
                new_cat = db.query(ExpenseCategory).filter(
                    ExpenseCategory.id == expense.category_id
                ).first()
                old_cat = db.query(ExpenseCategory).filter(
                    ExpenseCategory.id == old_category_id
                ).first() if old_category_id else None
                if new_cat and new_cat.name not in _UNLEARNABLE_CATEGORIES:
                    # Moving off a placeholder the SERVER chose
                    # ("Ukategoriseret" / "Andet") is likewise an answer —
                    # the owner never picked the thing being replaced.
                    prior_name = (
                        old_cat.name
                        if old_cat and old_cat.name not in _UNLEARNABLE_CATEGORIES
                        else None
                    )
                    record_signal(
                        db, user.id, expense.vendor_key, "category_name", new_cat.name,
                        kind="correction" if prior_name else "confirm",
                        previous_value=prior_name,
                    )
            db.commit()
        except Exception:  # noqa: BLE001 — learning must never break an edit
            logger.warning("vendor memory write failed on update", exc_info=True)
            db.rollback()

    return expense


@router.post("/{expense_id}/attach-receipt", response_model=ExpenseResponse)
# Cheaper than /upload-receipt (no OCR call), so a slightly higher ceiling —
# still bounded per-IP against image-spam abuse.
@_limiter.limit("12/minute;120/day")
async def attach_receipt_to_expense(
    expense_id: str,
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Attach a receipt image to an EXISTING expense — NO OCR, NO scan-cap.

    Backs the one-tap "Mangler bilag" flow on the Expenses list: the owner
    already typed the amount + category, they just need to staple the legal
    bilag so the MOMS-fradrag is defensible under Bogføringsloven. So we
    only STORE the image and set receipt_photo — we deliberately do NOT run
    OCR (the figures are already entered and owner-confirmed) and do NOT
    consume an `expense_receipt_scans` credit (attaching evidence to a row
    you already entered is not a scan; metering it would punish the owner
    for doing the compliant thing, or lock them out of real scanning).

    Multi-barrier:
      1. auth        — get_current_user
      2. tenant      — row must belong to this user (404 otherwise)
      3. bounds      — content_type image/*, body ≤ 5 MB, PIL.verify()
                       inside save_receipt_photo rejects non-images
      4. rate-limit  — per-IP burst + daily ceiling
      5. audit       — expense.receipt_attached row (best-effort)
      6. honest      — returns the updated row; the list re-reads source
    """
    expense = (
        db.query(Expense)
        .filter(Expense.id == expense_id, Expense.user_id == user.id)
        .first()
    )
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")

    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(400, "Please upload an image file")
    raw = await file.read()
    if len(raw) > 5 * 1024 * 1024:
        raise HTTPException(400, "Image too large (max 5 MB)")

    from app.services.receipt_ocr import save_receipt_photo
    try:
        stored_path = save_receipt_photo(raw, file.filename, str(user.id), kind="expense")
    except ValueError as e:
        raise HTTPException(400, str(e))

    expense.receipt_photo = stored_path
    # Mark as a manual attach so the scan-cap meter excludes it (no OCR ran).
    expense.receipt_source = "attach"
    db.commit()
    db.refresh(expense)

    # Evidence-attachment audit trail (best-effort — never blocks the
    # attach; the photo is already stored + linked above).
    try:
        from app.services.audit_service import record as audit_record
        audit_record(
            db,
            user,
            "expense.receipt_attached",
            "expense",
            entity_id=expense.id,
            after={
                "expense_id": str(expense.id),
                "receipt_photo": stored_path,
                "amount": float(expense.amount),
                "date": expense.date.isoformat() if expense.date else None,
            },
        )
        db.commit()
    except Exception:  # noqa: BLE001 — audit write must never break attach
        logger.exception("audit.expense.receipt_attached failed")

    return expense


# ── Godkend-kø (approve queue) ──────────────────────────────────────
def _promote_to_approved(db: Session, user: User, expense: Expense, *, kind: str = "confirm") -> None:
    """Flip a pending draft → approved — the moment it becomes a real booked
    expense. Allocate the bilagsnummer NOW (not at draft, so abandoned drafts
    never burn the Bogføringsloven §10 voucher sequence), cash-sync, learn the
    category, and write the L7 audit row. Caller commits. Every side-effect is
    failure-isolated so a hiccup never blocks the approval itself."""
    if expense.voucher_number is None:
        try:
            from app.services.voucher_service import allocate_voucher
            expense.voucher_number = allocate_voucher(db, user.id, "expense", expense.date.year)
        except Exception:  # noqa: BLE001
            expense.voucher_number = None
    expense.status = "approved"
    if expense.payment_method == "cash" and not expense.is_personal:
        try:
            sync_cash_out_for_expense(db, expense)
        except Exception:  # noqa: BLE001
            logger.warning("approve: cash sync failed for expense=%s", expense.id)
    cat = None
    if expense.category_id:
        cat = db.query(ExpenseCategory).filter(ExpenseCategory.id == expense.category_id).first()
    if expense.description and cat:
        try:
            learn_category(expense.description, cat.name, user.id, db)
        except Exception:  # noqa: BLE001
            pass

    # Per-vendor memory. `kind` is the honesty hinge: a single Godkend is
    # the owner looking at one draft and agreeing, but one tap on
    # "Godkend alle 8" is NOT eight agreements. record_signal drops
    # kind="batch" entirely — otherwise auto-fill validates itself:
    # memory fills a draft, the sweep approves it unread, that mints
    # evidence, and memory fills more confidently next time.
    if expense.vendor_key:
        try:
            if expense.payment_method:
                record_signal(
                    db, user.id, expense.vendor_key, "payment_method",
                    expense.payment_method, kind=kind,
                )
            if cat and cat.name not in _UNLEARNABLE_CATEGORIES:
                record_signal(
                    db, user.id, expense.vendor_key, "category_name",
                    cat.name, kind=kind,
                )
        except Exception:  # noqa: BLE001 — learning must never block approval
            logger.warning("approve: vendor memory write failed for expense=%s", expense.id)
    try:
        from app.services.audit_service import record as audit_record
        audit_record(
            db, user, "expense.approved", "expense", entity_id=expense.id,
            after={
                "expense_id": str(expense.id),
                "amount": float(expense.amount),
                "voucher_number": expense.voucher_number,
                "date": expense.date.isoformat() if expense.date else None,
            },
        )
    except Exception:  # noqa: BLE001
        logger.warning("approve: audit failed for expense=%s", expense.id)


@router.get("/moms-conflicts")
def moms_conflicts(
    start: date | None = Query(None),
    end: date | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Expenses where the receipt's printed MOMS disagrees with the
    figure the filing derives.

    Read-only and advisory. It resolves nothing: which number is right
    is a decision for the owner and their revisor, and the filing basis
    does not change because this endpoint says so. Surfacing the
    disagreement IS the value — an over-claim the owner never sees is
    the one SKAT finds.
    """
    from app.services.moms_crosscheck import (
        find_conflicts, summarise, TOLERANCE_KR,
    )

    conflicts = find_conflicts(db, user.id, start, end)
    return {
        **summarise(conflicts),
        "tolerance_kr": TOLERANCE_KR,
        "conflicts": [
            {
                "expense_id": c.expense_id,
                "date": c.date.isoformat(),
                "description": c.description,
                "category_name": c.category_name,
                "amount": c.amount,
                "printed_vat": c.printed_vat,
                "derived_vat": c.derived_vat,
                "difference": c.difference,
                "over_claiming": c.over_claiming,
            }
            for c in conflicts
        ],
    }


@router.get("/pending", response_model=list[ExpenseResponse])
def list_pending(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The Godkend-kø: AI-proposed drafts awaiting the owner's approval. Drafts
    are excluded from every money total (not_pending gate) until approved."""
    return (
        db.query(Expense)
        .filter(Expense.user_id == user.id, Expense.is_deleted.isnot(True), Expense.status == "pending")
        .order_by(Expense.created_at.desc())
        .all()
    )


@router.post("/{expense_id}/approve", response_model=ExpenseResponse)
def approve_expense(
    expense_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Approve one draft → it becomes a real booked expense (enters MOMS /
    Foresight / reports). A draft with no confident beløb CANNOT be approved —
    it stays in the kø (AI proposes, owner approves; never a silent 0-kr row)."""
    expense = (
        db.query(Expense)
        .filter(Expense.id == expense_id, Expense.user_id == user.id, Expense.is_deleted.isnot(True))
        .first()
    )
    if not expense:
        raise HTTPException(status_code=404, detail="Expense not found")
    if expense.status != "pending":
        return expense  # idempotent — already approved
    if not expense.amount or float(expense.amount) <= 0:
        raise HTTPException(status_code=422, detail="Udkast mangler beløb og kan ikke godkendes")
    # Same rule for the payment method. Approving without one books the
    # row at the model default and silently skips the cash-out sync, so
    # a cash purchase would vanish from kassebeholdning.
    if not expense.payment_method:
        raise HTTPException(status_code=422, detail="Udkast mangler betalingsmåde og kan ikke godkendes")
    _promote_to_approved(db, user, expense)
    db.commit()
    db.refresh(expense)
    return expense


@router.post("/approve-batch")
def approve_batch(
    data: ExpenseApproveBatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Bulk-approve the 'klar' drafts the owner tapped. Owned + pending only;
    drafts missing a beløb are skipped (never silently posted as 0 kr)."""
    rows = (
        db.query(Expense)
        .filter(
            Expense.id.in_(data.ids), Expense.user_id == user.id,
            Expense.is_deleted.isnot(True), Expense.status == "pending",
        )
        .all()
    )
    approved, skipped = [], []
    skipped_no_amount, skipped_no_method = [], []
    for e in rows:
        if not e.amount or float(e.amount) <= 0:
            skipped.append(str(e.id))
            skipped_no_amount.append(str(e.id))
            continue
        if not e.payment_method:
            skipped.append(str(e.id))
            skipped_no_method.append(str(e.id))
            continue
        _promote_to_approved(db, user, e, kind="batch")
        approved.append(str(e.id))
    db.commit()
    # `skipped` stays the union for back-compat; the split lets the queue
    # tell the owner WHAT is missing instead of silently doing less than
    # the button promised.
    return {
        "approved": approved, "skipped": skipped, "count": len(approved),
        "skipped_no_amount": skipped_no_amount,
        "skipped_no_method": skipped_no_method,
    }


def _get_or_create_uncategorized(db: Session, user_id):
    """Honest catch-all so a draft always has a category (NOT NULL). Owner/queue
    re-tags it before approving. Created lazily, idempotent by name."""
    cat = (
        db.query(ExpenseCategory)
        .filter(ExpenseCategory.user_id == user_id, ExpenseCategory.name == "Ukategoriseret")
        .first()
    )
    if not cat:
        cat = ExpenseCategory(user_id=user_id, name="Ukategoriseret", color="#9ca3af")
        db.add(cat)
        db.flush()
    return cat


@router.post("/burst-scan")
# Burst is heavier (N Opus OCR calls) — bound it harder per-IP than single scan.
@_limiter.limit("3/minute;40/day")
async def burst_scan(
    request: Request,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Snap-a-pile (Godkend-kø S3): OCR each receipt and drop it into the queue
    as a DRAFT with its bilag attached — never a posted row until the owner taps
    Godkend. Empties the drawer in one ceremony. Honest on the monthly scan cap:
    processes up to the limit, then returns cap_reached so the UI can say
    'X af Y brugt' instead of silently truncating. OCR failure never blocks the
    draft — it lands with amount 0 ('Mangler beløb') for the owner to fix."""
    from app.services.receipt_ocr import save_receipt_photo_ex, parse_expense_receipt

    cap = get_cap(user, "expense_receipt_scans_per_month")
    used = _count_receipt_scans_this_month(db, user.id) if cap >= 0 else 0

    created, skipped, cap_reached = [], 0, False
    for f in files:
        if cap >= 0 and (used + len(created)) >= cap:
            cap_reached = True
            break
        if not f.content_type or not f.content_type.startswith("image/"):
            skipped += 1
            continue
        raw = await f.read()
        if len(raw) > 5 * 1024 * 1024:
            skipped += 1
            continue
        try:
            stored, local = save_receipt_photo_ex(raw, f.filename, str(user.id), kind="expense")
        except ValueError:
            skipped += 1
            continue

        parsed = {"vendor": None, "amount": None, "date": None}
        # OCR the file we just wrote for THIS receipt. The old newest-by-
        # mtime glob was worst here: a pile of receipts is uploaded in one
        # request, so every draft in the batch raced to read whichever
        # file happened to land last.
        try:
            parsed = parse_expense_receipt(local)
        except Exception:  # noqa: BLE001 — OCR must never block the draft
            pass

        amount = parsed.get("amount") or 0
        vendor = parsed.get("vendor")
        try:
            pdate = date.fromisoformat(parsed["date"]) if parsed.get("date") else None
        except Exception:  # noqa: BLE001
            pdate = None

        # The pile joins the same key space as the single scan, so a
        # correction made on a draft teaches the same vendor the scan
        # flow reads from. Without this, drafts neither read nor write
        # memory at all.
        v_key = canonical_vendor_key(vendor)
        memory = vendor_recall(db, user.id, v_key) if v_key else {}

        cat_id = None
        # Memory first — the owner's own confirmed history at this
        # supplier — and only at PREFILL, i.e. 3+ clean agreements. A
        # 2-sighting hunch must not silently fill a row that "Godkend
        # alle" can then sweep past without anyone looking at it.
        mem_cat = memory.get("category_name")
        if mem_cat and mem_cat["band"] == "prefill":
            c = resolve_category(mem_cat["value"], user.id, db)
            if c:
                cat_id = c.id
        if cat_id is None and vendor:
            hit = suggest_category_for(vendor, user.id, db)
            if hit:
                c = resolve_category(hit["category_name"], user.id, db)
                if c:
                    cat_id = c.id
        if cat_id is None:
            cat_id = _get_or_create_uncategorized(db, user.id).id

        # PAPER BEATS MEMORY: only fill the method when the receipt
        # itself didn't say. Still NULL if memory has nothing confident,
        # so the draft stays un-approvable until the owner answers.
        draft_method = parsed.get("payment_method")
        if not draft_method:
            mem_pm = memory.get("payment_method")
            if mem_pm and mem_pm["band"] == "prefill":
                draft_method = mem_pm["value"]

        draft = Expense(
            user_id=user.id, category_id=cat_id, date=pdate or date.today(),
            amount=amount, description=vendor or "Bilag",
            # Read off the receipt ("Kontant" / "Dankort" / "MobilePay"),
            # NULL when the paper doesn't say. It used to be hardcoded
            # "card", so a pile of cash purchases booked as card and
            # sync_cash_out_for_expense never fired — cash left the drawer
            # and the books never saw it. The single-scan path has refused
            # to guess this since #139; the pile was still guessing.
            payment_method=draft_method,
            vendor_key=v_key,
            receipt_photo=stored, receipt_source="scan", status="pending",
        )
        db.add(draft)
        created.append(draft)

    db.commit()
    for d in created:
        db.refresh(d)
    return {
        "created": len(created),
        "skipped": skipped,
        "cap_reached": cap_reached,
        "used_this_month": used + len(created),
        "monthly_cap": cap,
        "drafts": [ExpenseResponse.model_validate(d).model_dump(mode="json") for d in created],
    }


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
# Same defensive rate limit as parse-receipt above — this is the
# parallel "store + auto-extract" upload endpoint that also drives an
# Opus 4.7 OCR call under the hood. Per-IP burst + daily ceiling.
@_limiter.limit("6/minute;80/day")
async def upload_expense_receipt(
    request: Request,
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
                        "Upgrade to Starter for 200 / month."
                    ),
                },
            )

    from app.services.receipt_ocr import save_receipt_photo_ex, extract_amount_from_image, parse_expense_receipt
    try:
        stored_path, local_path = save_receipt_photo_ex(raw, file.filename, str(user.id), kind="expense")
    except ValueError as e:
        raise HTTPException(400, str(e))

    # Use the local copy we JUST wrote — never re-derive it by globbing
    # the user's upload dir by mtime. Two receipts in flight at once and
    # the newest file is somebody else's; we would OCR that image and
    # store its amount against this row.

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

    # ── Cross-check the total against the receipt's own figures ──────
    # The regex path picks the LARGEST total-looking number, which on a
    # Danish cash receipt is usually the cash tendered or the change, not
    # the total. A creased "AT BETALE" drops it onto that fallback and it
    # books 200,00 instead of 52,05 — reproduced on a real receipt.
    #
    # The paper disproves that itself: its printed MOMS only implies a
    # legal DK rate against the true total. We never substitute silently
    # — a contradicted amount becomes a question with the alternates.
    from app.services.amount_reconcile import reconcile_amount
    verdict = reconcile_amount(
        amount_block.get("all_amounts_found") or [],
        chosen=amount,
        vat_amount=parsed.get("vat_amount"),
        line_items=parsed.get("line_items"),
    )
    if verdict.confident and verdict.amount is not None:
        amount = verdict.amount

    # ── Per-vendor memory ─────────────────────────────────────────────
    # Memory is consulted BEFORE the keyword fallback, but it only ever
    # fills a null. PAPER ALWAYS BEATS MEMORY: if the receipt printed the
    # payment method, we do not consult memory for it and we do not
    # render a "you usually..." line — the value stays `detected`.
    vendor_key = canonical_vendor_key(parsed.get("vendor"))
    memory = vendor_recall(db, user.id, vendor_key, consume_demotion=True) if vendor_key else {}

    learned_payment = None
    if not parsed.get("payment_method"):
        pm = memory.get("payment_method")
        if pm and pm["band"] in ("suggest", "prefill"):
            learned_payment = {
                "value": pm["value"],
                "source": "learned",
                # The CONSECUTIVE run, not the lifetime count — the copy
                # claims "the last N times", and an owner who corrected
                # us once could otherwise be shown a number they can
                # disprove from their own list.
                "evidence_n": pm["streak"],
                "band": pm["band"],
                "vendor_label": pm.get("display_name") or vendor_key,
            }

    # Best-effort category suggestion — memory first (this owner's own
    # confirmed history at this exact supplier), keyword map only as cold
    # start. The keyword map cannot learn; it is a frozen literal.
    suggested_category = None
    cat_hit = None
    mem_cat = memory.get("category_name")
    if mem_cat and mem_cat["band"] in ("suggest", "prefill"):
        cat_hit = {
            "category_name": mem_cat["value"],
            "source": "learned",
            "evidence_n": mem_cat["streak"],
            "band": mem_cat["band"],
        }
    elif parsed.get("vendor"):
        legacy = suggest_category_for(parsed["vendor"], user.id, db)
        if legacy:
            # Cold start only. Deliberately NOT labelled "learned" and
            # deliberately never band=prefill — the legacy 0.9/0.7/0.6
            # numbers are hardcoded constants, not measured accuracy, so
            # they may suggest but must not auto-fill.
            cat_hit = {
                "category_name": legacy["category_name"],
                "source": "keyword",
                "evidence_n": 0,
                "band": "suggest",
            }
    if cat_hit:
        # Exact-name lookup used to be the whole of this step, which meant
        # an English concept from DEFAULT_KEYWORDS ("Ingredients") never
        # matched the Danish buckets onboarding seeds (Vareforbrug), and
        # the suggestion was thrown away on every scan for every DK
        # account. resolve_category maps the concept onto a category the
        # owner actually has.
        cat = resolve_category(cat_hit["category_name"], user.id, db)
        if cat:
            suggested_category = {
                "category_id": str(cat.id),
                "category_name": cat.name,
                "source": cat_hit["source"],
                "evidence_n": cat_hit["evidence_n"],
                "band": cat_hit["band"],
            }
        else:
            # Still nothing? Say so rather than dropping a correct guess —
            # the owner can create it in one tap. No category_id, so
            # nothing can be preselected from this.
            suggested_category = {
                "category_id": None,
                "category_name": preferred_name_for(cat_hit["category_name"]),
                "source": cat_hit["source"],
                "evidence_n": cat_hit["evidence_n"],
                "band": "suggest",
                "needs_create": True,
            }
    try:
        db.commit()  # persist demotion decrements consumed by recall()
    except Exception:  # noqa: BLE001
        db.rollback()

    return {
        "vendor_key": vendor_key,
        "learned_payment_method": learned_payment,
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
        # Pass-through from Claude Vision (May 2026). Frontend uses
        # confidence_per_field to render "verify this" hints on
        # low-confidence fields and claude_notes to surface any
        # ambiguity the model flagged. Existing callers ignore unknown
        # keys so this is back-compat.
        "confidence_per_field": parsed.get("confidence_per_field") or {},
        "claude_notes": parsed.get("claude_notes"),
        "vat_amount": parsed.get("vat_amount"),
        "vat_rate": parsed.get("vat_rate"),
        "line_items": parsed.get("line_items") or [],
        # "cash" | "card" | "mobilepay", or None when the receipt didn't
        # say. None means ASK — the form must not pre-pick a method the
        # paper doesn't support, or cash purchases book as card.
        "suggested_payment_method": parsed.get("payment_method"),
        # How much the receipt's own figures back the amount above.
        # `confident: false` with alternates means ASK — the paper
        # contradicts what the parser picked, or there was nothing to
        # check it against.
        "amount_check": {
            "confident": verdict.confident,
            "reason": verdict.reason,
            "alternates": verdict.alternates,
        },
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
    # vendor_hint / autofill are request metadata, not columns — strip
    # them or the model constructor raises. (This endpoint splats the
    # dump, so every future ExpenseCreate field lands here too.)
    receipt_payload = data.model_dump()
    rp_vendor = receipt_payload.pop("vendor_hint", None) or receipt_payload.get("description")
    # Every non-column field on ExpenseCreate has to be stripped here.
    # This endpoint splats the whole dump into Expense(), so each new
    # request-only field breaks it — vendor_hint/autofill did once
    # already, now allow_duplicate. Pop by difference rather than by
    # memory so the next one can't repeat it.
    for _request_only in ("autofill", "allow_duplicate"):
        receipt_payload.pop(_request_only, None)
    receipt_payload["vat_source"] = (
        "receipt" if receipt_payload.get("vat_amount") is not None else None
    )
    expense = Expense(
        user_id=user.id,
        vendor_key=canonical_vendor_key(rp_vendor),
        **receipt_payload,
    )
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
