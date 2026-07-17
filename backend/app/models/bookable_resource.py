"""BookableResource — the generic unit a reservation occupies.

Reservations (table booking + appointments) all reduce to "a resource is
busy for a time-range". A resource is whatever fills up:

  • restaurant → a TABLE (capacity_seats = how many it seats, zone =
    indoor / terrace / bar). A party needs one table with enough seats.
  • salon / clinic → a PROVIDER or chair (capacity_seats = 1). The
    resource's availability comes from that staff member's published
    Schedule shifts, so `staff_id` links back to StaffMember.
  • room → a private dining room / treatment room (capacity_seats = its
    seat count).

One engine, two skins — `kind` drives which availability source the
router feeds the availability engine. See app/services/availability_engine.py.

Soft-delete (is_deleted) rather than hard-delete: past Reservations point
at resource_id, and we want the historical "which table" to survive a
floor reshuffle without orphaning the audit trail.
"""
import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Float, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class BookableResource(Base):
    """A table, provider, or room that a reservation can occupy."""

    __tablename__ = "bookable_resources"
    __table_args__ = (
        Index("ix_bookable_resource_user_active", "user_id", "is_active", "is_deleted"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    # 'table' | 'provider' | 'room'. Drives the availability source.
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="table")

    # Display label — "Bord 4", "Vindue 2", "Maria (frisør)", "Behandlingsrum 1".
    label: Mapped[str] = mapped_column(String(120), nullable=False)

    # Seats. For a table = its cover count; for a provider/chair = 1.
    # The engine fits a party only into a resource with capacity_seats >=
    # party_size (no auto-combine in v1 — that's a Phase-3 optimisation).
    capacity_seats: Mapped[int] = mapped_column(Integer, nullable=False, default=2)

    # Optional grouping — "Indendørs" / "Terrasse" / "Bar". Surfaced in the
    # owner floor view, AND scopes table-combining: only tables sharing a zone
    # can be pushed together (you can't join an indoor table to a terrace one).
    zone: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # Can this table be pushed together with other combinable tables in the
    # same zone to seat a party that fits no single table (a party of 6 across
    # a 4-top + a 2-top)? Each combined table keeps its own occupancy row, so
    # the DB exclusion constraint still guarantees no double-booking. Tables /
    # rooms only — providers (capacity 1) are never combinable. Default off:
    # combining is opt-in per table so a fresh floor behaves exactly as before.
    combinable: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # For kind='provider': the StaffMember whose published schedule defines
    # this resource's availability windows. NULL for tables/rooms — AND NULL
    # for the owner "self-chair" (see follows_opening_hours below).
    staff_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("staff_members.id"), nullable=True, index=True,
    )

    # Owner "self-chair" honesty marker (salon first-booking unlock). When
    # TRUE on a kind='provider' resource, this chair's availability comes from
    # the owner's CONFIRMED weekly opening hours (booking_hours settings key)
    # instead of a bound StaffMember's published shifts — so a solo salon owner
    # can take appointments without creating a StaffMember (zero payroll/CPR/
    # wage surface: this row has staff_id=NULL and no employment record).
    # It is an EXPLICIT marker, not "staff_id IS NULL": a legacy NULL-staff
    # provider row (default FALSE) never lights up on the opening-hours path.
    # The engine still fails closed — no declared hours ⇒ no slots (never a
    # silent venue-hours fallback). See reservation_service._opening_hours_windows.
    follows_opening_hours: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false",
    )

    # Manual ordering in the owner floor list.
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # ── 2D floor-plan position ────────────────────────────────────────
    # Where this table sits on the owner's drag-arranged room map. Stored
    # as a PERCENT of the room canvas (0–100 on each axis) so the layout is
    # resolution-independent — the frontend renders the same arrangement on
    # a phone, a host-stand tablet, or a desktop without re-pixel-mapping.
    # NULL = "not placed yet" (legacy rows + freshly-created tables): the
    # frontend drops un-placed tables into an auto-grow grid until the owner
    # drags them onto the canvas, so a NULL here is a first-class state, not
    # a missing value. Hence nullable with NO server default (unlike `shape`).
    pos_x: Mapped[float | None] = mapped_column(Float, nullable=True)
    pos_y: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Render shape on the floor map: 'round' (a round top) or 'square'
    # (a square/rectangular top). Cosmetic only — does not affect seating
    # or the availability engine. server_default 'round' so existing rows
    # adopt a sane default and the ADD COLUMN is a non-locking metadata-only
    # change on Postgres (constant default, no table rewrite).
    shape: Mapped[str | None] = mapped_column(
        String(12), nullable=True, server_default="round", default="round",
    )

    # Table orientation on the floor map, degrees clockwise. COSMETIC ONLY —
    # does not affect seating or the availability engine (like `shape`). Nullable
    # with NO server default: NULL is read as 0° (unrotated) everywhere, so legacy
    # rows and fresh tables render upright and nothing regresses. Percent/degree
    # geometry is resolution-independent on the fixed 16:10 canvas.
    rotation_deg: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Drawn size multiplier on the floor map (1.0 = the seat-derived default).
    # COSMETIC ONLY — never affects seating or the availability engine. Nullable
    # with NO default: NULL is read as 1.0 everywhere, so legacy rows keep their
    # seat-derived footprint. Deliberately NOT sent to the public booker — the
    # guest map re-derives footprint from capacity_seats, so drawn size can never
    # imply capacity. capacity_seats stays the SOLE booking-authoritative number.
    size_scale: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Active = bookable. Inactive resources stay in history but the engine
    # skips them (e.g. a table pulled for renovation).
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)

    user: Mapped["User"] = relationship()  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<BookableResource {self.kind}:{self.label} seats={self.capacity_seats}>"
