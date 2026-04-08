"""Competitor Scan endpoints — CRUD + price tracking + nearby discovery."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.services.competitor_service import (
    get_competitor_insights, add_competitor, add_price_check, delete_competitor,
)

router = APIRouter()


class CompetitorCreate(BaseModel):
    name: str
    address: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class PriceCheckCreate(BaseModel):
    competitor_id: str
    item_name: str
    their_price: float
    our_price: Optional[float] = None
    notes: Optional[str] = None


@router.get("/insights")
def competitor_insights(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full competitor analysis: tracked competitors, price comparisons, nearby businesses."""
    lat = float(current_user.latitude) if current_user.latitude else None
    lon = float(current_user.longitude) if current_user.longitude else None
    return get_competitor_insights(current_user.id, db, lat, lon)


@router.post("/add")
def create_competitor(
    body: CompetitorCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a new competitor to track."""
    return add_competitor(current_user.id, db, body.name, body.address, body.category, body.notes)


@router.post("/price-check")
def create_price_check(
    body: PriceCheckCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Log a price comparison for a competitor."""
    return add_price_check(
        current_user.id, db, body.competitor_id,
        body.item_name, body.their_price, body.our_price, body.notes,
    )


@router.delete("/{competitor_id}")
def remove_competitor(
    competitor_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a competitor and all their price checks."""
    return delete_competitor(current_user.id, db, competitor_id)
