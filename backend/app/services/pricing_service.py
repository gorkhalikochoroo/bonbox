"""
Price Optimization Service — margin analysis, ticket trends, price impact simulation.

Uses existing sales + inventory data. No external API needed.
"""

from datetime import date, timedelta
from collections import defaultdict

from sqlalchemy import func, and_
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.inventory import InventoryItem


def get_pricing_insights(user_id, db: Session) -> dict:
    """Analyze pricing: avg ticket, margins, top items, price simulation."""
    today = date.today()
    d30 = today - timedelta(days=30)
    d60 = today - timedelta(days=60)

    # ─── Average ticket ───
    current = db.query(
        func.count(Sale.id).label("txns"),
        func.coalesce(func.sum(Sale.amount), 0).label("rev"),
    ).filter(Sale.user_id == user_id, Sale.date >= d30, Sale.is_deleted.isnot(True)).first()

    prev = db.query(
        func.count(Sale.id).label("txns"),
        func.coalesce(func.sum(Sale.amount), 0).label("rev"),
    ).filter(Sale.user_id == user_id, Sale.date >= d60, Sale.date < d30, Sale.is_deleted.isnot(True)).first()

    cur_txns = int(current.txns or 0)
    cur_rev = float(current.rev or 0)
    prev_txns = int(prev.txns or 0)
    prev_rev = float(prev.rev or 0)

    avg_ticket = round(cur_rev / cur_txns, 2) if cur_txns else 0
    prev_avg_ticket = round(prev_rev / prev_txns, 2) if prev_txns else 0
    ticket_change = round(avg_ticket - prev_avg_ticket, 2)
    daily_volume = round(cur_txns / 30, 1) if cur_txns else 0

    # ─── Item-level margins ───
    item_sales = (
        db.query(
            Sale.item_name,
            func.count(Sale.id).label("qty"),
            func.sum(Sale.amount).label("revenue"),
            func.avg(Sale.unit_price).label("avg_price"),
            func.avg(Sale.cost_at_sale).label("avg_cost"),
        )
        .filter(
            Sale.user_id == user_id, Sale.date >= d30,
            Sale.is_deleted.isnot(True),
            Sale.item_name.isnot(None),
            Sale.unit_price.isnot(None),
        )
        .group_by(Sale.item_name)
        .order_by(func.sum(Sale.amount).desc())
        .limit(20)
        .all()
    )

    # Moms-aware margin (same pattern as wine.py / inventory.py).
    # avg_price comes from Sale.unit_price which is gross/incl-Moms in B2C
    # default; avg_cost is the wholesale cost stored ex-Moms. Comparing
    # raw gives an inflated margin number — extract Moms first.
    try:
        from app.services.tax_service import _get_vat_rate
        from app.models.user import User as _User
        u = db.query(_User).filter(_User.id == user_id).first()
        vat_rate = _get_vat_rate(getattr(u, "currency", "DKK") or "DKK")
        prices_incl_moms = bool(getattr(u, "prices_include_moms", True))
    except Exception:  # noqa: BLE001
        vat_rate = 0.25
        prices_incl_moms = True

    items = []
    low_margin_items = []
    for row in item_sales:
        avg_price_gross = float(row.avg_price or 0)
        avg_cost = float(row.avg_cost or 0)
        # Net price = what business actually keeps after Moms is remitted
        if prices_incl_moms and vat_rate > 0:
            net_price = avg_price_gross / (1 + vat_rate)
        else:
            net_price = avg_price_gross
        margin = round((net_price - avg_cost) / net_price * 100, 1) if net_price > 0 else 0
        revenue = float(row.revenue or 0)

        item = {
            "name": row.item_name,
            "qty_sold": int(row.qty),
            "revenue": round(revenue, 2),
            "avg_price": round(avg_price_gross, 2),       # display gross to user
            "avg_price_net": round(net_price, 2),         # for cross-check
            "avg_cost": round(avg_cost, 2),
            "margin_pct": margin,
        }
        items.append(item)
        if 0 < margin < 30 and revenue > 0:
            low_margin_items.append(item)

    # ─── Inventory items without sales (potential dead stock pricing issue) ───
    unsold_items = (
        db.query(InventoryItem.name, InventoryItem.sell_price, InventoryItem.cost_per_unit, InventoryItem.quantity)
        .filter(
            InventoryItem.user_id == user_id,
            InventoryItem.quantity > 0,
            InventoryItem.sell_price.isnot(None),
            ~InventoryItem.id.in_(
                db.query(Sale.inventory_item_id)
                .filter(Sale.user_id == user_id, Sale.date >= d30, Sale.inventory_item_id.isnot(None))
                .distinct()
            ),
        )
        .limit(10)
        .all()
    )

    no_sales = [
        {
            "name": item.name,
            "sell_price": float(item.sell_price) if item.sell_price else 0,
            "cost": float(item.cost_per_unit) if item.cost_per_unit else 0,
            "stock": float(item.quantity),
        }
        for item in unsold_items
    ]

    # ─── Alerts ───
    alerts = _generate_pricing_alerts(
        avg_ticket, prev_avg_ticket, ticket_change, daily_volume,
        items, low_margin_items, no_sales, cur_rev,
    )

    return {
        "avg_ticket": avg_ticket,
        "prev_avg_ticket": prev_avg_ticket,
        "ticket_change": ticket_change,
        "ticket_trend": "up" if ticket_change > 0 else "down" if ticket_change < 0 else "flat",
        "daily_volume": daily_volume,
        "monthly_revenue": round(cur_rev, 2),
        "total_transactions": cur_txns,
        "top_items": items[:10],
        "low_margin_items": low_margin_items[:5],
        "no_sales_items": no_sales[:5],
        "alerts": alerts,
    }


def simulate_price_change(user_id, db: Session, increase_amount: float) -> dict:
    """Simulate impact of a price increase on revenue."""
    today = date.today()
    d30 = today - timedelta(days=30)

    result = db.query(func.count(Sale.id)).filter(
        Sale.user_id == user_id, Sale.date >= d30, Sale.is_deleted.isnot(True)
    ).scalar() or 0

    daily_volume = result / 30 if result else 0
    monthly_impact = round(increase_amount * daily_volume * 30, 2)
    annual_impact = round(monthly_impact * 12, 2)

    return {
        "increase_amount": increase_amount,
        "daily_volume": round(daily_volume, 1),
        "monthly_impact": monthly_impact,
        "annual_impact": annual_impact,
    }


def _generate_pricing_alerts(avg_ticket, prev_avg, change, daily_vol, items, low_margin, no_sales, monthly_rev):
    alerts = []

    if change < -5 and prev_avg > 0:
        pct = round(abs(change) / prev_avg * 100, 1)
        alerts.append({
            "type": "ticket_drop", "severity": "warning", "icon": "📉",
            "title": f"Average ticket dropped {round(abs(change))} ({pct}%)",
            "detail": f"Was {round(prev_avg)}, now {round(avg_ticket)}. Check if discounting or smaller orders are the cause.",
            "action": "Review recent sales for pattern changes. Consider upselling strategies.",
        })
    elif change > 5 and prev_avg > 0:
        alerts.append({
            "type": "ticket_up", "severity": "positive", "icon": "📈",
            "title": f"Average ticket up {round(change)}!",
            "detail": f"Grew from {round(prev_avg)} to {round(avg_ticket)}. Keep it up!",
            "action": None,
        })

    if low_margin:
        names = ", ".join(i["name"] for i in low_margin[:3])
        alerts.append({
            "type": "low_margin", "severity": "warning", "icon": "⚠️",
            "title": f"{len(low_margin)} items with margins under 30%",
            "detail": f"Top: {names}. Consider raising prices or renegotiating supplier costs.",
            "action": "A 10% price increase on these items could significantly improve profitability.",
        })

    if no_sales and len(no_sales) >= 3:
        alerts.append({
            "type": "no_sales", "severity": "info", "icon": "🏷️",
            "title": f"{len(no_sales)} stocked items with zero sales this month",
            "detail": "These items have stock but no sales in 30 days. Consider a sale/discount or discontinuing.",
            "action": "Run a promotion or bundle these with popular items.",
        })

    if avg_ticket > 0 and daily_vol > 0:
        small_increase = 5
        monthly = round(small_increase * daily_vol * 30)
        alerts.append({
            "type": "opportunity", "severity": "info", "icon": "💡",
            "title": f"A {small_increase} increase per transaction = {monthly:,}/month",
            "detail": f"With {round(daily_vol)} daily transactions, small price adjustments add up fast.",
            "action": "Use the price simulator to model different scenarios.",
        })

    if not alerts:
        alerts.append({
            "type": "healthy", "severity": "positive", "icon": "✅",
            "title": "Pricing looks healthy", "detail": "No major issues detected.", "action": None,
        })

    return alerts
