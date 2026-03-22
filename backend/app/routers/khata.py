import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models.user import User
from app.models.khata import KhataCustomer, KhataTransaction
from app.schemas.khata import (
    KhataCustomerCreate, KhataCustomerUpdate, KhataCustomerResponse,
    KhataTransactionCreate, KhataTransactionUpdate, KhataTransactionResponse,
)
from app.services.auth import get_current_user

router = APIRouter()


def _customer_balance(db: Session, customer_id: uuid.UUID) -> float:
    """Calculate balance (total purchases - total payments) for a customer."""
    result = db.query(
        func.coalesce(func.sum(KhataTransaction.purchase_amount), 0)
        - func.coalesce(func.sum(KhataTransaction.paid_amount), 0)
    ).filter(KhataTransaction.customer_id == customer_id).scalar()
    return float(result)


# --- Customers ---

@router.get("/customers", response_model=list[KhataCustomerResponse])
def list_customers(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    customers = (
        db.query(KhataCustomer)
        .filter(KhataCustomer.user_id == user.id, KhataCustomer.is_deleted == False)
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
    txn = KhataTransaction(user_id=user.id, **data.model_dump())
    db.add(txn)
    db.commit()
    db.refresh(txn)
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
        .filter(KhataCustomer.user_id == user.id, KhataCustomer.is_deleted == False)
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
