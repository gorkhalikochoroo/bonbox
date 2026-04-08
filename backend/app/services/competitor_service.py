"""
Competitor Scan Service — track competitors, compare prices, detect positioning gaps.

Manual competitor tracking + price comparison analytics.
Uses OpenStreetMap Overpass API (free, no key) for nearby business discovery.
"""

from datetime import date, timedelta
from collections import defaultdict

import httpx
from sqlalchemy import func, and_
from sqlalchemy.orm import Session

from app.models.competitor import Competitor, CompetitorPrice
from app.models.sale import Sale


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

    # ─── Nearby businesses from OpenStreetMap ───
    nearby = []
    if lat and lon:
        nearby = _search_nearby_osm(lat, lon)

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
        "nearby_businesses": nearby[:10],
        "alerts": alerts,
    }


def add_competitor(user_id: str, db: Session, name: str, address: str = None, category: str = None, notes: str = None) -> dict:
    """Add a competitor to track."""
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


def add_price_check(user_id: str, db: Session, competitor_id: str, item_name: str,
                    their_price: float, our_price: float = None, notes: str = None) -> dict:
    """Log a price comparison for a competitor."""
    # Verify competitor belongs to user
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


def _search_nearby_osm(lat: float, lon: float, radius: int = 1000) -> list:
    """Search OpenStreetMap for nearby businesses (free, no API key)."""
    query = f"""
    [out:json][timeout:10];
    (
      node["shop"](around:{radius},{lat},{lon});
      node["amenity"~"restaurant|cafe|bar|fast_food|pub"](around:{radius},{lat},{lon});
    );
    out body 15;
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
            results.append({
                "name": name,
                "type": tags.get("amenity") or tags.get("shop") or "business",
                "address": tags.get("addr:street", ""),
                "lat": el.get("lat"),
                "lon": el.get("lon"),
            })
        return results
    except Exception:
        return []


def _generate_competitor_alerts(total_comps, total_checks, position,
                                 overpriced, underpriced, cheaper, pricier):
    alerts = []

    if total_comps == 0:
        alerts.append({
            "type": "no_competitors", "severity": "info", "icon": "🔍",
            "title": "No competitors tracked yet",
            "detail": "Add your nearby competitors to start price monitoring and market positioning.",
            "action": "Use the form below to add your first competitor.",
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
