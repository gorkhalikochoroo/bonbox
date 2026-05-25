"""Booking ORM — public-facing event ticket reservations (v3 ledger-only).

Per `docs/event-booking-product-spec.md` §5.1. The Booking row is the
durable record across the visitor lifecycle:

    pending → paid → attended
                 ↘ refunded
                 ↘ cancelled
                 ↘ expired

Created on POST /api/public/bookings (no user auth; idempotency_key +
booking-token JWT). Promoted to `paid` when the organizer marks it paid
in-app (path A) OR when a payment-import CSV auto-matches it (path B).
The `paid` transition is the keystone that writes a Sale row via
`services/booking_to_sale.py::write_sale_from_booking`.

BonBox NEVER touches money. The Booking is the LEDGER; the merchant
rails stay with the organizer (their own MobilePay Erhverv + Dankort
terminal). Payment provider fields are captured for revisor provenance
when known, NULL otherwise.

Multi-barrier doctrine guarantees the spec calls for:
  • L2 tenant scope: `organizer_user_id` is denormalized so webhook/scan
    handlers and capacity queries don't JOIN through events.
  • L7 PLAN_CAPS: enforced on POST endpoints, not at the model layer.
  • L8 audit: every state transition writes an audit_logs row via the
    router (booking.created / booking.paid / booking.expired / ...).

Bogføringsloven §10: when paid, Booking + linked Sale row + audit_logs
chain together for the 5-year financial-retention requirement.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    String,
    DateTime,
    Text,
    Boolean,
    ForeignKey,
    Index,
    Integer,
    JSON,
    CheckConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class Booking(Base):
    """One visitor's reservation against a published Event.

    A Booking can carry multiple ticket lines + addon lines and produces
    one Ticket row per individual ticket (so a booking of 4 tickets
    fans into 4 Ticket rows). When paid, the *whole* booking maps to
    ONE Sale row (per spec §8.1 — bilagsnummer per Sale, not per ticket).
    """

    __tablename__ = "bookings"
    __table_args__ = (
        # Fast organizer guest-list pagination ("most recent first").
        Index("ix_bookings_organizer", "organizer_user_id", "created_at"),
        # Fast per-event status filter ("paid bookings for event X").
        Index("ix_bookings_event_status", "event_id", "status"),
        # Pending-expiry sweep (cron) — index just the pending rows.
        # PostgreSQL supports partial indexes; the migration uses WHERE
        # status = 'pending'. Non-partial here for SQLite tests.
        Index("ix_bookings_pending_expiry", "expires_at"),
        # Payment ref uniqueness — UNIQUE constraint enforced via the
        # raw migration (NULLS NOT DISTINCT not portable to SQLite, so
        # at the ORM layer we just index it).
        Index(
            "ix_bookings_payment_ref",
            "payment_provider", "payment_provider_ref",
        ),
        # State-transition CHECK — defense-in-depth on top of the
        # router-level state machine.
        CheckConstraint(
            "status IN ('pending','paid','attended','refunded','cancelled','expired')",
            name="ck_booking_status_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        GUID(), primary_key=True, default=uuid.uuid4,
    )

    # ── Parent event ────────────────────────────────────────────────
    # ON DELETE RESTRICT in the migration — once a booking exists you
    # can't hard-delete the event without first refunding/cancelling
    # the booking. Soft-delete on the event side (is_deleted) is still
    # allowed and is the canonical path.
    event_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("events.id"), nullable=False, index=True,
    )

    # ── Tenant scope (denormalized from event.user_id) ──────────────
    # The whole reason this lives on Booking instead of being JOINed
    # through events: webhook + scan handlers + capacity counters
    # need a single-table tenant filter. Stamped at booking-create
    # time from `event.user_id` and NEVER updated thereafter.
    organizer_user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False, index=True,
    )

    # ── Visitor identity (guest checkout — no account required) ─────
    # GDPR posture: customer_email is retained for the 5-year financial
    # window per Bogføringsloven §10 even after marketing_consent flips
    # to False. Right-to-deletion = name/phone redacted but email-hash
    # + booking row preserved.
    customer_email: Mapped[str] = mapped_column(String(255), nullable=False)
    customer_name: Mapped[str] = mapped_column(String(160), nullable=False)
    customer_phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    # Default False — checkbox is opt-in per GDPR. UI surfaces this with
    # "Vi gemmer din email til at sende dig billetter. Marketing-mails
    # kun hvis du sætter kryds nedenfor." (L10 honest claim).
    customer_consent_marketing: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False,
    )

    # ── Line items ──────────────────────────────────────────────────
    # ticket_lines: `[{"label": "Voksen", "qty": 2, "unit_price_dkk": 150}, ...]`
    # addon_lines:  `[{"label": "Momo plate", "qty": 1, "unit_price_dkk": 60}, ...]`
    # Stored as JSONB on Postgres for forward-compat (we never query
    # into them — the breakdown ships to Sale.ticket_breakdown on paid).
    ticket_lines: Mapped[list] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=False,
    )
    addon_lines: Mapped[list | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True,
    )

    # ── Money (whole DKK — int) ─────────────────────────────────────
    # gross-inclusive (matches Sale.amount convention). CHECK >= 0
    # enforced at the migration layer for defense-in-depth.
    total_amount_dkk: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="DKK")
    # Inherited from Event.is_tax_exempt at booking-create time.
    # Stamped here too so a later flip on Event doesn't retroactively
    # alter accountant-grade artifacts already issued.
    is_tax_exempt: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # ── State machine ───────────────────────────────────────────────
    # pending  — created, capacity held, no Sale row yet
    # paid     — organizer marked it paid; Sale row populated
    # attended — door-scan succeeded (terminal positive state)
    # refunded — kreditnota chain written (terminal negative state)
    # cancelled — visitor self-cancelled before pay (capacity freed)
    # expired  — pending past expires_at; cron swept it back
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", index=True,
    )

    # ── Payment provenance (NULL for v1 manual confirm) ─────────────
    # Future-compatible columns: filled in when CSV auto-match path
    # (B) lands or when v2 ships real MobilePay/Stripe webhooks.
    # 'mobilepay' | 'stripe' | 'manual' | NULL
    payment_provider: Mapped[str | None] = mapped_column(
        String(20), nullable=True,
    )
    # Provider's payment ID (mp_…, pi_…, csv_row_hash). UNIQUE-indexed
    # at the migration layer so a retry of the same webhook/import is
    # idempotent.
    payment_provider_ref: Mapped[str | None] = mapped_column(
        String(120), nullable=True,
    )

    # When the paid transition happened. Drives the year-anchor for
    # bilagsnummer allocation (allocate_voucher(year=paid_at.year)).
    paid_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # ── Sale linkage (financial-bridge) ─────────────────────────────
    # Populated atomically with the paid transition by
    # services/booking_to_sale.py::write_sale_from_booking. ON DELETE
    # SET NULL so even a (hypothetical) hard-delete of the Sale leaves
    # the Booking row intact for audit reconstruction.
    sale_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("sales.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )

    # Refund chain (kreditnota Sale). Set when the booking transitions
    # to 'refunded' — points at the negative-amount Sale row that
    # carries the K-2026-NNNN voucher. Same SET NULL posture.
    refund_sale_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("sales.id", ondelete="SET NULL"),
        nullable=True,
    )

    # ── Door-scan state ─────────────────────────────────────────────
    attended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    attended_scanner_user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=True,
    )

    # ── Idempotency on creation ─────────────────────────────────────
    # Visitor's client sends X-Idempotency-Key on POST. Same key →
    # same Booking row returned (no duplicate). UNIQUE at the DB layer.
    idempotency_key: Mapped[str | None] = mapped_column(
        String(64), nullable=True, unique=True,
    )

    # ── Soft-delete + expiry ────────────────────────────────────────
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # Visitor's pending booking auto-expires (capacity released) if not
    # marked paid by this timestamp. Default = created_at + 30 minutes
    # (set in the router; nullable for legacy / test rows).
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utc_now,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utc_now, onupdate=utc_now,
    )

    # ── Relationships (string-refs to avoid import cycles) ──────────
    event: Mapped["Event"] = relationship("Event", foreign_keys=[event_id])  # type: ignore[name-defined]
    tickets: Mapped[list["Ticket"]] = relationship(  # type: ignore[name-defined]
        "Ticket", back_populates="booking", cascade="all, delete-orphan",
    )

    def __repr__(self) -> str:  # pragma: no cover — debugging aid
        return (
            f"<Booking {self.id} event={self.event_id} "
            f"status={self.status} amount={self.total_amount_dkk} {self.currency}>"
        )
