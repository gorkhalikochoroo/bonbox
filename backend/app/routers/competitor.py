"""Competitor Scan endpoints — CRUD + price tracking + Google Places discovery."""

import logging
from typing import Optional

import httpx
from datetime import timedelta

import threading

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from fastapi import Path as FastAPIPath
from pydantic import BaseModel
from sqlalchemy import func, desc
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.routers.auth import get_current_user
from app.models.business_profile import BusinessProfile
from app.models.competitor import Competitor
from app.models.user import User
from app.models.inventory import InventoryItem
from app.services.competitor_service import (
    get_competitor_insights, add_competitor, add_competitor_from_place,
    add_price_check, delete_competitor, discover_nearby,
)
from app.services.menu_extractor import extract_menu_from_image
from app.utils.client_ip import client_ip
from slowapi import Limiter

logger = logging.getLogger("bonbox.competitor")

router = APIRouter()
_limiter = Limiter(key_func=client_ip)


# ── Google Places lookups: a per-account ceiling ──────────────────────────
# /discover and /cuisine-market make a paid Google Places Nearby Search on the
# platform key. competitor_service caches the answers (12 h, by rounded
# location / keyword / radius), so only a cache MISS reaches Google — and
# only those are counted here, per account, from audit_logs (sweep, 8 Oct).
PLACES_LOOKUP_ACTION = "competitor.places_lookup"
PLACES_LOOKUPS_PER_DAY = 30


def _places_lookup_ceiling(db: Session, user: User):
    """A callable for discover_nearby(before_google_call=…): 429 at the daily
    ceiling, 503 when the count fails; otherwise the call is counted first."""
    def _check() -> None:
        from app.models.audit_log import AuditLog
        from app.utils.time import utc_now
        try:
            n = (
                db.query(func.count(AuditLog.id))
                .filter(AuditLog.user_id == user.id,
                        AuditLog.action == PLACES_LOOKUP_ACTION,
                        AuditLog.created_at >= utc_now() - timedelta(days=1))
                .scalar() or 0
            )
        except Exception:  # noqa: BLE001
            logger.warning("places lookup count failed (user=%s)", user.id)
            raise HTTPException(status_code=503, detail={
                "code": "places_lookup_unavailable",
                "message": "Couldn't scan right now. Try again in a minute.",
                "message_da": "Kunne ikke søge lige nu. Prøv igen om et minut.",
            })
        if n >= PLACES_LOOKUPS_PER_DAY:
            raise HTTPException(status_code=429, detail={
                "code": "places_lookup_daily_cap",
                "cap": PLACES_LOOKUPS_PER_DAY,
                "message": (f"BonBox has looked up nearby places {PLACES_LOOKUPS_PER_DAY} times for you "
                            "in the last 24 hours, the most it does a day. Searches you already ran "
                            "still show; try a new one tomorrow."),
                "message_da": (f"BonBox har slået steder i nærheden op {PLACES_LOOKUPS_PER_DAY} gange for dig "
                               "det seneste døgn, og flere gør BonBox ikke på en dag. Søgninger, du "
                               "allerede har lavet, vises stadig; prøv en ny i morgen."),
            })
        from app.services import audit_service
        audit_service.record(db, user, PLACES_LOOKUP_ACTION, "competitor")
        db.commit()
    return _check


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
@_limiter.limit("10/minute")
def discover(
    request: Request,
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
    result = discover_nearby(lat, lon, keyword, radius,
                             before_google_call=_places_lookup_ceiling(db, current_user))
    # Mark already-tracked places
    for p in result.get("places", []):
        p["already_tracked"] = p.get("place_id", "") in tracked_ids
    return result


@router.get("/cuisine-market")
@_limiter.limit("10/minute")
def cuisine_market(
    request: Request,
    radius: int = Query(3000, ge=500, le=10000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """How many nearby businesses serve the same cuisine as me?

    Reads `cuisine` from BusinessProfile, runs a Google Places nearbysearch
    with that string as the keyword, returns:
      {
        "cuisine": "nepali",
        "count": 3,
        "places": [...],  # with `already_tracked` flag per row
        "radius_m": 3000,
        "needs_setup": false,
      }

    Surfaces:
      • needs_setup=true if user hasn't set cuisine yet → frontend shows
        a prompt to set it in Profile
      • needs_location=true if user hasn't set lat/lon → same pattern
      • count=0 with valid setup → genuine "you're the only one nearby"
        (that's actionable insight, not an error)
    """
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == current_user.id)
        .first()
    )
    cuisine = (getattr(profile, "cuisine", None) or "").strip() if profile else ""

    if not cuisine:
        return {
            "cuisine": "",
            "count": 0,
            "places": [],
            "radius_m": radius,
            "needs_setup": True,
            "message": "Tell us what you serve in Profile, then we'll show you who else serves it near you.",
        }

    lat = float(current_user.latitude) if current_user.latitude else None
    lon = float(current_user.longitude) if current_user.longitude else None
    if not lat or not lon:
        return {
            "cuisine": cuisine,
            "count": 0,
            "places": [],
            "radius_m": radius,
            "needs_location": True,
            "message": "Set your business location in Profile, then we'll scan the area.",
        }

    # Pull already-tracked place_ids so the frontend can show "Tracked" badges
    tracked = (
        db.query(Competitor.place_id)
        .filter(Competitor.user_id == current_user.id, Competitor.place_id.isnot(None))
        .all()
    )
    tracked_ids = {r[0] for r in tracked}

    # Google Places nearbysearch with cuisine as keyword. We also pass
    # type=restaurant when the user's business_type is restaurant/cafe/bar,
    # but for workshop/retail/service we let Google interpret the keyword
    # without a type constraint.
    bt = (current_user.business_type or "").lower()
    use_type = bt if bt in {"restaurant", "cafe", "bar", "bakery"} else None
    _ceiling = _places_lookup_ceiling(db, current_user)
    try:
        result = discover_nearby(lat, lon, cuisine, radius, place_type=use_type) \
            if "place_type" in discover_nearby.__code__.co_varnames \
            else discover_nearby(lat, lon, cuisine, radius, before_google_call=_ceiling)
    except HTTPException:
        raise  # the per-account ceiling (429/503) — said, not swallowed
    except Exception as e:  # noqa: BLE001
        logger.warning("cuisine_market discover failed: %s", e)
        return {
            "cuisine": cuisine,
            "count": 0,
            "places": [],
            "radius_m": radius,
            "error": "Couldn't scan right now. Try again in a minute.",
        }

    places = result.get("places", []) or []
    for p in places:
        p["already_tracked"] = p.get("place_id", "") in tracked_ids

    return {
        "cuisine": cuisine,
        "count": len(places),
        "places": places[:20],  # cap to keep response small
        "radius_m": radius,
        "source": result.get("source"),
    }


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


# ── Google photos: the key stays on the server (review, 8 Oct) ─────────────
# /photos used to hand the browser `view_url = …&key=<platform key>`: any
# account could add a competitor from any public place_id and read the key in
# clear text, and with it skip every per-account ceiling. Now the list carries
# references only; thumbnails load through /{id}/photo/{ref} below, which adds
# the key server-side. The Place Details call is cached per place (the same
# TTL as discovery) and a cache miss counts against the per-account Places
# ceiling; photo bytes are cached too, so re-opening the picker is free.
_PHOTO_THUMB_WIDTH = 400
_PLACE_PHOTOS_MAX = 1000
_PHOTO_BYTES_MAX = 120
_place_photos_cache: dict[str, tuple[float, list[dict]]] = {}
_photo_bytes_cache: dict[tuple[str, int], tuple[float, bytes, str]] = {}
_photo_cache_lock = threading.Lock()


def _reset_photo_caches_for_tests() -> None:
    with _photo_cache_lock:
        _place_photos_cache.clear()
        _photo_bytes_cache.clear()


def _cache_now() -> float:
    from app.services import competitor_service
    return competitor_service._now_seconds()


def _cache_ttl() -> float:
    from app.services import competitor_service
    return competitor_service.PLACES_CACHE_TTL_SECONDS


def _evict_oldest(cache: dict, limit: int) -> None:
    if len(cache) >= limit:
        for k, _ in sorted(cache.items(), key=lambda kv: kv[1][0])[: limit // 10 or 1]:
            cache.pop(k, None)


def _place_photo_refs(db: Session, user: User, place_id: str) -> tuple[list[dict] | None, str | None]:
    """The photos Google lists for a place: (list, None), or (None, reason).
    A cache miss runs the per-account Places ceiling first (429/503 raise)."""
    with _photo_cache_lock:
        hit = _place_photos_cache.get(place_id)
        if hit is not None and _cache_now() - hit[0] < _cache_ttl():
            return [dict(p) for p in hit[1]], None
    key = getattr(settings, "GOOGLE_PLACES_API_KEY", None)
    if not key:
        return None, "no_api_key"
    _places_lookup_ceiling(db, user)()
    try:
        resp = httpx.get(
            "https://maps.googleapis.com/maps/api/place/details/json",
            params={
                "place_id": place_id,
                "fields": "photos",  # only this field — cheapest billing
                "key": key,
            },
            timeout=8.0,
        )
        data = resp.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("place details fetch failed for %s: %s", place_id, e)
        return None, "fetch_error"
    if data.get("status") not in ("OK", "ZERO_RESULTS"):
        return None, f"api_status:{data.get('status', 'UNKNOWN')}"
    photos = []
    for p in ((data.get("result") or {}).get("photos") or [])[:10]:
        ref = p.get("photo_reference")
        if ref:
            photos.append({"photo_reference": ref, "width": p.get("width"),
                           "height": p.get("height")})
    with _photo_cache_lock:
        _evict_oldest(_place_photos_cache, _PLACE_PHOTOS_MAX)
        _place_photos_cache[place_id] = (_cache_now(), [dict(p) for p in photos])
    return photos, None


@router.get("/{competitor_id}/photos")
def list_competitor_photos(
    competitor_id: str,
    max_count: int = Query(8, ge=1, le=10),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Up to N Google Places photos for the competitor, as references:
    {photo_reference, width, height}. The picker loads each thumbnail through
    GET /{competitor_id}/photo/{photo_reference} — never a Google URL, so the
    platform key never reaches the browser.

    One Place Details call per place per cache window (`fields=photos`),
    counted against the per-account Places ceiling (429 past it).

    Falls back gracefully to an empty list (no error thrown) when:
      • No GOOGLE_PLACES_API_KEY is configured
      • The competitor has no `place_id` (was added manually)
      • Google returned no photos for this place
    Frontend treats empty list as "ask user to upload instead."
    """
    comp = _verify_competitor(competitor_id, db, current_user)

    if not comp.place_id:
        return {"photos": [], "reason": "no_place_id"}
    if not getattr(settings, "GOOGLE_PLACES_API_KEY", None):
        return {"photos": [], "reason": "no_api_key"}
    photos, reason = _place_photo_refs(db, current_user, comp.place_id)
    if photos is None:
        return {"photos": [], "reason": reason}
    return {"photos": photos[:max_count]}


@router.get("/{competitor_id}/photo/{photo_reference}")
@_limiter.limit("60/minute")
def competitor_photo(
    request: Request,
    competitor_id: str,
    photo_reference: str = FastAPIPath(..., min_length=10, max_length=2000,
                                       pattern=r"^[A-Za-z0-9_\-]+$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """One competitor photo thumbnail, fetched server-side (the key never
    leaves the server). Owner-scoped (404 for another venue's competitor),
    and only a reference Google listed for THIS competitor's place — the
    proxy is not a way to fetch arbitrary Google photos on the platform key."""
    comp = _verify_competitor(competitor_id, db, current_user)
    if not comp.place_id:
        raise HTTPException(status_code=404, detail="Photo not found")
    photos, _reason = _place_photo_refs(db, current_user, comp.place_id)
    if not photos or photo_reference not in {p["photo_reference"] for p in photos}:
        raise HTTPException(status_code=404, detail="Photo not found")
    cache_key = (photo_reference, _PHOTO_THUMB_WIDTH)
    with _photo_cache_lock:
        hit = _photo_bytes_cache.get(cache_key)
        if hit is not None and _cache_now() - hit[0] < _cache_ttl():
            content, media_type = hit[1], hit[2]
        else:
            content, media_type = None, ""
    if content is None:
        content, media_type = _fetch_photo_bytes(photo_reference, max_width=_PHOTO_THUMB_WIDTH)
        if not content:
            raise HTTPException(status_code=502, detail="Couldn't fetch the photo from Google.")
        media_type = (media_type or "image/jpeg").split(";")[0].strip()
        if not media_type.startswith("image/"):
            raise HTTPException(status_code=502, detail="Couldn't fetch the photo from Google.")
        with _photo_cache_lock:
            _evict_oldest(_photo_bytes_cache, _PHOTO_BYTES_MAX)
            _photo_bytes_cache[cache_key] = (_cache_now(), content, media_type)
    return Response(content=content, media_type=media_type,
                    headers={"Cache-Control": "private, max-age=3600"})


def _fetch_photo_bytes(photo_reference: str, max_width: int = 1600) -> tuple[bytes | None, str]:
    """Download a Google Places photo by reference. Returns (bytes, media_type).
    The key is added here, server-side; it never reaches the browser."""
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
                    "maxwidth": max_width,  # 1600 default: bigger than display, better OCR
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


def _enforce_menu_scan_plan(user: User):
    """Tier gate for AI menu scan endpoints. Pro+ only — the Claude
    vision call is the most expensive thing we offer (~2¢ per scan,
    bulk-extracts 30 prices in 10 seconds). It's also the most
    impressive feature we have; gating it gives Pro a clear pitch."""
    from app.services.billing import has_feature, effective_plan, min_plan_for_feature
    if not has_feature(user, "ai_menu_scan"):
        # Derived, not typed. ai_menu_scan opened to Starter+ on 2026-07-12
        # under the all-features doctrine; this 402 kept quoting Pro.
        plan = min_plan_for_feature("ai_menu_scan") or "pro"
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "feature": "ai_menu_scan",
                "required_plan": plan,
                "current_plan": effective_plan(user),
                "message": (
                    f"AI menu scan is on {plan.capitalize()}. Compare competitor prices "
                    "manually with the price-check log on any plan."
                ),
            },
        )


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

    Tier-gated: Pro+ (ai_menu_scan feature). The Claude vision call
    is our most expensive per-request feature and the bulk-import is
    the most impressive value moment we have.
    """
    _enforce_menu_scan_plan(current_user)
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
    user picks a Google photo from the /photos result.

    Tier-gated: Pro+ (ai_menu_scan feature) — shared gate with
    /scan-menu upload variant."""
    _enforce_menu_scan_plan(current_user)
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
