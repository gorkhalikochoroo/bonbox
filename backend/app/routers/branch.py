"""Branch management endpoints — CRUD for multi-location bookkeeping.

Each branch gets its own sales, expenses, cashbook, inventory.
Data is filtered by branch_id header (X-Branch-Id) across all endpoints.
"""

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel
from sqlalchemy import func, and_
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.models.branch import Branch
from app.models.sale import Sale
from app.models.expense import Expense
from app.models.cashbook import CashTransaction
from app.models.inventory import InventoryItem

router = APIRouter()


class BranchCreate(BaseModel):
    name: str
    address: Optional[str] = None
    business_type: Optional[str] = "general"  # restaurant | workshop | retail | service | general


class BranchUpdate(BaseModel):
    name: Optional[str] = None
    address: Optional[str] = None
    business_type: Optional[str] = None
    is_active: Optional[bool] = None


@router.get("/list")
def list_branches(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all branches for the current owner."""
    branches = (
        db.query(Branch)
        .filter(Branch.user_id == current_user.id, Branch.is_active.is_(True))
        .order_by(Branch.is_default.desc(), Branch.created_at.asc())
        .all()
    )

    result = []
    for b in branches:
        # Quick summary stats
        rev = db.query(func.coalesce(func.sum(Sale.amount), 0)).filter(
            Sale.user_id == current_user.id, Sale.branch_id == b.id,
            Sale.is_deleted.isnot(True),
        ).scalar() or 0

        exp = db.query(func.coalesce(func.sum(Expense.amount), 0)).filter(
            Expense.user_id == current_user.id, Expense.branch_id == b.id,
            Expense.is_deleted.isnot(True), Expense.is_personal.isnot(True),
        ).scalar() or 0

        inv_count = db.query(func.count(InventoryItem.id)).filter(
            InventoryItem.user_id == current_user.id, InventoryItem.branch_id == b.id,
        ).scalar() or 0

        result.append({
            "id": str(b.id),
            "name": b.name,
            "address": b.address,
            "business_type": b.business_type or "general",
            "is_default": b.is_default,
            "total_revenue": round(float(rev), 2),
            "total_expenses": round(float(exp), 2),
            "inventory_items": int(inv_count),
            "created": str(b.created_at.date()) if b.created_at else None,
        })

    return {"branches": result, "count": len(result)}


@router.post("/create")
def create_branch(
    body: BranchCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Create a new branch."""
    # Check if this is the first branch — make it default
    existing = db.query(func.count(Branch.id)).filter(
        Branch.user_id == current_user.id
    ).scalar()

    branch = Branch(
        user_id=current_user.id,
        name=body.name,
        address=body.address,
        business_type=body.business_type or "general",
        is_default=(existing == 0),
    )
    db.add(branch)
    db.commit()
    db.refresh(branch)
    return {
        "id": str(branch.id),
        "name": branch.name,
        "business_type": branch.business_type,
        "is_default": branch.is_default,
        "message": f"Branch '{branch.name}' created",
    }


@router.put("/{branch_id}")
def update_branch(
    branch_id: str,
    body: BranchUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a branch."""
    branch = db.query(Branch).filter(
        Branch.id == branch_id, Branch.user_id == current_user.id
    ).first()
    if not branch:
        return {"error": "Branch not found"}

    if body.name is not None:
        branch.name = body.name
    if body.address is not None:
        branch.address = body.address
    if body.business_type is not None:
        branch.business_type = body.business_type
    if body.is_active is not None:
        branch.is_active = body.is_active

    db.commit()
    return {"message": f"Branch '{branch.name}' updated"}


@router.post("/{branch_id}/set-default")
def set_default_branch(
    branch_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Set a branch as the default."""
    # Remove default from all branches
    db.query(Branch).filter(Branch.user_id == current_user.id).update({"is_default": False})

    branch = db.query(Branch).filter(
        Branch.id == branch_id, Branch.user_id == current_user.id
    ).first()
    if not branch:
        return {"error": "Branch not found"}

    branch.is_default = True
    db.commit()
    return {"message": f"'{branch.name}' set as default branch"}


@router.get("/summary")
def branch_summary(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Consolidated vs per-branch summary for the owner."""
    branches = (
        db.query(Branch)
        .filter(Branch.user_id == current_user.id, Branch.is_active.is_(True))
        .all()
    )

    if not branches:
        return {
            "has_branches": False,
            "message": "No branches set up. Create branches to enable multi-location bookkeeping.",
        }

    today = date.today()
    month_start = today.replace(day=1)

    branch_summaries = []
    total_rev = 0
    total_exp = 0

    for b in branches:
        rev = float(db.query(func.coalesce(func.sum(Sale.amount), 0)).filter(
            Sale.user_id == current_user.id, Sale.branch_id == b.id,
            Sale.date >= month_start, Sale.is_deleted.isnot(True),
        ).scalar() or 0)

        exp = float(db.query(func.coalesce(func.sum(Expense.amount), 0)).filter(
            Expense.user_id == current_user.id, Expense.branch_id == b.id,
            Expense.date >= month_start,
            Expense.is_deleted.isnot(True), Expense.is_personal.isnot(True),
        ).scalar() or 0)

        total_rev += rev
        total_exp += exp

        branch_summaries.append({
            "id": str(b.id),
            "name": b.name,
            "business_type": b.business_type or "general",
            "is_default": b.is_default,
            "month_revenue": round(rev, 2),
            "month_expenses": round(exp, 2),
            "month_profit": round(rev - exp, 2),
        })

    # Also count unassigned data (branch_id IS NULL)
    unassigned_rev = float(db.query(func.coalesce(func.sum(Sale.amount), 0)).filter(
        Sale.user_id == current_user.id, Sale.branch_id.is_(None),
        Sale.date >= month_start, Sale.is_deleted.isnot(True),
    ).scalar() or 0)

    unassigned_exp = float(db.query(func.coalesce(func.sum(Expense.amount), 0)).filter(
        Expense.user_id == current_user.id, Expense.branch_id.is_(None),
        Expense.date >= month_start,
        Expense.is_deleted.isnot(True), Expense.is_personal.isnot(True),
    ).scalar() or 0)

    return {
        "has_branches": True,
        "branches": branch_summaries,
        "consolidated": {
            "month_revenue": round(total_rev + unassigned_rev, 2),
            "month_expenses": round(total_exp + unassigned_exp, 2),
            "month_profit": round((total_rev + unassigned_rev) - (total_exp + unassigned_exp), 2),
        },
        "unassigned": {
            "revenue": round(unassigned_rev, 2),
            "expenses": round(unassigned_exp, 2),
        },
    }
