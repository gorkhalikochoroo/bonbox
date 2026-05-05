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
