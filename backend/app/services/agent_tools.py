"""
agent_tools.py -- Tool functions that the AI agent uses to query BonBox data.

Every tool accepts (db: Session, user_id: UUID) plus optional parameters and
returns a dict with two keys:
    "summary"  -- a human-friendly one-liner (used in chat responses)
    "data"     -- a structured dict (used for follow-up logic / charts)

All queries filter by user_id and exclude soft-deleted rows
(is_deleted.isnot(True)) where the model supports it.
"""

from datetime import date, timedelta
from typing import Optional
from uuid import UUID

from sqlalchemy import func, case
from sqlalchemy.orm import Session

from app.models import (
    Sale,
    Expense,
    ExpenseCategory,
    InventoryItem,
    WasteLog,
    KhataCustomer,
    KhataTransaction,
    CashTransaction,
    User,
)


# ---------------------------------------------------------------------------
# Currency helper (inline fallback -- app.utils.currency does not exist yet)
# ---------------------------------------------------------------------------

def _get_currency(db: Session, user_id: UUID) -> str:
    """Return the user's configured currency code (default 'DKK')."""
    user = db.query(User.currency).filter(User.id == user_id).first()
    return user[0] if user and user[0] else "DKK"


def _fmt(amount: float, currency: str) -> str:
    """Format a number with thousands separator and currency code."""
    return f"{amount:,.0f} {currency}"


# ---------------------------------------------------------------------------
# Period helpers
# ---------------------------------------------------------------------------

def _resolve_period(
    period: str = "this_month",
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> tuple[date, date]:
    """
    Convert a period string into a concrete (start_date, end_date) tuple.

    Supported periods:
        today, yesterday, this_week, last_week, this_month, last_month,
        last_30_days, custom (requires from_date / to_date).
    """
    today = date.today()

    # Claude may pass date strings instead of date objects
    if isinstance(from_date, str):
        from_date = date.fromisoformat(from_date)
    if isinstance(to_date, str):
        to_date = date.fromisoformat(to_date)

    if period == "custom" and from_date and to_date:
        return from_date, to_date

    if period == "today":
        return today, today

    if period == "yesterday":
        yday = today - timedelta(days=1)
        return yday, yday

    if period == "this_week":
        start = today - timedelta(days=today.weekday())          # Monday
        return start, today

    if period == "last_week":
        start = today - timedelta(days=today.weekday() + 7)
        end = start + timedelta(days=6)
        return start, end

    if period == "this_month":
        return today.replace(day=1), today

    if period == "last_month":
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        return last_prev.replace(day=1), last_prev

    if period == "last_30_days":
        return today - timedelta(days=30), today

    # Fallback: this_month
    return today.replace(day=1), today


def _previous_period(start: date, end: date) -> tuple[date, date]:
    """Compute the comparison period of the same length ending right before *start*."""
    length = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=length - 1)
    return prev_start, prev_end


def _pct_change(current: float, previous: float) -> Optional[float]:
    """Return percentage change or None when previous is zero."""
    if previous == 0:
        return None
    return round(((current - previous) / previous) * 100, 1)


# ---------------------------------------------------------------------------
# 1. Revenue
# ---------------------------------------------------------------------------

def query_revenue(
    db: Session,
    user_id: UUID,
    period: str = "this_month",
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> dict:
    """Query sales revenue for the given period."""
    currency = _get_currency(db, user_id)
    start, end = _resolve_period(period, from_date, to_date)
    prev_start, prev_end = _previous_period(start, end)

    base = (
        db.query(Sale)
        .filter(
            Sale.user_id == user_id,
            Sale.is_deleted.isnot(True),
        )
    )

    # -- Current period totals --
    totals = (
        base.filter(Sale.date >= start, Sale.date <= end)
        .with_entities(
            func.coalesce(func.sum(Sale.amount), 0).label("total"),
            func.count(Sale.id).label("count"),
        )
        .first()
    )
    total_revenue = float(totals.total)
    sale_count = int(totals.count)

    # -- Previous period totals for comparison --
    prev_totals = (
        base.filter(Sale.date >= prev_start, Sale.date <= prev_end)
        .with_entities(
            func.coalesce(func.sum(Sale.amount), 0).label("total"),
            func.count(Sale.id).label("count"),
        )
        .first()
    )
    prev_revenue = float(prev_totals.total)
    change_pct = _pct_change(total_revenue, prev_revenue)

    # -- Daily breakdown --
    daily_rows = (
        base.filter(Sale.date >= start, Sale.date <= end)
        .with_entities(
            Sale.date,
            func.coalesce(func.sum(Sale.amount), 0).label("total"),
            func.count(Sale.id).label("count"),
        )
        .group_by(Sale.date)
        .order_by(Sale.date)
        .all()
    )
    daily_breakdown = [
        {"date": str(r.date), "total": float(r.total), "count": int(r.count)}
        for r in daily_rows
    ]

    # -- Payment method split --
    payment_rows = (
        base.filter(Sale.date >= start, Sale.date <= end)
        .with_entities(
            Sale.payment_method,
            func.coalesce(func.sum(Sale.amount), 0).label("total"),
            func.count(Sale.id).label("count"),
        )
        .group_by(Sale.payment_method)
        .all()
    )
    payment_split = {
        r.payment_method: {"total": float(r.total), "count": int(r.count)}
        for r in payment_rows
    }

    # -- Average per day --
    num_days = max((end - start).days + 1, 1)
    avg_per_day = round(total_revenue / num_days, 2)

    # -- Build summary --
    period_label = period.replace("_", " ").title()
    change_str = ""
    if change_pct is not None:
        direction = "up" if change_pct >= 0 else "down"
        change_str = f" ({direction} {abs(change_pct)}% vs previous period)"

    summary = (
        f"{period_label} revenue: {_fmt(total_revenue, currency)} "
        f"from {sale_count} sales{change_str}"
    )

    return {
        "summary": summary,
        "data": {
            "period": {"start": str(start), "end": str(end), "label": period_label},
            "total_revenue": total_revenue,
            "sale_count": sale_count,
            "avg_per_day": avg_per_day,
            "previous_revenue": prev_revenue,
            "change_pct": change_pct,
            "daily_breakdown": daily_breakdown,
            "payment_split": payment_split,
            "currency": currency,
        },
    }


# ---------------------------------------------------------------------------
# 2. Expenses
# ---------------------------------------------------------------------------

def query_expenses(
    db: Session,
    user_id: UUID,
    period: str = "this_month",
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
    category: Optional[str] = None,
) -> dict:
    """Query business expenses for the given period (excludes personal)."""
    currency = _get_currency(db, user_id)
    start, end = _resolve_period(period, from_date, to_date)
    prev_start, prev_end = _previous_period(start, end)

    base = (
        db.query(Expense)
        .filter(
            Expense.user_id == user_id,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
        )
    )

    # Optional category filter (by name, case-insensitive)
    if category:
        base = base.join(ExpenseCategory, Expense.category_id == ExpenseCategory.id).filter(
            func.lower(ExpenseCategory.name) == category.lower()
        )

    # -- Current period --
    totals = (
        base.filter(Expense.date >= start, Expense.date <= end)
        .with_entities(
            func.coalesce(func.sum(Expense.amount), 0).label("total"),
            func.count(Expense.id).label("count"),
        )
        .first()
    )
    total_expenses = float(totals.total)
    expense_count = int(totals.count)

    # -- Previous period --
    prev_totals = (
        base.filter(Expense.date >= prev_start, Expense.date <= prev_end)
        .with_entities(
            func.coalesce(func.sum(Expense.amount), 0).label("total"),
        )
        .first()
    )
    prev_expenses = float(prev_totals.total)
    change_pct = _pct_change(total_expenses, prev_expenses)

    # -- Breakdown by category --
    # Need a fresh query to ensure the join is clean for grouping
    cat_rows = (
        db.query(
            ExpenseCategory.name.label("category"),
            func.coalesce(func.sum(Expense.amount), 0).label("total"),
            func.count(Expense.id).label("count"),
        )
        .join(ExpenseCategory, Expense.category_id == ExpenseCategory.id)
        .filter(
            Expense.user_id == user_id,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
            Expense.date >= start,
            Expense.date <= end,
        )
        .group_by(ExpenseCategory.name)
        .order_by(func.sum(Expense.amount).desc())
        .all()
    )
    by_category = [
        {"category": r.category, "total": float(r.total), "count": int(r.count)}
        for r in cat_rows
    ]

    # Top categories (up to 3)
    top_categories = [c["category"] for c in by_category[:3]]

    period_label = period.replace("_", " ").title()
    change_str = ""
    if change_pct is not None:
        direction = "up" if change_pct >= 0 else "down"
        change_str = f" ({direction} {abs(change_pct)}% vs previous period)"

    summary = (
        f"{period_label} expenses: {_fmt(total_expenses, currency)} "
        f"across {expense_count} entries{change_str}"
    )
    if top_categories:
        summary += f". Top: {', '.join(top_categories)}"

    return {
        "summary": summary,
        "data": {
            "period": {"start": str(start), "end": str(end), "label": period_label},
            "total_expenses": total_expenses,
            "expense_count": expense_count,
            "previous_expenses": prev_expenses,
            "change_pct": change_pct,
            "by_category": by_category,
            "top_categories": top_categories,
            "currency": currency,
        },
    }


# ---------------------------------------------------------------------------
# 3. Inventory
# ---------------------------------------------------------------------------

def query_inventory(
    db: Session,
    user_id: UUID,
    low_stock_only: bool = False,
) -> dict:
    """Query inventory items; optionally filter to low-stock items only."""
    currency = _get_currency(db, user_id)
    today = date.today()
    expiry_threshold = today + timedelta(days=7)

    base = db.query(InventoryItem).filter(InventoryItem.user_id == user_id)

    if low_stock_only:
        base = base.filter(InventoryItem.quantity <= InventoryItem.min_threshold)

    items = base.order_by(InventoryItem.name).all()

    total_stock_value = 0.0
    low_stock_items = []
    expiring_soon = []
    item_list = []

    for item in items:
        qty = float(item.quantity or 0)
        cost = float(item.cost_per_unit or 0)
        stock_value = round(qty * cost, 2)
        total_stock_value += stock_value

        is_low = qty <= float(item.min_threshold or 0)
        is_expiring = (
            item.expiry_date is not None and item.expiry_date <= expiry_threshold
        )

        entry = {
            "id": str(item.id),
            "name": item.name,
            "quantity": qty,
            "unit": item.unit,
            "cost_per_unit": cost,
            "stock_value": stock_value,
            "min_threshold": float(item.min_threshold or 0),
            "is_low_stock": is_low,
            "expiry_date": str(item.expiry_date) if item.expiry_date else None,
            "is_expiring_soon": is_expiring,
            "category": item.category,
        }
        item_list.append(entry)

        if is_low:
            low_stock_items.append(item.name)
        if is_expiring:
            expiring_soon.append(item.name)

    total_stock_value = round(total_stock_value, 2)

    # -- Summary --
    parts = [f"{len(item_list)} items in inventory (value: {_fmt(total_stock_value, currency)})"]
    if low_stock_items:
        parts.append(f"{len(low_stock_items)} low-stock: {', '.join(low_stock_items[:5])}")
    if expiring_soon:
        parts.append(
            f"{len(expiring_soon)} expiring within 7 days: {', '.join(expiring_soon[:5])}"
        )

    summary = ". ".join(parts)

    return {
        "summary": summary,
        "data": {
            "total_items": len(item_list),
            "total_stock_value": total_stock_value,
            "low_stock_count": len(low_stock_items),
            "low_stock_names": low_stock_items,
            "expiring_soon_count": len(expiring_soon),
            "expiring_soon_names": expiring_soon,
            "items": item_list,
            "currency": currency,
        },
    }


# ---------------------------------------------------------------------------
# 4. Waste
# ---------------------------------------------------------------------------

def query_waste(
    db: Session,
    user_id: UUID,
    period: str = "this_month",
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> dict:
    """Query waste logs for the given period."""
    currency = _get_currency(db, user_id)
    start, end = _resolve_period(period, from_date, to_date)
    prev_start, prev_end = _previous_period(start, end)

    base = (
        db.query(WasteLog)
        .filter(
            WasteLog.user_id == user_id,
            WasteLog.is_deleted.isnot(True),
        )
    )

    # -- Current period --
    totals = (
        base.filter(WasteLog.date >= start, WasteLog.date <= end)
        .with_entities(
            func.coalesce(func.sum(WasteLog.estimated_cost), 0).label("total_cost"),
            func.count(WasteLog.id).label("count"),
        )
        .first()
    )
    total_cost = float(totals.total_cost)
    waste_count = int(totals.count)

    # -- Previous period --
    prev_totals = (
        base.filter(WasteLog.date >= prev_start, WasteLog.date <= prev_end)
        .with_entities(
            func.coalesce(func.sum(WasteLog.estimated_cost), 0).label("total_cost"),
        )
        .first()
    )
    prev_cost = float(prev_totals.total_cost)
    change_pct = _pct_change(total_cost, prev_cost)

    # -- Breakdown by reason --
    reason_rows = (
        base.filter(WasteLog.date >= start, WasteLog.date <= end)
        .with_entities(
            WasteLog.reason,
            func.coalesce(func.sum(WasteLog.estimated_cost), 0).label("total_cost"),
            func.count(WasteLog.id).label("count"),
        )
        .group_by(WasteLog.reason)
        .order_by(func.sum(WasteLog.estimated_cost).desc())
        .all()
    )
    by_reason = [
        {"reason": r.reason, "total_cost": float(r.total_cost), "count": int(r.count)}
        for r in reason_rows
    ]

    # -- Top wasted items --
    item_rows = (
        base.filter(WasteLog.date >= start, WasteLog.date <= end)
        .with_entities(
            WasteLog.item_name,
            func.coalesce(func.sum(WasteLog.estimated_cost), 0).label("total_cost"),
        )
        .group_by(WasteLog.item_name)
        .order_by(func.sum(WasteLog.estimated_cost).desc())
        .limit(5)
        .all()
    )
    top_items = [
        {"item_name": r.item_name, "total_cost": float(r.total_cost)}
        for r in item_rows
    ]

    period_label = period.replace("_", " ").title()
    change_str = ""
    if change_pct is not None:
        direction = "up" if change_pct >= 0 else "down"
        change_str = f" ({direction} {abs(change_pct)}% vs previous period)"

    summary = (
        f"{period_label} waste: {_fmt(total_cost, currency)} "
        f"from {waste_count} entries{change_str}"
    )

    return {
        "summary": summary,
        "data": {
            "period": {"start": str(start), "end": str(end), "label": period_label},
            "total_cost": total_cost,
            "waste_count": waste_count,
            "previous_cost": prev_cost,
            "change_pct": change_pct,
            "by_reason": by_reason,
            "top_items": top_items,
            "currency": currency,
        },
    }


# ---------------------------------------------------------------------------
# 5. Khata (credit book)
# ---------------------------------------------------------------------------

def query_khata(
    db: Session,
    user_id: UUID,
    customer_name: Optional[str] = None,
) -> dict:
    """Query khata (credit book) -- outstanding balances per customer."""
    currency = _get_currency(db, user_id)
    today = date.today()

    customer_base = (
        db.query(KhataCustomer)
        .filter(
            KhataCustomer.user_id == user_id,
            KhataCustomer.is_deleted.isnot(True),
        )
    )

    if customer_name:
        customer_base = customer_base.filter(
            func.lower(KhataCustomer.name).contains(customer_name.lower())
        )

    customers = customer_base.all()

    customer_list = []
    total_outstanding = 0.0
    overdue_count = 0

    for cust in customers:
        # Aggregate transactions for this customer
        txn_agg = (
            db.query(
                func.coalesce(func.sum(KhataTransaction.purchase_amount), 0).label("total_purchased"),
                func.coalesce(func.sum(KhataTransaction.paid_amount), 0).label("total_paid"),
                func.count(KhataTransaction.id).label("txn_count"),
                func.max(KhataTransaction.date).label("last_txn_date"),
            )
            .filter(
                KhataTransaction.customer_id == cust.id,
                KhataTransaction.user_id == user_id,
            )
            .first()
        )

        purchased = float(txn_agg.total_purchased)
        paid = float(txn_agg.total_paid)
        outstanding = round(purchased - paid, 2)
        total_outstanding += outstanding

        last_txn_date = txn_agg.last_txn_date
        # Flag as overdue if outstanding > 0 and last transaction was > 30 days ago
        is_overdue = (
            outstanding > 0
            and last_txn_date is not None
            and (today - last_txn_date).days > 30
        )
        if is_overdue:
            overdue_count += 1

        customer_list.append({
            "id": str(cust.id),
            "name": cust.name,
            "phone": cust.phone,
            "total_purchased": purchased,
            "total_paid": paid,
            "outstanding": outstanding,
            "transaction_count": int(txn_agg.txn_count),
            "last_transaction_date": str(last_txn_date) if last_txn_date else None,
            "is_overdue": is_overdue,
        })

    # Sort by outstanding descending
    customer_list.sort(key=lambda c: c["outstanding"], reverse=True)
    total_outstanding = round(total_outstanding, 2)

    customers_with_balance = [c for c in customer_list if c["outstanding"] > 0]

    summary = (
        f"Khata: {_fmt(total_outstanding, currency)} outstanding "
        f"across {len(customers_with_balance)} customers"
    )
    if overdue_count:
        summary += f" ({overdue_count} overdue > 30 days)"

    return {
        "summary": summary,
        "data": {
            "total_outstanding": total_outstanding,
            "customer_count": len(customer_list),
            "customers_with_balance": len(customers_with_balance),
            "overdue_count": overdue_count,
            "customers": customer_list,
            "currency": currency,
        },
    }


# ---------------------------------------------------------------------------
# 6. Cashbook
# ---------------------------------------------------------------------------

def query_cashbook(
    db: Session,
    user_id: UUID,
    period: str = "this_month",
    from_date: Optional[date] = None,
    to_date: Optional[date] = None,
) -> dict:
    """Query cash transactions for the given period."""
    currency = _get_currency(db, user_id)
    start, end = _resolve_period(period, from_date, to_date)

    base = (
        db.query(CashTransaction)
        .filter(
            CashTransaction.user_id == user_id,
            CashTransaction.is_deleted.isnot(True),
            CashTransaction.date >= start,
            CashTransaction.date <= end,
        )
    )

    # -- Aggregate cash_in vs cash_out --
    agg = (
        base.with_entities(
            func.coalesce(
                func.sum(case((CashTransaction.type == "cash_in", CashTransaction.amount), else_=0)),
                0,
            ).label("total_in"),
            func.coalesce(
                func.sum(case((CashTransaction.type == "cash_out", CashTransaction.amount), else_=0)),
                0,
            ).label("total_out"),
            func.count(CashTransaction.id).label("count"),
        )
        .first()
    )
    total_in = float(agg.total_in)
    total_out = float(agg.total_out)
    net_cash = round(total_in - total_out, 2)
    txn_count = int(agg.count)

    # -- Daily breakdown --
    daily_rows = (
        base.with_entities(
            CashTransaction.date,
            func.coalesce(
                func.sum(case((CashTransaction.type == "cash_in", CashTransaction.amount), else_=0)),
                0,
            ).label("cash_in"),
            func.coalesce(
                func.sum(case((CashTransaction.type == "cash_out", CashTransaction.amount), else_=0)),
                0,
            ).label("cash_out"),
        )
        .group_by(CashTransaction.date)
        .order_by(CashTransaction.date)
        .all()
    )
    daily_breakdown = [
        {
            "date": str(r.date),
            "cash_in": float(r.cash_in),
            "cash_out": float(r.cash_out),
            "net": round(float(r.cash_in) - float(r.cash_out), 2),
        }
        for r in daily_rows
    ]

    # -- By category --
    cat_rows = (
        base.with_entities(
            CashTransaction.category,
            CashTransaction.type,
            func.coalesce(func.sum(CashTransaction.amount), 0).label("total"),
        )
        .group_by(CashTransaction.category, CashTransaction.type)
        .order_by(func.sum(CashTransaction.amount).desc())
        .all()
    )
    by_category = [
        {"category": r.category or "Uncategorized", "type": r.type, "total": float(r.total)}
        for r in cat_rows
    ]

    period_label = period.replace("_", " ").title()
    net_direction = "positive" if net_cash >= 0 else "negative"

    summary = (
        f"{period_label} cashbook: {_fmt(total_in, currency)} in, "
        f"{_fmt(total_out, currency)} out. "
        f"Net: {_fmt(abs(net_cash), currency)} ({net_direction})"
    )

    return {
        "summary": summary,
        "data": {
            "period": {"start": str(start), "end": str(end), "label": period_label},
            "total_cash_in": total_in,
            "total_cash_out": total_out,
            "net_cash": net_cash,
            "transaction_count": txn_count,
            "daily_breakdown": daily_breakdown,
            "by_category": by_category,
            "currency": currency,
        },
    }


# ---------------------------------------------------------------------------
# 7. Business overview (composite snapshot)
# ---------------------------------------------------------------------------

def business_overview(db: Session, user_id: UUID) -> dict:
    """
    Pull together a comprehensive business snapshot:
    today's revenue, month-to-date revenue, month expenses, profit margin,
    inventory alerts, and khata receivables.
    """
    currency = _get_currency(db, user_id)

    # -- Today's revenue --
    today_rev = query_revenue(db, user_id, period="today")

    # -- Month-to-date revenue --
    month_rev = query_revenue(db, user_id, period="this_month")

    # -- Month-to-date expenses --
    month_exp = query_expenses(db, user_id, period="this_month")

    # -- Profit margin --
    revenue = month_rev["data"]["total_revenue"]
    expenses = month_exp["data"]["total_expenses"]
    profit = round(revenue - expenses, 2)
    margin = round((profit / revenue) * 100, 1) if revenue > 0 else 0.0

    # -- Inventory alerts (low stock only) --
    inv = query_inventory(db, user_id, low_stock_only=True)

    # -- Khata receivables --
    khata = query_khata(db, user_id)

    # -- Build summary --
    lines = [
        f"Today: {_fmt(today_rev['data']['total_revenue'], currency)} "
        f"({today_rev['data']['sale_count']} sales)",
        f"This month: {_fmt(revenue, currency)} revenue, "
        f"{_fmt(expenses, currency)} expenses, "
        f"{_fmt(profit, currency)} profit ({margin}% margin)",
    ]
    if inv["data"]["low_stock_count"] > 0:
        lines.append(
            f"Inventory alert: {inv['data']['low_stock_count']} items low stock"
        )
    if inv["data"]["expiring_soon_count"] > 0:
        lines.append(
            f"Expiry alert: {inv['data']['expiring_soon_count']} items expiring within 7 days"
        )
    if khata["data"]["total_outstanding"] > 0:
        lines.append(
            f"Khata receivable: {_fmt(khata['data']['total_outstanding'], currency)} "
            f"from {khata['data']['customers_with_balance']} customers"
        )

    summary = ". ".join(lines)

    return {
        "summary": summary,
        "data": {
            "today_revenue": today_rev["data"]["total_revenue"],
            "today_sales": today_rev["data"]["sale_count"],
            "month_revenue": revenue,
            "month_expenses": expenses,
            "month_profit": profit,
            "profit_margin_pct": margin,
            "month_revenue_change_pct": month_rev["data"]["change_pct"],
            "month_expense_change_pct": month_exp["data"]["change_pct"],
            "low_stock_count": inv["data"]["low_stock_count"],
            "low_stock_items": inv["data"]["low_stock_names"][:5],
            "expiring_soon_count": inv["data"]["expiring_soon_count"],
            "expiring_soon_items": inv["data"]["expiring_soon_names"][:5],
            "khata_outstanding": khata["data"]["total_outstanding"],
            "khata_overdue_count": khata["data"]["overdue_count"],
            "currency": currency,
        },
    }
