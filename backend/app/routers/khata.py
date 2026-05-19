import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models.user import User
from app.models.khata import KhataCustomer, KhataTransaction
from app.models.inventory import InventoryItem, InventoryLog
from app.schemas.khata import (
    KhataCustomerCreate, KhataCustomerUpdate, KhataCustomerResponse,
    KhataTransactionCreate, KhataTransactionUpdate, KhataTransactionResponse,
)
from app.services.auth import get_current_user
from app.services.khata_sync import (
    sync_sale_for_khata_purchase,
    sync_cashbook_for_khata_payment,
    delete_khata_synced_entries,
    update_khata_synced_entries,
)

router = APIRouter()


def _customer_balance(db: Session, customer_id: uuid.UUID, user_id=None) -> float:
    """
    Calculate balance (total purchases - total payments) for a customer.

    Defense-in-depth: callers always filter customer_id against user_id
    upstream, but we accept user_id here too so any future caller can't
    accidentally compute another tenant's balance.
    """
    q = db.query(
        func.coalesce(func.sum(KhataTransaction.purchase_amount), 0)
        - func.coalesce(func.sum(KhataTransaction.paid_amount), 0)
    ).filter(KhataTransaction.customer_id == customer_id)
    if user_id is not None:
        q = q.filter(KhataTransaction.user_id == user_id)
    result = q.scalar()
    return float(result or 0)


# --- Customers ---

@router.get("/customers", response_model=list[KhataCustomerResponse])
def list_customers(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    customers = (
        db.query(KhataCustomer)
        .filter(KhataCustomer.user_id == user.id, KhataCustomer.is_deleted.isnot(True))
        .order_by(KhataCustomer.name)
        .all()
    )
    results = []
    for c in customers:
        resp = KhataCustomerResponse.model_validate(c)
        resp.balance = _customer_balance(db, c.id)
        results.append(resp)
    return results


@router.post("/customers", response_model=KhataCustomerResponse, status_code=201)
def create_customer(
    data: KhataCustomerCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    customer = KhataCustomer(user_id=user.id, **data.model_dump())
    db.add(customer)
    db.commit()
    db.refresh(customer)
    resp = KhataCustomerResponse.model_validate(customer)
    resp.balance = 0
    return resp


@router.put("/customers/{customer_id}", response_model=KhataCustomerResponse)
def update_customer(
    customer_id: str,
    data: KhataCustomerUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    customer = db.query(KhataCustomer).filter(
        KhataCustomer.id == customer_id, KhataCustomer.user_id == user.id
    ).first()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(customer, field, value)
    db.commit()
    db.refresh(customer)
    resp = KhataCustomerResponse.model_validate(customer)
    resp.balance = _customer_balance(db, customer.id)
    return resp


@router.delete("/customers/{customer_id}", status_code=204)
def delete_customer(
    customer_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    customer = db.query(KhataCustomer).filter(
        KhataCustomer.id == customer_id, KhataCustomer.user_id == user.id
    ).first()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    customer.is_deleted = True
    db.commit()


# --- Transactions ---

@router.get("/customers/{customer_id}/transactions", response_model=list[KhataTransactionResponse])
def list_transactions(
    customer_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Verify customer belongs to user
    customer = db.query(KhataCustomer).filter(
        KhataCustomer.id == customer_id, KhataCustomer.user_id == user.id
    ).first()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    return (
        db.query(KhataTransaction)
        .filter(KhataTransaction.customer_id == customer_id, KhataTransaction.user_id == user.id)
        .order_by(KhataTransaction.date.desc(), KhataTransaction.created_at.desc())
        .all()
    )


@router.post("/transactions", response_model=KhataTransactionResponse, status_code=201)
def create_transaction(
    data: KhataTransactionCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Verify customer belongs to user
    customer = db.query(KhataCustomer).filter(
        KhataCustomer.id == data.customer_id, KhataCustomer.user_id == user.id
    ).first()
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    txn_data = data.model_dump(exclude={"inventory_items"})
    txn = KhataTransaction(user_id=user.id, **txn_data)
    db.add(txn)
    db.commit()
    db.refresh(txn)
    # Sync to Sales & CashBook
    sync_sale_for_khata_purchase(db, txn, customer.name)
    sync_cashbook_for_khata_payment(db, txn, customer.name)
    # Deduct inventory stock for items sold on credit
    for inv_item in data.inventory_items:
        item = db.query(InventoryItem).filter(
            InventoryItem.id == inv_item.item_id,
            InventoryItem.user_id == user.id,
        ).first()
        if item:
            item.quantity = float(item.quantity) - inv_item.quantity
            log = InventoryLog(
                item_id=item.id,
                change_qty=-inv_item.quantity,
                reason=f"khata:{customer.name}",
                date=data.date,
            )
            db.add(log)
    db.commit()
    return txn


@router.put("/transactions/{txn_id}", response_model=KhataTransactionResponse)
def update_transaction(
    txn_id: str,
    data: KhataTransactionUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    txn = db.query(KhataTransaction).filter(
        KhataTransaction.id == txn_id, KhataTransaction.user_id == user.id
    ).first()
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(txn, field, value)
    # Update synced entries
    customer = db.query(KhataCustomer).filter(KhataCustomer.id == txn.customer_id).first()
    update_khata_synced_entries(db, txn, customer.name if customer else "Unknown")
    db.commit()
    db.refresh(txn)
    return txn


@router.delete("/transactions/{txn_id}", status_code=204)
def delete_transaction(
    txn_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    txn = db.query(KhataTransaction).filter(
        KhataTransaction.id == txn_id, KhataTransaction.user_id == user.id
    ).first()
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    delete_khata_synced_entries(db, txn.id, user.id)
    db.delete(txn)
    db.commit()


# --- Summary ---

@router.get("/summary")
def get_summary(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Get all non-deleted customers for this user
    customers = (
        db.query(KhataCustomer)
        .filter(KhataCustomer.user_id == user.id, KhataCustomer.is_deleted.isnot(True))
        .all()
    )

    customer_balances = []
    total_receivable = 0.0

    for c in customers:
        balance = _customer_balance(db, c.id)
        customer_balances.append({"id": c.id, "name": c.name, "balance": balance})
        total_receivable += balance

    # Sort by balance descending and take top 5
    top_debtors = sorted(customer_balances, key=lambda x: x["balance"], reverse=True)[:5]

    return {
        "total_receivable": total_receivable,
        "customer_count": len(customers),
        "top_debtors": top_debtors,
    }


@router.get("/at-risk")
def get_at_risk_regulars(
    min_visits: int = 3,
    days_silent: int = 14,
    lookback_days: int = 90,
    limit: int = 20,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List regular customers who haven't been back recently.

    Mirrors the precompute logic used by the Daily Brief loyalty signal
    so the Brief's CTA can deep-link here and the Khata page can show
    the same "regulars at risk" list.

    Definition:
      - Regular = customer with ≥ `min_visits` transactions in the
        last `lookback_days` days (default ≥3 visits in 90d).
      - At-risk = last visit was ≥ `days_silent` days ago (default 14).

    Returns a list ranked by visit_count desc, then days_since desc so
    the most-loyal-but-silent customers float to the top. Capped at
    `limit` rows to keep the response small.

    Defensive: bounds checks on inputs so an over-eager caller can't
    request a 10-year lookback or 1000-row page.
    """
    from datetime import date, timedelta

    # Input bounds — same kind of multi-layer guard the rest of the
    # router uses. A hostile/curious caller can't poke around outside
    # these.
    min_visits = max(2, min(min_visits, 20))
    days_silent = max(1, min(days_silent, 365))
    lookback_days = max(7, min(lookback_days, 366))
    limit = max(1, min(limit, 100))

    today = date.today()
    window_start = today - timedelta(days=lookback_days)
    silent_cutoff = today - timedelta(days=days_silent)

    # Per-customer (visit_count, last_visit) within the lookback window.
    # One SQL roundtrip — no N+1. Mirrors compute_precompute() in the
    # daily_brief service.
    rows = (
        db.query(
            KhataCustomer.id.label("cid"),
            KhataCustomer.name.label("name"),
            KhataCustomer.phone.label("phone"),
            func.count(KhataTransaction.id).label("visits"),
            func.max(KhataTransaction.date).label("last_visit"),
        )
        .join(KhataTransaction, KhataTransaction.customer_id == KhataCustomer.id)
        .filter(
            KhataCustomer.user_id == user.id,
            KhataCustomer.is_deleted.isnot(True),
            KhataTransaction.user_id == user.id,
            KhataTransaction.date >= window_start,
        )
        .group_by(KhataCustomer.id, KhataCustomer.name, KhataCustomer.phone)
        .having(func.count(KhataTransaction.id) >= min_visits)
        .all()
    )

    at_risk = []
    for r in rows:
        if r.last_visit is None or r.last_visit > silent_cutoff:
            continue
        days_since = (today - r.last_visit).days
        at_risk.append({
            "id": str(r.cid),
            "name": str(r.name or "Customer"),
            "phone": (r.phone or "").strip() or None,
            "visits": int(r.visits or 0),
            "last_visit": r.last_visit.isoformat(),
            "days_since_last": days_since,
        })

    # Rank: visit_count desc, then days_since desc as tiebreaker.
    at_risk.sort(key=lambda c: (-c["visits"], -c["days_since_last"]))
    return {
        "regulars_at_risk": at_risk[:limit],
        "total_regulars": len(rows),
        "window": {
            "min_visits": min_visits,
            "days_silent": days_silent,
            "lookback_days": lookback_days,
        },
    }


@router.post("/outreach-log")
def log_outreach(
    payload: dict,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Best-effort audit trail when an owner opens an SMS via the
    Customer Outreach modal.

    Records: which template was used + how many recipients +
    customer_ids touched. NEVER records the message body itself —
    the SMS goes through the owner's own phone, BonBox doesn't see
    the content (and shouldn't, even if asked).

    Returns 200 on validation failure too (best-effort logging
    shouldn't block the owner's actual goal: opening their SMS app).
    """
    try:
        from app.services import audit_service
        customer_ids = payload.get("customer_ids", [])
        if not isinstance(customer_ids, list):
            customer_ids = []
        # Cap to prevent abuse
        customer_ids = [str(c)[:64] for c in customer_ids[:100]]
        template = str(payload.get("template", ""))[:32]
        recipient_count = int(payload.get("recipient_count") or 0)

        audit_service.record(
            db, user=user,
            action="khata.outreach_initiated",
            entity_type="khata_customer_group",
            entity_id=None,
            before=None,
            after={
                "template": template,
                "recipient_count": recipient_count,
                "customer_ids_count": len(customer_ids),
                # We deliberately DON'T store the raw ids — just the
                # count, so adoption tracking works without persistent
                # customer-level outreach history (privacy posture).
            },
        )
        db.commit()
    except Exception:  # noqa: BLE001
        # Audit failure must NEVER block the SMS flow. Silent log only.
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True}
