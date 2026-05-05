import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models.user import User
from app.models.loan import LoanPerson, LoanTransaction
from app.schemas.loan import (
    LoanPersonCreate, LoanPersonUpdate, LoanPersonResponse,
    LoanTransactionCreate, LoanTransactionUpdate, LoanTransactionResponse,
)
from app.services.auth import get_current_user

router = APIRouter()


def _person_balances(db: Session, person_id: uuid.UUID, user_id=None):
    """
    Returns (borrowed_balance, lent_balance).

      borrowed_balance = sum(borrowed, not repayment) - sum(borrowed, repayment)
      lent_balance     = sum(lent,     not repayment) - sum(lent,     repayment)

    Defense-in-depth: callers always scope by user upstream, but accept user_id
    here too so any future caller can't accidentally compute another tenant's
    balance (same hardening applied to khata._customer_balance).
    """
    q = db.query(LoanTransaction).filter(LoanTransaction.person_id == person_id)
    if user_id is not None:
        q = q.filter(LoanTransaction.user_id == user_id)
    txns = q.all()
    borrowed = 0.0
    lent = 0.0
    for t in txns:
        amt = float(t.amount or 0)
        if t.type == "borrowed":
            if t.is_repayment:
                borrowed -= amt
            else:
                borrowed += amt
        elif t.type == "lent":
            if t.is_repayment:
                lent -= amt
            else:
                lent += amt
    return borrowed, lent


# --- Persons ---

@router.get("/persons", response_model=list[LoanPersonResponse])
def list_persons(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    persons = (
        db.query(LoanPerson)
        .filter(LoanPerson.user_id == user.id, LoanPerson.is_deleted == False)
        .order_by(LoanPerson.name)
        .all()
    )
    results = []
    for p in persons:
        resp = LoanPersonResponse.model_validate(p)
        borrowed, lent = _person_balances(db, p.id)
        resp.borrowed_balance = borrowed
        resp.lent_balance = lent
        resp.net_balance = lent - borrowed  # positive = they owe me
        results.append(resp)
    return results


@router.post("/persons", response_model=LoanPersonResponse, status_code=201)
def create_person(
    data: LoanPersonCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    person = LoanPerson(user_id=user.id, **data.model_dump())
    db.add(person)
    db.commit()
    db.refresh(person)
    resp = LoanPersonResponse.model_validate(person)
    return resp


@router.put("/persons/{person_id}", response_model=LoanPersonResponse)
def update_person(
    person_id: str,
    data: LoanPersonUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    person = db.query(LoanPerson).filter(
        LoanPerson.id == person_id, LoanPerson.user_id == user.id
    ).first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(person, field, value)
    db.commit()
    db.refresh(person)
    resp = LoanPersonResponse.model_validate(person)
    borrowed, lent = _person_balances(db, person.id)
    resp.borrowed_balance = borrowed
    resp.lent_balance = lent
    resp.net_balance = lent - borrowed
    return resp


@router.delete("/persons/{person_id}", status_code=204)
def delete_person(
    person_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    person = db.query(LoanPerson).filter(
        LoanPerson.id == person_id, LoanPerson.user_id == user.id
    ).first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    person.is_deleted = True
    db.commit()


# --- Transactions ---

@router.get("/persons/{person_id}/transactions", response_model=list[LoanTransactionResponse])
def list_transactions(
    person_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    person = db.query(LoanPerson).filter(
        LoanPerson.id == person_id, LoanPerson.user_id == user.id
    ).first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    return (
        db.query(LoanTransaction)
        .filter(LoanTransaction.person_id == person_id, LoanTransaction.user_id == user.id)
        .order_by(LoanTransaction.date.desc(), LoanTransaction.created_at.desc())
        .all()
    )


@router.post("/transactions", response_model=LoanTransactionResponse, status_code=201)
def create_transaction(
    data: LoanTransactionCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    person = db.query(LoanPerson).filter(
        LoanPerson.id == data.person_id, LoanPerson.user_id == user.id
    ).first()
    if not person:
        raise HTTPException(status_code=404, detail="Person not found")
    if data.type not in ("borrowed", "lent"):
        raise HTTPException(status_code=400, detail="Type must be 'borrowed' or 'lent'")
    txn = LoanTransaction(user_id=user.id, **data.model_dump())
    db.add(txn)
    db.commit()
    db.refresh(txn)
    return txn


@router.put("/transactions/{txn_id}", response_model=LoanTransactionResponse)
def update_transaction(
    txn_id: str,
    data: LoanTransactionUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    txn = db.query(LoanTransaction).filter(
        LoanTransaction.id == txn_id, LoanTransaction.user_id == user.id
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
    txn = db.query(LoanTransaction).filter(
        LoanTransaction.id == txn_id, LoanTransaction.user_id == user.id
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
    persons = (
        db.query(LoanPerson)
        .filter(LoanPerson.user_id == user.id, LoanPerson.is_deleted == False)
        .all()
    )
    total_borrowed = 0.0
    total_lent = 0.0
    person_list = []
    for p in persons:
        borrowed, lent = _person_balances(db, p.id)
        net = lent - borrowed
        total_borrowed += borrowed
        total_lent += lent
        person_list.append({"id": str(p.id), "name": p.name, "borrowed": borrowed, "lent": lent, "net": net})

    return {
        "total_borrowed": total_borrowed,
        "total_lent": total_lent,
        "net_balance": total_lent - total_borrowed,
        "person_count": len(persons),
        "persons": sorted(person_list, key=lambda x: abs(x["net"]), reverse=True)[:10],
    }
