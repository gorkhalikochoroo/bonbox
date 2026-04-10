"""Competitor Scan endpoints — CRUD + price tracking + Google Places discovery."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.services.competitor_service import (
    get_competitor_insights, add_competitor, add_competitor_from_place,
    add_price_check, delete_competitor, discover_nearby,
)

router = APIRouter()


class CompetitorCreate(BaseModel):
    name: str
    address: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None


class PlaceAddRequest(BaseModel):
    place_id: str
    name: str
    address: Optional[str] = None
    category: Optional[str] = None
    google_rating: Optional[float] = None
    price_level: Optional[int] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    photo_ref: Optional[str] = None
    total_ratings: Optional[int] = None


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


@router.get("/discover")
def discover(
    keyword: Optional[str] = Query(None),
    radius: int = Query(1500, ge=500, le=5000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Discover nearby businesses via Google Places (or OSM fallback)."""
    lat = float(current_user.latitude) if current_user.latitude else None
    lon = float(current_user.longitude) if current_user.longitude else None
    if not lat or not lon:
        return {"places": [], "source": "none", "error": "Set your business location in Profile first."}
    # Get already tracked place_ids so frontend can mark them
    from app.models.competitor import Competitor
    tracked = db.query(Competitor.place_id).filter(
        Competitor.user_id == current_user.id, Competitor.place_id.isnot(None)
    ).all()
    tracked_ids = {r[0] for r in tracked}
    result = discover_nearby(lat, lon, keyword, radius)
    # Mark already-tracked places
    for p in result.get("places", []):
        p["already_tracked"] = p.get("place_id", "") in tracked_ids
    return result


@router.post("/add")
def create_competitor(
    body: CompetitorCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a new competitor manually."""
    return add_competitor(current_user.id, db, body.name, body.address, body.category, body.notes)


@router.post("/add-from-place")
def create_from_place(
    body: PlaceAddRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Add a competitor from a Google Places discovery result."""
    try:
        return add_competitor_from_place(current_user.id, db, body)
    except Exception as e:
        raise HTTPException(500, detail=f"Failed to save: {str(e)}")


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
