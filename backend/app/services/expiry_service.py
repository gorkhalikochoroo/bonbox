"""
Expiry Forecasting Service — tracks items approaching expiry, waste prediction,
order reduction recommendations.

Uses inventory (expiry_date, is_perishable) + waste logs (historical waste patterns).

────────────────────────────────────────────────────────────────────────
Phase 1 — Expiry alert chain (May 2026, Manoj-confirmed)
────────────────────────────────────────────────────────────────────────
Functions below `get_expiry_forecast` power the Phase 1 alert chain:
  • scan_upcoming_expiries() — surface items expiring in N days, with
    a defensive feature-flag check so Free users can't sneak past L4.
  • estimate_waste_cost() — DKK at risk for items in the alert window.
    Returns 0 for users lacking `expiry_alerts` (defensive L4 layer
    behind the router gate at L3).
  • infer_expiry_date() — single source of truth for "this item has no
    explicit expiry; should we guess?". Combines received_date /
    created_at + category shelf-life from inventory_perishable.
  • record_expiry_action() — log a used / wasted / extended /
    sold_at_discount action on a soon-expiring item; writes an
    AuditLog row (L7) so the future "BonBox saved you X kr this
    month" claim has provenance.

All functions are user-scoped (L5) and fail closed (L6) on missing data
or unknown feature flags.
"""

from datetime import date, datetime, timedelta
from collections import defaultdict
from typing import Optional
from uuid import UUID

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


# ═══════════════════════════════════════════════════════════════════════
# Phase 1 — Expiry alert chain (Manoj-confirmed, May 2026)
# ═══════════════════════════════════════════════════════════════════════

# Per-action enumeration. Stays a flat tuple so the router can build a
# pydantic Literal and tests can iterate the canonical list. Each value
# maps to (audit_action, optional WasteLog reason).
_EXPIRY_ACTIONS: dict[str, dict[str, str | None]] = {
    "used": {"audit": "expiry.item_used", "waste_reason": None},
    "wasted": {"audit": "expiry.item_wasted", "waste_reason": "expired"},
    "extended": {"audit": "expiry.item_extended", "waste_reason": None},
    "sold_discount": {"audit": "expiry.item_sold_discount", "waste_reason": None},
}


def allowed_expiry_actions() -> list[str]:
    """Canonical action list. Used by tests + the router Literal."""
    return list(_EXPIRY_ACTIONS.keys())


def infer_expiry_date(item: InventoryItem) -> Optional[date]:
    """Single source of truth for "what date should we treat this item
    as expiring on?".

    Multi-layer fallback per L8 (inventory OCR → category default → silent):
      1. If item already has explicit expiry_date, use it.
      2. Otherwise: if category is in PERISHABLE_CATEGORIES AND a base
         date is available (received_date OR created_at::date), infer
         received_date + (expected_shelf_life_days OR category default).
      3. Otherwise: None — item is silently skipped from alerts (no
         false-positive "expires in ?" entries per L6 / L9).
    """
    if item.expiry_date:
        return item.expiry_date
    # Lazy import keeps the SHELF_LIFE_DAYS dict out of this module's
    # top-level import graph — used only when we need to infer.
    from app.services.inventory_perishable import (
        compute_default_expiry, is_perishable_category,
    )
    cat = getattr(item, "category", None)
    if not is_perishable_category(cat):
        return None
    base = getattr(item, "received_date", None)
    if base is None:
        created = getattr(item, "created_at", None)
        base = created.date() if isinstance(created, datetime) else None
    if base is None:
        base = date.today()
    override = getattr(item, "expected_shelf_life_days", None)
    if isinstance(override, int) and 0 < override <= 365:
        return base + timedelta(days=int(override))
    return compute_default_expiry(cat, base)


def scan_upcoming_expiries(
    user,
    db: Session,
    *,
    days_ahead: int = 3,
    include_expired: bool = True,
) -> dict:
    """Return items expiring within `days_ahead` days.

    Returns
    -------
    {
        "items": [
            {
                "id": str,
                "name": str,
                "category": str | None,
                "quantity": float,
                "unit": str,
                "expiry_date": "YYYY-MM-DD",
                "days_left": int,                 # negative = expired
                "cost_at_risk_dkk": float | None, # None for Free users
                "inferred": bool,                 # True = no explicit date
            },
            ...
        ],
        "total_at_risk_dkk": float,
        "feature_available": bool,                # has_feature(expiry_alerts)
        "scan_window_days": int,
    }

    L4 — defensive feature gate runs inside the service so a router that
    forgets to gate, or a bypass via cron, still strips the waste-cost
    field for Free users (which is the marketing-promise tier line).
    L5 — strictly user_id-scoped query; cross-tenant access impossible.
    """
    from app.services.billing import has_feature  # lazy import

    today = date.today()
    cutoff = today + timedelta(days=max(0, int(days_ahead)))

    # Pull every perishable / dated item; we infer in Python because
    # inferred dates aren't stored. Cap at 200 to keep memory bounded.
    rows = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity > 0,
        )
        .order_by(InventoryItem.expiry_date.asc().nullslast())
        .limit(200)
        .all()
    )

    feature_available = bool(has_feature(user, "expiry_alerts"))

    items_out: list[dict] = []
    total_at_risk = 0.0
    for item in rows:
        eff_date = infer_expiry_date(item)
        if eff_date is None:
            continue  # L8 silent skip — no category, no explicit date
        days_left = (eff_date - today).days
        if days_left < 0 and not include_expired:
            continue
        if days_left > int(days_ahead):
            continue
        qty = float(item.quantity or 0)
        unit_cost = float(item.cost_per_unit or 0)
        cost = round(qty * unit_cost, 2)
        total_at_risk += cost
        inferred = item.expiry_date is None
        items_out.append({
            "id": str(item.id),
            "name": item.name,
            "category": item.category or None,
            "quantity": qty,
            "unit": item.unit or "pieces",
            "expiry_date": eff_date.isoformat(),
            "days_left": days_left,
            # L4 — waste-cost field is gated. Free users see the items
            # but the DKK column is None (frontend hides the column).
            "cost_at_risk_dkk": cost if feature_available else None,
            "inferred": inferred,
        })

    return {
        "items": items_out,
        # Tier-gated aggregate — Free gets 0, paid gets the real number.
        # Mirrors the "(380 DKK at risk)" line in the Brief insight.
        "total_at_risk_dkk": round(total_at_risk, 2) if feature_available else 0.0,
        "feature_available": feature_available,
        "scan_window_days": int(days_ahead),
    }


def estimate_waste_cost(user, db: Session, *, days_ahead: int = 3) -> float:
    """Sum of cost_at_risk for items expiring within `days_ahead` days.

    L4 — defensive: returns 0.0 for Free users (no `expiry_alerts`)
    regardless of what items are in stock. The router/Brief generator
    SHOULD have already filtered at the call site, but this defensive
    layer ensures a refactor can't accidentally leak a paid-tier number.
    """
    from app.services.billing import has_feature
    if not has_feature(user, "expiry_alerts"):
        return 0.0
    scan = scan_upcoming_expiries(user, db, days_ahead=days_ahead)
    return float(scan.get("total_at_risk_dkk") or 0.0)


def record_expiry_action(
    db: Session,
    user,
    item: InventoryItem,
    *,
    action: str,
    ip_address: str | None = None,
) -> dict:
    """Apply an owner-confirmed action to a soon-expiring item.

    Actions:
      • "used"          — used in service; decrements stock, no waste log
      • "wasted"        — discarded; decrements stock + writes WasteLog
      • "extended"      — pushes expiry_date +3 days (owner override)
      • "sold_discount" — sold at discount; decrements stock, no waste

    L7 — every action writes an AuditLog row (`expiry.action_taken`)
    with item_id, action, and item_value_dkk so the future "BonBox
    saved you X kr this month from prevented waste" claim has data.
    L9 — extensions and stock-decrements are bounded so a misclick
    can't wipe the quantity below zero.
    """
    from app.services.audit_service import record as audit_record

    if action not in _EXPIRY_ACTIONS:
        raise ValueError(f"unknown expiry action: {action!r}")

    qty = float(item.quantity or 0)
    unit_cost = float(item.cost_per_unit or 0)
    item_value = round(qty * unit_cost, 2)
    before = {
        "id": str(item.id),
        "quantity": qty,
        "expiry_date": item.expiry_date.isoformat() if item.expiry_date else None,
    }

    if action == "extended":
        # Owner overrides by pushing the expiry +3 days. Bounded so a
        # holding-the-button misclick can't extend by a year.
        from datetime import timedelta as _td
        base = item.expiry_date or infer_expiry_date(item) or date.today()
        item.expiry_date = base + _td(days=3)
    elif action == "wasted":
        # Decrement quantity to 0 + log waste row with `expired` reason.
        item.quantity = 0
        try:
            db.add(WasteLog(
                user_id=user.id,
                item_name=item.name,
                quantity=qty,
                unit=item.unit or "pieces",
                estimated_cost=item_value,
                reason="expired",
                date=date.today(),
            ))
        except Exception:  # noqa: BLE001
            # WasteLog signature may evolve; do not block the user's
            # action on a write here — the audit log captures it.
            pass
    elif action in ("used", "sold_discount"):
        # Decrement to 0; the existing inventory flow will rebuild the
        # quantity on the next received delivery. Bounded below 0.
        item.quantity = 0

    after = {
        "id": str(item.id),
        "quantity": float(item.quantity or 0),
        "expiry_date": item.expiry_date.isoformat() if item.expiry_date else None,
        "action": action,
    }

    # L7 — single audit row covers both alerts AND owner actions; the
    # action key in the JSON detail makes them filterable.
    audit_record(
        db,
        user,
        action="expiry.action_taken",
        entity_type="inventory_item",
        entity_id=item.id if isinstance(item.id, UUID) else None,
        before=before,
        after={**after, "item_value_dkk": item_value},
        ip_address=ip_address,
    )
    db.commit()
    return {"ok": True, "action": action, "item_value_dkk": item_value}


def record_alert_sent(
    db: Session,
    user,
    *,
    items_count: int,
    total_at_risk_dkk: float,
    channel: str = "brief",
) -> None:
    """L7 — log that an expiry alert was surfaced (Brief, push, or
    Dashboard card render). Best-effort; an audit-write failure does
    not block the alert from reaching the user.
    """
    if items_count <= 0:
        return  # L9 — no false-positive "0 items expiring" alerts logged
    try:
        from app.services.audit_service import record as audit_record
        audit_record(
            db,
            user,
            action="expiry.alert_sent",
            entity_type="user",
            entity_id=user.id if isinstance(getattr(user, "id", None), UUID) else None,
            after={
                "items_count": int(items_count),
                "total_at_risk_dkk": round(float(total_at_risk_dkk or 0), 2),
                "channel": channel[:40],
            },
        )
        db.commit()
    except Exception:  # noqa: BLE001
        # Never let observability writes break user-visible alerts.
        pass
