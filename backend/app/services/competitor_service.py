"""
Competitor Scan Service — track competitors, compare prices, detect positioning gaps.

Google Places API for nearby business discovery (with OSM fallback).
Manual price tracking + comparison analytics.
"""

import logging
from datetime import date
from math import radians, cos, sin, asin, sqrt

import httpx
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.competitor import Competitor, CompetitorPrice
from app.config import settings

logger = logging.getLogger(__name__)


# ── Distance helper ─────────────────────────────────────────

def _haversine(lat1, lon1, lat2, lon2):
    """Distance in meters between two GPS coordinates."""
    R = 6371000
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return R * 2 * asin(sqrt(a))


# ── Google Places Discovery ─────────────────────────────────

def discover_nearby(lat: float, lon: float, keyword: str = None, radius: int = 1500) -> dict:
    """Discover nearby businesses — Google Places first, OSM fallback."""
    api_key = settings.GOOGLE_PLACES_API_KEY
    if api_key:
        try:
            return _search_google_places(lat, lon, keyword, radius, api_key)
        except Exception as e:
            logger.warning(f"Google Places failed, falling back to OSM: {e}")

    # Fallback to OpenStreetMap
    places = _search_nearby_osm(lat, lon, radius)
    return {"places": places, "source": "osm"}


def _search_google_places(lat: float, lon: float, keyword: str, radius: int, api_key: str) -> dict:
    """Search Google Places Nearby Search API."""
    url = "https://maps.googleapis.com/maps/api/place/nearbysearch/json"
    params = {
        "location": f"{lat},{lon}",
        "radius": radius,
        "type": "restaurant|cafe|bar|bakery|food|meal_delivery|meal_takeaway",
        "key": api_key,
    }
    if keyword:
        params["keyword"] = keyword

    resp = httpx.get(url, params=params, timeout=10)
    data = resp.json()

    if data.get("status") not in ("OK", "ZERO_RESULTS"):
        logger.error(f"Google Places error: {data.get('status')} — {data.get('error_message', '')}")
        raise Exception(f"Google Places: {data.get('status')}")

    places = []
    for r in data.get("results", []):
        geo = r.get("geometry", {}).get("location", {})
        p_lat = geo.get("lat")
        p_lon = geo.get("lng")
        dist = round(_haversine(lat, lon, p_lat, p_lon)) if p_lat and p_lon else None

        # Extract photo reference
        photos = r.get("photos", [])
        photo_ref = photos[0].get("photo_reference") if photos else None

        # Extract types as readable category
        types = r.get("types", [])
        category = _google_type_to_category(types)

        places.append({
            "place_id": r.get("place_id"),
            "name": r.get("name"),
            "address": r.get("vicinity", ""),
            "category": category,
            "google_rating": r.get("rating"),
            "total_ratings": r.get("user_ratings_total", 0),
            "price_level": r.get("price_level"),
            "latitude": p_lat,
            "longitude": p_lon,
            "distance_m": dist,
            "photo_ref": photo_ref,
            "open_now": r.get("opening_hours", {}).get("open_now"),
        })

    # Sort by distance
    places.sort(key=lambda p: p.get("distance_m") or 99999)
    return {"places": places, "source": "google"}


def _google_type_to_category(types: list) -> str:
    """Convert Google Places types to a human-readable category."""
    priority = [
        ("restaurant", "Restaurant"),
        ("cafe", "Cafe"),
        ("bar", "Bar"),
        ("bakery", "Bakery"),
        ("meal_takeaway", "Takeaway"),
        ("meal_delivery", "Delivery"),
        ("food", "Food"),
        ("night_club", "Night Club"),
    ]
    for key, label in priority:
        if key in types:
            return label
    return "Business"


# ── Google Places Photo URL ─────────────────────────────────

def get_photo_url(photo_ref: str, max_width: int = 400) -> str:
    """Build Google Places photo URL."""
    key = settings.GOOGLE_PLACES_API_KEY
    if not key or not photo_ref:
        return ""
    return (
        f"https://maps.googleapis.com/maps/api/place/photo"
        f"?maxwidth={max_width}&photo_reference={photo_ref}&key={key}"
    )


# ── OSM Fallback ────────────────────────────────────────────

def _search_nearby_osm(lat: float, lon: float, radius: int = 1500) -> list:
    """Search OpenStreetMap for nearby businesses (free, no API key)."""
    query = f"""
    [out:json][timeout:10];
    (
      node["shop"](around:{radius},{lat},{lon});
      node["amenity"~"restaurant|cafe|bar|fast_food|pub|bakery"](around:{radius},{lat},{lon});
    );
    out body 20;
    """
    try:
        resp = httpx.post(
            "https://overpass-api.de/api/interpreter",
            data={"data": query},
            timeout=12,
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
        results = []
        for el in data.get("elements", []):
            tags = el.get("tags", {})
            name = tags.get("name")
            if not name:
                continue
            p_lat = el.get("lat")
            p_lon = el.get("lon")
            dist = round(_haversine(lat, lon, p_lat, p_lon)) if p_lat and p_lon else None
            results.append({
                "place_id": f"osm_{el.get('id', '')}",
                "name": name,
                "category": tags.get("amenity") or tags.get("shop") or "business",
                "address": tags.get("addr:street", ""),
                "latitude": p_lat,
                "longitude": p_lon,
                "distance_m": dist,
                "google_rating": None,
                "total_ratings": None,
                "price_level": None,
                "photo_ref": None,
                "open_now": None,
            })
        results.sort(key=lambda p: p.get("distance_m") or 99999)
        return results
    except Exception:
        return []


# ── Competitor CRUD ─────────────────────────────────────────

def add_competitor(user_id: str, db: Session, name: str, address: str = None,
                   category: str = None, notes: str = None) -> dict:
    """Add a competitor manually."""
    comp = Competitor(
        user_id=user_id,
        name=name,
        address=address,
        category=category,
        notes=notes,
    )
    db.add(comp)
    db.commit()
    db.refresh(comp)
    return {"id": str(comp.id), "name": comp.name, "message": "Competitor added"}


def add_competitor_from_place(user_id: str, db: Session, place_data) -> dict:
    """Add a competitor from a Google Places discovery result."""
    # Check if already tracked by place_id
    if place_data.place_id:
        existing = db.query(Competitor).filter(
            Competitor.user_id == user_id,
            Competitor.place_id == place_data.place_id,
        ).first()
        if existing:
            return {"id": str(existing.id), "name": existing.name, "message": "Already tracking this competitor"}

    comp = Competitor(
        user_id=user_id,
        name=place_data.name,
        address=place_data.address,
        category=place_data.category,
        place_id=place_data.place_id,
        google_rating=place_data.google_rating,
        price_level=place_data.price_level,
        latitude=place_data.latitude,
        longitude=place_data.longitude,
        photo_ref=place_data.photo_ref,
        total_ratings=place_data.total_ratings,
    )
    db.add(comp)
    db.commit()
    db.refresh(comp)
    return {"id": str(comp.id), "name": comp.name, "message": f"Now tracking {comp.name}"}


def add_price_check(user_id: str, db: Session, competitor_id: str, item_name: str,
                    their_price: float, our_price: float = None, notes: str = None) -> dict:
    """Log a price comparison for a competitor."""
    comp = db.query(Competitor).filter(
        Competitor.id == competitor_id, Competitor.user_id == user_id
    ).first()
    if not comp:
        return {"error": "Competitor not found"}

    check = CompetitorPrice(
        competitor_id=competitor_id,
        item_name=item_name,
        their_price=their_price,
        our_price=our_price,
        date_checked=date.today(),
        notes=notes,
    )
    db.add(check)
    db.commit()
    return {"message": "Price check logged", "competitor": comp.name, "item": item_name}


def delete_competitor(user_id: str, db: Session, competitor_id: str) -> dict:
    """Delete a competitor and all their price checks."""
    comp = db.query(Competitor).filter(
        Competitor.id == competitor_id, Competitor.user_id == user_id
    ).first()
    if not comp:
        return {"error": "Competitor not found"}
    name = comp.name
    db.delete(comp)
    db.commit()
    return {"message": f"Deleted {name}"}


# ── Insights & Analytics ────────────────────────────────────

def get_competitor_insights(user_id: str, db: Session, lat: float = None, lon: float = None) -> dict:
    """Full competitor analysis: tracked competitors, price comparisons, alerts."""

    competitors = (
        db.query(Competitor)
        .filter(Competitor.user_id == user_id)
        .order_by(Competitor.created_at.desc())
        .all()
    )

    competitor_data = []
    all_price_checks = []
    cheaper_count = 0
    pricier_count = 0
    total_checks = 0

    for comp in competitors:
        prices = (
            db.query(CompetitorPrice)
            .filter(CompetitorPrice.competitor_id == comp.id)
            .order_by(CompetitorPrice.date_checked.desc())
            .all()
        )

        price_list = []
        for p in prices:
            diff = None
            diff_pct = None
            position = "unknown"
            if p.our_price and p.their_price:
                diff = round(float(p.our_price) - float(p.their_price), 2)
                diff_pct = round(diff / float(p.their_price) * 100, 1) if float(p.their_price) > 0 else 0
                if diff > 0:
                    position = "we_are_higher"
                    pricier_count += 1
                elif diff < 0:
                    position = "we_are_lower"
                    cheaper_count += 1
                else:
                    position = "same"
                total_checks += 1

            entry = {
                "id": str(p.id),
                "item": p.item_name,
                "their_price": float(p.their_price),
                "our_price": float(p.our_price) if p.our_price else None,
                "diff": diff,
                "diff_pct": diff_pct,
                "position": position,
                "date": str(p.date_checked),
                "notes": p.notes,
            }
            price_list.append(entry)
            all_price_checks.append({**entry, "competitor": comp.name})

        competitor_data.append({
            "id": str(comp.id),
            "name": comp.name,
            "address": comp.address,
            "category": comp.category,
            "notes": comp.notes,
            "place_id": comp.place_id,
            "google_rating": comp.google_rating,
            "price_level": comp.price_level,
            "total_ratings": comp.total_ratings,
            "photo_ref": comp.photo_ref,
            "price_checks": len(prices),
            "recent_prices": price_list[:5],
            "created": str(comp.created_at.date()) if comp.created_at else None,
        })

    # ─── Price position summary ───
    price_position = "balanced"
    if total_checks >= 3:
        if pricier_count > total_checks * 0.6:
            price_position = "premium"
        elif cheaper_count > total_checks * 0.6:
            price_position = "budget"

    # ─── Items where we're significantly higher ───
    overpriced_items = [
        p for p in all_price_checks
        if p["diff_pct"] is not None and p["diff_pct"] > 15
    ]
    overpriced_items.sort(key=lambda x: x["diff_pct"] or 0, reverse=True)

    # ─── Items where we're cheaper (opportunities to raise) ───
    underpriced_items = [
        p for p in all_price_checks
        if p["diff_pct"] is not None and p["diff_pct"] < -10
    ]
    underpriced_items.sort(key=lambda x: x["diff_pct"] or 0)

    # ─── Alerts ───
    alerts = _generate_competitor_alerts(
        len(competitors), total_checks, price_position,
        overpriced_items, underpriced_items, cheaper_count, pricier_count,
    )

    return {
        "total_competitors": len(competitors),
        "total_price_checks": total_checks,
        "price_position": price_position,
        "cheaper_count": cheaper_count,
        "pricier_count": pricier_count,
        "competitors": competitor_data,
        "overpriced_items": overpriced_items[:5],
        "underpriced_items": underpriced_items[:5],
        "alerts": alerts,
    }


def _generate_competitor_alerts(total_comps, total_checks, position,
                                 overpriced, underpriced, cheaper, pricier):
    alerts = []

    if total_comps == 0:
        alerts.append({
            "type": "no_competitors", "severity": "info", "icon": "🔍",
            "title": "No competitors tracked yet",
            "detail": "Discover nearby businesses and start tracking their prices.",
            "action": "Use the Discover tab to find and track competitors near you.",
        })
        return alerts

    if total_checks == 0:
        alerts.append({
            "type": "no_prices", "severity": "info", "icon": "📋",
            "title": f"{total_comps} competitor(s) tracked, but no price data",
            "detail": "Log price checks to see how your prices compare.",
            "action": "Click on a competitor and add item prices.",
        })
        return alerts

    if overpriced and len(overpriced) >= 2:
        names = ", ".join(p["item"] for p in overpriced[:3])
        alerts.append({
            "type": "overpriced", "severity": "warning", "icon": "📈",
            "title": f"{len(overpriced)} item(s) priced 15%+ above competitors",
            "detail": f"Items: {names}. Higher prices may lose price-sensitive customers.",
            "action": "Consider if premium positioning justifies the gap, or adjust prices.",
        })

    if underpriced and len(underpriced) >= 2:
        names = ", ".join(p["item"] for p in underpriced[:3])
        alerts.append({
            "type": "underpriced", "severity": "positive", "icon": "💡",
            "title": f"{len(underpriced)} item(s) priced 10%+ below competitors",
            "detail": f"Items: {names}. You have room to raise prices without losing competitiveness.",
            "action": "Small price increases on these items = free profit.",
        })

    if position == "premium":
        alerts.append({
            "type": "premium", "severity": "info", "icon": "👑",
            "title": "Premium positioning detected",
            "detail": f"You're priced higher on {pricier} of {total_checks} items. Ensure quality matches.",
            "action": None,
        })
    elif position == "budget":
        alerts.append({
            "type": "budget", "severity": "info", "icon": "🏷️",
            "title": "Budget positioning detected",
            "detail": f"You're priced lower on {cheaper} of {total_checks} items.",
            "action": "Consider selective price increases on high-demand items.",
        })

    if not alerts:
        alerts.append({
            "type": "balanced", "severity": "positive", "icon": "✅",
            "title": "Competitive pricing looks balanced",
            "detail": "Your prices are in line with competitors.",
            "action": None,
        })

    return alerts
