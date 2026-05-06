"""Terminal CRUD — owners configure their physical POS stations here.

Per-tenant scoped: every endpoint filters on user_id. Multi-barrier:
  • Auth gate (get_current_user)
  • DB-level user_id filter on every query (defense vs IDOR)
  • Soft-delete preserves history; never hard-deletes a terminal that
    has linked extractions (would orphan the FKs)
  • Per-user cap on terminal count (DEFAULT_TERMINAL_LIMIT) so a
    runaway script can't fill the table

The "branch_id" coupling is optional — single-branch owners can skip it
and leave terminals scoped just to user_id. Multi-branch owners can
move terminals between branches via PUT.
"""
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.branch import Branch
from app.models.kasserapport import KasserapportExtraction
from app.models.terminal import Terminal
from app.models.user import User
from app.schemas.terminal import TerminalCreate, TerminalResponse, TerminalUpdate
from app.services.auth import get_current_user

logger = logging.getLogger("bonbox.terminal_router")

router = APIRouter()


# Cap to prevent abuse / data bloat. Real businesses rarely have >10
# terminals; setting at 20 leaves headroom for chains while preventing
# a misbehaving client from creating 10K rows.
DEFAULT_TERMINAL_LIMIT = 20


def _validate_branch_owned(db: Session, user_id: uuid.UUID, branch_id: uuid.UUID | None):
    """Defense — confirm the branch_id (if given) belongs to this user."""
    if branch_id is None:
        return
    branch = (
        db.query(Branch)
        .filter(Branch.id == branch_id, Branch.user_id == user_id)
        .first()
    )
    if not branch:
        raise HTTPException(status_code=404, detail="Branch not found")


@router.get("", response_model=list[TerminalResponse])
def list_terminals(
    branch_id: str | None = Query(None),
    include_inactive: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List all terminals belonging to this owner. Filterable by branch
    and by active flag."""
    q = (
        db.query(Terminal)
        .filter(
            Terminal.user_id == user.id,
            Terminal.is_deleted.isnot(True),
        )
    )
    if not include_inactive:
        q = q.filter(Terminal.is_active.is_(True))
    if branch_id:
        try:
            uuid.UUID(branch_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid branch_id")
        q = q.filter(Terminal.branch_id == branch_id)
    return (
        q.order_by(Terminal.display_order.asc(), Terminal.created_at.asc())
        .all()
    )


@router.post("", response_model=TerminalResponse, status_code=201)
def create_terminal(
    data: TerminalCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a new terminal under this owner.

    Defense layers:
      • Pydantic enforces name length + max field sizes
      • Branch ownership re-validated server-side (forged branch_id rejected)
      • Per-user cap prevents runaway creation
    """
    # Cap check
    count = (
        db.query(func.count(Terminal.id))
        .filter(Terminal.user_id == user.id, Terminal.is_deleted.isnot(True))
        .scalar()
        or 0
    )
    if count >= DEFAULT_TERMINAL_LIMIT:
        raise HTTPException(
            status_code=400,
            detail=f"Terminal limit reached ({DEFAULT_TERMINAL_LIMIT}). Delete unused ones first.",
        )

    _validate_branch_owned(db, user.id, data.branch_id)

    term = Terminal(
        id=uuid.uuid4(),
        user_id=user.id,
        branch_id=data.branch_id,
        name=data.name.strip(),
        display_order=data.display_order,
        accepts_dankort=data.accepts_dankort,
        accepts_mobilepay=data.accepts_mobilepay,
        accepts_amex=data.accepts_amex,
        receipt_label=(data.receipt_label or "").strip() or None,
    )
    db.add(term)
    db.commit()
    db.refresh(term)
    return term


@router.put("/{terminal_id}", response_model=TerminalResponse)
def update_terminal(
    terminal_id: str,
    data: TerminalUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Partial update. Only fields present in the body are changed."""
    term = (
        db.query(Terminal)
        .filter(
            Terminal.id == terminal_id,
            Terminal.user_id == user.id,
            Terminal.is_deleted.isnot(True),
        )
        .first()
    )
    if not term:
        raise HTTPException(status_code=404, detail="Terminal not found")

    updates = data.model_dump(exclude_unset=True)
    if "branch_id" in updates:
        _validate_branch_owned(db, user.id, updates["branch_id"])
    if "name" in updates and updates["name"]:
        updates["name"] = updates["name"].strip()
    if "receipt_label" in updates:
        updates["receipt_label"] = (updates["receipt_label"] or "").strip() or None

    for field_name, value in updates.items():
        setattr(term, field_name, value)
    term.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(term)
    return term


@router.delete("/{terminal_id}", status_code=204)
def delete_terminal(
    terminal_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Soft-delete the terminal. Linked extractions retain their
    terminal_id (stored as the deleted UUID) so historical reports
    still render the per-terminal breakdown correctly."""
    term = (
        db.query(Terminal)
        .filter(
            Terminal.id == terminal_id,
            Terminal.user_id == user.id,
            Terminal.is_deleted.isnot(True),
        )
        .first()
    )
    if not term:
        raise HTTPException(status_code=404, detail="Terminal not found")

    term.is_deleted = True
    term.is_active = False
    term.updated_at = datetime.utcnow()
    db.commit()
    return  # 204 No Content
