from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models.user import User
from app.models.cashbook import CashTransaction
from app.schemas.cashbook import CashTransactionCreate, CashTransactionUpdate, CashTransactionResponse
from app.services.auth import get_current_user

router = APIRouter()


@router.get("", response_model=list[CashTransactionResponse])
def list_transactions(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(CashTransaction).filter(CashTransaction.user_id == user.id)
    if from_date:
        query = query.filter(CashTransaction.date >= from_date)
    if to_date:
        query = query.filter(CashTransaction.date <= to_date)
    return query.order_by(CashTransaction.date.desc(), CashTransaction.created_at.desc()).all()


@router.get("/balance")
def get_balance(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(CashTransaction).filter(CashTransaction.user_id == user.id)
    if from_date:
        query = query.filter(CashTransaction.date >= from_date)
    if to_date:
        query = query.filter(CashTransaction.date <= to_date)

    total_in = float(
        query.filter(CashTransaction.type == "cash_in")
        .with_entities(func.coalesce(func.sum(CashTransaction.amount), 0))
        .scalar()
    )
    total_out = float(
        query.filter(CashTransaction.type == "cash_out")
        .with_entities(func.coalesce(func.sum(CashTransaction.amount), 0))
        .scalar()
    )

    return {
        "balance": total_in - total_out,
        "total_in": total_in,
        "total_out": total_out,
        "period_start": str(from_date) if from_date else None,
        "period_end": str(to_date) if to_date else None,
    }


@router.post("", response_model=CashTransactionResponse, status_code=201)
def create_transaction(
    data: CashTransactionCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if data.type not in ("cash_in", "cash_out"):
        raise HTTPException(status_code=400, detail="Type must be 'cash_in' or 'cash_out'")
    txn = CashTransaction(user_id=user.id, **data.model_dump())
    db.add(txn)
    db.commit()
    db.refresh(txn)
    return txn


@router.put("/{txn_id}", response_model=CashTransactionResponse)
def update_transaction(
    txn_id: str,
    data: CashTransactionUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    txn = db.query(CashTransaction).filter(
        CashTransaction.id == txn_id, CashTransaction.user_id == user.id
    ).first()
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        if field == "type" and value not in ("cash_in", "cash_out"):
            raise HTTPException(status_code=400, detail="Type must be 'cash_in' or 'cash_out'")
        setattr(txn, field, value)
    db.commit()
    db.refresh(txn)
    return txn


@router.delete("/{txn_id}", status_code=204)
def delete_transaction(
    txn_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    txn = db.query(CashTransaction).filter(
        CashTransaction.id == txn_id, CashTransaction.user_id == user.id
    ).first()
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")
    db.delete(txn)
    db.commit()
