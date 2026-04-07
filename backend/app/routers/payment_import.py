"""Payment provider imports — connect, sync, and confirm transactions."""
import json
import uuid
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.payment_connection import PaymentConnection
from app.services.auth import get_current_user
from app.services.payment_providers import (
    get_providers,
    get_providers_for_country,
    fetch_transactions,
    PROVIDERS,
)
from app.services.cash_sync import sync_cash_in_for_sale, sync_cash_out_for_expense
from app.schemas.payment_import import (
    ConnectRequest,
    ConnectionResponse,
    SyncResponse,
    SyncConfirmRequest,
    SyncConfirmResponse,
    PaymentTransaction,
)

# Reuse categorization from expenses router
from app.routers.expenses import suggest_category_for, learn_category

router = APIRouter()


# ── Provider info ───────────────────────────────────────────

@router.get("/providers")
def list_providers(country: str | None = Query(None)):
    """List available payment providers, optionally filtered by country."""
    if country:
        return get_providers_for_country(country)
    return get_providers()


# ── Connection management ───────────────────────────────────

@router.get("/connections", response_model=list[ConnectionResponse])
def list_connections(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List user's connected payment providers."""
    conns = db.query(PaymentConnection).filter(
        PaymentConnection.user_id == user.id,
    ).order_by(PaymentConnection.created_at.desc()).all()
    return conns


@router.post("/connect", response_model=ConnectionResponse)
def connect_provider(
    data: ConnectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Connect a payment provider by saving merchant credentials."""
    if data.provider not in PROVIDERS:
        raise HTTPException(400, f"Unknown provider: {data.provider}")

    provider_info = PROVIDERS[data.provider]
    required = [f["key"] for f in provider_info["fields"]]
    missing = [k for k in required if not data.credentials.get(k)]
    if missing:
        raise HTTPException(400, f"Missing required fields: {', '.join(missing)}")

    # Check if user already has a connection for this provider
    existing = db.query(PaymentConnection).filter(
        PaymentConnection.user_id == user.id,
        PaymentConnection.provider == data.provider,
    ).first()

    if existing:
        # Update existing connection
        existing.credentials = json.dumps(data.credentials)
        existing.label = data.label or provider_info["name"]
        existing.is_active = True
        db.commit()
        db.refresh(existing)
        return existing

    conn = PaymentConnection(
        id=uuid.uuid4(),
        user_id=user.id,
        provider=data.provider,
        label=data.label or provider_info["name"],
        credentials=json.dumps(data.credentials),
    )
    db.add(conn)
    db.commit()
    db.refresh(conn)
    return conn


@router.delete("/connections/{connection_id}")
def disconnect_provider(
    connection_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Remove a payment provider connection."""
    conn = db.query(PaymentConnection).filter(
        PaymentConnection.id == connection_id,
        PaymentConnection.user_id == user.id,
    ).first()
    if not conn:
        raise HTTPException(404, "Connection not found")

    db.delete(conn)
    db.commit()
    return {"message": f"{conn.label} disconnected"}


# ── Sync transactions ──────────────────────────────────────

@router.post("/sync/{connection_id}", response_model=SyncResponse)
async def sync_transactions(
    connection_id: uuid.UUID,
    date_from: str = Query(None, description="Start date (YYYY-MM-DD)"),
    date_to: str = Query(None, description="End date (YYYY-MM-DD)"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Fetch transactions from a connected payment provider."""
    conn = db.query(PaymentConnection).filter(
        PaymentConnection.id == connection_id,
        PaymentConnection.user_id == user.id,
    ).first()
    if not conn:
        raise HTTPException(404, "Connection not found")
    if not conn.is_active:
        raise HTTPException(400, "Connection is inactive")

    creds = json.loads(conn.credentials)

    # Default: last 30 days
    d_to = date.fromisoformat(date_to) if date_to else date.today()
    d_from = date.fromisoformat(date_from) if date_from else d_to - timedelta(days=30)

    try:
        raw_txns = await fetch_transactions(conn.provider, creds, d_from, d_to)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Failed to fetch from {conn.provider}: {str(e)}")

    # Add category suggestions
    transactions = []
    for txn in raw_txns:
        if txn["type"] == "expense":
            suggestion = suggest_category_for(txn["description"], user.id, db)
            txn["suggested_category"] = suggestion["category_name"] if suggestion else "Other"
            txn["confidence"] = suggestion["confidence"] if suggestion else 0.0
        else:
            txn["suggested_category"] = "Sales"
            txn["confidence"] = 1.0
        transactions.append(PaymentTransaction(**txn))

    # Update last synced
    conn.last_synced_at = datetime.utcnow()
    db.commit()

    return SyncResponse(
        provider=conn.provider,
        transactions=transactions,
        total_count=len(transactions),
        date_from=d_from.isoformat(),
        date_to=d_to.isoformat(),
    )


# ── Confirm import ──────────────────────────────────────────

@router.post("/confirm", response_model=SyncConfirmResponse)
def confirm_payment_import(
    body: SyncConfirmRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Save confirmed payment transactions as Sales and Expenses.

    Uses the same dedup + categorization logic as bank CSV import.
    """
    conn = db.query(PaymentConnection).filter(
        PaymentConnection.id == body.connection_id,
        PaymentConnection.user_id == user.id,
    ).first()
    if not conn:
        raise HTTPException(404, "Connection not found")

    imported = 0
    skipped = 0
    errors = []

    for txn in body.transactions:
        ref_id = f"pay_{conn.provider}_{txn.ref_hash}"

        try:
            txn_date = date.fromisoformat(txn.date)
        except ValueError:
            errors.append(f"Invalid date: {txn.date}")
            continue

        if txn.type == "income":
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
            if txn.payment_method in ("cash", "mixed"):
                sync_cash_in_for_sale(db, sale)
            imported += 1

        elif txn.type == "expense":
            exists = db.query(Expense.id).filter(
                Expense.user_id == user.id,
                Expense.reference_id == ref_id,
            ).first()
            if exists:
                skipped += 1
                continue

            cat_name = txn.suggested_category or "Other"
            category = db.query(ExpenseCategory).filter(
                ExpenseCategory.user_id == user.id,
                ExpenseCategory.name == cat_name,
            ).first()
            if not category:
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
            sync_cash_out_for_expense(db, expense, category_name=cat_name)
            learn_category(txn.description, cat_name, user.id, db)
            imported += 1

    db.commit()

    return SyncConfirmResponse(imported=imported, skipped=skipped, errors=errors)
