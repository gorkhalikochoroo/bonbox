"""
Mileage entry — kørselsgodtgørelse (Danish business mileage deduction).

Skattestyrelsen 2026 rates:
  - 0–20.000 km/year: 3,79 kr/km
  - 20.000+ km/year: 2,23 kr/km

Compliance per Bekendtgørelse om skattefri godtgørelse:
  - Must be logged the SAME day (not retroactively reconstructed)
  - Required fields: date, purpose, from, to, km, vehicle registration
  - Once exported to revisor / locked into a closed period, immutable.
"""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    String, Date, DateTime, Numeric, Boolean, ForeignKey, Text, Integer, Index,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class MileageEntry(Base):
    __tablename__ = "mileage_entries"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    branch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("branches.id"), nullable=True, index=True
    )

    # Required compliance fields
    trip_date: Mapped[date] = mapped_column(Date, nullable=False, default=date.today, index=True)
    from_address: Mapped[str] = mapped_column(Text, nullable=False)
    to_address: Mapped[str] = mapped_column(Text, nullable=False)
    km: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    purpose: Mapped[str] = mapped_column(Text, nullable=False)
    # Skattestyrelsen mandates a purpose string — "møde", "leverance",
    # "venue setup", "supplier pickup", etc. Empty = invalid log.
    vehicle_reg: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    # License plate (registreringsnummer). Pulled from user.vehicle_reg
    # at write-time if available; user can override per trip.

    # Computed at write-time
    rate_per_km: Mapped[Decimal] = mapped_column(Numeric(5, 4), nullable=False)
    # 3.79 or 2.23 depending on YTD km when this entry was created. Frozen.
    deduction_amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    # km * rate_per_km

    # Optional faktura linkage
    invoice_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("invoices.id"), nullable=True, index=True
    )
    # If set: this mileage was billed back to the customer as a faktura line.

    # Lock state — once exported to revisor / quarter closed, no edits
    locked: Mapped[bool] = mapped_column(Boolean, default=False)

    # Notes (optional, internal)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Audit
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    __table_args__ = (
        Index("ix_mileage_user_year", "user_id", "trip_date"),
    )

    def __repr__(self) -> str:
        return f"<MileageEntry {self.trip_date} {self.km}km → {self.deduction_amount} kr>"
