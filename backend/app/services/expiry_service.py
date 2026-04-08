"""
Expiry Forecasting Service — tracks items approaching expiry, waste prediction,
order reduction recommendations.

Uses inventory (expiry_date, is_perishable) + waste logs (historical waste patterns).
"""

from datetime import date, timedelta
from collections import defaultdict

from sqlalchemy import func, and_
from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem
from app.models.waste import WasteLog


def get_expiry_forecast(user_id: str, db: Session) -> dict:
    """Full expiry analysis: upcoming expirations, waste trends, recommendations."""
    today = date.today()
    d7 = today + timedelta(days=7)
    d14 = today + timedelta(days=14)
    d30 = today + timedelta(days=30)

    # ─── Items with expiry dates ───
    items_with_expiry = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user_id,
            InventoryItem.expiry_date.isnot(None),
            InventoryItem.quantity > 0,
        )
        .order_by(InventoryItem.expiry_date.asc())
        .all()
    )

    expired = []
    expiring_soon = []      # within 7 days
    expiring_moderate = []   # 7-14 days
    expiring_later = []      # 14-30 days

    total_at_risk_value = 0

    for item in items_with_expiry:
        days_left = (item.expiry_date - today).days
        cost = float(item.cost_per_unit or 0) * float(item.quantity or 0)
        sell_value = float(item.sell_price or 0) * float(item.quantity or 0)

        entry = {
            "id": str(item.id),
            "name": item.name,
            "category": item.category or "General",
            "quantity": float(item.quantity),
            "unit": item.unit,
            "expiry_date": str(item.expiry_date),
            "days_left": days_left,
            "cost_at_risk": round(cost, 2),
            "sell_value": round(sell_value, 2),
            "is_perishable": item.is_perishable,
        }

        if days_left < 0:
            entry["status"] = "expired"
            expired.append(entry)
            total_at_risk_value += cost
        elif days_left <= 7:
            entry["status"] = "critical"
            expiring_soon.append(entry)
            total_at_risk_value += cost
        elif days_left <= 14:
            entry["status"] = "warning"
            expiring_moderate.append(entry)
            total_at_risk_value += cost * 0.5  # partial risk
        elif days_left <= 30:
            entry["status"] = "upcoming"
            expiring_later.append(entry)

    # ─── Perishable items WITHOUT expiry dates (gap detection) ───
    perishable_no_expiry = (
        db.query(InventoryItem.name, InventoryItem.quantity, InventoryItem.unit)
        .filter(
            InventoryItem.user_id == user_id,
            InventoryItem.is_perishable.is_(True),
            InventoryItem.expiry_date.is_(None),
            InventoryItem.quantity > 0,
        )
        .limit(10)
        .all()
    )
    missing_expiry = [
        {"name": i.name, "quantity": float(i.quantity), "unit": i.unit}
        for i in perishable_no_expiry
    ]

    # ─── Waste history (last 90 days) ───
    d90_ago = today - timedelta(days=90)
    waste_logs = (
        db.query(
            WasteLog.item_name,
            WasteLog.reason,
            func.count(WasteLog.id).label("count"),
            func.sum(WasteLog.estimated_cost).label("total_cost"),
            func.sum(WasteLog.quantity).label("total_qty"),
        )
        .filter(
            WasteLog.user_id == user_id,
            WasteLog.date >= d90_ago,
            WasteLog.is_deleted.isnot(True),
        )
        .group_by(WasteLog.item_name, WasteLog.reason)
        .order_by(func.sum(WasteLog.estimated_cost).desc())
        .limit(20)
        .all()
    )

    # Aggregate waste by item
    waste_by_item = defaultdict(lambda: {"expired_cost": 0, "other_cost": 0, "total_qty": 0, "count": 0})
    total_waste_cost = 0
    expired_waste_cost = 0

    for row in waste_logs:
        cost = float(row.total_cost or 0)
        total_waste_cost += cost
        item = waste_by_item[row.item_name]
        item["count"] += int(row.count)
        item["total_qty"] += float(row.total_qty or 0)
        if row.reason == "expired":
            item["expired_cost"] += cost
            expired_waste_cost += cost
        else:
            item["other_cost"] += cost

    # Top wasted items
    top_waste = sorted(
        [{"name": k, **v, "total_cost": round(v["expired_cost"] + v["other_cost"], 2)}
         for k, v in waste_by_item.items()],
        key=lambda x: x["total_cost"],
        reverse=True,
    )[:10]

    # ─── Monthly waste trend ───
    monthly_waste = (
        db.query(
            func.date_trunc("month", WasteLog.date).label("month") if not _is_sqlite(db) else WasteLog.date,
            func.sum(WasteLog.estimated_cost).label("cost"),
            func.count(WasteLog.id).label("count"),
        )
        .filter(
            WasteLog.user_id == user_id,
            WasteLog.date >= today - timedelta(days=180),
            WasteLog.is_deleted.isnot(True),
        )
        .group_by("month")
        .order_by("month")
        .all()
    ) if not _is_sqlite(db) else []

    waste_trend = []
    for row in monthly_waste:
        month_str = row.month.strftime("%b %Y") if hasattr(row.month, "strftime") else str(row.month)
        waste_trend.append({
            "month": month_str,
            "cost": round(float(row.cost or 0), 2),
            "count": int(row.count or 0),
        })

    # ─── Recommendations ───
    recommendations = _generate_recommendations(
        expired, expiring_soon, top_waste, total_at_risk_value, expired_waste_cost,
    )

    # ─── Alerts ───
    alerts = _generate_expiry_alerts(
        expired, expiring_soon, expiring_moderate, missing_expiry,
        total_at_risk_value, total_waste_cost, expired_waste_cost,
    )

    return {
        "expired_items": expired[:10],
        "expiring_soon": expiring_soon[:10],
        "expiring_moderate": expiring_moderate[:10],
        "expiring_later": expiring_later[:10],
        "total_at_risk_value": round(total_at_risk_value, 2),
        "total_tracked_items": len(items_with_expiry),
        "missing_expiry": missing_expiry[:5],
        "waste_summary": {
            "total_cost_90d": round(total_waste_cost, 2),
            "expired_cost_90d": round(expired_waste_cost, 2),
            "top_items": top_waste[:5],
        },
        "waste_trend": waste_trend,
        "recommendations": recommendations,
        "alerts": alerts,
    }


def _is_sqlite(db: Session) -> bool:
    """Check if database is SQLite (for query compatibility)."""
    try:
        return "sqlite" in str(db.get_bind().url)
    except Exception:
        return False


def _generate_recommendations(expired, expiring_soon, top_waste, at_risk_value, expired_waste_cost):
    """Actionable recommendations based on expiry/waste data."""
    recs = []

    if expired:
        names = ", ".join(i["name"] for i in expired[:3])
        recs.append({
            "type": "remove_expired", "priority": "high", "icon": "🗑️",
            "title": f"Remove {len(expired)} expired item(s)",
            "detail": f"Items past expiry: {names}. Log as waste and remove from stock.",
        })

    if expiring_soon:
        names = ", ".join(i["name"] for i in expiring_soon[:3])
        recs.append({
            "type": "discount_soon", "priority": "high", "icon": "🏷️",
            "title": f"Discount {len(expiring_soon)} item(s) expiring within 7 days",
            "detail": f"{names} — sell at reduced price to avoid waste.",
        })

    # Items that repeatedly get wasted → reduce order quantity
    repeat_waste = [w for w in top_waste if w["count"] >= 3]
    if repeat_waste:
        names = ", ".join(w["name"] for w in repeat_waste[:3])
        recs.append({
            "type": "reduce_order", "priority": "medium", "icon": "📦",
            "title": "Reduce order quantity for repeat-waste items",
            "detail": f"{names} appear frequently in waste logs. Order less to reduce losses.",
        })

    if at_risk_value > 0:
        recs.append({
            "type": "value_at_risk", "priority": "medium", "icon": "💸",
            "title": f"Value at risk: {round(at_risk_value):,}",
            "detail": "Total cost of expired + soon-expiring stock. Act now to minimize loss.",
        })

    if not recs:
        recs.append({
            "type": "all_good", "priority": "low", "icon": "✅",
            "title": "No urgent expiry issues",
            "detail": "Keep tracking expiry dates to stay ahead of waste.",
        })

    return recs


def _generate_expiry_alerts(expired, soon, moderate, missing, at_risk, waste_total, waste_expired):
    alerts = []

    if expired:
        alerts.append({
            "type": "expired_stock", "severity": "warning", "icon": "🚨",
            "title": f"{len(expired)} item(s) already expired!",
            "detail": "Remove from stock immediately and log as waste.",
            "action": "Go to Inventory to update stock, then log in Waste Tracker.",
        })

    if soon:
        cost = sum(i["cost_at_risk"] for i in soon)
        alerts.append({
            "type": "expiring_soon", "severity": "warning", "icon": "⏰",
            "title": f"{len(soon)} item(s) expire within 7 days",
            "detail": f"At-risk value: {round(cost):,}. Sell, discount, or use before expiry.",
            "action": "Consider a flash sale or bundle deal.",
        })

    if moderate:
        alerts.append({
            "type": "expiring_moderate", "severity": "info", "icon": "📅",
            "title": f"{len(moderate)} item(s) expire in 7-14 days",
            "detail": "Plan to use or promote these items soon.",
            "action": None,
        })

    if missing and len(missing) >= 2:
        alerts.append({
            "type": "missing_expiry", "severity": "info", "icon": "📝",
            "title": f"{len(missing)} perishable items missing expiry dates",
            "detail": "Add expiry dates to enable forecasting for these items.",
            "action": "Go to Inventory and update expiry dates.",
        })

    if waste_expired > 500:
        alerts.append({
            "type": "high_waste", "severity": "warning", "icon": "📉",
            "title": f"Expired waste cost: {round(waste_expired):,} (90 days)",
            "detail": "Significant value lost to expiry. Better tracking and ordering can help.",
            "action": "Review top wasted items and reduce order quantities.",
        })

    if not alerts:
        alerts.append({
            "type": "healthy", "severity": "positive", "icon": "✅",
            "title": "Expiry tracking looks good",
            "detail": "No urgent issues. Keep adding expiry dates to stay ahead.",
            "action": None,
        })

    return alerts
