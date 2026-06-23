"""Behandling — a salon's bookable SERVICE (treatment) in its catalog.

S2 of the salon-appointments feature. A `Behandling` is one row in a
per-salon list of services the owner offers — "Klipdame", "Farve",
"Vask + føn" — each with a duration (informational for now) and an
OPTIONAL display price.

DK terminology lock: "behandling" / "behandlinger" (service / treatment)
stays Danish in every UI language. This model name follows that lock.

Honesty gate:
  • `price_kr` is DISPLAY-ONLY. It never charges money, never feeds
    MOMS / Tax, never reconciles against a sale. It exists so the owner
    can show guests a price on the (future S3) booking page.
  • `duration_min` is informational until S3 wires it into the booking
    flow's slot length. It carries no occupancy/availability meaning yet.

Tenant-scoped: every query filters by `user_id`. Hard-delete (no
soft-delete column) — a service catalog has no historical reservation FK
pointing at it in S2, so removing a row is clean. (S3 will copy the name
onto the Reservation, not FK it, so this stays true.)

Mirrors the canonical CREATE TABLE in app/main.py::_run_migrations()
(Migration 025 block) + the documentation-only alembic 020.
"""
import uuid
from datetime import datetime

from sqlalchemy import String, Integer, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class Behandling(Base):
    """A salon service the owner lists in their Behandlinger catalog."""

    __tablename__ = "behandlinger"
    __table_args__ = (
        Index("ix_behandlinger_user_active", "user_id", "active"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True, nullable=False)

    # Display name — "Klip dame", "Farve", "Vask + føn". Behandling stays Danish.
    name: Mapped[str] = mapped_column(String(120), nullable=False)

    # How long the treatment takes. Informational in S2 — S3 wires it into
    # the booking slot length. Default 30 (the most common short service).
    duration_min: Mapped[int] = mapped_column(Integer, nullable=False, default=30)

    # DISPLAY-ONLY price in whole kroner. Nullable = "no price shown". Never
    # charges money, never feeds MOMS/Tax (honesty gate). Integer (whole kr.)
    # keeps it unambiguously a label, not a money amount the books rely on.
    price_kr: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Inactive services stay in the catalog but the (future) booking page
    # hides them — lets an owner pull a seasonal service without deleting it.
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    # Manual ordering in the owner catalog list.
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    user: Mapped["User"] = relationship()  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<Behandling {self.name} {self.duration_min}min>"
