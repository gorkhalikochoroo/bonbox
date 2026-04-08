"""
Cross-Outlet Intelligence Service — compares performance across team members (outlets),
detects stock imbalances, suggests transfers.

Works with existing team structure: owner + team members where each user_id
represents a point-of-sale or outlet.
"""

from datetime import date, timedelta
from collections import defaultdict

from sqlalchemy import func, and_
from sqlalchemy.orm import Session

from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense
from app.models.inventory import InventoryItem


def get_outlet_intelligence(user_id: str, db: Session) -> dict:
    """Cross-outlet comparison: performance, inventory, transfer suggestions."""
    today = date.today()
    d30 = today - timedelta(days=30)

    # Get team members (outlets) under this owner
    owner = db.query(User).filter(User.id == user_id).first()
    if not owner:
        return _empty_response()

    team_members = (
        db.query(User)
        .filter(User.owner_id == user_id)
        .all()
    )

    # Include owner as an outlet too
    all_outlets = [owner] + team_members

    if len(all_outlets) < 2:
        return _empty_response(
            message="Cross-outlet intelligence requires at least 2 team members. Add staff in Team to enable comparisons."
        )

    # ─── Per-outlet performance ───
    outlet_data = []
    all_inventory = defaultdict(list)  # item_name -> [{outlet, qty, cost, ...}]

    for outlet in all_outlets:
        oid = outlet.id
        label = outlet.business_name or outlet.email or f"Outlet {str(oid)[:6]}"
        role = outlet.role or "owner" if outlet.id == user_id else outlet.role or "staff"

        # Sales
        sales_result = db.query(
            func.count(Sale.id).label("txns"),
            func.coalesce(func.sum(Sale.amount), 0).label("revenue"),
        ).filter(
            Sale.user_id == oid, Sale.date >= d30, Sale.is_deleted.isnot(True)
        ).first()

        txns = int(sales_result.txns or 0)
        revenue = float(sales_result.revenue or 0)
        avg_ticket = round(revenue / txns, 2) if txns else 0

        # Expenses
        expenses_result = db.query(
            func.coalesce(func.sum(Expense.amount), 0)
        ).filter(
            Expense.user_id == oid, Expense.date >= d30,
            Expense.is_deleted.isnot(True), Expense.is_personal.isnot(True),
        ).scalar() or 0
        expenses = float(expenses_result)

        profit = round(revenue - expenses, 2)
        margin = round(profit / revenue * 100, 1) if revenue > 0 else 0

        # Inventory summary
        inv_items = (
            db.query(
                InventoryItem.name,
                InventoryItem.quantity,
                InventoryItem.cost_per_unit,
                InventoryItem.min_threshold,
                InventoryItem.unit,
            )
            .filter(InventoryItem.user_id == oid, InventoryItem.quantity > 0)
            .all()
        )

        inv_count = len(inv_items)
        inv_value = sum(
            float(i.quantity or 0) * float(i.cost_per_unit or 0) for i in inv_items
        )
        low_stock = sum(
            1 for i in inv_items
            if float(i.quantity or 0) <= float(i.min_threshold or 0) and float(i.min_threshold or 0) > 0
        )

        # Track items for imbalance detection
        for item in inv_items:
            all_inventory[item.name].append({
                "outlet": label,
                "outlet_id": str(oid),
                "qty": float(item.quantity or 0),
                "cost": float(item.cost_per_unit or 0),
                "threshold": float(item.min_threshold or 0),
                "unit": item.unit,
            })

        outlet_data.append({
            "id": str(oid),
            "name": label,
            "role": role,
            "revenue": round(revenue, 2),
            "transactions": txns,
            "avg_ticket": avg_ticket,
            "expenses": round(expenses, 2),
            "profit": profit,
            "margin": margin,
            "inventory_items": inv_count,
            "inventory_value": round(inv_value, 2),
            "low_stock_count": low_stock,
        })

    # Sort by revenue
    outlet_data.sort(key=lambda x: x["revenue"], reverse=True)

    # ─── Stock imbalances & transfer suggestions ───
    imbalances = []
    transfers = []

    for item_name, locations in all_inventory.items():
        if len(locations) < 2:
            continue

        qtys = [loc["qty"] for loc in locations]
        avg_qty = sum(qtys) / len(qtys)
        if avg_qty == 0:
            continue

        max_loc = max(locations, key=lambda x: x["qty"])
        min_loc = min(locations, key=lambda x: x["qty"])

        # Significant imbalance: one has 2x+ the average, another below threshold
        if max_loc["qty"] > avg_qty * 1.5 and min_loc["qty"] < avg_qty * 0.6:
            surplus = round(max_loc["qty"] - avg_qty, 1)
            deficit = round(avg_qty - min_loc["qty"], 1)
            transfer_qty = round(min(surplus, deficit), 1)

            imbalances.append({
                "item": item_name,
                "unit": max_loc["unit"],
                "surplus_outlet": max_loc["outlet"],
                "surplus_qty": round(max_loc["qty"], 1),
                "deficit_outlet": min_loc["outlet"],
                "deficit_qty": round(min_loc["qty"], 1),
                "avg_qty": round(avg_qty, 1),
            })

            if transfer_qty > 0:
                transfers.append({
                    "item": item_name,
                    "unit": max_loc["unit"],
                    "from_outlet": max_loc["outlet"],
                    "to_outlet": min_loc["outlet"],
                    "suggested_qty": transfer_qty,
                    "value": round(transfer_qty * max_loc["cost"], 2),
                })

    # Sort by value (highest value transfers first)
    transfers.sort(key=lambda x: x["value"], reverse=True)

    # ─── Performance comparison metrics ───
    total_revenue = sum(o["revenue"] for o in outlet_data)
    total_txns = sum(o["transactions"] for o in outlet_data)
    best = outlet_data[0] if outlet_data else None
    weakest = outlet_data[-1] if len(outlet_data) >= 2 else None

    # ─── Alerts ───
    alerts = _generate_outlet_alerts(
        outlet_data, imbalances, transfers, total_revenue, best, weakest,
    )

    return {
        "outlet_count": len(outlet_data),
        "outlets": outlet_data,
        "total_revenue": round(total_revenue, 2),
        "total_transactions": total_txns,
        "imbalances": imbalances[:10],
        "transfer_suggestions": transfers[:10],
        "best_performer": best,
        "weakest_performer": weakest,
        "alerts": alerts,
    }


def _empty_response(message=None):
    return {
        "outlet_count": 0,
        "outlets": [],
        "total_revenue": 0,
        "total_transactions": 0,
        "imbalances": [],
        "transfer_suggestions": [],
        "best_performer": None,
        "weakest_performer": None,
        "alerts": [{
            "type": "no_data", "severity": "info", "icon": "🏪",
            "title": "Cross-outlet intelligence not available yet",
            "detail": message or "Add team members to enable cross-outlet comparisons.",
            "action": "Go to Team and invite staff or managers for your outlets.",
        }],
    }


def _generate_outlet_alerts(outlets, imbalances, transfers, total_rev, best, weakest):
    alerts = []

    if len(outlets) >= 2 and best and weakest:
        gap = best["revenue"] - weakest["revenue"]
        if gap > 0 and best["revenue"] > 0:
            gap_pct = round(gap / best["revenue"] * 100)
            if gap_pct > 40:
                alerts.append({
                    "type": "performance_gap", "severity": "warning", "icon": "📊",
                    "title": f"Performance gap: {gap_pct}% between outlets",
                    "detail": f"{best['name']} leads with {round(best['revenue']):,} revenue vs {weakest['name']} at {round(weakest['revenue']):,}.",
                    "action": "Investigate what's working at the top performer and replicate.",
                })

    if transfers:
        total_value = sum(t["value"] for t in transfers)
        alerts.append({
            "type": "transfer_opportunity", "severity": "info", "icon": "🔄",
            "title": f"{len(transfers)} stock transfer(s) suggested",
            "detail": f"Rebalancing stock could save ~{round(total_value):,} in value at risk.",
            "action": "Review transfer suggestions and move surplus stock to outlets that need it.",
        })

    if imbalances and len(imbalances) >= 3:
        alerts.append({
            "type": "stock_imbalance", "severity": "warning", "icon": "⚖️",
            "title": f"{len(imbalances)} stock imbalances detected",
            "detail": "Multiple items are unevenly distributed across outlets.",
            "action": "Consider centralizing ordering or weekly stock audits.",
        })

    # Check for outlets with high expenses relative to revenue
    for o in outlets:
        if o["revenue"] > 0 and o["margin"] < 10:
            alerts.append({
                "type": "low_margin", "severity": "warning", "icon": "⚠️",
                "title": f"{o['name']}: margin only {o['margin']}%",
                "detail": f"Revenue {round(o['revenue']):,} vs expenses {round(o['expenses']):,}.",
                "action": "Review expenses for this outlet.",
            })
            break  # Only one alert for this

    if not alerts:
        alerts.append({
            "type": "healthy", "severity": "positive", "icon": "✅",
            "title": "All outlets performing well",
            "detail": "No major imbalances or performance gaps detected.",
            "action": None,
        })

    return alerts
