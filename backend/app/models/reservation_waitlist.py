"""
ReservationWaitlistEntry — the Venteliste (reservation waitlist).

A party the venue COULD NOT SEAT yet: on a full night the owner turns people
away and, instead of a paper pad, parks them here. It is deliberately NOT a
Reservation with status="waitlisted":

  • A waitlist party holds NO resource and writes NO reservation_occupancy row,
    so it is STRUCTURALLY incapable of holding a table or leaking into the
    availability engine / the book / the live-alert feed / Insights. The
    Postgres no-double-booking EXCLUDE constraint (task #288) stays untouched.
  • When a table frees (a booking is cancelled/no-showed) the app SURFACES the
    matching waiting parties to the OWNER — it never auto-books, never holds,
    never claims a table is reserved. "BonBox tells, the owner acts" (same
    doctrine as inventory). Converting a party into a real booking goes through
    the ordinary create-with-occupancy path, so no-double-booking still governs.

Erasure: user_id carries a users-FK so the metadata-driven delete_account
sweep removes these rows automatically; guest PII (name/phone/email) is nulled
by the nightly purge on rows past `purge_after`, mirroring Reservation.

NOTE: a separate `waitlist_entries` table already exists (paid-tier interest
capture) — this is a DIFFERENT table, `reservation_waitlist`.
"""

import uuid
from datetime import datetime, date

from sqlalchemy import String, Integer, Date, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now

# The lifecycle. Terminal = converted | expired | cancelled. A row never
# mirrors "seated" — that fact is read live through converted_reservation_id,
# so there is no second write-path to keep in sync.
WAITLIST_STATUSES = ("waiting", "notified", "converted", "expired", "cancelled")


class ReservationWaitlistEntry(Base):
    __tablename__ = "reservation_waitlist"
    __table_args__ = (
        # Owner Venteliste for a day + the freed-slot match scan (same index).
        Index("ix_rsvp_waitlist_user_day", "user_id", "waitlist_date", "status"),
        # GDPR PII sweep (mirrors ix_reservation_purge).
        Index("ix_rsvp_waitlist_purge", "purge_after"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # Tenant key AND the users-FK the metadata GDPR sweep keys off.
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), index=True, nullable=False,
    )

    # ── Guest (personal data — purged after `purge_after`) ─────────────
    guest_name: Mapped[str | None] = mapped_column(String(160), nullable=True)
    guest_phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    guest_email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # ── The waiting party ──────────────────────────────────────────────
    party_size: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    # Matching is per DAY — a waitlist party is time-flexible, so there is no
    # starts_at. The optional desired window only RANKS matches.
    waitlist_date: Mapped[date] = mapped_column(Date, nullable=False)
    desired_from: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    desired_to: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="waiting")
    # 'manual' (owner typed it) | 'public' (guest self-added — v2).
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="manual")
    note: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # ── Owner-initiated notify (anti-spam) ─────────────────────────────
    notified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Server-enforced cap (≤2): a double-tap or two host iPads can't double-SMS.
    notify_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # Set ONLY on convert — points at the real Reservation the shared
    # create-with-occupancy path wrote. `converted` is therefore a MEASURED
    # fact, never a claim (the linked row exists).
    converted_reservation_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("reservations.id"), nullable=True,
    )

    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expired_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # GDPR: stamped at create = waitlist_date + retention_days; the nightly
    # purge nulls the PII columns past this and stamps purged_at.
    purge_after: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    purged_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now,
    )
