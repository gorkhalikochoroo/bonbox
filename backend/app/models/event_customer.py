"""EventCustomer ORM — one row per (organizer, unique visitor email).

Per `docs/event-booking-product-spec.md` §5.1. The de-duplicated
customer profile across bookings. Used by:

  • Pro-tier customer outreach ("regulars at risk" → re-engage email).
  • Post-event NPS / "thanks for coming" follow-ups.
  • GDPR right-to-deletion: hashes the email + redacts name/phone but
    keeps the row for the 5y financial-retention window.

Incremented on every paid booking by services/booking_to_sale.py:
  • bookings_count += 1
  • total_spend_dkk += booking.total_amount_dkk
  • last_seen_at = utc_now()

`marketing_consent` is set from the booking's
`customer_consent_marketing` checkbox (only OR-true semantics — once
opted-in, stays opted-in unless the visitor unsubscribes via the
post-event email footer).

UNIQUE (organizer_user_id, email) — same visitor across two different
organizers gets two different rows. Marketing consent is per-organizer
by design (GDPR purpose-limitation).
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
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class EventCustomer(Base):
    """De-duplicated visitor profile per organizer."""

    __tablename__ = "event_customers"
    __table_args__ = (
        # Per-organizer email uniqueness — same person across two
        # different cafés is two distinct rows. This is the visitor's
        # GDPR boundary: consent on Café A does NOT carry to Café B.
        UniqueConstraint(
            "organizer_user_id", "email",
            name="uq_event_customer_organizer_email",
        ),
        # Lookups by organizer + sorted by last_seen for the
        # "regulars" view + customer-outreach segmentation.
        Index(
            "ix_event_customer_organizer_seen",
            "organizer_user_id", "last_seen_at",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        GUID(), primary_key=True, default=uuid.uuid4,
    )

    # ── Tenant ──────────────────────────────────────────────────────
    # ON DELETE CASCADE — when a user account is deleted (hard delete,
    # not soft), wipe the customer profiles too. Bookings stay (FK
    # via Booking.organizer_user_id is the financial-retention link).
    organizer_user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    # ── Identity ────────────────────────────────────────────────────
    # email is lowercased + stripped at the write layer (router does
    # this before query / upsert).
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(40), nullable=True)

    # ── Lifecycle metadata ──────────────────────────────────────────
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utc_now,
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utc_now,
    )
    # Aggregate counters incremented atomically on booking.paid
    # (see services/booking_to_sale.py).
    bookings_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0,
    )
    total_spend_dkk: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0,
    )

    # GDPR — opt-in only. Default False; flipped to True only when the
    # visitor explicitly checks the marketing-consent box on a booking.
    # Once True, stays True until the visitor unsubscribes (sets it
    # back to False — single source of truth for outreach gating).
    marketing_consent: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False,
    )

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return (
            f"<EventCustomer {self.email} org={self.organizer_user_id} "
            f"bookings={self.bookings_count} spend={self.total_spend_dkk}>"
        )
