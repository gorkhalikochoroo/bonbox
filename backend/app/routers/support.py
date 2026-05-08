"""Support tickets — in-app support channel routed to the founder.

Owner endpoints (auth-gated, tenant-scoped):
  • POST /support/tickets    — submit a new ticket
  • GET  /support/tickets    — list my tickets (own only)

Admin endpoints (admin-only):
  • GET  /support/admin/tickets        — open triage queue
  • POST /support/admin/tickets/{id}/respond — close + answer

Multi-layer security:
  • Auth gate (Depends(get_current_user)).
  • Tenant scope on every owner query (user_id == current.id).
  • Admin gate via existing User.is_admin column on admin endpoints.
  • Field caps enforced at the schema (subject ≤140, body ≤5000,
    kind ≤40) to prevent payload bombs.
  • Per-user rate limit (5 tickets/hour) so a misbehaving client or
    runaway script can't fill the table.
  • No raw HTML interpolated anywhere — body is plain text.
"""
from __future__ import annotations

import logging
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.support_ticket import SupportTicket
from app.models.user import User
from app.services.auth import get_current_user
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.support_router")
router = APIRouter()


# Per-user submission cap. Genuine support requests are rare; this only
# fires under abuse / a runaway client.
TICKETS_PER_HOUR_CAP = 5

ALLOWED_KINDS = {"bug", "question", "feature", "export", "scan", "billing", "other"}


class CreateTicketBody(BaseModel):
    kind: str = Field("other", max_length=40)
    subject: str = Field(..., min_length=1, max_length=140)
    body: str = Field(..., min_length=1, max_length=5000)
    context: str | None = Field(None, max_length=2000)


def _serialise(t: SupportTicket) -> dict:
    return {
        "id": str(t.id),
        "kind": t.kind,
        "subject": t.subject,
        "body": t.body,
        "status": t.status,
        "response_text": t.response_text,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "responded_at": t.responded_at.isoformat() if t.responded_at else None,
        "closed_at": t.closed_at.isoformat() if t.closed_at else None,
    }


@router.post("/tickets", status_code=201)
def create_ticket(
    body: CreateTicketBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner submits a support ticket. Rate-limited per user.

    Plan-aware:
      • All tiers can submit — silently churning free users is the
        bigger risk than support spam.
      • Pro tier gets `priority_support` flag → ticket subject prefixed
        with [PRIORITY] for the triage queue. Same surface, faster
        first-response on the founder's side.
    """
    # Rate limit
    cutoff = utc_now() - timedelta(hours=1)
    recent = (
        db.query(func.count(SupportTicket.id))
        .filter(SupportTicket.user_id == user.id, SupportTicket.created_at >= cutoff)
        .scalar()
        or 0
    )
    if recent >= TICKETS_PER_HOUR_CAP:
        raise HTTPException(
            status_code=429,
            detail=f"Too many tickets in the last hour ({recent}). Please wait a bit.",
        )

    kind = (body.kind or "other").strip().lower()
    if kind not in ALLOWED_KINDS:
        kind = "other"

    # Pro tier → priority subject prefix for founder's triage queue.
    subject = body.subject.strip()
    try:
        from app.services.billing import has_feature
        if has_feature(user, "priority_support") and not subject.startswith("[PRIORITY]"):
            subject = f"[PRIORITY] {subject}"[:140]
    except Exception:  # noqa: BLE001
        # Never block ticket creation on entitlement check failure.
        pass

    t = SupportTicket(
        id=uuid.uuid4(),
        user_id=user.id,
        kind=kind,
        subject=subject,
        body=body.body.strip(),
        context=(body.context or "").strip() or None,
        status="open",
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return _serialise(t)


@router.get("/tickets")
def list_my_tickets(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner sees their own tickets (open + closed history). Tenant-
    scoped — server filters on user_id."""
    rows = (
        db.query(SupportTicket)
        .filter(SupportTicket.user_id == user.id)
        .order_by(SupportTicket.created_at.desc())
        .limit(50)
        .all()
    )
    return {"tickets": [_serialise(t) for t in rows], "count": len(rows)}


# ─── Admin / triage ───────────────────────────────────────────────────


def _require_admin(user: User):
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin only")


@router.get("/admin/tickets")
def admin_list(
    status: str | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin(user)
    q = db.query(SupportTicket)
    if status:
        q = q.filter(SupportTicket.status == status)
    rows = q.order_by(SupportTicket.created_at.desc()).limit(200).all()
    return {"tickets": [_serialise(t) for t in rows], "count": len(rows)}


class RespondBody(BaseModel):
    response_text: str = Field(..., min_length=1, max_length=5000)
    close: bool = True


@router.post("/admin/tickets/{ticket_id}/respond")
def admin_respond(
    ticket_id: str,
    body: RespondBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    _require_admin(user)
    try:
        tid = uuid.UUID(ticket_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid ticket_id")
    t = db.query(SupportTicket).filter(SupportTicket.id == tid).first()
    if not t:
        raise HTTPException(status_code=404, detail="Ticket not found")
    t.response_text = body.response_text.strip()
    t.responded_at = utc_now()
    t.status = "closed" if body.close else "responded"
    if body.close:
        t.closed_at = utc_now()
    db.commit()
    db.refresh(t)
    return _serialise(t)
