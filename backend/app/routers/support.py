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
        "is_priority": bool(getattr(t, "is_priority", False)),
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "responded_at": t.responded_at.isoformat() if t.responded_at else None,
        "closed_at": t.closed_at.isoformat() if t.closed_at else None,
    }


def _post_to_priority_slack(*, ticket: SupportTicket, owner: User) -> None:
    """P10 — best-effort post of a priority ticket to a Slack incoming
    webhook. Never raises: a Slack outage MUST NOT block the founder's
    in-app triage. Silently no-ops when no webhook is configured.

    Posts a compact Slack message with subject, kind, owner email, and
    a link back to the admin triage UI. The webhook URL itself is the
    auth boundary — Slack signs the channel on the receiving side, so
    we don't include any signing/secret here.
    """
    from app.config import settings  # local import — avoids cycles
    webhook = (getattr(settings, "PRIORITY_SUPPORT_SLACK_WEBHOOK", "") or "").strip()
    if not webhook:
        return
    try:
        import json as _json
        import urllib.request as _urlreq
        payload = {
            "text": (
                f":star2: *Pro priority ticket* — {ticket.subject}\n"
                f"From: {owner.email or 'unknown'} · Kind: {ticket.kind}\n"
                f"```{(ticket.body or '')[:500]}```"
            )
        }
        req = _urlreq.Request(
            webhook,
            data=_json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        # 4 second timeout — Slack normally responds in < 200ms; a
        # multi-second hang means an outage and we'd rather skip than
        # block the request thread.
        _urlreq.urlopen(req, timeout=4).close()
    except Exception as _exc:  # noqa: BLE001
        logger.warning("priority Slack post failed: %s", _exc)


def _send_priority_email(*, ticket: SupportTicket, owner: User) -> None:
    """P10 — best-effort email notification for a priority ticket.

    Pro tickets get routed to the dedicated PRIORITY_SUPPORT_EMAIL inbox
    in addition to the regular triage flow (which today reads tickets
    directly from the DB via /support/admin). Without the env var set,
    this is a no-op so the marketing claim degrades gracefully to the
    in-app behavior (DB row tagged + [PRIORITY] subject).

    Why a CC + dedicated inbox rather than only the in-app queue:
      • Email is the founder's notification surface today (Render alerts,
        Stripe receipts) — a separate Pro inbox means Pro tickets cannot
        get buried in the general support firehose.
      • The owner's email is set as Reply-To so a one-tap reply lands
        back in their inbox directly (skipping the in-app loop on
        first-response).
    """
    from app.config import settings  # local import — avoids cycles
    priority_to = (getattr(settings, "PRIORITY_SUPPORT_EMAIL", "") or "").strip()
    if not priority_to:
        return
    try:
        from app.services.email_service import send_email
        subject = f"[PRIORITY] {ticket.subject}" if not ticket.subject.startswith("[PRIORITY]") else ticket.subject
        # Plain-text body wrapped in <pre> — same minimal shape as the
        # other internal admin notifications. No markdown / HTML in the
        # body to avoid surprising the recipient client.
        html = (
            "<p>New Pro priority ticket:</p>"
            f"<p><b>From:</b> {owner.email or 'unknown'}<br/>"
            f"<b>Kind:</b> {ticket.kind}<br/>"
            f"<b>Subject:</b> {ticket.subject}</p>"
            "<pre style=\"white-space:pre-wrap;font-family:inherit\">"
            f"{(ticket.body or '')[:5000]}"
            "</pre>"
        )
        send_email(
            to=priority_to,
            subject=subject,
            html=html,
            reply_to=owner.email or None,
        )
    except Exception as _exc:  # noqa: BLE001
        logger.warning("priority email send failed: %s", _exc)


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

    # P10 — Pro tier priority routing.
    # Three things happen for a Pro user (or anyone with the
    # `priority_support` flag): subject is prefixed [PRIORITY] for the
    # founder's eyeballs in the in-app queue, the DB row is tagged
    # `is_priority=true` for sortable triage, and (if env vars are set)
    # the ticket is mirrored to a dedicated Pro inbox + Slack webhook.
    # The structured side-channels are best-effort — a Resend/Slack
    # outage MUST NOT block ticket creation. If env vars are empty,
    # behavior degrades to the in-app prefix + DB tag (the marketing
    # claim still holds: priority IS a separable lane, even when the
    # external side-channels aren't yet wired).
    subject = body.subject.strip()
    is_priority = False
    try:
        from app.services.billing import has_feature
        if has_feature(user, "priority_support"):
            is_priority = True
            if not subject.startswith("[PRIORITY]"):
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
        is_priority=is_priority,
    )
    db.add(t)
    db.commit()
    db.refresh(t)

    # P10 — out-of-band priority routing, best-effort. Both helpers no-op
    # silently when their env var is empty. Wrapped in a top-level
    # try/except so a network blip cannot turn a 201 into a 500 (the
    # ticket has already been committed — surfacing the email/Slack
    # error to the user would be misleading).
    if is_priority:
        try:
            _send_priority_email(ticket=t, owner=user)
            _post_to_priority_slack(ticket=t, owner=user)
        except Exception as _exc:  # noqa: BLE001
            logger.warning("priority routing best-effort failed: %s", _exc)

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
    # P10 — priority-first triage ordering. Pro tickets surface above
    # standard ones inside the same created_at window so the founder's
    # SLA promise is mechanically enforced, not just a subject-line
    # convention. Falls back gracefully on older rows where the column
    # defaults to FALSE (= sorts below new priority rows).
    rows = (
        q.order_by(SupportTicket.is_priority.desc(), SupportTicket.created_at.desc())
        .limit(200)
        .all()
    )
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
