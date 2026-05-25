"""Ticket ORM — one row per individual ticket issued by a Booking.

Per `docs/event-booking-product-spec.md` §5.1. A booking of 4 tickets
fans into 4 Ticket rows so the door-scan endpoint can mark each one
attended idempotently. The tier label + frozen price ride on the
Ticket row so the visitor's web ticket page (/t/{id}) can render the
specific tier they purchased even if the Event's `ticket_tiers` array
later changes.

QR payload:
  qr_payload is the encoded JWT string (NOT a raw image) — image
  generation is render-time at the email + /t/{id} endpoint. Payload
  shape:
      {"tid": str(ticket.id), "eid": str(event.id),
       "exp": event.ends_at + 6h, "sub": "bonbox-ticket"}
  HS256-signed by services/qr_signer.py.

Scan flow:
  POST /api/tickets/{id}/scan (organizer-auth, L4-rate-limited 120/min).
  Idempotent — re-scanning a `scanned_at`-stamped ticket returns the
  prior result without altering it. Defense against the door rush
  where a scanner might double-tap.

Soft-void:
  is_void = True is set when the parent Booking transitions to
  'refunded' or 'cancelled'. The ticket row stays for audit; the scan
  endpoint refuses voided tickets with a 410 Gone (L10 honest claim).
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    String,
    DateTime,
    Boolean,
    ForeignKey,
    Index,
    Integer,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class Ticket(Base):
    """One individual ticket issued by a paid (or pending) Booking."""

    __tablename__ = "tickets"
    __table_args__ = (
        # "All tickets for this booking" — for the visitor's web-ticket page
        # render + the door-scan dashboard's per-booking lookup.
        Index("ix_tickets_booking", "booking_id"),
        # "Scanned / unscanned count for this event" — drives the
        # organizer's live "47 of 80 scanned" badge on EventDetail.
        Index("ix_tickets_event_scanned", "event_id", "scanned_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        GUID(), primary_key=True, default=uuid.uuid4,
    )

    # ── Parent booking (CASCADE so refund/void chains clean up) ─────
    # NOTE: spec calls for ON DELETE CASCADE so refunding a booking
    # (which already nulls sale_id on the Sale → Booking link) takes
    # the tickets with it. In practice we void rather than delete,
    # but the constraint is here for defense-in-depth.
    booking_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("bookings.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    # Denormalized event_id so the door-scan rate-limit ("120/min per
    # event") and the per-event scanned-count query never need a JOIN
    # through bookings.
    event_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("events.id"), nullable=False, index=True,
    )

    # ── Tier provenance (frozen at issue-time) ──────────────────────
    # Same shape as Event.ticket_tiers[i]: a free-form label + a
    # whole-DKK price. Frozen here so a later tier-price change on the
    # Event doesn't retroactively alter the visitor's ticket display.
    tier_label: Mapped[str] = mapped_column(String(40), nullable=False)
    tier_price_dkk: Mapped[int] = mapped_column(Integer, nullable=False)

    # ── QR payload (JWT string, not image bytes) ────────────────────
    # Signed at ticket-create time with TICKET_SIGNING_KEY. Stored so
    # the visitor can re-render the QR from /t/{id} without us needing
    # to re-sign on every page load. Token shape documented in
    # services/qr_signer.py.
    qr_payload: Mapped[str] = mapped_column(Text, nullable=False)

    # ── Scan state (idempotent) ─────────────────────────────────────
    # NULL until the door scan succeeds. Re-scanning is a no-op that
    # returns the prior scanned_at — the scan endpoint never reverts
    # a stamped scan (audit-trail discipline).
    scanned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Which organizer/staff hit the scan endpoint. Always belongs to
    # the same tenant as Booking.organizer_user_id (verified at the
    # router layer). Null when the scan hasn't happened yet.
    scanner_user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=True,
    )

    # ── Void state ──────────────────────────────────────────────────
    # Set True when the parent booking refunds/cancels. We do NOT
    # delete the ticket row — the audit trail requires the QR payload
    # and tier_label to survive so revisor PDFs can reconstruct the
    # original sale + the kreditnota chain.
    is_void: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utc_now,
    )

    # ── Relationships ───────────────────────────────────────────────
    booking: Mapped["Booking"] = relationship(  # type: ignore[name-defined]
        "Booking", back_populates="tickets", foreign_keys=[booking_id],
    )

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        scanned = "scanned" if self.scanned_at else "issued"
        return (
            f"<Ticket {self.id} booking={self.booking_id} "
            f"tier={self.tier_label!r} {self.tier_price_dkk}kr {scanned}>"
        )
