"""Cultural-event entity CRUD (migration 013 — kulturarrangør sprint).

Built for Sudip-style customers: cultural-event organizers, mobile
vendors, pop-up shops who run a handful of one-off events per year and
need to slice their Sales/Expenses ledger by which event a row belongs
to. Distinct from `routers/event_log.py` (analytics telemetry) — both
exist because the historical naming on EventLog was unfortunate.

Endpoints:
  POST   /api/events            — create
  GET    /api/events            — list this user's events (sortable)
  GET    /api/events/{id}       — one event
  PATCH  /api/events/{id}       — partial update
  DELETE /api/events/{id}       — soft-delete (is_deleted = True)
  GET    /api/events/{id}/summary — aggregate sales / MOMS / guests / expenses

Multi-barrier doctrine (every mutation):
  L1 — Auth: get_current_user resolves owner / accountant view.
  L2 — Bounds checks: Pydantic + max_length on every text field.
  L5 — Tenant scope: every query filters by Event.user_id == user.id.
  L7 — Audit row: mutations leave an immutable AuditLog entry.
  L8 — Best-effort audit failure (audit_service.record swallows errors).

Soft-delete:
  • DELETE marks is_deleted = True + deleted_at.
  • The List endpoint excludes soft-deleted rows by default; pass
    ?include_deleted=true to see them (used by /recently-deleted-style
    admin tooling).
  • Sale.event_id FKs are ON DELETE SET NULL, so even a hard-delete
    wouldn't orphan a sale — soft-delete is the canonical pattern
    because it preserves the audit trail and lets future-you restore.
"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models.event import Event
from app.models.sale import Sale
from app.models.user import User
from app.schemas.event import EventCreate, EventResponse, EventSummary, EventUpdate
from app.schemas.sale import SaleResponse
from app.services.auth import get_current_user
from app.services import audit_service
from app.utils.time import utc_now

router = APIRouter()


# ─── Helpers ─────────────────────────────────────────────────────────


def _client_ip(request: Request | None) -> str | None:
    """Best-effort client IP for the audit row. Falls back to None when
    we're called without a request object (shouldn't happen on FastAPI
    routes but kept defensive for service-level reuse)."""
    if request is None:
        return None
    try:
        # X-Forwarded-For from the load balancer when present
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
        return request.client.host if request.client else None
    except Exception:
        return None


def _get_owned_event(
    db: Session, user: User, event_id: UUID, *, include_deleted: bool = False,
) -> Event:
    """Look up an event scoped to the owner. Raises 404 on miss.

    Defense-in-depth: even if a client guesses a UUID, the user_id filter
    guarantees they only ever see their own data. This is the multi-tenant
    boundary — it has tests in tests/test_events.py guarding it.
    """
    q = db.query(Event).filter(Event.id == event_id, Event.user_id == user.id)
    if not include_deleted:
        q = q.filter(Event.is_deleted.isnot(True))
    ev = q.first()
    if ev is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Event not found")
    return ev


# ─── CRUD ────────────────────────────────────────────────────────────


@router.post("", response_model=EventResponse, status_code=status.HTTP_201_CREATED)
def create_event(
    data: EventCreate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a new cultural event for the authenticated owner.

    The owner can pre-register events ahead of time (e.g. enter the
    season's 10 movie nights in January) so that during a busy night
    they just pick from a dropdown instead of typing a label.
    """
    ev = Event(
        user_id=user.id,
        name=data.name.strip(),
        event_date=data.event_date,
        venue=(data.venue.strip() if data.venue else None),
        notes=data.notes,
    )
    db.add(ev)
    db.flush()  # populate ev.id before audit row

    # L7 — audit row. Best-effort: audit_service swallows exceptions so a
    # transient DB issue here can never block a legitimate create.
    audit_service.record(
        db, user,
        action="event.create",
        entity_type="event",
        entity_id=ev.id,
        after={
            "id": str(ev.id),
            "name": ev.name,
            "event_date": ev.event_date.isoformat(),
            "venue": ev.venue,
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(ev)
    return ev


@router.get("", response_model=list[EventResponse])
def list_events(
    sort: str = Query("date_desc", pattern="^(date_desc|date_asc|name_asc)$"),
    include_deleted: bool = False,
    q: Optional[str] = Query(None, max_length=120),
    limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List this user's events.

    `sort=date_desc` (default) — newest first, which matches how owners
    actually scan the list ("the event I just did is what I want to
    review"). Date-asc + name-asc are offered for the dropdown in
    SalesPage which sorts alphabetically.
    """
    query = db.query(Event).filter(Event.user_id == user.id)
    if not include_deleted:
        query = query.filter(Event.is_deleted.isnot(True))
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(Event.name.ilike(like))

    if sort == "date_asc":
        query = query.order_by(Event.event_date.asc(), Event.created_at.asc())
    elif sort == "name_asc":
        query = query.order_by(func.lower(Event.name).asc())
    else:  # date_desc default
        query = query.order_by(Event.event_date.desc(), Event.created_at.desc())

    return query.limit(limit).all()


@router.get("/{event_id}", response_model=EventResponse)
def get_event(
    event_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return _get_owned_event(db, user, event_id, include_deleted=True)


@router.patch("/{event_id}", response_model=EventResponse)
def update_event(
    event_id: UUID,
    data: EventUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ev = _get_owned_event(db, user, event_id)

    before = {
        "name": ev.name,
        "event_date": ev.event_date.isoformat(),
        "venue": ev.venue,
        "notes": ev.notes,
    }

    payload = data.model_dump(exclude_unset=True)
    if "name" in payload and isinstance(payload["name"], str):
        payload["name"] = payload["name"].strip()
    if "venue" in payload and isinstance(payload["venue"], str):
        payload["venue"] = payload["venue"].strip() or None
    for field, value in payload.items():
        setattr(ev, field, value)

    audit_service.record(
        db, user,
        action="event.update",
        entity_type="event",
        entity_id=ev.id,
        before=before,
        after={**before, **payload},
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(ev)
    return ev


@router.delete("/{event_id}", status_code=status.HTTP_204_NO_CONTENT)
def soft_delete_event(
    event_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Soft-delete only. Sale.event_id FK is ON DELETE SET NULL, so even
    a hard-delete wouldn't break the historical sales — but the soft
    pattern preserves the audit trail and the option to restore."""
    ev = _get_owned_event(db, user, event_id)
    if not ev.is_deleted:
        ev.is_deleted = True
        ev.deleted_at = utc_now()
        audit_service.record(
            db, user,
            action="event.soft_delete",
            entity_type="event",
            entity_id=ev.id,
            before={"is_deleted": False},
            after={"is_deleted": True, "deleted_at": ev.deleted_at.isoformat()},
            ip_address=_client_ip(request),
        )
        db.commit()
    return None


# ─── Aggregate summary ──────────────────────────────────────────────


def _sum_ticket_counts(breakdown: dict | None) -> int:
    """Helper: sum the `count` field across every tier in a
    ticket_breakdown blob. Returns 0 for None / malformed input —
    summary endpoints must never blow up on dirty data."""
    if not isinstance(breakdown, dict):
        return 0
    total = 0
    for payload in breakdown.values():
        if isinstance(payload, dict):
            try:
                total += int(payload.get("count", 0) or 0)
            except (TypeError, ValueError):
                continue
    return total


@router.get("/{event_id}/summary", response_model=EventSummary)
def event_summary(
    event_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Aggregate read for the EventsPage detail view.

    Computed from live data — no caching. Cheap because cultural events
    cap at maybe ~200 sales / event for the target customer; we'd worry
    about caching only when a single event crosses 5-figure sale counts.

    MOMS computation here is the OWNER VIEW (a quick gut-check), not
    the accountant-grade computation. The accountant-grade total comes
    from `bookkeeping_export` / `tax_filing_pdf` which run the canonical
    Decimal math + reconciliation. Honesty check: this summary number
    can drift slightly from the PDF if the user changes MOMS-exempt
    flags after the fact, and that's fine — the PDF is source of truth.
    """
    ev = _get_owned_event(db, user, event_id, include_deleted=True)

    # ── Sales aggregates ─────────────────────────────────────────────
    sales_q = (
        db.query(Sale)
        .filter(
            Sale.user_id == user.id,
            Sale.event_id == ev.id,
            Sale.is_deleted.isnot(True),
        )
    )
    sales = sales_q.all()

    total_sales = 0.0
    total_exempt = 0.0
    total_moms = 0.0
    total_guests_from_breakdown = 0
    total_guests_fallback = 0
    moms_rate = 0.25  # DK default — accountant-grade calc lives in tax_service

    for s in sales:
        amount = float(s.amount or 0)
        total_sales += amount
        if s.is_tax_exempt:
            total_exempt += amount
        else:
            # gross-incl-moms convention: MOMS = amount * rate / (1 + rate)
            total_moms += amount * moms_rate / (1.0 + moms_rate)
        breakdown_guests = _sum_ticket_counts(s.ticket_breakdown)
        if breakdown_guests > 0:
            total_guests_from_breakdown += breakdown_guests
        elif s.guest_count:
            total_guests_fallback += int(s.guest_count or 0)

    total_guests = total_guests_from_breakdown + total_guests_fallback

    # ── Expense ties ────────────────────────────────────────────────
    # Agent Z's sprint adds Expense.event_id; until that lands we hasattr-
    # gate the lookup so this endpoint is forward-compatible without an
    # import-time dependency on a column that may not exist yet.
    expense_count = 0
    total_expense_amount = 0.0
    try:
        from app.models.expense import Expense as _Expense  # local import
        if hasattr(_Expense, "event_id"):
            expense_rows = (
                db.query(_Expense)
                .filter(
                    _Expense.user_id == user.id,
                    _Expense.event_id == ev.id,
                    _Expense.is_deleted.isnot(True),
                )
                .all()
            )
            expense_count = len(expense_rows)
            total_expense_amount = float(sum(float(e.amount or 0) for e in expense_rows))
    except Exception:  # noqa: BLE001
        # Forwards-compat defensive: never let the expense lookup take
        # down the summary endpoint. Falls back to zeros.
        expense_count = 0
        total_expense_amount = 0.0

    return EventSummary(
        event=EventResponse.model_validate(ev),
        total_sales_amount=round(total_sales, 2),
        total_moms=round(total_moms, 2),
        total_exempt_amount=round(total_exempt, 2),
        total_guests=total_guests,
        sale_count=len(sales),
        expense_count=expense_count,
        total_expense_amount=round(total_expense_amount, 2),
    )


@router.get("/{event_id}/sales", response_model=list[SaleResponse])
def event_sales(
    event_id: UUID,
    limit: int = Query(500, ge=1, le=2000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List every Sale tagged for this event. Used by EventsPage detail
    view to render the table beneath the summary cards."""
    ev = _get_owned_event(db, user, event_id, include_deleted=True)
    rows = (
        db.query(Sale)
        .filter(
            Sale.user_id == user.id,
            Sale.event_id == ev.id,
            Sale.is_deleted.isnot(True),
        )
        .order_by(Sale.date.desc(), Sale.created_at.desc())
        .limit(limit)
        .all()
    )
    return rows
