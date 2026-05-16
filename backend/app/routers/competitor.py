"""Competitor Scan endpoints — CRUD + price tracking + Google Places discovery."""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from sqlalchemy import func, desc
from sqlalchemy.orm import Session

from app.database import get_db
from app.routers.auth import get_current_user
from app.models.user import User
from app.models.inventory import InventoryItem
from app.services.competitor_service import (
    get_competitor_insights, add_competitor, add_competitor_from_place,
    add_price_check, delete_competitor, discover_nearby,
)

router = APIRouter()


# Common menu items per vertical — populated when the user has nothing in
# inventory yet. Drawn from real BonBox tenant data on what gets tracked
# most often. Currency-agnostic — we never preset a price, only the name.
# Keep lists short (8–10) so the chip row doesn't sprawl.
_SUGGESTED_ITEMS_BY_TYPE = {
    "restaurant": [
        "Burger", "Pizza", "Pasta", "Salad", "Steak", "Fries",
        "Soft drink", "Beer", "House wine (glass)", "Coffee",
    ],
    "cafe": [
        "Espresso", "Latte", "Cappuccino", "Filter coffee", "Hot chocolate",
        "Croissant", "Bagel", "Sandwich", "Smoothie", "Cake (slice)",
    ],
    "bar": [
        "Beer (bottle)", "Beer (draft)", "House wine (glass)", "Cocktail",
        "Gin & tonic", "Shot", "Soft drink", "Snack plate", "Wings",
    ],
    "bakery": [
        "Bread (loaf)", "Croissant", "Pastry", "Cake (slice)", "Cookie",
        "Bun", "Sourdough", "Sandwich", "Coffee",
    ],
    "workshop": [
        "Oil change", "Tire change", "Brake service", "Diagnostic",
        "Wheel alignment", "Battery replacement", "Inspection (syn)",
    ],
    "retail": [
        "Top seller #1", "Top seller #2", "Top seller #3",
        "Best value item", "Loss leader", "Premium item",
    ],
    "service": [
        "Standard appointment", "Premium service", "Express service",
        "Consultation", "Package deal",
    ],
}


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


@router.get("/suggested-items")
def suggested_items(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Smart starter items for the price-check form.

    Two sources, deduplicated:
      1. User's own inventory — actual items they sell. We send the name AND
         the price (so 'Our price' autofills when they pick this chip — no
         hunting through inventory). Sorted by quantity desc (top sellers).
      2. Vertical defaults — typical items for the business_type, used as
         fallback when inventory is empty (new tenants) or to supplement.

    Returns max 12 items so the chip row stays compact on mobile.
    """
    from app.models.inventory import InventoryItem

    biz = (current_user.business_type or "restaurant").lower().strip()
    fallback = _SUGGESTED_ITEMS_BY_TYPE.get(biz) or _SUGGESTED_ITEMS_BY_TYPE["restaurant"]

    # Pull user's inventory items. We grab name + selling price so the
    # frontend can pre-fill 'our price' when the user clicks a chip.
    own = []
    try:
        rows = (
            db.query(InventoryItem.name, InventoryItem.selling_price)
            .filter(
                InventoryItem.user_id == current_user.id,
                InventoryItem.is_deleted.isnot(True),
                InventoryItem.name.isnot(None),
            )
            .order_by(desc(InventoryItem.quantity), InventoryItem.name)
            .limit(20)
            .all()
        )
        seen = set()
        for name, price in rows:
            key = (name or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            own.append({
                "name": name.strip(),
                "our_price": float(price) if price is not None else None,
                "source": "inventory",
            })
    except Exception:
        own = []  # fail open — fallback still works

    # Fill the rest from vertical defaults (skip dupes with inventory)
    inv_keys = {it["name"].lower() for it in own}
    suggested = list(own[:8])  # leave room for at least a few defaults
    for name in fallback:
        if len(suggested) >= 12:
            break
        if name.lower() in inv_keys:
            continue
        suggested.append({"name": name, "our_price": None, "source": "preset"})

    return {
        "items": suggested,
        "business_type": biz,
        "currency": current_user.currency or "DKK",
        "inventory_count": len(own),
    }


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
