"""Reservation — a guest booking a resource for a time-range.

Covers BOTH verticals on one model:
  • restaurant table booking — party_size guests, a table for a turn-time
  • salon / clinic appointment — one client + a named service, a provider
    for the service duration

Lifecycle (status):
    requested  → guest submitted; awaiting owner approval (group/large party,
                 or businesses that run approve-everything mode)
    confirmed  → holding a resource for the slot
    seated     → guest arrived / appointment in progress
    completed  → done (counts toward show history)
    no_show    → did not arrive (feeds guest-reliability signal)
    cancelled  → guest or owner cancelled

GDPR (the part most reservation tools get wrong)
-------------------------------------------------
A reservation carries name + email + phone, and — if the guest discloses
it — **allergy information, which is Art. 9 special-category health data.**
So:
  • allergy capture is always OPTIONAL (you can't compel disclosure of
    health data) — invite, never require.
  • `purge_after` is stamped at create time (service date + the business's
    retention window). A nightly job nulls the guest PII + allergy fields
    on rows past purge_after, keeping the row for aggregate stats but
    dropping the personal data. It is never copied into analytics.

Visitor identity on the public side is a signed booking-token JWT
(app/services/qr_signer.py), not a login — same pattern as event bookings.
"""
import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, DateTime, Text, ForeignKey, Index, JSON
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class Reservation(Base):
    """A single table booking or appointment."""

    __tablename__ = "reservations"
    __table_args__ = (
        # Owner reservation book: "today's service, in time order".
        Index("ix_reservation_user_start", "user_id", "starts_at", "is_deleted"),
        # Availability engine: existing bookings on a resource for a day.
        Index("ix_reservation_resource_start", "resource_id", "starts_at"),
        # GDPR purge sweep.
        Index("ix_reservation_purge", "purge_after"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    # Assigned resource. NULL while a request is pending (no hold yet) or
    # if the owner books "any table" — auto-assigned on confirm. For a
    # combined seating this holds the PRIMARY table (the first id of
    # combined_resource_ids) for display + sort; the full set lives below and
    # the per-table holds live in reservation_occupancy.
    resource_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("bookable_resources.id"), nullable=True,
    )

    # Combined seating: the full ordered list of table ids (incl. the primary)
    # when a party was seated across two+ tables. NULL / absent for the common
    # single-table booking. This is a display convenience — the authoritative,
    # overlap-protected hold for EACH table is its own reservation_occupancy
    # row, so combining can never weaken the no-double-booking guarantee.
    combined_resource_ids: Mapped[list | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True,
    )

    # ── Guest (personal data — purged after `purge_after`) ─────────────
    guest_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    guest_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    guest_phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    guest_consent_marketing: Mapped[bool] = mapped_column(Boolean, default=False)

    # ── The booking ────────────────────────────────────────────────────
    party_size: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    starts_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    # Appointment vertical: the booked service + its length. For tables,
    # service_name is NULL and duration is the seating turn-time.
    service_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    duration_min: Mapped[int] = mapped_column(Integer, nullable=False, default=90)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="confirmed")

    # 'public' (guest via link) | 'manual' (owner typed it) | 'walk_in'.
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="public")

    # ── Allergy / dietary (Art. 9 health data — see module docstring) ──
    # Structured tag keys from app/services/allergens.py (vertical-aware:
    # EU-14 food for restaurants, care allergens for salon, medical for
    # clinic). Free-text note for anything that doesn't fit a tag.
    allergen_tags: Mapped[list | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True,
    )
    allergy_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 'preference' | 'intolerance' | 'severe' — lets staff triage the
    # dangerous ones at a glance. NULL = none disclosed.
    allergy_severity: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # Optional context the guest may add.
    occasion: Mapped[str | None] = mapped_column(String(60), nullable=True)
    guest_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── Notification bookkeeping ───────────────────────────────────────
    confirmation_sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reminder_sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # ── State transitions ──────────────────────────────────────────────
    seated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    cancel_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # ── GDPR retention (stamped at create: service date + retention_days) ─
    purge_after: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    purged_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Idempotency for public create (X-Idempotency-Key) — same key returns
    # the same reservation, never a duplicate hold.
    idempotency_key: Mapped[str | None] = mapped_column(String(80), nullable=True, unique=True)

    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)

    user: Mapped["User"] = relationship()  # type: ignore[name-defined]
    resource: Mapped["BookableResource"] = relationship()  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<Reservation {self.guest_name} party={self.party_size} @ {self.starts_at} [{self.status}]>"
