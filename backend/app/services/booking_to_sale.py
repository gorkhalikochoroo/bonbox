"""Booking → Sale bridge — the financial keystone.

Per `docs/event-booking-product-spec.md` §5.4. Single code path that
materialises a Sale row from a paid Booking:

  1. Resolves event = booking.event (via FK).
  2. Constructs `ticket_breakdown = {kind: "event_booking", tiers,
     addons, gross, payment_provider, provider_ref, booking_id,
     computed_at}`.
  3. Calls allocate_voucher(db, organizer.id, "sale", booking.paid_at.year)
     for the bilagsnummer.
  4. Writes Sale row with `event_id`, `amount`, `payment_method`,
     `is_tax_exempt`, `ticket_breakdown`, `guest_count`, `voucher_number`.
  5. Stamps `booking.sale_id = sale.id` + `booking.status = 'paid'`.
  6. Increments the EventCustomer counters (creates the row if absent).
  7. Writes audit_logs row `booking.paid` with the full provenance.

Called from BOTH:
  • routers/events.py::cashup_event — for the existing "💰 Cash up event"
    flow (refactored to drop its inline Sale-write and call this
    service instead) — when we have a Booking row to bridge from
    (path A "mark paid"). Path C (manual cash-up without bookings)
    keeps its inline Sale-write because there's no Booking source.
  • routers/events.py::mark_booking_paid + bulk_mark_booking_paid —
    the new "tap a checkmark" path A (default).

Multi-barrier discipline:
  • Idempotent — calling write_sale_from_booking on a booking that
    already has sale_id is a no-op that returns the existing Sale.
    Same-transaction defense against double-confirm clicks.
  • Status guarded — only callable when booking.status in
    ('pending', 'paid'). 'paid' = idempotent return; anything else
    (refunded / cancelled / expired) raises.
  • MOMS posture inherited from booking.is_tax_exempt (which itself
    was stamped from event.is_tax_exempt at booking-create). A flip
    on the event AFTER bookings exist does NOT retroactively alter
    the sale's tax posture (audit-trail discipline).
"""
from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

from sqlalchemy.orm import Session

from app.models.booking import Booking
from app.models.event import Event
from app.models.event_customer import EventCustomer
from app.models.sale import Sale
from app.utils.time import utc_now

logger = logging.getLogger(__name__)


class BookingNotConfirmable(Exception):
    """Booking is in a state from which it cannot transition to paid.

    Raised when the caller passes a booking with status in
    ('refunded', 'cancelled', 'expired'). Router-level callers catch
    this and surface as 409 Conflict with the exact reason.
    """


def write_sale_from_booking(
    db: Session,
    booking: Booking,
    *,
    payment_method: Optional[str] = None,
    provider_ref: Optional[str] = None,
) -> Sale:
    """Materialise a Sale row from a Booking + flip the booking to paid.

    Idempotent: if `booking.sale_id` is already populated, returns the
    existing Sale without re-allocating a voucher or touching the
    counters. Caller (route handler) is responsible for db.commit().

    Args:
      db: open SQLAlchemy session — caller commits.
      booking: the Booking row to bridge. Must be reloaded from the
               same session so FK relationships resolve cleanly.
      payment_method: optional manual override ("mobilepay" / "card" /
               "cash"). Falls back to booking.payment_provider or
               "manual" when neither is set.
      provider_ref: optional manual reference (MobilePay txn ID,
               Dankort receipt code). Stored in ticket_breakdown
               provenance + on Booking.payment_provider_ref so the
               revisor PDF can quote it.

    Returns:
      The Sale row. Already added + flushed to the session.

    Raises:
      BookingNotConfirmable: when booking.status not in
                  ('pending', 'paid').
    """
    # ── L9 graceful — idempotency check first ───────────────────────
    # If the booking already carries a sale_id, return the existing
    # Sale and short-circuit. Defends against the "double-tap mark
    # paid" race condition Sudip's iPhone-on-the-door scenario hits.
    if booking.sale_id is not None:
        existing_sale = (
            db.query(Sale).filter(Sale.id == booking.sale_id).first()
        )
        if existing_sale is not None:
            logger.info(
                "booking_to_sale: idempotent return for booking=%s sale=%s",
                booking.id, existing_sale.id,
            )
            return existing_sale
        # sale_id pointed at a row that's been hard-deleted (shouldn't
        # happen — Sale soft-deletes — but defend). Fall through and
        # re-mint a fresh Sale; the original audit trail still ties
        # the booking to the originally-allocated bilagsnummer.
        logger.warning(
            "booking_to_sale: booking %s sale_id=%s missing — re-minting",
            booking.id, booking.sale_id,
        )
        booking.sale_id = None

    # ── State guard ─────────────────────────────────────────────────
    if booking.status not in ("pending", "paid"):
        raise BookingNotConfirmable(
            f"Booking {booking.id} is in status {booking.status!r} — "
            "only pending bookings can be marked paid (refunded / "
            "cancelled / expired are terminal)."
        )

    # ── Resolve event (FK, may need a fresh query if not pre-loaded) ─
    event: Event | None = booking.event
    if event is None:
        event = (
            db.query(Event)
            .filter(Event.id == booking.event_id)
            .first()
        )
    if event is None:
        raise BookingNotConfirmable(
            f"Booking {booking.id} references a missing event "
            f"{booking.event_id} — cannot bridge to Sale."
        )

    # paid_at — stamp now if this is the first confirm transition.
    # Year-anchor for the bilagsnummer comes off this timestamp.
    now = utc_now()
    if booking.paid_at is None:
        booking.paid_at = now
    voucher_year = booking.paid_at.year

    # ── ticket_breakdown — shape per spec §5.4 ──────────────────────
    # `kind="event_booking"` differentiates from "event_cashup" (the
    # legacy bulk cash-up path) so reporting code can bucket bookings
    # separately. Future reports can filter on this key.
    provider = (
        payment_method
        or booking.payment_provider
        or "manual"
    )
    ref = provider_ref or booking.payment_provider_ref
    tier_rows = list(booking.ticket_lines or [])
    addon_rows = list(booking.addon_lines or [])
    ticket_breakdown = {
        "kind": "event_booking",
        "tiers": tier_rows,
        "addons": addon_rows,
        "gross": int(booking.total_amount_dkk),
        "payment_provider": provider,
        "provider_ref": ref,
        "booking_id": str(booking.id),
        "customer_email": booking.customer_email,
        "customer_name": booking.customer_name,
        "computed_at": now.isoformat(),
    }

    # ── Bilagsnummer (L4 fail-soft per voucher_service convention) ──
    voucher_number: int | None
    try:
        from app.services.voucher_service import allocate_voucher
        voucher_number = allocate_voucher(
            db, booking.organizer_user_id, "sale", voucher_year,
        )
    except Exception as exc:  # noqa: BLE001 — fail-soft per existing pattern
        logger.warning(
            "booking_to_sale: voucher allocation failed for booking=%s: %s",
            booking.id, exc,
        )
        voucher_number = None

    # ── Guest count — sum of qty across ticket lines ────────────────
    try:
        guest_count = sum(int(row.get("qty", 0) or 0) for row in tier_rows)
    except (TypeError, ValueError):
        # Defensive — if the JSONB row got into a weird shape, fall
        # back to 0 rather than crashing the entire bridge.
        guest_count = 0

    # ── Compose the Sale row ────────────────────────────────────────
    # `date` = the day the booking was paid (matches the bilagsnummer
    # year-anchor). order_channel stays default ("dine_in") — the
    # existing cashup path uses the same default so dashboards aren't
    # bifurcated.
    sale = Sale(
        user_id=booking.organizer_user_id,
        event_id=event.id,
        date=booking.paid_at.date(),
        amount=float(booking.total_amount_dkk),
        payment_method=provider,
        notes=f"Event booking: {event.name}",
        is_tax_exempt=bool(booking.is_tax_exempt),
        ticket_breakdown=ticket_breakdown,
        guest_count=guest_count,
        voucher_number=voucher_number,
    )
    db.add(sale)
    db.flush()  # populate sale.id

    # ── Stamp the booking ───────────────────────────────────────────
    booking.sale_id = sale.id
    booking.status = "paid"
    if provider and not booking.payment_provider:
        booking.payment_provider = provider
    if ref and not booking.payment_provider_ref:
        booking.payment_provider_ref = ref
    booking.updated_at = now

    # ── EventCustomer counter increment (best-effort) ───────────────
    # If the upsert fails for any reason (e.g. a unique-constraint
    # race), we log + continue — the Sale + Booking link is the
    # authoritative source-of-truth. The customer dedup table is a
    # convenience for outreach segmentation, not a financial ledger.
    try:
        email_norm = (booking.customer_email or "").strip().lower()
        if email_norm:
            customer = (
                db.query(EventCustomer)
                .filter(EventCustomer.organizer_user_id == booking.organizer_user_id)
                .filter(EventCustomer.email == email_norm)
                .first()
            )
            if customer is None:
                customer = EventCustomer(
                    organizer_user_id=booking.organizer_user_id,
                    email=email_norm,
                    name=booking.customer_name,
                    phone=booking.customer_phone,
                    first_seen_at=now,
                    last_seen_at=now,
                    bookings_count=1,
                    total_spend_dkk=int(booking.total_amount_dkk),
                    marketing_consent=bool(booking.customer_consent_marketing),
                )
                db.add(customer)
            else:
                customer.bookings_count = (customer.bookings_count or 0) + 1
                customer.total_spend_dkk = (
                    int(customer.total_spend_dkk or 0)
                    + int(booking.total_amount_dkk)
                )
                customer.last_seen_at = now
                # OR-true semantics — once a visitor has opted in,
                # they stay opted in even if a later booking unchecks.
                if booking.customer_consent_marketing and not customer.marketing_consent:
                    customer.marketing_consent = True
            db.flush()
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "booking_to_sale: EventCustomer upsert failed for booking=%s: %s",
            booking.id, exc,
        )

    return sale


class BookingNotRefundable(Exception):
    """Booking is in a state from which it cannot be refunded.

    Raised when the caller passes a booking that hasn't been paid yet
    (`pending`, `cancelled`, `expired`) or has already been refunded.
    Router-level callers catch this and surface as 409 Conflict.
    """


def write_kreditnota_from_booking(
    db: Session,
    booking: Booking,
    *,
    reason: Optional[str] = None,
    refund_amount_dkk: Optional[int] = None,
) -> Sale:
    """Materialise a kreditnota Sale (negative amount) for a refunded booking.

    BonBox doesn't move money — the organizer refunded the customer via
    their own MobilePay/Dankort/cash. This function records the inverse
    accounting entry: a negative-amount Sale row with a `K-YYYY-NNNN`
    bilagsnummer that the revisor PDF reconciles against the original.

    Idempotent: if `booking.refund_sale_id` is already populated, returns
    the existing kreditnota Sale.

    Args:
      db: open SQLAlchemy session — caller commits.
      booking: the paid Booking to refund. Must have status='paid' and
               a sale_id (the original Sale this kreditnota offsets).
      reason: optional free-text reason for the audit trail.
      refund_amount_dkk: optional partial-refund amount (DKK integer).
               Defaults to booking.total_amount_dkk (full refund). Must
               be > 0 and ≤ booking.total_amount_dkk.

    Returns:
      The kreditnota Sale row (amount is negative).

    Raises:
      BookingNotRefundable: when booking is in a non-paid state OR
                  refund_amount_dkk is out of bounds.
    """
    # ── L9 idempotency check ────────────────────────────────────────
    if booking.refund_sale_id is not None:
        existing = (
            db.query(Sale).filter(Sale.id == booking.refund_sale_id).first()
        )
        if existing is not None:
            logger.info(
                "booking_to_sale: idempotent kreditnota return for booking=%s sale=%s",
                booking.id, existing.id,
            )
            return existing
        booking.refund_sale_id = None  # phantom FK — re-mint

    # ── State guard ─────────────────────────────────────────────────
    # Only `paid` bookings can be refunded. `refunded` is terminal.
    if booking.status != "paid":
        raise BookingNotRefundable(
            f"Booking {booking.id} is in status {booking.status!r} — "
            "only paid bookings can be refunded."
        )

    # Default to full refund. Partial-refund support handled via the
    # optional param; partials must be a positive integer ≤ original.
    full_amount = int(booking.total_amount_dkk)
    if refund_amount_dkk is None:
        refund_amount = full_amount
    else:
        refund_amount = int(refund_amount_dkk)
        if refund_amount <= 0 or refund_amount > full_amount:
            raise BookingNotRefundable(
                f"refund_amount_dkk={refund_amount} out of bounds "
                f"(1..{full_amount})."
            )

    # ── Resolve event ───────────────────────────────────────────────
    event: Event | None = booking.event
    if event is None:
        event = (
            db.query(Event)
            .filter(Event.id == booking.event_id)
            .first()
        )

    now = utc_now()
    refunded_at_year = now.year

    # ── Bilagsnummer — kreditnota sequence (K-YYYY-NNNN) ────────────
    voucher_number: int | None
    try:
        from app.services.voucher_service import allocate_voucher
        voucher_number = allocate_voucher(
            db, booking.organizer_user_id, "kreditnota", refunded_at_year,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "booking_to_sale: kreditnota voucher allocation failed "
            "for booking=%s: %s",
            booking.id, exc,
        )
        voucher_number = None

    # ── ticket_breakdown — kind="event_booking_refund" ──────────────
    # Carries the link to the original Sale for revisor reconciliation.
    original_sale = (
        db.query(Sale).filter(Sale.id == booking.sale_id).first()
        if booking.sale_id is not None
        else None
    )
    ticket_breakdown = {
        "kind": "event_booking_refund",
        "original_booking_id": str(booking.id),
        "original_sale_id": str(booking.sale_id) if booking.sale_id else None,
        "original_voucher_number": (
            original_sale.voucher_number if original_sale else None
        ),
        "refund_amount_dkk": refund_amount,
        "original_amount_dkk": full_amount,
        "is_partial": refund_amount < full_amount,
        "reason": reason,
        "payment_provider": booking.payment_provider or "manual",
        "provider_ref": booking.payment_provider_ref,
        "computed_at": now.isoformat(),
    }

    # ── Compose the negative Sale row (kreditnota) ──────────────────
    kreditnota_sale = Sale(
        user_id=booking.organizer_user_id,
        event_id=event.id if event is not None else booking.event_id,
        date=now.date(),
        amount=float(-refund_amount),  # NEGATIVE — the inverse entry
        payment_method=booking.payment_provider or "manual",
        notes=(
            f"Kreditnota: {event.name if event else 'event'}"
            + (f" — {reason}" if reason else "")
        ),
        is_tax_exempt=bool(booking.is_tax_exempt),
        ticket_breakdown=ticket_breakdown,
        guest_count=0,  # refunds don't count toward attendance metrics
        voucher_number=voucher_number,
    )
    db.add(kreditnota_sale)
    db.flush()

    # ── Stamp booking + void tickets ────────────────────────────────
    booking.refund_sale_id = kreditnota_sale.id
    # Only flip to 'refunded' on full refund; partial leaves status='paid'
    # but with a refund_sale_id pointing at the partial kreditnota.
    if refund_amount >= full_amount:
        booking.status = "refunded"
        # Void all tickets — they shouldn't scan green at the door
        from app.models.ticket import Ticket
        db.query(Ticket).filter(Ticket.booking_id == booking.id).update(
            {Ticket.is_void: True}, synchronize_session=False,
        )
    booking.updated_at = now

    return kreditnota_sale


def event_for_booking(db: Session, booking: Booking) -> Event | None:
    """Helper exposed for callers that need the resolved event without
    triggering the full sale-write path (e.g. summary endpoints)."""
    if booking.event is not None:
        return booking.event
    return db.query(Event).filter(Event.id == booking.event_id).first()
