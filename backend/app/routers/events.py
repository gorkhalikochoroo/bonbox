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
from app.models.booking import Booking
from app.models.event import Event
from app.models.sale import Sale
from app.models.ticket import Ticket
from app.models.user import User
from app.schemas.booking import (
    BookingListResponse,
    BookingResponse,
    BulkMarkPaidRequest,
    MarkPaidRequest,
    MarkRefundedRequest,
)
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
from app.services.billing import enforce_cap, get_cap
from app.services.booking_to_sale import (
    BookingNotConfirmable,
    BookingNotRefundable,
    write_kreditnota_from_booking,
    write_sale_from_booking,
)
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

    # ── Bridge through Booking → Sale (keystone refactor 2026-05-25) ──
    # Path C cash-up (cash event without an inbound visitor booking)
    # now materialises a synthetic Booking row (`payment_provider =
    # "manual_cashup"`) and immediately bridges it to a Sale via the
    # same `write_sale_from_booking` keystone used by Path A (organizer
    # mark-paid) and the future Path B (CSV auto-match). One Sale-
    # creation code path = same bilagsnummer chain, same MOMS handling,
    # same revisor PDF shape no matter how the cash arrived.
    #
    # The synthetic Booking exists primarily for the audit chain. It
    # is stamped `paid` immediately (no visitor lifecycle) and carries
    # the per-tier rows in `ticket_lines` so revisor PDFs can still
    # quote the breakdown. customer_email is an aggregate placeholder
    # ("aggregate@bonbox.dk") because no individual visitor is involved
    # — this is the legacy cash-up flow where the organizer rang up
    # the cash on their own terminal.
    ticket_lines_payload = [
        {
            "label": row["label"],
            "qty": row["qty"],
            "unit_price_dkk": int(row["unit_price"]),
        }
        for row in tier_breakdown_rows
    ]
    now = utc_now()
    booking = Booking(
        event_id=ev.id,
        organizer_user_id=user.id,
        customer_email="aggregate@bonbox.dk",
        customer_name=f"Cashup {ev.name}"[:160],
        ticket_lines=ticket_lines_payload,
        addon_lines=None,
        total_amount_dkk=int(gross),
        currency="DKK",
        is_tax_exempt=bool(ev.is_tax_exempt),
        status="pending",
        payment_provider="manual_cashup",
        # Idempotency key includes sale_date so a second cash-up the
        # same day for the same event is distinguished from a retry.
        # Without this, accidentally double-tapping would create two
        # bookings (each with its own Sale) — which is what we want
        # the FIRST time around but want to dedupe on retries within
        # the same request session. We don't have a request-side
        # idempotency-key header on the cashup endpoint yet; the unique
        # constraint is the safety net for genuinely-double posts.
        idempotency_key=f"cashup-{ev.id}-{sale_date.isoformat()}-{int(now.timestamp())}",
    )
    db.add(booking)
    db.flush()  # populate booking.id

    sale = write_sale_from_booking(
        db,
        booking,
        payment_method=payment_method,
        provider_ref=None,
    )
    # Override sale.date with the user-provided / event-anchored date
    # (write_sale_from_booking defaults to booking.paid_at.date(); the
    # cash-up flow lets the owner back-fill). Notes stay from the
    # cashup notes (write_sale_from_booking sets a generic
    # "Event booking: <name>" — overwrite it here).
    sale.date = sale_date
    sale.notes = sale_notes
    # Annotate the breakdown so reporting can distinguish path C
    # (manual cashup) from path A (visitor mark-paid). Both still
    # carry kind="event_booking" so existing consumers see the same
    # shape; we add a sub-kind on the ticket_breakdown blob.
    # NOTE: reassign the whole dict (not just mutate in-place) so
    # SQLAlchemy's change-tracking picks up the new keys (JSON column
    # doesn't track in-place mutation by default).
    if isinstance(sale.ticket_breakdown, dict):
        breakdown = dict(sale.ticket_breakdown)
        breakdown["sub_kind"] = "event_cashup"
        breakdown["payment_split"] = payment_split_payload
        sale.ticket_breakdown = breakdown

    # L7 — Audit row. Both `event.cashup` and `booking.paid` land in
    # audit_logs: event.cashup is the business-level intent at this
    # router; booking.paid is written by the service when the keystone
    # runs (kept as a separate row so revisor PDFs can grep on either).
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
            "booking_id": str(booking.id),
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


# ─── Publish / unpublish (event-booking spec §5.3) ──────────────────


def _allocate_slug(db: Session, event: Event) -> str:
    """Generate a kebab-case slug + 4-char random suffix.

    Pattern: `nepali-movie-night-14-lakhey-7k4q`.

    Collision retry up to 3 times. If all 3 collide, raise 500 — the
    caller surfaces a friendly Danish error.
    """
    import random
    import re

    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    # Slugify the event name.
    raw = re.sub(r"[^a-z0-9]+", "-", (event.name or "event").lower()).strip("-")
    # Cap the base at 60 chars so the full slug (base + dash + 4 chars)
    # stays well under the column's 80-char limit.
    base = raw[:60] or "event"
    rng = random.SystemRandom()
    for _ in range(3):
        suffix = "".join(rng.choices(alphabet, k=4))
        candidate = f"{base}-{suffix}"
        existing = db.query(Event).filter(Event.slug == candidate).first()
        if existing is None:
            return candidate
    # All 3 attempts collided — extremely unlikely (32^4 = ~1M per
    # base). Raise so the caller can return a 500 + ask the user to
    # rename their event.
    raise HTTPException(
        status_code=500,
        detail={
            "error": "slug_collision",
            "message": (
                "Kunne ikke generere et unikt link til arrangementet. "
                "Prøv at omdøbe arrangementet og prøv igen."
            ),
        },
    )


@router.post("/{event_id}/publish", response_model=EventResponse)
def publish_event(
    event_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Allocate a slug + flip the event to published=True.

    L7 — `published_events_per_month` cap check. Free=1/mo, Starter/Pro
    unlimited. Counted by audit_logs `event.published` rows in the
    current calendar month for this user (matches the inbox cap-counter
    pattern).
    """
    ev = _get_owned_event(db, user, event_id, include_deleted=False)

    # If already published, the toggle is a no-op (idempotent — Sudip
    # tapping "Publish" twice should not consume two cap slots).
    if ev.published and ev.slug:
        return ev

    # L7 — published-events-per-month cap.
    from app.models.audit_log import AuditLog
    now = utc_now()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    publishes_this_month = (
        db.query(func.count(AuditLog.id))
        .filter(AuditLog.user_id == user.id)
        .filter(AuditLog.action == "event.published")
        .filter(AuditLog.created_at >= month_start)
        .scalar()
        or 0
    )
    enforce_cap(user, "published_events_per_month", int(publishes_this_month))

    # Allocate slug only on first-time publish; preserve a previously
    # allocated slug on re-publish (after a temporary unpublish) so
    # social-share links stay stable.
    if not ev.slug:
        ev.slug = _allocate_slug(db, ev)
    ev.published = True
    ev.published_at = ev.published_at or now
    # Sensible booking-window defaults if the organizer didn't set
    # them: open NOW, close 1h before starts_at (or 1h before event_date
    # 18:00 default if starts_at is unset). Org can edit later.
    if ev.bookings_open_at is None:
        ev.bookings_open_at = now
    if ev.bookings_close_at is None and ev.starts_at is not None:
        from datetime import timedelta
        ev.bookings_close_at = ev.starts_at - timedelta(hours=1)
    ev.updated_at = now

    audit_service.record(
        db, user,
        action="event.published",
        entity_type="event",
        entity_id=ev.id,
        after={
            "event_id": str(ev.id),
            "slug": ev.slug,
            "published_at": ev.published_at.isoformat(),
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(ev)
    return ev


@router.post("/{event_id}/unpublish", response_model=EventResponse)
def unpublish_event(
    event_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Stop accepting new bookings. Slug is preserved so existing
    /e/{slug} shares can re-resolve later if the organizer republishes.
    """
    ev = _get_owned_event(db, user, event_id, include_deleted=False)
    if not ev.published:
        # Idempotent — no audit row written for a no-op flip.
        return ev
    ev.published = False
    ev.updated_at = utc_now()
    audit_service.record(
        db, user,
        action="event.unpublished",
        entity_type="event",
        entity_id=ev.id,
        before={"published": True},
        after={"published": False, "slug": ev.slug},
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(ev)
    return ev


# ─── Organizer bookings list + mark paid ────────────────────────────


def _booking_to_response(booking: Booking) -> BookingResponse:
    """Pydantic projection that drops None-typed JSONB cells safely."""
    return BookingResponse(
        id=booking.id,
        event_id=booking.event_id,
        organizer_user_id=booking.organizer_user_id,
        customer_email=booking.customer_email,
        customer_name=booking.customer_name,
        customer_phone=booking.customer_phone,
        customer_consent_marketing=bool(booking.customer_consent_marketing),
        ticket_lines=list(booking.ticket_lines or []),
        addon_lines=list(booking.addon_lines) if booking.addon_lines else None,
        total_amount_dkk=int(booking.total_amount_dkk),
        currency=booking.currency,
        is_tax_exempt=bool(booking.is_tax_exempt),
        status=booking.status,
        payment_provider=booking.payment_provider,
        payment_provider_ref=booking.payment_provider_ref,
        paid_at=booking.paid_at,
        sale_id=booking.sale_id,
        refund_sale_id=booking.refund_sale_id,
        attended_at=booking.attended_at,
        expires_at=booking.expires_at,
        created_at=booking.created_at,
        updated_at=booking.updated_at,
    )


@router.get("/{event_id}/bookings", response_model=BookingListResponse)
def list_event_bookings(
    event_id: UUID,
    page: int = Query(1, ge=1, le=10_000),
    page_size: int = Query(50, ge=1, le=200),
    status_filter: Optional[str] = Query(None, alias="status", max_length=20),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Organizer guest list for an event. Paginated.

    L2 — tenant scope via _get_owned_event. L6 — every Booking query
    filters by organizer_user_id (denormalized so this never JOINs
    through events).
    """
    ev = _get_owned_event(db, user, event_id, include_deleted=True)

    base = (
        db.query(Booking)
        .filter(Booking.organizer_user_id == user.id)
        .filter(Booking.event_id == ev.id)
        .filter(Booking.is_deleted.isnot(True))
    )
    if status_filter:
        # Bounded set of accepted values so a hostile input can't
        # widen the filter.
        if status_filter not in (
            "pending", "paid", "attended", "refunded", "cancelled", "expired",
        ):
            raise HTTPException(
                status_code=400,
                detail=f"Unknown status filter: {status_filter!r}",
            )
        base = base.filter(Booking.status == status_filter)

    total = base.count()
    rows = (
        base.order_by(Booking.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    # Aggregate counters for the EventDetail header banner.
    paid_count = (
        db.query(func.count(Booking.id))
        .filter(Booking.organizer_user_id == user.id)
        .filter(Booking.event_id == ev.id)
        .filter(Booking.status.in_(("paid", "attended")))
        .filter(Booking.is_deleted.isnot(True))
        .scalar()
        or 0
    )
    pending_count = (
        db.query(func.count(Booking.id))
        .filter(Booking.organizer_user_id == user.id)
        .filter(Booking.event_id == ev.id)
        .filter(Booking.status == "pending")
        .filter(Booking.is_deleted.isnot(True))
        .scalar()
        or 0
    )
    paid_revenue = (
        db.query(func.coalesce(func.sum(Booking.total_amount_dkk), 0))
        .filter(Booking.organizer_user_id == user.id)
        .filter(Booking.event_id == ev.id)
        .filter(Booking.status.in_(("paid", "attended")))
        .filter(Booking.is_deleted.isnot(True))
        .scalar()
        or 0
    )

    return BookingListResponse(
        bookings=[_booking_to_response(b) for b in rows],
        total=int(total),
        page=page,
        page_size=page_size,
        paid_count=int(paid_count),
        pending_count=int(pending_count),
        paid_revenue_dkk=int(paid_revenue),
    )


# Sub-router for booking-id-scoped endpoints. Mounted with prefix
# `/api/bookings` from main.py so the routes land at the spec-mandated
# paths (`/api/bookings/{id}/mark-paid`, `/api/bookings/bulk-mark-paid`).
bookings_router = APIRouter()


@bookings_router.post("/{booking_id}/mark-paid", response_model=BookingResponse)
def mark_booking_paid(
    booking_id: UUID,
    data: MarkPaidRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Path A — organizer taps a checkmark to mark a booking paid.

    Bridges the Booking → Sale via the keystone service, allocating a
    bilagsnummer + writing the audit_logs chain. Idempotent: marking
    an already-paid booking returns the existing Sale link unchanged.
    """
    booking = (
        db.query(Booking)
        .filter(Booking.id == booking_id)
        .filter(Booking.organizer_user_id == user.id)
        .filter(Booking.is_deleted.isnot(True))
        .first()
    )
    if booking is None:
        raise HTTPException(status_code=404, detail="Booking not found")

    try:
        sale = write_sale_from_booking(
            db,
            booking,
            payment_method=data.payment_method,
            provider_ref=data.provider_ref,
        )
    except BookingNotConfirmable as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "booking_not_confirmable",
                "message": str(exc),
                "current_status": booking.status,
            },
        )

    audit_service.record(
        db, user,
        action="booking.paid",
        entity_type="booking",
        entity_id=booking.id,
        after={
            "booking_id": str(booking.id),
            "sale_id": str(sale.id),
            "voucher_number": sale.voucher_number,
            "amount_dkk": int(booking.total_amount_dkk),
            "payment_method": data.payment_method or booking.payment_provider,
            "provider_ref": data.provider_ref,
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(booking)
    return _booking_to_response(booking)


@bookings_router.post("/bulk-mark-paid")
def bulk_mark_booking_paid(
    data: BulkMarkPaidRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Batch Path A — organizer ticks N rows in the guest list.

    Per-row try/except so one bad booking can't take down the batch.
    Returns a structured outcome list with per-row status.
    """
    outcomes: list[dict] = []
    succeeded = 0
    for bid in data.booking_ids:
        booking = (
            db.query(Booking)
            .filter(Booking.id == bid)
            .filter(Booking.organizer_user_id == user.id)
            .filter(Booking.is_deleted.isnot(True))
            .first()
        )
        if booking is None:
            outcomes.append({"booking_id": str(bid), "status": "not_found"})
            continue
        try:
            sale = write_sale_from_booking(
                db, booking, payment_method=data.payment_method,
            )
            audit_service.record(
                db, user,
                action="booking.paid",
                entity_type="booking",
                entity_id=booking.id,
                after={
                    "booking_id": str(booking.id),
                    "sale_id": str(sale.id),
                    "voucher_number": sale.voucher_number,
                    "amount_dkk": int(booking.total_amount_dkk),
                    "bulk": True,
                },
                ip_address=_client_ip(request),
            )
            outcomes.append({
                "booking_id": str(booking.id),
                "status": "ok",
                "sale_id": str(sale.id),
                "voucher_number": sale.voucher_number,
            })
            succeeded += 1
        except BookingNotConfirmable as exc:
            outcomes.append({
                "booking_id": str(booking.id),
                "status": "skipped",
                "reason": str(exc),
            })
    db.commit()
    return {
        "requested": len(data.booking_ids),
        "succeeded": succeeded,
        "outcomes": outcomes,
    }


@bookings_router.post("/{booking_id}/mark-refunded", response_model=BookingResponse)
def mark_booking_refunded(
    booking_id: UUID,
    data: MarkRefundedRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mark a paid booking as refunded — organizer self-service kreditnota.

    BonBox doesn't move money. The organizer refunded the customer via
    their own MobilePay / Dankort / cash. This endpoint just records the
    inverse accounting entry: a negative-amount Sale row with a
    K-YYYY-NNNN bilagsnummer that the revisor PDF reconciles against
    the original Sale.

    Full refund (default): booking.status flips to 'refunded', all
    tickets get voided so they no longer scan green at the door.
    Partial refund (refund_amount_dkk < total): booking.status stays
    'paid' with refund_sale_id pointing at the partial kreditnota.

    Idempotent: calling on an already-refunded booking returns the
    existing kreditnota Sale unchanged.

    L1-L10 doctrine:
      L1: get_current_user
      L2: organizer_user_id filter (no cross-tenant refund)
      L3: Pydantic bounds — reason ≤ 500 char, refund_amount_dkk > 0
      L6: tenant scope on the booking query
      L8: audit_logs `booking.refunded` with kreditnota provenance
      L9: idempotent via refund_sale_id check inside the service
      L10: BookingNotRefundable surfaces as 409 with current_status
    """
    booking = (
        db.query(Booking)
        .filter(Booking.id == booking_id)
        .filter(Booking.organizer_user_id == user.id)
        .filter(Booking.is_deleted.isnot(True))
        .first()
    )
    if booking is None:
        raise HTTPException(status_code=404, detail="Booking not found")

    try:
        kreditnota_sale = write_kreditnota_from_booking(
            db,
            booking,
            reason=data.reason,
            refund_amount_dkk=data.refund_amount_dkk,
        )
    except BookingNotRefundable as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "booking_not_refundable",
                "message": str(exc),
                "current_status": booking.status,
            },
        )

    is_partial = (
        data.refund_amount_dkk is not None
        and int(data.refund_amount_dkk) < int(booking.total_amount_dkk)
    )

    audit_service.record(
        db, user,
        action="booking.refunded",
        entity_type="booking",
        entity_id=booking.id,
        after={
            "booking_id": str(booking.id),
            "kreditnota_sale_id": str(kreditnota_sale.id),
            "kreditnota_voucher_number": kreditnota_sale.voucher_number,
            "refund_amount_dkk": int(abs(kreditnota_sale.amount)),
            "original_amount_dkk": int(booking.total_amount_dkk),
            "is_partial": is_partial,
            "reason": data.reason,
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(booking)
    return _booking_to_response(booking)
