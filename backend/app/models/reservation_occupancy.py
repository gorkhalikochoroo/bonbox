"""ReservationOccupancy — the overlap-protected physical-table row.

This is the integrity backbone for "no double-booking, ever" (see
docs/reservations-architecture.md §2). One row marks a resource as
physically occupied by a reservation for a half-open `[starts_at, ends_at)`
range. On Postgres a gist EXCLUDE constraint on
`(resource_id WITH =, tsrange(starts_at, ends_at) WITH &&) WHERE (active)`
makes overlapping active rows on the same resource *physically impossible* —
the DB, not the app, is the source of truth for occupancy.

Why a separate table (not a constraint on `reservations`):
  • A reservation can occupy MORE THAN ONE resource (combinable tables — a
    party of 6 across two 4-tops = two occupancy rows, each individually
    overlap-protected). `reservations.resource_id` stays the primary/display
    resource.
  • The partial `WHERE (active)` lets cancelled / no-show / completed rows
    stop blocking the slot the instant their `active` flag flips to FALSE,
    without deleting history.

IMPORTANT: this model defines ONLY columns. SQLAlchemy/SQLite cannot express
a gist range-exclusion constraint portably, so the constraint itself is added
by Migration 023 on Postgres only. On SQLite the table exists (via
`Base.metadata.create_all`) but has no exclusion constraint — local dev relies
on the app-level `recheck_and_assign` fast path; the insert-and-catch backstop
simply never fires because the constraint can't exist. Belt (app) on local,
belt + suspenders (app + DB) on prod.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class ReservationOccupancy(Base):
    """A resource physically held by a reservation for a time-range."""

    __tablename__ = "reservation_occupancy"
    __table_args__ = (
        # Tenant-scoped lookups (the active-occupancy index locality the
        # exclusion constraint can't give us on its own).
        Index("ix_reservation_occupancy_user_start", "user_id", "starts_at"),
        # Cascade-friendly lookup by parent reservation (lifecycle flips).
        Index("ix_reservation_occupancy_reservation", "reservation_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)

    # Parent reservation. ON DELETE CASCADE so a hard-deleted reservation
    # takes its occupancy rows with it (we soft-delete in app code, but the
    # cascade is the safety net the doc's §2 schema specifies).
    reservation_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("reservations.id", ondelete="CASCADE"), nullable=False,
    )
    resource_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("bookable_resources.id"), nullable=False,
    )
    # Tenant — denormalized for index locality (matches the doc; every query
    # still filters by user_id).
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), nullable=False)

    # Half-open [starts_at, ends_at) — touching ends DON'T conflict, matching
    # the engine's `_overlaps` semantics and the migration's tsrange.
    starts_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ends_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    # FALSE once the reservation is cancelled / no_show / completed-released.
    # The partial exclusion index only considers active rows.
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    reservation: Mapped["Reservation"] = relationship()  # type: ignore[name-defined]
    resource: Mapped["BookableResource"] = relationship()  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return (
            f"<ReservationOccupancy resource={self.resource_id} "
            f"{self.starts_at}–{self.ends_at} active={self.active}>"
        )
