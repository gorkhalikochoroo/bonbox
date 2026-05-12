"""
Customer (debitor) CRUD endpoints.

Plan gating: requires Starter or above (Free tier doesn't get faktura,
so the customer record is meaningless there). Enforced at the route
dependency level via `require_starter_plan`.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.customer import Customer
from app.models.user import User
from app.routers.auth import get_current_user
from app.schemas.invoicing import CustomerCreate, CustomerResponse, CustomerUpdate
from app.services.billing import effective_plan

router = APIRouter()


# ─── Plan gate ───────────────────────────────────────────────────────
# Inlined for now — when we have more invoicing endpoints we'll lift this
# into app/deps/plan.py as `require_starter_plan`.
#
# Allowed: starter, pro, business (legacy), and trial. Trial users are
# Pro-tier during their 14-day window — must get full invoicing access,
# otherwise the trial isn't a real trial.

_STARTER_AND_ABOVE = {"starter", "pro", "business", "trial"}


def _require_invoicing_plan(user: User = Depends(get_current_user)) -> User:
    # Use effective_plan so:
    #   • plan="free" + active trial_ends_at → resolves to "trial" → allowed
    #   • legacy plan="business" → resolves to "pro" → allowed
    plan = (effective_plan(user) or "free").lower()
    if plan not in _STARTER_AND_ABOVE:
        raise HTTPException(
            status.HTTP_402_PAYMENT_REQUIRED,
            "Upgrade to Starter to use invoicing features",
        )
    return user


# ─── Endpoints ───────────────────────────────────────────────────────

@router.post("", response_model=CustomerResponse, status_code=status.HTTP_201_CREATED)
def create_customer(
    data: CustomerCreate,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Create a debitor record."""
    c = Customer(
        user_id=user.id,
        branch_id=data.branch_id,
        name=data.name,
        cvr=data.cvr,
        is_company=data.is_company,
        email=data.email,
        phone=data.phone,
        address=data.address,
        zipcode=data.zipcode,
        city=data.city,
        country=data.country,
        dawa_address_id=data.dawa_address_id,
        payment_terms_days=data.payment_terms_days,
        default_lang=data.default_lang,
    )
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


@router.get("", response_model=list[CustomerResponse])
def list_customers(
    branch_id: Optional[UUID] = None,
    include_deleted: bool = False,
    q: Optional[str] = None,  # search by name / CVR
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    query = db.query(Customer).filter(Customer.user_id == user.id)
    if not include_deleted:
        query = query.filter(Customer.is_deleted.is_(False))
    if branch_id is not None:
        query = query.filter(Customer.branch_id == branch_id)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (Customer.name.ilike(like)) | (Customer.cvr.ilike(like))
        )
    return query.order_by(Customer.name).all()


@router.get("/{customer_id}", response_model=CustomerResponse)
def get_customer(
    customer_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    c = (
        db.query(Customer)
        .filter(Customer.id == customer_id, Customer.user_id == user.id)
        .first()
    )
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found")
    return c


@router.patch("/{customer_id}", response_model=CustomerResponse)
def update_customer(
    customer_id: UUID,
    data: CustomerUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    c = (
        db.query(Customer)
        .filter(Customer.id == customer_id, Customer.user_id == user.id)
        .first()
    )
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found")
    if c.is_deleted:
        raise HTTPException(status.HTTP_409_CONFLICT, "Customer is deleted")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(c, field, value)
    db.commit()
    db.refresh(c)
    return c


@router.delete("/{customer_id}", status_code=status.HTTP_204_NO_CONTENT)
def soft_delete_customer(
    customer_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """
    Soft-delete only. Hard-delete would orphan past invoices, which is
    a compliance no-no — the customer record needs to be retrievable for
    every faktura that references it, for 5 years.
    """
    c = (
        db.query(Customer)
        .filter(Customer.id == customer_id, Customer.user_id == user.id)
        .first()
    )
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Customer not found")
    c.is_deleted = True
    db.commit()
    return None
