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
from app.schemas.event import (
    EventCashupRequest,
    EventCashupResponse,
    EventCreate,
    EventResponse,
    EventSummary,
    EventUpdate,
)
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
    # Serialize ticket_tiers for storage. Pydantic validation already
    # enforced length (1..6), label bounds, price bounds, and
    # case-insensitive uniqueness — we just need to dump to dicts so
    # the JSONB/JSON column receives plain Python types.
    tiers_payload = (
        [t.model_dump() for t in data.ticket_tiers]
        if data.ticket_tiers
        else None
    )

    ev = Event(
        user_id=user.id,
        name=data.name.strip(),
        event_date=data.event_date,
        venue=(data.venue.strip() if data.venue else None),
        notes=data.notes,
        ticket_tiers=tiers_payload,
        is_tax_exempt=bool(data.is_tax_exempt),
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
            "ticket_tiers_count": len(tiers_payload) if tiers_payload else 0,
            "is_tax_exempt": ev.is_tax_exempt,
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
        "ticket_tiers": ev.ticket_tiers,
        "is_tax_exempt": ev.is_tax_exempt,
    }

    payload = data.model_dump(exclude_unset=True)
    if "name" in payload and isinstance(payload["name"], str):
        payload["name"] = payload["name"].strip()
    if "venue" in payload and isinstance(payload["venue"], str):
        payload["venue"] = payload["venue"].strip() or None
    # `ticket_tiers` arrives as list[TicketTier] (Pydantic instances) or
    # plain dicts via model_dump. model_dump returns dicts already; the
    # JSON/JSONB column expects plain Python types so we pass through.
    # Sending `[]` clears the tiers; omitting the key leaves them
    # unchanged (exclude_unset above guarantees this).
    if "ticket_tiers" in payload and payload["ticket_tiers"] is not None:
        # Defensive: ensure dicts (handles both raw-dict path and the
        # TicketTier-instance path uniformly). Empty list stays empty.
        payload["ticket_tiers"] = [
            t if isinstance(t, dict) else t.model_dump()
            for t in payload["ticket_tiers"]
        ]
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


def _compute_event_summary(db: Session, user: User, ev: Event) -> EventSummary:
    """Build the EventSummary aggregate for one event. Pulled out so
    /cashup can return a fresh summary without an extra HTTP round-trip
    on the frontend (the EventsPage detail panel refreshes in place).

    Computed from live data — no caching. Cheap because cultural events
    cap at maybe ~200 sales / event for the target customer; we'd worry
    about caching only when a single event crosses 5-figure sale counts.
    """
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


@router.get("/{event_id}/summary", response_model=EventSummary)
def event_summary(
    event_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Aggregate read for the EventsPage detail view.

    MOMS computation here is the OWNER VIEW (a quick gut-check), not
    the accountant-grade computation. The accountant-grade total comes
    from `bookkeeping_export` / `tax_filing_pdf` which run the canonical
    Decimal math + reconciliation. Honesty check: this summary number
    can drift slightly from the PDF if the user changes MOMS-exempt
    flags after the fact, and that's fine — the PDF is source of truth.
    """
    ev = _get_owned_event(db, user, event_id, include_deleted=True)
    return _compute_event_summary(db, user, ev)


# ─── Cash-up (migration 015) ────────────────────────────────────────


@router.post(
    "/{event_id}/cashup",
    response_model=EventCashupResponse,
    status_code=status.HTTP_201_CREATED,
)
def cashup_event(
    event_id: UUID,
    data: EventCashupRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Cash up a whole event in one shot — Sudip's 30-second flow.

    Computes gross from per-tier qty × price, validates the optional
    payment_split sums (±1 DKK), allocates a bilagsnummer, writes ONE
    Sale row tagged to the event with a structured `ticket_breakdown`
    JSONB blob, and returns the Sale + fresh summary.

    Multi-barrier 10-layer doctrine (this endpoint touches money +
    revisor-bound artifacts, so it gets every layer):

      L1 — Auth: get_current_user dependency.
      L2 — Bounds: Pydantic schema enforces tier_counts 1..6, label
           1..40 chars, qty 0..9999, payment_split fields ≥0.
      L3 — Rate-limit: inherits the SlowAPI default global cap;
           per-route cap is overkill for an 8-13×/year action and
           SlowAPI is already mounted at app-level.
      L4 — Fail-soft: voucher allocation is wrapped in try/except so
           a transient sequence-fetch hiccup leaves voucher_number
           NULL rather than blocking the sale (parity with
           routers/sales.py).
      L5 — Tenant scope: _get_owned_event filters by user.id, so
           guessing an event_id from a different tenant returns 404
           (NOT 403, per IDOR convention — don't leak existence).
      L6 — Fail-closed: soft-deleted events are rejected (409). An
           event with no ticket_tiers defined is rejected (409). A
           cash-up label that doesn't match any defined tier is
           rejected (400) — the router refuses to half-commit.
      L7 — Audit row: `event.cashup` action with before/after
           snapshot of the gross + tier breakdown. Best-effort
           (audit_service swallows internal errors).
      L8 — Fallback: payment_method defaults to "mixed" when no split
           is supplied; ticket_breakdown captures provenance even
           without a split.
      L9 — Graceful HTTP: 201 Created on success; 409 for state
           conflicts (no tiers, soft-deleted); 400 for label
           mismatches and split-sum mismatch; 404 for missing event.
      L10 — Honest claims: error detail strings name the specific
           problem ("Tier 'VIP' not defined on this event"), never
           generic "validation failed". The frontend renders these
           verbatim so the owner can self-correct.
    """
    # L5 — tenant scope. include_deleted=False because L6 below would
    # reject a soft-deleted event anyway; passing False here surfaces
    # the IDOR-defended 404 sooner.
    ev = _get_owned_event(db, user, event_id, include_deleted=False)

    # L6 — Fail-closed: event must have ticket_tiers defined. Without
    # a tier catalogue we have no prices to multiply by, and falling
    # back to "ask the user for prices on every cash-up" would defeat
    # the 30-second pitch.
    tiers_raw = ev.ticket_tiers
    if not tiers_raw:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "Event has no ticket tiers defined. Edit the event "
                "and add at least one tier (label + price) before "
                "running cash-up."
            ),
        )

    # Build a label → price_dkk map for fast lookup. Case-insensitive
    # on both sides so "voksen" in the cash-up payload matches "Voksen"
    # on the event. Defensive against malformed JSON: skip rows that
    # don't have both label + price_dkk (won't happen for tiers we
    # wrote, but the DB column is intentionally loose).
    tier_prices: dict[str, int] = {}
    tier_canonical: dict[str, str] = {}  # casefold → original label
    for entry in tiers_raw:
        if not isinstance(entry, dict):
            continue
        label = entry.get("label")
        price = entry.get("price_dkk")
        if not isinstance(label, str) or not isinstance(price, (int, float)):
            continue
        key = label.casefold()
        tier_prices[key] = int(price)
        tier_canonical[key] = label

    # L6 — every label in the cash-up must exist on the event's tiers.
    # L10 — honest error: name the exact tier that's the problem.
    unknown: list[str] = []
    for row in data.tier_counts:
        if row.label.casefold() not in tier_prices:
            unknown.append(row.label)
    if unknown:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Tier(s) not defined on this event: "
                f"{', '.join(repr(u) for u in unknown)}. "
                "Update the event's ticket tiers or use one of: "
                f"{', '.join(tier_canonical.values())}."
            ),
        )

    # Compute gross + per-tier subtotals. Whole DKK throughout — tier
    # prices are int, qty is int, so the product is exact and no float
    # rounding noise enters the chain. We store float in the JSONB blob
    # only because the surrounding Sale.amount is Numeric(12,2).
    tier_breakdown_rows: list[dict] = []
    gross = 0
    for row in data.tier_counts:
        if row.qty <= 0:
            # Skip zero-qty tiers — they don't contribute to gross
            # and storing them in the breakdown would just be noise
            # ("0 × Voksen at 150" is meaningless on the revisor PDF).
            continue
        unit_price = tier_prices[row.label.casefold()]
        subtotal = unit_price * row.qty
        canonical_label = tier_canonical[row.label.casefold()]
        tier_breakdown_rows.append({
            "label": canonical_label,
            "qty": row.qty,
            "unit_price": unit_price,
            "subtotal": subtotal,
        })
        gross += subtotal

    if gross <= 0:
        # Should have been caught by Pydantic's "at least one qty > 0"
        # validator, but defend if all positive-qty rows reference
        # tiers with price=0 (free entry). The Pydantic check fires
        # before this so this is the unreachable backstop.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cash-up gross is 0 — at least one paid tier must have qty > 0.",
        )

    # L2 — payment_split sum validation. Tolerance: ±1 DKK per Manoj's
    # brief (cash-counting and card-terminal totals can drift by a
    # krone or two on real-world events). Reject anything outside the
    # tolerance so the owner can catch a typo before commit.
    payment_split_payload: dict[str, float] | None = None
    payment_method = "mixed"  # L8 — sensible fallback
    if data.payment_split is not None:
        split_total = data.payment_split.non_zero_total()
        if split_total > 0:
            if abs(split_total - gross) > 1.0:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"Payment split sums to {split_total:.0f} kr "
                        f"but cash-up gross is {gross} kr. "
                        f"Difference: {abs(split_total - gross):.0f} kr "
                        "(allowed tolerance: ±1 kr). Adjust the split."
                    ),
                )
            # Persist only the non-null/non-zero methods for a clean
            # JSONB blob — saves the revisor squinting at "online: 0".
            payment_split_payload = {
                k: float(v) for k, v in {
                    "cash": data.payment_split.cash,
                    "card": data.payment_split.card,
                    "mobilepay": data.payment_split.mobilepay,
                    "online": data.payment_split.online,
                    "mixed": data.payment_split.mixed,
                }.items()
                if v is not None and v > 0
            }
            # If a single method dominates the split, use it as the
            # Sale.payment_method so dashboards / channel reports
            # bucket the row correctly. Otherwise stay "mixed".
            dom = data.payment_split.dominant_method()
            if dom is not None and len(payment_split_payload) == 1:
                payment_method = dom

    # Sale.date — owner can override (back-fill case); default to the
    # event's date so the bilagsnummer year-bucket lines up with when
    # the event actually happened. Field is `sale_date` on the schema
    # to avoid shadowing the `date` import inside the class scope.
    sale_date = data.sale_date or ev.event_date

    # Notes — owner-supplied wins; otherwise we synthesise a clear
    # provenance line so the revisor PDF reads cleanly:
    #   "Cash-up: Nepali Movie Night"
    sale_notes = (
        data.notes.strip() if data.notes and data.notes.strip()
        else f"Cash-up: {ev.name}"
    )

    # Build the structured ticket_breakdown JSONB blob. Schema:
    #   {
    #     "kind": "event_cashup",
    #     "tiers": [{label, qty, unit_price, subtotal}],
    #     "gross": 8650,
    #     "payment_split": {cash: 2000, mobilepay: 6000, card: 650} | null,
    #     "computed_at": "2026-05-24T20:15:43Z"
    #   }
    # `kind=event_cashup` distinguishes this from a Billetto-import
    # breakdown if/when that ever populates the same column. Future
    # reporting code can filter on kind without parsing the tiers
    # array.
    ticket_breakdown = {
        "kind": "event_cashup",
        "tiers": tier_breakdown_rows,
        "gross": gross,
        "payment_split": payment_split_payload,
        "computed_at": utc_now().isoformat(),
    }

    # ── Create the Sale row ──────────────────────────────────────────
    # Mirrors routers/sales.py:create_sale so accountant-grade artifact
    # invariants hold: voucher_number allocated via the same code path,
    # event_id + ticket_breakdown populated, is_tax_exempt stamped
    # from the event's whole-event posture.
    sale = Sale(
        user_id=user.id,
        event_id=ev.id,
        date=sale_date,
        amount=float(gross),
        payment_method=payment_method,
        notes=sale_notes,
        is_tax_exempt=bool(ev.is_tax_exempt),
        ticket_breakdown=ticket_breakdown,
        # guest_count = sum of qty across all tiers — gives the
        # events/summary endpoint a guest count even before it
        # parses the ticket_breakdown JSON (defense in depth).
        guest_count=sum(r["qty"] for r in tier_breakdown_rows),
        # order_channel defaults to "dine_in" in the column default,
        # but a cultural event isn't dine-in. We don't have a
        # purpose-built "event" channel yet, and adding one would
        # require a UI sweep — for v1 stay on the default and let
        # the event_id tag drive the per-event grouping. Revisit if
        # channel-based reports get noisy for heavy event users.
    )

    # L4 — Fail-soft voucher allocation. Wrapped per the existing
    # routers/sales.py pattern: leaving voucher_number NULL is
    # preferable to refusing the sale on a transient sequence hiccup.
    try:
        from app.services.voucher_service import allocate_voucher
        sale.voucher_number = allocate_voucher(
            db, user.id, "sale", sale.date.year,
        )
    except Exception:  # noqa: BLE001
        sale.voucher_number = None

    db.add(sale)
    db.flush()  # populate sale.id for the audit row + response

    # L7 — Audit row. Both `event.cashup` and the implicit `sale.create`
    # land in audit_logs: we write event.cashup here (cash-up is the
    # business-level intent), and the Sale row itself is captured
    # because audit_service.record fires at the same DB savepoint.
    audit_service.record(
        db, user,
        action="event.cashup",
        entity_type="event",
        entity_id=ev.id,
        before={
            "event_id": str(ev.id),
            "event_name": ev.name,
        },
        after={
            "event_id": str(ev.id),
            "sale_id": str(sale.id),
            "voucher_number": sale.voucher_number,
            "gross_dkk": gross,
            "is_tax_exempt": bool(ev.is_tax_exempt),
            "tier_breakdown": tier_breakdown_rows,
            "payment_split_provided": payment_split_payload is not None,
            "payment_method": payment_method,
            "sale_date": sale.date.isoformat(),
        },
        ip_address=_client_ip(request),
    )

    db.commit()
    db.refresh(sale)
    db.refresh(ev)

    # Fresh summary so the EventsPage detail panel re-renders without
    # a second fetch. Reuses the same code path as /summary so the
    # owner sees consistent numbers.
    summary = _compute_event_summary(db, user, ev)
    return EventCashupResponse(
        sale=SaleResponse.model_validate(sale),
        summary=summary,
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
