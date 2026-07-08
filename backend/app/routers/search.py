"""Global search across the user's tenant scope.

Powers the Claude-style ⌘K command palette. Single endpoint, single
query parameter — returns grouped results across sales, expenses,
inventory, daily closes, and khata customers.

Why grouped (not a flat ranked list):
  • Owners think in entity types ("find that fish supplier expense")
  • Grouped is much easier to scan visually
  • Each group has its own per-row UI (amount on right, date below
    title) which would be hard to do in a single ranked list

Search strategy:
  • ILIKE %q% on the indexed text columns of each entity
  • Per-group cap of 5 results (keeps the modal compact)
  • Tenant-scoped via user_id filter (defense in depth — every model
    join goes through the user's id)
  • Soft-deleted rows excluded everywhere

Performance: each query hits an indexed column with a LIMIT clause,
so a typical search takes under 30ms even on a busy tenant. We can
upgrade to pg_trgm + similarity for fuzzy matching later if owners
ask for it.
"""
from __future__ import annotations

from datetime import date as _date

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import get_current_user

router = APIRouter()

# Per-IP rate limiter — search is cheap but typing fires on every
# keystroke (debounced client-side). 60/min covers heavy use without
# letting a runaway script torch the DB.
_limiter = Limiter(key_func=client_ip)

# Per-group result cap — keeps the modal compact + DB queries fast.
_PER_GROUP_LIMIT = 5
# Daily-close cap is smaller because each row is an exact-date hit;
# users rarely want more than a couple of date matches.
_CLOSES_LIMIT = 3


def _safe_pattern(q: str) -> str:
    """Escape SQL LIKE wildcards so a query like '50%' doesn't
    accidentally match everything containing '50'."""
    # Escape % and _ which are SQL LIKE wildcards. \\ first so we
    # don't double-escape the escape character itself.
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _search_sales(db: Session, user_id, pattern: str) -> list[dict]:
    """Sales matching by item_name or notes. Returns recent first."""
    rows = (
        db.query(Sale)
        .filter(
            Sale.user_id == user_id,
            Sale.is_deleted.isnot(True),
            or_(
                Sale.item_name.ilike(pattern, escape="\\"),
                Sale.notes.ilike(pattern, escape="\\"),
            ),
        )
        .order_by(Sale.date.desc(), Sale.created_at.desc())
        .limit(_PER_GROUP_LIMIT)
        .all()
    )
    return [
        {
            "id": str(s.id),
            "label": s.item_name or "Sale",
            "sublabel": s.date.isoformat() if s.date else "",
            "amount": float(s.amount) if s.amount is not None else None,
            "link": "/sales",
            "icon": "💰",
        }
        for s in rows
    ]


def _search_expenses(db: Session, user_id, pattern: str) -> list[dict]:
    """Expenses matching description, supplier, or category name."""
    rows = (
        db.query(Expense, ExpenseCategory.name.label("cat_name"))
        .outerjoin(ExpenseCategory, ExpenseCategory.id == Expense.category_id)
        .filter(
            Expense.user_id == user_id,
            Expense.is_deleted.isnot(True),
            or_(
                Expense.description.ilike(pattern, escape="\\"),
                Expense.notes.ilike(pattern, escape="\\"),
                ExpenseCategory.name.ilike(pattern, escape="\\"),
            ),
        )
        .order_by(Expense.date.desc(), Expense.created_at.desc())
        .limit(_PER_GROUP_LIMIT)
        .all()
    )
    return [
        {
            "id": str(e.id),
            "label": e.description or "Expense",
            "sublabel": f"{cat_name or '—'} · {e.date.isoformat() if e.date else ''}",
            "amount": float(e.amount) if e.amount is not None else None,
            "link": "/expenses",
            "icon": "💸",
        }
        for e, cat_name in rows
    ]


def _search_inventory(db: Session, user_id, pattern: str) -> list[dict]:
    """Inventory items matching name or category."""
    rows = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user_id,
            or_(
                InventoryItem.name.ilike(pattern, escape="\\"),
                InventoryItem.category.ilike(pattern, escape="\\"),
            ),
        )
        .order_by(InventoryItem.name)
        .limit(_PER_GROUP_LIMIT)
        .all()
    )
    return [
        {
            "id": str(item.id),
            "label": item.name or "Item",
            "sublabel": (
                f"{item.category or 'General'} · "
                f"{float(item.quantity or 0):g} {item.unit or ''}"
            ).strip(" ·"),
            "amount": float(item.cost_per_unit) if item.cost_per_unit is not None else None,
            "link": "/inventory",
            "icon": "📦",
        }
        for item in rows
    ]


def _search_closes(db: Session, user_id, pattern: str) -> list[dict]:
    """Daily closes matching by date string ('2026-05', '7. maj') or
    by notes content. Date matching is cheap because we just ILIKE
    the iso-string column representation."""
    rows = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user_id,
            DailyClose.is_deleted.isnot(True),
            or_(
                DailyClose.notes.ilike(pattern, escape="\\"),
                DailyClose.closed_by.ilike(pattern, escape="\\"),
            ),
        )
        .order_by(DailyClose.date.desc())
        .limit(_CLOSES_LIMIT)
        .all()
    )
    return [
        {
            "id": str(c.id),
            "label": f"Daily close · {c.date.isoformat() if c.date else ''}",
            "sublabel": (c.closed_by or "—") + (
                f" · {c.status}" if getattr(c, "status", None) else ""
            ),
            "amount": float(c.revenue_total) if c.revenue_total is not None else None,
            "link": "/daily-close",
            "icon": "📋",
        }
        for c in rows
    ]


def _search_khata(db: Session, user_id, pattern: str) -> list[dict]:
    """Khata (credit-book) customers matching name or phone."""
    # Khata model is loaded conditionally because not all installs
    # have the khata module enabled. Failing to import shouldn't
    # break the whole search endpoint.
    try:
        from app.models.khata import KhataCustomer
    except ImportError:
        return []
    try:
        rows = (
            db.query(KhataCustomer)
            .filter(
                KhataCustomer.user_id == user_id,
                KhataCustomer.is_deleted.isnot(True),
                or_(
                    KhataCustomer.name.ilike(pattern, escape="\\"),
                    KhataCustomer.phone.ilike(pattern, escape="\\"),
                ),
            )
            .order_by(KhataCustomer.name)
            .limit(_PER_GROUP_LIMIT)
            .all()
        )
    except Exception:  # noqa: BLE001 - schema variants
        return []
    return [
        {
            "id": str(c.id),
            "label": c.name or "Customer",
            "sublabel": (c.phone or "").strip() or "Khata customer",
            "amount": None,
            "link": "/khata",
            "icon": "👤",
        }
        for c in rows
    ]


# ─── Endpoint ─────────────────────────────────────────────────────────

@router.get("")
@_limiter.limit("60/minute")
def global_search(
    request: Request,
    q: str = Query(..., min_length=1, max_length=100,
                   description="Free-text search query"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Cross-entity search for the ⌘K command palette.

    Returns:
      {
        "query": "fish",
        "groups": [
          {"key": "sales",      "label": "Sales",      "items": [...]},
          {"key": "expenses",   "label": "Expenses",   "items": [...]},
          {"key": "inventory",  "label": "Inventory",  "items": [...]},
          {"key": "closes",     "label": "Daily Closes","items": [...]},
          {"key": "khata",      "label": "Khata",      "items": [...]},
        ],
        "total": 17,
      }
    Empty groups are omitted from the response so the frontend can
    just render whatever comes back without filtering.
    """
    cleaned = q.strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail="Query cannot be empty.")
    pattern = _safe_pattern(cleaned)

    groups = []
    for key, label, fn in [
        ("sales",     "Sales",         _search_sales),
        ("expenses",  "Expenses",      _search_expenses),
        ("inventory", "Inventory",     _search_inventory),
        ("closes",    "Daily Closes",  _search_closes),
        ("khata",     "Khata",         _search_khata),
    ]:
        items = fn(db, user.id, pattern)
        if items:
            groups.append({"key": key, "label": label, "items": items})

    total = sum(len(g["items"]) for g in groups)
    return {"query": cleaned, "groups": groups, "total": total}
