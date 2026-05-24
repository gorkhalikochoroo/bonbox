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
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.branch import Branch
from app.models.kasserapport import KasserapportExtraction
from app.models.terminal import Terminal
from app.models.user import User
from app.schemas.terminal import TerminalCreate, TerminalResponse, TerminalUpdate
from app.services.auth import get_current_user
from app.services.billing import effective_plan
from app.services.terminal_inference import (
    TerminalInferenceError,
    bulk_create_terminals,
    infer_terminals_from_extractions,
)
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.terminal_router")

router = APIRouter()


# Cap to prevent abuse / data bloat. Real businesses rarely have >10
# terminals; setting at 20 leaves headroom for chains while preventing
# a misbehaving client from creating 10K rows.
DEFAULT_TERMINAL_LIMIT = 20

# Free-tier terminal cap (P5 — matches the "1 branch" claim). Multi-POS
# management is a Pro entitlement; Free owners get one terminal so they
# can still scan + close a single till. The /aggregate + render endpoints
# on the kasserapport router are tier-gated on `multi_terminal_close`,
# but capping the terminal COUNT here closes the front-door: a Free user
# can't even build the multi-terminal data set they would need to hit
# the aggregator. Trial = full Pro so trials get the chain headroom.
_FREE_TIER_TERMINAL_CAP = 1


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

    # Tier gate (P5) — Free is capped at 1 terminal so the "1 branch"
    # marketing claim is enforced at the data layer, not just the
    # multi-terminal close endpoint. Returns a structured 402 so the
    # frontend can render UpgradeNudge instead of a generic error.
    if effective_plan(user) == "free" and count >= _FREE_TIER_TERMINAL_CAP:
        from app.services.billing import feature_locked_detail
        raise HTTPException(
            status_code=402,
            detail=feature_locked_detail(user, "multi_terminal_close"),
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
    term.updated_at = utc_now()
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
    term.updated_at = utc_now()
    db.commit()
    return  # 204 No Content


# ─────────────────────────────────────────────────────────────────────────
# Smart Terminals — inference-first setup (May 2026)
#
# Replaces the configuration-heavy "first set up your terminals, THEN
# close" flow with: scan a few kasserapports and we propose the terminals
# from the OCR'd labels. Confirm with one tap. Mirror of the
# SmartStaffingCard pattern.
#
# Both endpoints are auth-gated and tenant-scoped. The /infer endpoint
# is read-only — it returns a proposal but writes nothing. The
# /bulk-create endpoint is the only writer, atomic, capped, and re-
# validates all proposals before any insert.
# ─────────────────────────────────────────────────────────────────────────


class InferTerminalsBody(BaseModel):
    """Optional whitelist of recent extraction IDs. If omitted, the
    service walks the most recent extractions itself."""
    extraction_ids: list[uuid.UUID] | None = None


@router.post("/infer")
def infer_terminals(
    body: InferTerminalsBody | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Read-only — propose terminals from recent kasserapport scans.

    The service does its own tenant filtering on extraction_ids so a
    forged ID from another owner's account silently disappears (it
    won't match `user_id == user.id` in the query).

    Returns the same shape as /api/business/staffing-suggestion and
    /api/inventory/{id}/usage-suggestion: { proposals, confidence,
    data_quality, reasoning, existing_terminals }.
    """
    extraction_ids = (body.extraction_ids if body else None) or None
    proposal = infer_terminals_from_extractions(
        db, user=user, extraction_ids=extraction_ids
    )
    return proposal


class BulkTerminalProposal(BaseModel):
    """One row of the bulk-create body. Mirrors TerminalCreate but
    every field has a default so the SmartTerminalsCard can send the
    proposal verbatim from /infer without re-shaping."""
    name: str = Field(..., min_length=1, max_length=80)
    receipt_label: str | None = Field(None, max_length=40)
    display_order: int = Field(0, ge=0, le=999)
    accepts_dankort: bool = True
    accepts_mobilepay: bool = True
    accepts_amex: bool = False


class BulkCreateBody(BaseModel):
    """Body of POST /api/terminals/bulk-create."""
    branch_id: uuid.UUID | None = None
    terminals: list[BulkTerminalProposal]


@router.post("/bulk-create", response_model=list[TerminalResponse], status_code=201)
def bulk_create(
    body: BulkCreateBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Atomically create N terminals from a confirmed proposal.

    Defense layers:
      • Pydantic enforces per-item shape (name length, flag types).
      • Service layer pre-validates all entries (cap check, branch
        ownership, redundant field bounds) BEFORE writing any row.
      • If anything fails, the whole batch rolls back — no half-applied
        state.

    Translation:
      Service raises TerminalInferenceError → 422 with the reason.
      Anything else → 500 (logged).

    Tier gate (P5):
      Free is capped at 1 terminal. If creating N terminals would push
      the user past the Free cap, return a structured 402 so the
      frontend can render UpgradeNudge.
    """
    # P5 — bulk path mirrors the single-create gate. We check the
    # resulting count, not just the current count, because a Free user
    # could otherwise drive past the cap in one request.
    if effective_plan(user) == "free":
        existing = (
            db.query(func.count(Terminal.id))
            .filter(Terminal.user_id == user.id, Terminal.is_deleted.isnot(True))
            .scalar()
            or 0
        )
        if existing + len(body.terminals) > _FREE_TIER_TERMINAL_CAP:
            from app.services.billing import feature_locked_detail
            raise HTTPException(
                status_code=402,
                detail=feature_locked_detail(user, "multi_terminal_close"),
            )

    try:
        created = bulk_create_terminals(
            db,
            user=user,
            proposals=[p.model_dump() for p in body.terminals],
            branch_id=body.branch_id,
        )
    except PermissionError:
        # L4 — service-level Free-tier cap fired. Convert to the same
        # structured 402 the router gate above would have produced.
        from app.services.billing import feature_locked_detail
        raise HTTPException(
            status_code=402,
            detail=feature_locked_detail(user, "multi_terminal_close"),
        )
    except TerminalInferenceError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("bulk_create failed: %s", exc)
        raise HTTPException(status_code=500, detail="Could not create terminals") from exc
    return created
