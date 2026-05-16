"""Competitor Scan endpoints — CRUD + price tracking + Google Places discovery."""

import logging
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, desc
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.routers.auth import get_current_user
from app.models.competitor import Competitor
from app.models.user import User
from app.models.inventory import InventoryItem
from app.services.competitor_service import (
    get_competitor_insights, add_competitor, add_competitor_from_place,
    add_price_check, delete_competitor, discover_nearby,
)
from app.services.menu_extractor import extract_menu_from_image

logger = logging.getLogger("bonbox.competitor")

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


class PriceCheckBulkItem(BaseModel):
    item_name: str
    their_price: float
    our_price: Optional[float] = None
    notes: Optional[str] = None


class PriceCheckBulkCreate(BaseModel):
    competitor_id: str
    items: list[PriceCheckBulkItem]


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


@router.post("/price-check/bulk")
def create_price_checks_bulk(
    body: PriceCheckBulkCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Bulk-insert price checks. Used by the menu-scan UI after the
    user reviews extracted items.

    Tenant-scoped — the competitor must belong to the calling user.
    Returns counts so the UI can show "Added 24 of 27 items" (3 might
    be skipped if they have zero-priced or malformed rows).

    Soft-limit: 60 items per call (matches the menu extractor's per-
    image max). The user can run two scans if they have a giant menu.
    """
    # Tenant check
    comp = (
        db.query(Competitor)
        .filter(Competitor.id == body.competitor_id, Competitor.user_id == current_user.id)
        .first()
    )
    if not comp:
        raise HTTPException(status_code=404, detail="Competitor not found")

    if not body.items:
        return {"inserted": 0, "skipped": 0}
    if len(body.items) > 60:
        raise HTTPException(status_code=413, detail="Too many items (max 60 per call)")

    inserted = 0
    skipped = 0
    for it in body.items:
        name = (it.item_name or "").strip()
        if not name:
            skipped += 1
            continue
        if it.their_price is None or it.their_price < 0:
            skipped += 1
            continue
        try:
            add_price_check(
                current_user.id, db, body.competitor_id,
                name, float(it.their_price),
                float(it.our_price) if it.our_price is not None else None,
                (it.notes or "").strip() or None,
            )
            inserted += 1
        except Exception as e:  # noqa: BLE001
            logger.warning("bulk price-check skip on '%s': %s", name, e)
            skipped += 1
    return {"inserted": inserted, "skipped": skipped}


# ─────────────────────── Menu-photo scan flow ───────────────────────
#
# Two endpoints power the "Scan menu" feature on a competitor card:
#
#   GET  /{competitor_id}/photos    → list Google Places photos for the
#                                      competitor (so the user can pick
#                                      a menu shot without leaving the app)
#   POST /{competitor_id}/scan-menu → run Claude vision on an uploaded
#                                      photo OR a photo_reference,
#                                      return {name, price} items ready
#                                      to bulk-import as price checks


class ScanMenuFromRefRequest(BaseModel):
    """Use this body when the user picked an existing Google photo by
    photo_reference instead of uploading a new image."""
    photo_reference: str


def _verify_competitor(competitor_id: str, db: Session, user: User) -> Competitor:
    """Look up + tenant-scope check. 404 on miss or cross-tenant."""
    comp = (
        db.query(Competitor)
        .filter(Competitor.id == competitor_id, Competitor.user_id == user.id)
        .first()
    )
    if not comp:
        raise HTTPException(status_code=404, detail="Competitor not found")
    return comp


@router.get("/{competitor_id}/photos")
def list_competitor_photos(
    competitor_id: str,
    max_count: int = Query(8, ge=1, le=10),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Fetch up to N Google Places photos for the competitor.

    Calls Place Details with `fields=photos` (cheap — billed per
    *fields requested*, not per field). Returns a list of
    {photo_reference, width, height, view_url} the frontend can render
    in a picker grid.

    Falls back gracefully to an empty list (no error thrown) when:
      • No GOOGLE_PLACES_API_KEY is configured
      • The competitor has no `place_id` (was added manually)
      • Google returned no photos for this place
    Frontend treats empty list as "ask user to upload instead."
    """
    comp = _verify_competitor(competitor_id, db, current_user)

    if not comp.place_id:
        return {"photos": [], "reason": "no_place_id"}
    key = getattr(settings, "GOOGLE_PLACES_API_KEY", None)
    if not key:
        return {"photos": [], "reason": "no_api_key"}

    try:
        resp = httpx.get(
            "https://maps.googleapis.com/maps/api/place/details/json",
            params={
                "place_id": comp.place_id,
                "fields": "photos",  # only this field — cheapest billing
                "key": key,
            },
            timeout=8.0,
        )
        data = resp.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("place details fetch failed for %s: %s", comp.place_id, e)
        return {"photos": [], "reason": "fetch_error"}

    if data.get("status") not in ("OK", "ZERO_RESULTS"):
        return {"photos": [], "reason": f"api_status:{data.get('status', 'UNKNOWN')}"}

    photos = (data.get("result") or {}).get("photos") or []
    out = []
    for p in photos[:max_count]:
        ref = p.get("photo_reference")
        if not ref:
            continue
        out.append({
            "photo_reference": ref,
            "width": p.get("width"),
            "height": p.get("height"),
            # Proxy URL the frontend can use directly — we don't expose
            # the API key in the response, only in the URL the browser
            # follows. Google caches these aggressively.
            "view_url": (
                "https://maps.googleapis.com/maps/api/place/photo"
                f"?maxwidth=800&photo_reference={ref}&key={key}"
            ),
        })
    return {"photos": out}


def _fetch_photo_bytes(photo_reference: str) -> tuple[bytes | None, str]:
    """Download a Google Places photo by reference. Returns (bytes, media_type)."""
    key = getattr(settings, "GOOGLE_PLACES_API_KEY", None)
    if not key:
        return None, ""
    try:
        # `follow_redirects=True` is critical — Google's photo endpoint
        # 302-redirects to a signed Googleusercontent URL.
        with httpx.Client(follow_redirects=True, timeout=15.0) as client:
            resp = client.get(
                "https://maps.googleapis.com/maps/api/place/photo",
                params={
                    "maxwidth": 1600,  # bigger than display, better OCR
                    "photo_reference": photo_reference,
                    "key": key,
                },
            )
        if resp.status_code != 200:
            return None, ""
        return resp.content, resp.headers.get("content-type", "image/jpeg")
    except Exception as e:  # noqa: BLE001
        logger.warning("photo fetch failed: %s", e)
        return None, ""


@router.post("/{competitor_id}/scan-menu")
async def scan_menu_from_upload(
    competitor_id: str,
    photo: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Extract menu items + prices from an uploaded photo.

    Frontend uses this for both flows:
      • Camera/file picker on the user's device
      • The user pre-fetches a Google photo via /photos and uploads
        the bytes here (avoids a backend proxy when the frontend
        already has the URL)

    Use /scan-menu-from-ref instead when you want the backend to
    fetch the Google photo directly (avoids a CORS round-trip).
    """
    _verify_competitor(competitor_id, db, current_user)

    # Bound the upload size up front — UploadFile reads lazily, but we
    # don't want a 100 MB attempt to chew through memory before we
    # check size.
    raw = await photo.read()
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Photo too large (max 10 MB)")
    if not raw:
        raise HTTPException(status_code=400, detail="Empty photo upload")

    media_type = (photo.content_type or "image/jpeg").split(";")[0].strip()
    if not media_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")

    items, meta = extract_menu_from_image(raw, media_type=media_type)
    return {
        "items": items,
        "confidence": meta.get("confidence"),
        "note": meta.get("note"),
        "error": meta.get("error"),
        "currency_default": current_user.currency or "DKK",
    }


@router.post("/{competitor_id}/scan-menu-from-ref")
def scan_menu_from_google_ref(
    competitor_id: str,
    body: ScanMenuFromRefRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Same as /scan-menu but the photo is fetched server-side from a
    Google Places photo_reference. Saves a CORS round-trip when the
    user picks a Google photo from the /photos result."""
    _verify_competitor(competitor_id, db, current_user)

    data, media_type = _fetch_photo_bytes(body.photo_reference)
    if not data:
        raise HTTPException(
            status_code=502,
            detail="Couldn't fetch the photo from Google. Try uploading directly instead.",
        )

    items, meta = extract_menu_from_image(data, media_type=media_type or "image/jpeg")
    return {
        "items": items,
        "confidence": meta.get("confidence"),
        "note": meta.get("note"),
        "error": meta.get("error"),
        "currency_default": current_user.currency or "DKK",
    }


@router.delete("/{competitor_id}")
def remove_competitor(
    competitor_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a competitor and all their price checks."""
    return delete_competitor(current_user.id, db, competitor_id)
