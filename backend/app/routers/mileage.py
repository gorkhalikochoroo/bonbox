"""
Mileage (kørselsgodtgørelse) endpoints.

Same plan gating as the Customer + Invoice routes — Starter and above.
"""
from __future__ import annotations

from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.mileage import MileageEntry
from app.models.user import User
from app.routers.auth import get_current_user
from app.routers.customers import _require_invoicing_plan
from app.schemas.invoicing import (
    MileageEntryCreate, MileageEntryResponse, MileageYearSummary,
)
from app.services.mileage_service import MileageService

router = APIRouter()


@router.post("", response_model=MileageEntryResponse, status_code=status.HTTP_201_CREATED)
def create_mileage(
    data: MileageEntryCreate,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Log a single business trip."""
    entry = MileageService.create(
        db=db,
        user=user,
        from_address=data.from_address,
        to_address=data.to_address,
        km=data.km,
        purpose=data.purpose,
        trip_date=data.trip_date,
        vehicle_reg=data.vehicle_reg,
        branch_id=data.branch_id,
        notes=data.notes,
    )
    db.commit()
    db.refresh(entry)
    return entry


@router.get("", response_model=list[MileageEntryResponse])
def list_mileage(
    year: Optional[int] = None,
    branch_id: Optional[UUID] = None,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """List mileage entries — defaults to current year."""
    from datetime import date as _date
    query = db.query(MileageEntry).filter(MileageEntry.user_id == user.id)
    if year is None:
        year = _date.today().year
    start = _date(year, 1, 1)
    end = _date(year + 1, 1, 1)
    query = query.filter(MileageEntry.trip_date >= start, MileageEntry.trip_date < end)
    if branch_id is not None:
        query = query.filter(MileageEntry.branch_id == branch_id)
    return query.order_by(MileageEntry.trip_date.desc(), MileageEntry.created_at.desc()).all()


@router.get("/summary/{year}", response_model=MileageYearSummary)
def mileage_summary(
    year: int,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Annual roll-up for dashboard."""
    return MileageService.year_summary(db, user, year)


@router.patch("/{entry_id}", response_model=MileageEntryResponse)
def update_mileage(
    entry_id: UUID,
    data: MileageEntryCreate,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Edit a logged trip — only allowed if not locked."""
    entry = MileageService.update(
        db, user, entry_id, **data.model_dump(exclude_unset=True),
    )
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mileage(
    entry_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(_require_invoicing_plan),
):
    """Delete an unlocked trip."""
    MileageService.delete(db, user, entry_id)
    db.commit()
    return None
