"""Visitor-facing booking endpoints (no user auth).

Per `docs/event-booking-product-spec.md` §5.3:

  • POST /api/public/bookings              — create pending booking.
  • GET  /api/public/bookings/{id}         — visitor poll (token JWT).
  • POST /api/public/bookings/{id}/cancel  — visitor cancels pending.

Multi-barrier matrix (spec §7):
  L1 — No user auth. Identity = idempotency_key (creation) +
       booking-token JWT (subsequent reads).
  L2 — Tenant scope inherent in the booking's
       `organizer_user_id` denormalized field.
  L3 — Pydantic schema bounds (PublicBookingCreate) — max 50 tickets,
       max 6 addon lines × 50 each, email regex, name length.
  L4 — Rate limit: 6/min/IP on POST, 30/min/IP on GET, 6/min/IP on
       cancel.
  L5 — Fail-soft: DB hiccups → 503 with Danish copy.
  L6 — IDOR-safe: GET returns 404 for a UUID that doesn't match the
       token's bid (NOT 403, per spec).
  L7 — PLAN_CAPS fail-closed:
         * publish-gate enforced upstream (organizer-side).
         * Free tier's 30-ticket cap enforced HERE — visitor sees the
           generic "fully booked" 409 (no tier-leak).
  L8 — Audit: booking.created, booking.cancelled.
  L9 — Graceful HTTP: published=False → 410 Gone; soft-deleted ev →
       410; expired booking → 410.
  L10 — Honest claims: "fully booked" only when true; capacity surfaced
       only when sold ≥ 25% of capacity (handled in public_events).

NOTE: we deliberately do NOT `from __future__ import annotations` in
this module. FastAPI's body-resolver under Pydantic v2 fails to
dereference the ForwardRef('PublicBookingCreate') if PEP-563 stringly
annotations are in effect at function-definition time. See the same
note in app/schemas/booking.py.
"""
import logging
from datetime import timedelta
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Path, Request, status
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.booking import Booking
from app.models.event import Event
from app.models.ticket import Ticket
from app.models.user import User
from app.schemas.booking import (
    BookingAddonCreate,
    BookingLineCreate,
    PublicBookingCreate,
    PublicBookingResponse,
)
from app.services import audit_service
from app.services.billing import get_cap
from app.services.qr_signer import sign_booking_token, sign_ticket
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

router = APIRouter()

# Sibling router for the internal cron endpoint. Lives in this file
# for proximity (it sweeps Booking rows that the public router created),
# but mounted under a different prefix (`/api/internal/...`) in
# main.py so the path isn't `/api/public/internal/...`.
internal_router = APIRouter()

_limiter = Limiter(key_func=client_ip)


# Default pending lifetime for a booking before the expiry cron sweeps
# it back. Matches the "visitor finishes payment within 30 minutes"
# pattern that's industry standard for ticketing checkouts.
_PENDING_TTL = timedelta(minutes=30)


def _client_ip(request: Request | None) -> str | None:
    """Best-effort IP capture for the audit row."""
    if request is None:
        return None
    try:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
        return request.client.host if request.client else None
    except Exception:  # noqa: BLE001
        return None


def _resolve_published_event(db: Session, slug: str) -> Event | None:
    """L9 — only resolves published + not-deleted events."""
    return (
        db.query(Event)
        .filter(Event.slug == slug)
        .filter(Event.published.is_(True))
        .filter(Event.is_deleted.isnot(True))
        .first()
    )


def _resolve_organizer(db: Session, user_id) -> User | None:
    """Load the organizer for tier-cap lookup. None on missing."""
    return db.query(User).filter(User.id == user_id).first()


def _compute_total_dkk(
    event: Event,
    ticket_lines: list[BookingLineCreate],
    addon_lines: list[BookingAddonCreate] | None,
) -> tuple[int, list[dict], list[dict]]:
    """Cross-check labels against the event catalogue + compute gross.

    Returns:
      (total_dkk, materialised_ticket_lines, materialised_addon_lines)

    Raises HTTPException(400) on unknown labels — the visitor SPA
    should pre-validate against the public event JSON; this is the
    server-side defense-in-depth.
    """
    # Build a label → price map (case-insensitive).
    tier_prices: dict[str, int] = {}
    tier_canonical: dict[str, str] = {}
    for entry in event.ticket_tiers or []:
        if not isinstance(entry, dict):
            continue
        label = entry.get("label")
        price = entry.get("price_dkk")
        if not isinstance(label, str) or not isinstance(price, (int, float)):
            continue
        key = label.casefold()
        tier_prices[key] = int(price)
        tier_canonical[key] = label

    addon_prices: dict[str, int] = {}
    addon_canonical: dict[str, str] = {}
    for entry in event.addons or []:
        if not isinstance(entry, dict):
            continue
        label = entry.get("label")
        price = entry.get("price_dkk")
        if not isinstance(label, str) or not isinstance(price, (int, float)):
            continue
        key = label.casefold()
        addon_prices[key] = int(price)
        addon_canonical[key] = label

    # Resolve ticket lines
    total = 0
    materialised_tickets: list[dict] = []
    for line in ticket_lines:
        key = line.label.casefold()
        if key not in tier_prices:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Ukendt billettype: {line.label!r}. "
                    "Opdater siden og prøv igen."
                ),
            )
        unit = tier_prices[key]
        materialised_tickets.append({
            "label": tier_canonical[key],
            "qty": line.qty,
            "unit_price_dkk": unit,
        })
        total += unit * line.qty

    # Resolve addon lines
    materialised_addons: list[dict] = []
    if addon_lines:
        for ad in addon_lines:
            key = ad.label.casefold()
            if key not in addon_prices:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Ukendt tilvalg: {ad.label!r}. "
                        "Opdater siden og prøv igen."
                    ),
                )
            unit = addon_prices[key]
            materialised_addons.append({
                "label": addon_canonical[key],
                "qty": ad.qty,
                "unit_price_dkk": unit,
            })
            total += unit * ad.qty

    return total, materialised_tickets, materialised_addons


def _sold_tickets_count(db: Session, event: Event) -> int:
    """Sum of all live ticket counts (pending + paid + attended) for
    capacity checks. Cancelled/expired/refunded don't count."""
    rows = (
        db.query(Booking.ticket_lines)
        .filter(Booking.event_id == event.id)
        .filter(Booking.status.in_(("pending", "paid", "attended")))
        .all()
    )
    total = 0
    for (lines,) in rows:
        if isinstance(lines, list):
            for line in lines:
                if isinstance(line, dict):
                    try:
                        total += int(line.get("qty", 0) or 0)
                    except (TypeError, ValueError):
                        continue
    return total


def _to_public_response(
    booking: Booking,
    event: Event,
    *,
    booking_token: str | None,
    ticket_ids: list[UUID],
) -> PublicBookingResponse:
    """Project the booking to the visitor-safe response shape."""
    return PublicBookingResponse(
        id=booking.id,
        status=booking.status,
        event_slug=event.slug or "",
        event_name=event.name,
        customer_email=booking.customer_email,
        customer_name=booking.customer_name,
        ticket_lines=[
            BookingLineCreate(label=line["label"], qty=int(line["qty"]))
            for line in (booking.ticket_lines or [])
        ],
        addon_lines=(
            [
                BookingAddonCreate(label=ad["label"], qty=int(ad["qty"]))
                for ad in booking.addon_lines
            ]
            if booking.addon_lines
            else None
        ),
        total_amount_dkk=int(booking.total_amount_dkk),
        currency=booking.currency,
        is_tax_exempt=bool(booking.is_tax_exempt),
        expires_at=booking.expires_at,
        paid_at=booking.paid_at,
        booking_token=booking_token,
        ticket_ids=ticket_ids,
    )


# ─── POST — create booking ───────────────────────────────────────────


@router.post("/bookings", response_model=PublicBookingResponse, status_code=201)
@_limiter.limit("6/minute")
def create_booking(
    request: Request,
    data: PublicBookingCreate = Body(...),
    db: Session = Depends(get_db),
):
    """Create a pending booking against a published event.

    L1: no auth (visitor identity = idempotency_key + booking-token).
    """
    now = utc_now()

    # Idempotency — same key returns the prior booking unchanged.
    if data.idempotency_key:
        prior = (
            db.query(Booking)
            .filter(Booking.idempotency_key == data.idempotency_key)
            .first()
        )
        if prior is not None:
            event = (
                db.query(Event).filter(Event.id == prior.event_id).first()
            )
            ticket_ids = [
                t.id for t in
                db.query(Ticket).filter(Ticket.booking_id == prior.id).all()
            ]
            return _to_public_response(
                prior,
                event or Event(name="", slug=data.event_slug),  # type: ignore[arg-type]
                booking_token=sign_booking_token(str(prior.id)),
                ticket_ids=ticket_ids,
            )

    # L9 — published/not-deleted gate (410 Gone, not 404).
    try:
        event = _resolve_published_event(db, data.event_slug)
    except Exception as exc:  # noqa: BLE001 — L5 fail-soft
        logger.exception("public_bookings.create_booking: DB failure: %s", exc)
        return JSONResponse(
            status_code=503,
            content={
                "error": "service_unavailable",
                "message": "BonBox er midlertidigt utilgængelig. Prøv igen om et øjeblik.",
            },
        )
    if event is None:
        raise HTTPException(
            status_code=410,
            detail={
                "error": "event_not_available",
                "message": "Dette arrangement er ikke længere tilgængeligt.",
            },
        )

    # L9 — booking window discipline.
    if event.bookings_open_at and event.bookings_open_at > now:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "bookings_not_open",
                "message": "Booking er ikke åbnet endnu.",
                "opens_at": event.bookings_open_at.isoformat(),
            },
        )
    if event.bookings_close_at and event.bookings_close_at <= now:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "bookings_closed",
                "message": "Booking er lukket for dette arrangement.",
            },
        )

    # Cross-check labels + compute gross.
    total_dkk, ticket_lines, addon_lines = _compute_total_dkk(
        event, data.ticket_lines, data.addon_lines,
    )

    # L7 — capacity check: organizer's capacity_total AND the
    # tier cap (Free=30, Starter/Pro=-1). The visitor never sees a
    # tier-leak — both branches return the same generic 409.
    new_ticket_qty = sum(int(line.get("qty", 0)) for line in ticket_lines)
    sold = _sold_tickets_count(db, event)
    organizer = _resolve_organizer(db, event.user_id)

    # Tier cap from PLAN_CAPS.
    tier_cap = -1
    if organizer is not None:
        tier_cap = get_cap(organizer, "bookings_per_event_max")
    effective_cap = None
    if tier_cap >= 0:
        effective_cap = tier_cap
    if event.capacity_total and event.capacity_total > 0:
        if effective_cap is None:
            effective_cap = event.capacity_total
        else:
            effective_cap = min(effective_cap, event.capacity_total)
    if effective_cap is not None and sold + new_ticket_qty > effective_cap:
        raise HTTPException(
            status_code=409,
            detail={
                "error": "event_sold_out",
                "message": (
                    "Dette arrangement er fuldt booket. "
                    "Kontakt arrangøren for flere pladser."
                ),
            },
        )

    # L3 — addon gate for Free tier handled implicitly: Free events
    # have addons=NULL, so any addon_line submitted would fail the
    # label cross-check above. Defense-in-depth — even if the
    # organizer somehow stored addons on a Free event, the visitor
    # path would still reject unknown addon labels.

    # ── Materialise the Booking row ────────────────────────────────
    booking = Booking(
        event_id=event.id,
        organizer_user_id=event.user_id,
        customer_email=data.customer_email,
        customer_name=data.customer_name,
        customer_phone=data.customer_phone,
        customer_consent_marketing=bool(data.customer_consent_marketing),
        ticket_lines=ticket_lines,
        addon_lines=addon_lines or None,
        total_amount_dkk=int(total_dkk),
        currency="DKK",
        is_tax_exempt=bool(event.is_tax_exempt),
        status="pending",
        idempotency_key=data.idempotency_key,
        expires_at=now + _PENDING_TTL,
    )
    db.add(booking)
    db.flush()  # populate booking.id

    # Pre-allocate Ticket rows + sign QR JWTs. We pre-allocate at
    # booking-create rather than on paid so the door-scan endpoint
    # works on Path A "mark paid" → no extra round-trip to re-mint.
    ticket_ids: list[UUID] = []
    for line in ticket_lines:
        label = line["label"]
        unit = int(line["unit_price_dkk"])
        for _ in range(int(line["qty"])):
            ticket = Ticket(
                booking_id=booking.id,
                event_id=event.id,
                tier_label=label,
                tier_price_dkk=unit,
                # Sign with the ticket's id assigned after flush below.
                qr_payload="",
            )
            db.add(ticket)
            db.flush()
            ticket.qr_payload = sign_ticket(
                ticket_id=str(ticket.id),
                event_id=str(event.id),
                event_ends_at=event.ends_at,
            )
            ticket_ids.append(ticket.id)
    db.flush()

    # L8 — audit booking.created.
    audit_service.record(
        db,
        booking.organizer_user_id,
        action="booking.created",
        entity_type="booking",
        entity_id=booking.id,
        after={
            "event_id": str(event.id),
            "event_slug": event.slug,
            "customer_email": booking.customer_email,
            "ticket_count": new_ticket_qty,
            "total_dkk": int(booking.total_amount_dkk),
            "is_tax_exempt": bool(booking.is_tax_exempt),
        },
        actor_type="system.public_booking",
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(booking)

    token = sign_booking_token(str(booking.id))
    return _to_public_response(
        booking, event, booking_token=token, ticket_ids=ticket_ids,
    )


# ─── GET — visitor poll ──────────────────────────────────────────────


@router.get("/bookings/{booking_id}", response_model=PublicBookingResponse)
@_limiter.limit("30/minute")
def get_booking(
    request: Request,  # noqa: ARG001 — required by slowapi key_func
    booking_id: UUID = Path(...),
    token: str | None = None,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """Visitor poll. Requires the booking-token JWT (?token=... OR
    Authorization: Bearer ...). 404 for any token mismatch (L6 IDOR
    convention — never 403).
    """
    from app.services.qr_signer import verify_booking_token

    raw = token
    if not raw and authorization and authorization.lower().startswith("bearer "):
        raw = authorization.split(" ", 1)[1].strip()
    bid = verify_booking_token(raw) if raw else None
    if not bid or bid != str(booking_id):
        # IDOR-safe — never 403, always 404.
        raise HTTPException(status_code=404, detail="Booking not found")

    booking = (
        db.query(Booking)
        .filter(Booking.id == booking_id)
        .filter(Booking.is_deleted.isnot(True))
        .first()
    )
    if booking is None:
        raise HTTPException(status_code=404, detail="Booking not found")
    event = db.query(Event).filter(Event.id == booking.event_id).first()
    if event is None:
        raise HTTPException(status_code=410, detail="Event no longer available")
    ticket_ids = [
        t.id for t in db.query(Ticket).filter(Ticket.booking_id == booking.id).all()
    ]
    # No token rotation on read — same token continues to work.
    return _to_public_response(
        booking, event, booking_token=raw, ticket_ids=ticket_ids,
    )


# ─── POST — visitor cancels pending ─────────────────────────────────


@router.post("/bookings/{booking_id}/cancel", response_model=PublicBookingResponse)
@_limiter.limit("6/minute")
def cancel_booking(
    request: Request,
    booking_id: UUID = Path(...),
    token: str | None = None,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    """Visitor self-cancels a pending booking.

    Only allowed in `pending` state — paid bookings need a refund
    via the organizer-side endpoint. Voids the pre-issued tickets.
    """
    from app.services.qr_signer import verify_booking_token

    raw = token
    if not raw and authorization and authorization.lower().startswith("bearer "):
        raw = authorization.split(" ", 1)[1].strip()
    bid = verify_booking_token(raw) if raw else None
    if not bid or bid != str(booking_id):
        raise HTTPException(status_code=404, detail="Booking not found")

    booking = (
        db.query(Booking)
        .filter(Booking.id == booking_id)
        .filter(Booking.is_deleted.isnot(True))
        .first()
    )
    if booking is None:
        raise HTTPException(status_code=404, detail="Booking not found")
    if booking.status != "pending":
        raise HTTPException(
            status_code=409,
            detail={
                "error": "not_cancellable",
                "message": (
                    "Bookingen kan ikke længere annulleres direkte. "
                    "Kontakt arrangøren for refundering."
                ),
                "current_status": booking.status,
            },
        )
    now = utc_now()
    booking.status = "cancelled"
    booking.updated_at = now
    # Void pre-issued tickets.
    voided = 0
    for t in db.query(Ticket).filter(Ticket.booking_id == booking.id).all():
        if not t.is_void:
            t.is_void = True
            voided += 1
    audit_service.record(
        db,
        booking.organizer_user_id,
        action="booking.cancelled",
        entity_type="booking",
        entity_id=booking.id,
        before={"status": "pending"},
        after={
            "status": "cancelled",
            "actor": "visitor",
            "voided_tickets": voided,
        },
        actor_type="system.public_booking",
        ip_address=_client_ip(request),
    )
    db.commit()
    event = db.query(Event).filter(Event.id == booking.event_id).first()
    ticket_ids = [
        t.id for t in db.query(Ticket).filter(Ticket.booking_id == booking.id).all()
    ]
    return _to_public_response(
        booking,
        event or Event(name="", slug=""),  # type: ignore[arg-type]
        booking_token=raw,
        ticket_ids=ticket_ids,
    )


# ─── Internal cron — pending sweep ──────────────────────────────────


@internal_router.post("/booking-expiry-tick")
def booking_expiry_tick(
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Sweep pending bookings past their expires_at to `expired`.

    Auth: X-Cron-Secret header must match BONBOX_CRON_SECRET env var.
    Returns 401 on miss. Idempotent — re-running is a no-op.
    """
    import os

    expected = (os.environ.get("BONBOX_CRON_SECRET") or "").strip()
    actual = (request.headers.get("X-Cron-Secret") or "").strip()
    if not expected or not actual:
        raise HTTPException(status_code=401, detail="Unauthorized")
    # Constant-time compare (avoid early-exit timing leak).
    import hmac
    if not hmac.compare_digest(expected.encode(), actual.encode()):
        raise HTTPException(status_code=401, detail="Unauthorized")

    from app.services.booking_expiry import sweep_expired_pending

    outcome = sweep_expired_pending(db)
    db.commit()
    return outcome
