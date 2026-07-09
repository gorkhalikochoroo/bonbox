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
from app.services.admin_security import require_super_admin, _allowed_emails
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


def _admin_notify_recipients() -> list[str]:
    """Who gets emailed when ANY owner submits a ticket.

    Reuses existing config so no NEW env var is required to be notified:
      1. SUPPORT_NOTIFY_EMAIL (explicit override), else
      2. the super-admin allowlist (SUPER_ADMIN_EMAILS) — i.e. the founder.

    Returns [] when nothing is configured, in which case the notifier is
    a silent no-op (the ticket is still persisted + visible in the admin
    triage queue; email is an additive convenience, never the source of
    truth).
    """
    import os
    explicit = (os.environ.get("SUPPORT_NOTIFY_EMAIL") or "").strip()
    if explicit:
        return [explicit]
    return _allowed_emails()


def _owner_facing_reply_to() -> str | None:
    """Reply-To for OWNER-facing mail (the reply the customer receives).

    Deliberately does NOT fall back to SUPER_ADMIN_EMAILS: that allowlist is
    the founder's personal admin-LOGIN address, and stamping it as Reply-To on
    every customer reply would hand an attacker the exact account to target for
    admin takeover. Only an explicit support alias is used; with none set we
    send no Reply-To (replies go to the From noreply@ address, and the public
    support address on the Contact page stays the escape hatch). This is the
    inverse of _admin_notify_recipients, which is INBOUND (to the founder) and
    may safely use the login address as a recipient.
    """
    import os
    for var in ("SUPPORT_REPLY_TO", "SUPPORT_NOTIFY_EMAIL"):
        v = (os.environ.get(var) or "").strip()
        if v:
            return v
    return None


def _send_admin_notification(*, ticket: SupportTicket, owner: User) -> None:
    """Best-effort email to the founder for EVERY new ticket (not just Pro
    priority). Without this, a Free/Starter owner's bug report only landed
    in the DB and the founder had to remember to open the triage queue.

    Never raises: wrapped by the caller, but we also swallow here so a
    Resend blip can't turn a committed 201 into a surfaced error.

    Security: all owner-supplied text (subject / body / context / email)
    is HTML-escaped before interpolation so a crafted ticket can't inject
    markup into the founder's mail client.
    """
    recipients = _admin_notify_recipients()
    if not recipients:
        return
    import html as _html
    from app.services.email_service import send_email

    tag = "[PRIORITY] " if getattr(ticket, "is_priority", False) else ""
    subject = f"{tag}[BonBox] {ticket.kind}: {ticket.subject}"[:180]
    body_txt = _html.escape((ticket.body or "")[:5000])
    ctx_txt = _html.escape((ticket.context or "")[:2000])
    email_html = (
        "<p>New in-app support ticket:</p>"
        f"<p><b>From:</b> {_html.escape(owner.email or 'unknown')}<br/>"
        f"<b>Kind:</b> {_html.escape(ticket.kind or 'other')}<br/>"
        f"<b>Priority:</b> {'yes' if getattr(ticket, 'is_priority', False) else 'no'}<br/>"
        f"<b>Subject:</b> {_html.escape(ticket.subject or '')}</p>"
        "<pre style=\"white-space:pre-wrap;font-family:inherit\">"
        f"{body_txt}</pre>"
        f"<p style=\"color:#888;font-size:12px\">Context: {ctx_txt}</p>"
    )
    for to in recipients:
        try:
            # Reply-To = the owner, so hitting Reply in the founder's inbox
            # lands straight back with the person who reported the issue.
            send_email(to=to, subject=subject, html=email_html, reply_to=owner.email or None)
        except Exception as exc:  # noqa: BLE001
            logger.warning("support admin notify failed for %s: %s", to, exc)


def _send_owner_response_email(*, ticket: SupportTicket, owner: User) -> None:
    """Email the owner the founder's reply. Makes the SupportChip promise
    ("we'll reply by email") actually true — previously /respond only wrote
    response_text to the DB and the owner was never told.

    Best-effort + escaped, same doctrine as the admin notification.
    Reply-To is the founder's support address so the owner can reply back.
    """
    if not owner or not (owner.email or "").strip():
        return
    import html as _html
    from app.services.email_service import send_email

    # NEVER the super-admin login allowlist — see _owner_facing_reply_to.
    reply_to = _owner_facing_reply_to()
    subject = f"Re: {ticket.subject}"[:180]
    resp_txt = _html.escape((ticket.response_text or "")[:5000])
    orig_txt = _html.escape((ticket.body or "")[:2000])
    email_html = (
        "<p>Hi,</p>"
        "<p>Here's a reply to the message you sent us in BonBox:</p>"
        "<pre style=\"white-space:pre-wrap;font-family:inherit;"
        "border-left:3px solid #10b981;padding-left:12px\">"
        f"{resp_txt}</pre>"
        "<hr style=\"border:none;border-top:1px solid #eee;margin:16px 0\"/>"
        "<p style=\"color:#888;font-size:12px\">"
        f"Your original message ({_html.escape(ticket.subject or '')}):<br/>{orig_txt}</p>"
    )
    try:
        send_email(to=owner.email, subject=subject, html=email_html, reply_to=reply_to)
    except Exception as exc:  # noqa: BLE001
        logger.warning("support owner response email failed: %s", exc)


def _post_to_priority_slack(*, ticket: SupportTicket, owner: User) -> None:
    """P10 — best-effort post of a priority ticket to a Slack incoming
    webhook. Never raises: a Slack outage MUST NOT block the founder's
    in-app triage. Silently no-ops when no webhook is configured.

    Posts a compact Slack message with subject, kind, owner email, and
    a link back to the admin triage UI. The webhook URL itself is the
    auth boundary — Slack signs the channel on the receiving side, so
    we don't include any signing/secret here.

    L4 — defensive entitlement check. This helper runs OUTSIDE the HTTP
    enforce_feature surface (post-commit, best-effort side-channel) so
    if the router's `if has_feature(...)` block is ever refactored away,
    this guard still ensures only paid users' tickets get routed to the
    priority Slack channel. Multi-barrier defense: the side-channel is
    the actual "premium experience", so the gate has to be HERE too.
    """
    # L4 — never let a non-priority-support user reach the Slack post.
    # has_feature is the canonical entitlement check; the router-level
    # decision sits in create_ticket but a refactor could break that
    # branch without breaking the helper call site.
    try:
        from app.services.billing import has_feature as _l4_has_feature
        if not _l4_has_feature(owner, "priority_support"):
            return
    except Exception:  # noqa: BLE001
        # Fail closed — if the entitlement check can't even RUN, don't
        # post to the priority channel. Safer to drop a notification
        # than to leak premium routing to a Free user.
        return

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

    L4 — defensive entitlement check. Same rationale as
    _post_to_priority_slack: the side-channel email IS the premium
    experience, so the gate has to be enforced here, not just at the
    router's `if has_feature` branch. Multi-barrier defense holds even
    if a future refactor accidentally always-routes tickets through
    this helper.
    """
    # L4 — never let a non-priority-support user reach the dedicated
    # Pro inbox. Fail closed if has_feature itself errors.
    try:
        from app.services.billing import has_feature as _l4_has_feature
        if not _l4_has_feature(owner, "priority_support"):
            return
    except Exception:  # noqa: BLE001
        return

    from app.config import settings  # local import — avoids cycles
    priority_to = (getattr(settings, "PRIORITY_SUPPORT_EMAIL", "") or "").strip()
    if not priority_to:
        return
    try:
        import html as _html
        from app.services.email_service import send_email
        subject = f"[PRIORITY] {ticket.subject}" if not ticket.subject.startswith("[PRIORITY]") else ticket.subject
        # Plain-text body wrapped in <pre> — same minimal shape as the
        # other internal admin notifications. Owner-supplied text is
        # HTML-escaped so a crafted ticket can't inject markup into the
        # founder's mail client.
        html = (
            "<p>New Pro priority ticket:</p>"
            f"<p><b>From:</b> {_html.escape(owner.email or 'unknown')}<br/>"
            f"<b>Kind:</b> {_html.escape(ticket.kind or 'other')}<br/>"
            f"<b>Subject:</b> {_html.escape(ticket.subject or '')}</p>"
            "<pre style=\"white-space:pre-wrap;font-family:inherit\">"
            f"{_html.escape((ticket.body or '')[:5000])}"
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

    # Founder notification for EVERY ticket (Free/Starter/Pro alike). This
    # is the "connected to my admin mail" half — without it a normal owner's
    # bug report only sat in the DB. Best-effort + wrapped: the ticket is
    # already committed, so an email blip must not turn a 201 into a 500.
    try:
        _send_admin_notification(ticket=t, owner=user)
    except Exception as _exc:  # noqa: BLE001
        logger.warning("support admin notify best-effort failed: %s", _exc)

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
#
# Guarded by require_super_admin (SUPER_ADMIN_EMAILS allowlist + role ==
# super_admin, with audit logging + generic 404). NOTE: the old guard here
# gated on a non-existent `User.is_admin` attribute → getattr default False
# → these endpoints 403'd for EVERYONE, including the founder. Fixed to the
# same guard every other /admin route uses.


@router.get("/admin/tickets")
def admin_list(
    status: str | None = Query(None),
    db: Session = Depends(get_db),
    admin: User = Depends(require_super_admin),
):
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
    # Enrich with the owner's email/id so the founder can see WHO submitted
    # (the shared owner-facing serializer omits this on purpose). Batched to
    # avoid an N+1 across the triage list.
    user_ids = {t.user_id for t in rows}
    emails: dict = {}
    if user_ids:
        for uid, email in db.query(User.id, User.email).filter(User.id.in_(user_ids)).all():
            emails[uid] = email

    def _admin_row(t: SupportTicket) -> dict:
        d = _serialise(t)
        d["user_id"] = str(t.user_id) if t.user_id else None
        d["owner_email"] = emails.get(t.user_id)
        d["context"] = t.context
        return d

    return {"tickets": [_admin_row(t) for t in rows], "count": len(rows)}


class RespondBody(BaseModel):
    response_text: str = Field(..., min_length=1, max_length=5000)
    close: bool = True


@router.post("/admin/tickets/{ticket_id}/respond")
def admin_respond(
    ticket_id: str,
    body: RespondBody,
    db: Session = Depends(get_db),
    admin: User = Depends(require_super_admin),
):
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

    # Close the loop with the owner — email them the reply so the
    # SupportChip's "we'll reply by email" promise is actually kept.
    # Best-effort: the response is already committed, so a mail blip (or the
    # owner lookup itself) must not fail the request. Looked up server-side,
    # never trusted from the client — and inside the try so a post-commit DB
    # blip can't turn a saved 200 into a 500.
    try:
        owner = db.query(User).filter(User.id == t.user_id).first()
        _send_owner_response_email(ticket=t, owner=owner)
    except Exception as _exc:  # noqa: BLE001
        logger.warning("support owner response email best-effort failed: %s", _exc)

    return _serialise(t)
