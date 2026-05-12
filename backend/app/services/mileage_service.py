"""
Mileage (kørselsgodtgørelse) business logic.

2026 Skattestyrelsen rates:
  - 0–20.000 km/year: 3.79 kr/km
  - 20.000+ km/year: 2.23 kr/km

The rate is FROZEN at write-time — we don't backfill historical entries
when annual cumulative km crosses 20.000. Each entry carries the rate
that applied when it was logged. This matches how revisors expect to
audit the data.
"""
from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Optional
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.mileage import MileageEntry
from app.models.user import User

logger = logging.getLogger(__name__)

# Constants — kept here so the year-on-year rate update is a one-file change.
RATE_LOW_TIER = Decimal("3.79")   # ≤ 20.000 km/year (2026)
RATE_HIGH_TIER = Decimal("2.23")  # > 20.000 km/year (2026)
ANNUAL_TIER_THRESHOLD_KM = Decimal("20000")


def _round_kr(v: Decimal) -> Decimal:
    return Decimal(v).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


class MileageService:
    @staticmethod
    def year_to_date_km(db: Session, user_id: UUID, year: int) -> Decimal:
        """Sum of km for the user across this calendar year, all branches."""
        from datetime import date as _date
        start = _date(year, 1, 1)
        end = _date(year + 1, 1, 1)
        total = (
            db.query(func.coalesce(func.sum(MileageEntry.km), 0))
            .filter(
                MileageEntry.user_id == user_id,
                MileageEntry.trip_date >= start,
                MileageEntry.trip_date < end,
            )
            .scalar()
        )
        return Decimal(total or 0)

    @staticmethod
    def rate_for(ytd_km: Decimal) -> Decimal:
        """Pick the per-km rate based on cumulative YTD km BEFORE this trip."""
        return RATE_LOW_TIER if ytd_km < ANNUAL_TIER_THRESHOLD_KM else RATE_HIGH_TIER

    @staticmethod
    def create(
        db: Session,
        user: User,
        from_address: str,
        to_address: str,
        km: Decimal,
        purpose: str,
        trip_date: Optional[date] = None,
        vehicle_reg: Optional[str] = None,
        branch_id: Optional[UUID] = None,
        notes: Optional[str] = None,
    ) -> MileageEntry:
        """Log a single trip. Rate frozen at write-time."""
        trip = trip_date or date.today()
        ytd = MileageService.year_to_date_km(db, user.id, trip.year)
        rate = MileageService.rate_for(ytd)
        km_dec = Decimal(str(km))
        deduction = _round_kr(km_dec * rate)

        entry = MileageEntry(
            user_id=user.id,
            branch_id=branch_id,
            trip_date=trip,
            from_address=from_address,
            to_address=to_address,
            km=km_dec,
            purpose=purpose,
            vehicle_reg=vehicle_reg,
            rate_per_km=rate,
            deduction_amount=deduction,
            notes=notes,
            locked=False,
        )
        db.add(entry)
        db.flush()
        logger.info(
            "mileage.created user=%s km=%s rate=%s deduction=%s ytd_before=%s",
            user.id, km_dec, rate, deduction, ytd,
        )
        return entry

    @staticmethod
    def update(
        db: Session,
        user: User,
        entry_id: UUID,
        **changes,
    ) -> MileageEntry:
        """Edit a single trip — only allowed if not locked."""
        entry = (
            db.query(MileageEntry)
            .filter(MileageEntry.id == entry_id, MileageEntry.user_id == user.id)
            .first()
        )
        if entry is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Mileage entry not found")
        if entry.locked:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Mileage entry is locked (in a closed period or exported to revisor)",
            )
        # If km changed, recompute deduction at the historical rate
        if "km" in changes and changes["km"] is not None:
            entry.km = Decimal(str(changes["km"]))
            entry.deduction_amount = _round_kr(entry.km * entry.rate_per_km)
        # Plain string fields
        for k in ("from_address", "to_address", "purpose", "vehicle_reg", "notes"):
            if k in changes and changes[k] is not None:
                setattr(entry, k, changes[k])
        if "trip_date" in changes and changes["trip_date"] is not None:
            entry.trip_date = changes["trip_date"]
        db.flush()
        return entry

    @staticmethod
    def delete(db: Session, user: User, entry_id: UUID) -> None:
        """Hard-delete only if not locked. Locked entries can never be removed."""
        entry = (
            db.query(MileageEntry)
            .filter(MileageEntry.id == entry_id, MileageEntry.user_id == user.id)
            .first()
        )
        if entry is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Mileage entry not found")
        if entry.locked:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Mileage entry is locked and cannot be deleted",
            )
        db.delete(entry)
        db.flush()

    @staticmethod
    def year_summary(db: Session, user: User, year: int) -> dict:
        """Annual roll-up for the dashboard card."""
        from datetime import date as _date
        start = _date(year, 1, 1)
        end = _date(year + 1, 1, 1)
        rows = (
            db.query(
                func.coalesce(func.sum(MileageEntry.km), 0).label("km"),
                func.coalesce(func.sum(MileageEntry.deduction_amount), 0).label("ded"),
                func.count(MileageEntry.id).label("n"),
            )
            .filter(
                MileageEntry.user_id == user.id,
                MileageEntry.trip_date >= start,
                MileageEntry.trip_date < end,
            )
            .one()
        )
        total_km = Decimal(rows.km or 0)
        return {
            "year": year,
            "total_km": total_km,
            "total_deduction": Decimal(rows.ded or 0),
            "entries_count": int(rows.n or 0),
            "rate_tier": "high" if total_km > ANNUAL_TIER_THRESHOLD_KM else "low",
        }
