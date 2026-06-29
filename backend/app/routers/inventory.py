import uuid
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func, case
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.inventory import InventoryItem, InventoryLog, InventoryTemplate
from app.models.sale import Sale
from app.schemas.inventory import (
    InventoryItemCreate, InventoryItemUpdate, InventoryItemResponse,
    InventoryLogCreate, InventoryLogResponse,
    TemplateResponse, TemplateLoadRequest, PourRequest,
)
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import effective_plan, has_feature
from app.services.inventory_export import (
    build_stock_list_pdf, items_to_csv_bytes,
)

router = APIRouter()

# Rate limiter — protects state-changing inventory endpoints from being
# hammered (accidental UI loop, malicious script trying to exhaust our
# DB or pollute audit logs). 60/min per IP is generous for normal use:
# a busy bartender pouring at peak ~ 5/min; a stocktake script doing
# 60 logs/min is plausible. 120 starts to look suspicious. Defense layer
# 1 of 3: rate limit, input bounds (Pydantic Field ge/le), tenant scope.
_limiter = Limiter(key_func=get_remote_address)


@router.get("", response_model=list[InventoryItemResponse])
def list_items(
    category: str = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(InventoryItem).filter(InventoryItem.user_id == user.id)
    if category and category != "All":
        query = query.filter(InventoryItem.category == category)
    return query.all()


# ─── Export endpoints ─────────────────────────────────────────────────
# PDF and CSV export of the current stock list. Used for Bogføringsloven
# §10 retention paper trail, accountant handoff, and routine stocktake
# reviews. Multi-layer defense:
#   L1 — auth (get_current_user)
#   L2 — tenant scope (filter by user.id)
#   L3 — rate limit (5/minute — generation is expensive on big lists)
#   L4 — bounded category filter (uses existing constraint)


@router.get("/export.pdf")
@_limiter.limit("5/minute")
def export_stock_list_pdf(
    request: Request,
    category: str | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Stock list as a PDF report. Includes expiry highlighting + per-
    category subtotals + grand total. Useful for accountant handoff
    and Bogføringsloven §10 source-document retention."""
    query = db.query(InventoryItem).filter(InventoryItem.user_id == user.id)
    if category and category != "All":
        query = query.filter(InventoryItem.category == category)
    items = query.order_by(InventoryItem.category, InventoryItem.name).all()

    business_name = (getattr(user, "business_name", None) or "Stock List")
    currency = (getattr(user, "currency", None) or "DKK")
    pdf_bytes = build_stock_list_pdf(
        items, business_name=business_name, currency=currency,
    )
    filename = f"stock-list-{date.today().isoformat()}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/export.csv")
@_limiter.limit("10/minute")
def export_stock_list_csv(
    request: Request,
    category: str | None = Query(None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Stock list as a CSV. UTF-8 + BOM + semicolon delimiter so Danish
    Excel opens it correctly with Æ/Ø/Å intact."""
    query = db.query(InventoryItem).filter(InventoryItem.user_id == user.id)
    if category and category != "All":
        query = query.filter(InventoryItem.category == category)
    items = query.order_by(InventoryItem.category, InventoryItem.name).all()

    csv_bytes = items_to_csv_bytes(items)
    filename = f"stock-list-{date.today().isoformat()}.csv"
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/categories", response_model=list[str])
def list_categories(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (
        db.query(InventoryItem.category)
        .filter(InventoryItem.user_id == user.id)
        .distinct()
        .all()
    )
    return sorted(set(r[0] or "General" for r in rows))


@router.get("/expired", response_model=list[InventoryItemResponse])
def get_expired(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Items already past their expiry date and still in stock.

    Separate from /expiring (which is the "act soon" window). This is the
    "act now / write off" list — typically routed to the Waste tracker.
    """
    today = date.today()
    return (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.expiry_date.is_not(None),
            InventoryItem.expiry_date < today,
            InventoryItem.quantity > 0,
        )
        .order_by(InventoryItem.expiry_date)
        .all()
    )


@router.get("/expiring", response_model=list[InventoryItemResponse])
def get_expiring(
    days: int = Query(3, ge=1, le=365),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Items expiring within `days` from today.

    Critical fix: previously included already-expired items (expiry_date <
    today), so a 30-day-old expired bottle showed up in "expiring in 3 days".
    Now only items expiring TODAY or within the window appear.

    Also requires quantity > 0 — sold-out items aren't actionable.
    """
    today = date.today()
    cutoff = today + timedelta(days=days)
    return (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.expiry_date.is_not(None),
            InventoryItem.expiry_date >= today,
            InventoryItem.expiry_date <= cutoff,
            InventoryItem.quantity > 0,
        )
        .order_by(InventoryItem.expiry_date)
        .all()
    )


@router.post("", response_model=InventoryItemResponse, status_code=201)
def create_item(
    data: InventoryItemCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    payload = data.model_dump()
    # Auto-fill is_perishable + expiry_date for known-perishable categories
    # when the caller didn't specify. Same logic the smart-import /commit
    # uses — owner-supplied values always win.
    from app.services.inventory_perishable import mark_perishable_if_needed
    is_per, expiry = mark_perishable_if_needed(
        category=payload.get("category"),
        is_perishable=payload.get("is_perishable"),
        expiry_date=payload.get("expiry_date"),
    )
    payload["is_perishable"] = is_per
    payload["expiry_date"] = expiry
    item = InventoryItem(user_id=user.id, **payload)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.patch("/{item_id}", response_model=InventoryItemResponse)
def update_item(
    item_id: str,
    data: InventoryItemUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = db.query(InventoryItem).filter(
        InventoryItem.id == item_id,
        InventoryItem.user_id == user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(item, field, value)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/{item_id}", status_code=204)
def delete_item(
    item_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = db.query(InventoryItem).filter(
        InventoryItem.id == item_id,
        InventoryItem.user_id == user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    db.query(InventoryLog).filter(InventoryLog.item_id == item_id).delete()
    db.delete(item)
    db.commit()


@router.get("/alerts", response_model=list[InventoryItemResponse])
def get_alerts(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity > 0,
            InventoryItem.quantity <= InventoryItem.min_threshold,
        )
        .all()
    )


@router.post("/logs", response_model=InventoryLogResponse, status_code=201)
@_limiter.limit("60/minute")
def create_log(
    request: Request,
    data: InventoryLogCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Adjust inventory quantity by `change_qty` (positive or negative).

    Validates that change_qty != 0 (otherwise the log is meaningless).
    Allows the resulting quantity to go negative (legitimate for credit
    sales / unrecorded stock corrections) but logs a warning so the
    audit trail flags it for the owner.

    Multi-layer defense:
      L1 — Auth gate (Depends(get_current_user))
      L2 — Pydantic input bounds (change_qty ±1M, reason 120 chars)
      L3 — SlowAPI rate limit (60/min per IP)
      L4 — Strict tenant scope (item.user_id == user.id)
      L5 — Audit trail (every change is logged with reason for review)
    """
    if not data.change_qty or float(data.change_qty) == 0:
        raise HTTPException(status_code=400, detail="change_qty must be non-zero")

    item = db.query(InventoryItem).filter(
        InventoryItem.id == data.item_id,
        InventoryItem.user_id == user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    log = InventoryLog(**data.model_dump())
    new_qty = float(item.quantity) + float(data.change_qty)
    if new_qty < 0:
        # Permissive but visible — pre-order / unrecorded receipts can
        # legitimately result in temporary negative stock. Audit trail keeps it.
        import logging as _logging
        _logging.getLogger("bonbox.inventory").warning(
            "inventory log: %s would go negative (%.2f) for user=%s",
            item.name, new_qty, user.id,
        )
    item.quantity = round(new_qty, 4)
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


# ── Optælling (stock count) — bulk reconcile ─────────────────────────────
class _CountReconcileLine(BaseModel):
    item_id: uuid.UUID
    counted_qty: float = Field(..., ge=0, le=1_000_000)


class _CountReconcileBody(BaseModel):
    # Cap lines per count — a café/restaurant has well under 1000 SKUs; this
    # is a bulk-write guardrail, not a real limit.
    lines: list[_CountReconcileLine] = Field(..., min_length=1, max_length=1000)


@router.post("/count/reconcile")
@_limiter.limit("6/minute")
def inventory_count_reconcile(
    request: Request,
    body: _CountReconcileBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Commit a weekly/monthly stock count (optælling) in ONE call — the
    write-back for the count ritual. For each line: set item.quantity :=
    counted_qty (the owner's physical count is the only stored TRUTH) and write
    ONE InventoryLog reason='optælling' with change_qty = counted − previous,
    so the drift between the computed on-hand and the real shelf is inspectable.

    Returns the count, the adjusted lines, and the new lagerværdi (stock value)
    for the month-end "Send til revisor" hand-off.

    Multi-barrier (accountant-facing money/stock surface):
      L1 — auth (get_current_user)
      L2 — Pydantic bounds (≤1000 lines, counted_qty in [0, 1e6])
      L3 — SlowAPI rate limit (6/min per IP)
      L4 — strict tenant scope: only the caller's own items are touched;
           foreign / unknown ids are silently skipped (no cross-tenant write,
           no error leak)
      L5 — audit row (inventory.counted) for the owner + revisor trail
      L6 — honest value: lagerværdi sums quantity×cost across ALL items, not
           just the counted subset
    """
    ids = [ln.item_id for ln in body.lines]
    owned = {
        i.id: i
        for i in db.query(InventoryItem)
        .filter(InventoryItem.user_id == user.id, InventoryItem.id.in_(ids))
        .all()
    }

    today = date.today()
    batch = f"count:{today.isoformat()}"
    adjustments: list[dict] = []
    reconciled = 0
    for ln in body.lines:
        item = owned.get(ln.item_id)
        if not item:
            continue  # not the caller's item → skip, never write cross-tenant
        prev = round(float(item.quantity or 0), 2)
        counted = round(float(ln.counted_qty), 2)
        item.quantity = counted
        reconciled += 1
        delta = round(counted - prev, 2)
        if delta != 0:
            db.add(
                InventoryLog(
                    item_id=item.id,
                    change_qty=delta,
                    reason="optælling",
                    date=today,
                    batch_id=batch,
                )
            )
            adjustments.append(
                {
                    "item_id": str(item.id),
                    "name": item.name,
                    "from": prev,
                    "to": counted,
                    "delta": delta,
                    "unit": item.unit,
                }
            )

    # Lagerværdi across the WHOLE stock (not just counted lines).
    stock_value = 0.0
    for i in (
        db.query(InventoryItem).filter(InventoryItem.user_id == user.id).all()
    ):
        stock_value += float(i.quantity or 0) * float(i.cost_per_unit or 0)
    stock_value = round(stock_value, 2)

    audit_service.record(
        db,
        user=user,
        action="inventory.counted",
        entity_type="inventory",
        entity_id=None,
        after={
            "reconciled": reconciled,
            "adjusted": len(adjustments),
            "stock_value": stock_value,
        },
        ip_address=getattr(request.client, "host", None)
        if request and request.client
        else None,
    )
    db.commit()
    return {
        "reconciled": reconciled,
        "adjusted": len(adjustments),
        "adjustments": adjustments,
        "stock_value": stock_value,
        "counted_at": today.isoformat(),
    }


# ── Dead Stock Detection ──────────────────────────────────

@router.get("/dead-stock")
def get_dead_stock(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cutoff = date.today() - timedelta(days=30)

    # Subquery: most recent sale date per item_name for this user
    last_sale_sq = (
        db.query(
            Sale.item_name,
            func.max(Sale.date).label("last_sale_date"),
        )
        .filter(Sale.user_id == user.id, Sale.is_deleted.isnot(True))
        .group_by(Sale.item_name)
        .subquery()
    )

    # Join inventory items with their last sale date (if any)
    rows = (
        db.query(
            InventoryItem,
            last_sale_sq.c.last_sale_date,
        )
        .outerjoin(last_sale_sq, InventoryItem.name == last_sale_sq.c.item_name)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.quantity > 0,
        )
        .filter(
            # No sale at all, or last sale older than 30 days
            (last_sale_sq.c.last_sale_date == None) | (last_sale_sq.c.last_sale_date < cutoff)
        )
        .all()
    )

    today = date.today()
    result = []
    for item, last_sale_date in rows:
        qty = float(item.quantity)
        cost = float(item.cost_per_unit)
        stock_value = round(qty * cost, 2)
        if last_sale_date:
            days_since = (today - last_sale_date).days
        else:
            days_since = 999  # never sold
        result.append({
            "id": str(item.id),
            "name": item.name,
            "quantity": qty,
            "cost_per_unit": cost,
            "days_since_last_sale": days_since,
            "stock_value": stock_value,
        })

    # Sort by stock_value descending, limit 10
    result.sort(key=lambda x: x["stock_value"], reverse=True)
    return result[:10]


# ── Profit Per Item Ranking ───────────────────────────────

@router.get("/profit-ranking")
def get_profit_ranking(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    items = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.cost_per_unit > 0,
        )
        .all()
    )

    result = []
    for item in items:
        cost = float(item.cost_per_unit)
        sell = float(item.sell_price) if item.sell_price and float(item.sell_price) > 0 else None
        sell_pour = float(item.sell_price_per_pour) if item.sell_price_per_pour and float(item.sell_price_per_pour) > 0 else None

        # Use sell_price first, fall back to sell_price_per_pour for bar items
        effective_sell = sell if sell else sell_pour
        if not effective_sell or effective_sell <= 0:
            continue

        # Both margin and markup. Previously we labelled markup as "margin",
        # which gave artificially-inflated numbers (markup = 100% on a 50%
        # margin product). Now we ship both — frontend can pick the right
        # one. margin_pct stays as the canonical accounting "gross margin".
        markup_pct = round(((effective_sell - cost) / cost) * 100, 1)
        margin_pct = round(((effective_sell - cost) / effective_sell) * 100, 1)
        profit_per_unit = round(effective_sell - cost, 2)

        result.append({
            "name": item.name,
            "cost": cost,
            "sell": effective_sell,
            "margin_pct": margin_pct,
            "markup_pct": markup_pct,
            "profit_per_unit": profit_per_unit,
            "quantity": float(item.quantity),
        })

    result.sort(key=lambda x: x["margin_pct"], reverse=True)
    return result[:10]


# ── Pour / Bar ─────────────────────────────────────────────

@router.post("/pour", status_code=201)
@_limiter.limit("60/minute")
def record_pour(
    request: Request,
    data: PourRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Record a bar pour and decrement liquid stock.

    Multi-layer defense:
      L1 — Auth gate
      L2 — Pydantic input bounds (pours 1-500 — defends against
           accidental UI bugs and overflow attacks on pour_size × pours)
      L3 — SlowAPI rate limit (60/min per IP)
      L4 — Strict tenant scope (item.user_id == user.id)
      L5 — pour_size required (item must have been configured for pours)
      L6 — Insufficient-stock check (refuses negative-going pour with
           informative message including current stock)


    Critical accuracy fix: items stocked in bottles (unit='bottle' or
    similar) were being treated as if quantity was already in ml. Pouring
    2 × 30ml shots from "5 bottles" failed with "not enough stock" because
    it compared 60ml > 5 (bottles).

    Now we convert: if quantity is in bottles AND bottle_size is set, the
    available volume is quantity × bottle_size. After the pour we keep
    quantity in the same bottle unit (decimal — partial bottles allowed).
    """
    item = db.query(InventoryItem).filter(
        InventoryItem.id == data.item_id,
        InventoryItem.user_id == user.id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    if not item.pour_size:
        raise HTTPException(status_code=400, detail="Item has no pour size configured")

    pour_size_ml = float(item.pour_size)
    pours = data.pours
    bottle_size_ml = float(item.bottle_size) if item.bottle_size else None
    stocked_in_bottles = bool(bottle_size_ml and bottle_size_ml > 0)

    total_pour_ml = pour_size_ml * pours
    current_qty = float(item.quantity)

    if stocked_in_bottles:
        # quantity is in bottles; convert to ml for capacity check
        available_ml = current_qty * bottle_size_ml
        if total_pour_ml > available_ml:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Not enough stock. Have {available_ml:.0f}ml "
                    f"({current_qty} bottles × {bottle_size_ml:.0f}ml), "
                    f"need {total_pour_ml:.0f}ml"
                ),
            )
        # Decrement in bottle units (decimal)
        new_qty = current_qty - (total_pour_ml / bottle_size_ml)
    else:
        # Legacy mode: quantity is already in ml
        if total_pour_ml > current_qty:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Not enough stock. Have {current_qty} {item.pour_unit or 'ml'}, "
                    f"need {total_pour_ml}"
                ),
            )
        new_qty = current_qty - total_pour_ml

    pour_date = data.date or date.today()
    item.quantity = round(new_qty, 4)  # 4 decimals — preserves partial bottles
    # Log change_qty in same units as item.quantity (consistency for stock
    # history / audit trail). For bottle-stocked items this is a fractional
    # bottle decrement; for ml-stocked it's the ml.
    log_qty = -(total_pour_ml / bottle_size_ml) if stocked_in_bottles else -total_pour_ml
    log = InventoryLog(
        item_id=item.id,
        change_qty=round(log_qty, 4),
        reason=f"pour:{pours}x{pour_size_ml:.0f}{item.pour_unit or 'ml'}",
        date=pour_date,
    )
    db.add(log)

    # Auto-record sale if sell price is set
    revenue = float(item.sell_price_per_pour or 0) * data.pours
    if revenue > 0:
        sale = Sale(
            user_id=user.id,
            date=pour_date,
            amount=revenue,
            payment_method="cash",
            notes=f"Bar: {data.pours}x {item.name}",
            reference_id=f"pour_{item.id}_{pour_date}",
        )
        db.add(sale)

    db.commit()
    db.refresh(item)

    remaining_pours = int(float(item.quantity) / float(item.pour_size)) if float(item.pour_size) > 0 else 0

    return {
        "item_id": str(item.id),
        "name": item.name,
        "poured": data.pours,
        "ml_used": total_ml,
        "remaining_ml": float(item.quantity),
        "remaining_pours": remaining_pours,
        "revenue": revenue,
        "sale_recorded": revenue > 0,
    }


# ── Templates ──────────────────────────────────────────────

BAR_TEMPLATE_LIST = [
    {"name": "Vodka", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Tequila", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Rum", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Whiskey", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Gin", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 750, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Brandy", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Jägermeister", "unit": "ml", "category": "Spirits", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Red Wine", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "White Wine", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Rosé Wine", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Prosecco", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Champagne", "unit": "ml", "category": "Wine", "perishable": True, "reorder": 750, "bottle_size": 750, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Draft Beer", "unit": "ml", "category": "Beer", "perishable": True, "reorder": 5000, "bottle_size": 30000, "pour_size": 400, "pour_unit": "ml"},
    {"name": "Bottled Beer", "unit": "pieces", "category": "Beer", "perishable": True, "reorder": 12, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Coca-Cola", "unit": "ml", "category": "Mixers", "perishable": False, "reorder": 2000, "bottle_size": 1500, "pour_size": 200, "pour_unit": "ml"},
    {"name": "Tonic Water", "unit": "ml", "category": "Mixers", "perishable": False, "reorder": 2000, "bottle_size": 1000, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Soda Water", "unit": "ml", "category": "Mixers", "perishable": False, "reorder": 2000, "bottle_size": 1000, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Orange Juice", "unit": "ml", "category": "Mixers", "perishable": True, "reorder": 1000, "bottle_size": 1000, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Cranberry Juice", "unit": "ml", "category": "Mixers", "perishable": True, "reorder": 1000, "bottle_size": 1000, "pour_size": 150, "pour_unit": "ml"},
    {"name": "Lime Juice", "unit": "ml", "category": "Mixers", "perishable": True, "reorder": 500, "bottle_size": 500, "pour_size": 15, "pour_unit": "ml"},
    {"name": "Simple Syrup", "unit": "ml", "category": "Mixers", "perishable": True, "reorder": 500, "bottle_size": 750, "pour_size": 15, "pour_unit": "ml"},
    {"name": "Triple Sec", "unit": "ml", "category": "Liqueurs", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Kahlúa", "unit": "ml", "category": "Liqueurs", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Baileys", "unit": "ml", "category": "Liqueurs", "perishable": True, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Amaretto", "unit": "ml", "category": "Liqueurs", "perishable": False, "reorder": 200, "bottle_size": 700, "pour_size": 30, "pour_unit": "ml"},
    {"name": "Lemons", "unit": "pieces", "category": "Garnish", "perishable": True, "reorder": 10, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Limes", "unit": "pieces", "category": "Garnish", "perishable": True, "reorder": 10, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Mint", "unit": "pieces", "category": "Garnish", "perishable": True, "reorder": 5, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Olives", "unit": "pieces", "category": "Garnish", "perishable": True, "reorder": 20, "bottle_size": None, "pour_size": None, "pour_unit": None},
    {"name": "Ice", "unit": "kg", "category": "Supplies", "perishable": True, "reorder": 5, "bottle_size": None, "pour_size": None, "pour_unit": None},
]

RESTAURANT_TEMPLATE_LIST = [
    {"name": "Chicken", "unit": "kg", "category": "Protein", "perishable": True, "reorder": 5},
    {"name": "Rice", "unit": "kg", "category": "Pantry", "perishable": False, "reorder": 10},
    {"name": "Cooking Oil", "unit": "liters", "category": "Pantry", "perishable": False, "reorder": 5},
    {"name": "Onions", "unit": "kg", "category": "Produce", "perishable": True, "reorder": 10},
    {"name": "Tomatoes", "unit": "kg", "category": "Produce", "perishable": True, "reorder": 5},
    {"name": "Potatoes", "unit": "kg", "category": "Produce", "perishable": True, "reorder": 10},
    {"name": "Flour", "unit": "kg", "category": "Pantry", "perishable": False, "reorder": 5},
    {"name": "Cheese", "unit": "kg", "category": "Dairy", "perishable": True, "reorder": 2},
    {"name": "Butter", "unit": "kg", "category": "Dairy", "perishable": True, "reorder": 2},
    {"name": "Coca-Cola", "unit": "pieces", "category": "Beverages", "perishable": False, "reorder": 24},
    {"name": "Coffee Beans", "unit": "kg", "category": "Beverages", "perishable": False, "reorder": 3},
    {"name": "Takeaway Boxes", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 50},
    {"name": "Napkins", "unit": "packs", "category": "Supplies", "perishable": False, "reorder": 10},
]

VEGGIE_SHOP_TEMPLATE_LIST = [
    {"name": "Tomatoes", "unit": "kg", "category": "Vegetables", "perishable": True, "reorder": 10},
    {"name": "Potatoes", "unit": "kg", "category": "Vegetables", "perishable": True, "reorder": 20},
    {"name": "Onions", "unit": "kg", "category": "Vegetables", "perishable": True, "reorder": 15},
    {"name": "Spinach", "unit": "kg", "category": "Vegetables", "perishable": True, "reorder": 5},
    {"name": "Carrots", "unit": "kg", "category": "Vegetables", "perishable": True, "reorder": 10},
    {"name": "Cauliflower", "unit": "pieces", "category": "Vegetables", "perishable": True, "reorder": 10},
    {"name": "Chillies", "unit": "kg", "category": "Vegetables", "perishable": True, "reorder": 2},
    {"name": "Apples", "unit": "kg", "category": "Fruits", "perishable": True, "reorder": 10},
    {"name": "Bananas", "unit": "kg", "category": "Fruits", "perishable": True, "reorder": 10},
    {"name": "Coriander", "unit": "bunches", "category": "Herbs", "perishable": True, "reorder": 10},
    {"name": "Rice", "unit": "kg", "category": "Dry Goods", "perishable": False, "reorder": 25},
    {"name": "Red Lentils", "unit": "kg", "category": "Dry Goods", "perishable": False, "reorder": 10},
    {"name": "Plastic Bags", "unit": "packs", "category": "Supplies", "perishable": False, "reorder": 5},
]

KIOSK_TEMPLATE_LIST = [
    {"name": "Coca-Cola 0.5L", "unit": "pieces", "category": "Beverages", "perishable": False, "reorder": 24},
    {"name": "Red Bull", "unit": "pieces", "category": "Beverages", "perishable": False, "reorder": 12},
    {"name": "Water 0.5L", "unit": "pieces", "category": "Beverages", "perishable": False, "reorder": 24},
    {"name": "Chocolate Milk", "unit": "pieces", "category": "Beverages", "perishable": True, "reorder": 12},
    {"name": "Chips (assorted)", "unit": "pieces", "category": "Snacks", "perishable": False, "reorder": 20},
    {"name": "Chocolate Bars", "unit": "pieces", "category": "Snacks", "perishable": False, "reorder": 20},
    {"name": "Ice Cream", "unit": "pieces", "category": "Snacks", "perishable": True, "reorder": 20},
    {"name": "Cigarettes", "unit": "packs", "category": "Tobacco", "perishable": False, "reorder": 10},
    {"name": "Lighters", "unit": "pieces", "category": "Tobacco", "perishable": False, "reorder": 10},
    {"name": "Rundstykker", "unit": "pieces", "category": "Bakery", "perishable": True, "reorder": 20},
    {"name": "Hotdog Sausages", "unit": "packs", "category": "Bakery", "perishable": True, "reorder": 5},
    {"name": "Scratch Cards", "unit": "pieces", "category": "Misc", "perishable": False, "reorder": 20},
]

GROCERY_TEMPLATE_LIST = [
    {"name": "Milk", "unit": "pieces", "category": "Dairy", "perishable": True, "reorder": 20},
    {"name": "Eggs", "unit": "packs", "category": "Dairy", "perishable": True, "reorder": 10},
    {"name": "Butter", "unit": "pieces", "category": "Dairy", "perishable": True, "reorder": 10},
    {"name": "Rice", "unit": "pieces", "category": "Packaged", "perishable": False, "reorder": 15},
    {"name": "Pasta", "unit": "pieces", "category": "Packaged", "perishable": False, "reorder": 15},
    {"name": "Cooking Oil", "unit": "pieces", "category": "Packaged", "perishable": False, "reorder": 8},
    {"name": "Sugar", "unit": "pieces", "category": "Packaged", "perishable": False, "reorder": 8},
    {"name": "Instant Noodles", "unit": "pieces", "category": "Packaged", "perishable": False, "reorder": 20},
    {"name": "Soda (cans)", "unit": "pieces", "category": "Beverages", "perishable": False, "reorder": 24},
    {"name": "Dish Soap", "unit": "pieces", "category": "Household", "perishable": False, "reorder": 6},
    {"name": "Toilet Paper", "unit": "packs", "category": "Household", "perishable": False, "reorder": 10},
    {"name": "Toothpaste", "unit": "pieces", "category": "Personal Care", "perishable": False, "reorder": 5},
]

CLOTHING_TEMPLATE_LIST = [
    {"name": "T-Shirts", "unit": "pieces", "category": "Tops", "perishable": False, "reorder": 10},
    {"name": "Shirts", "unit": "pieces", "category": "Tops", "perishable": False, "reorder": 5},
    {"name": "Hoodies", "unit": "pieces", "category": "Tops", "perishable": False, "reorder": 5},
    {"name": "Jeans", "unit": "pieces", "category": "Bottoms", "perishable": False, "reorder": 5},
    {"name": "Trousers", "unit": "pieces", "category": "Bottoms", "perishable": False, "reorder": 5},
    {"name": "Dresses", "unit": "pieces", "category": "Dresses", "perishable": False, "reorder": 5},
    {"name": "Jackets", "unit": "pieces", "category": "Outerwear", "perishable": False, "reorder": 3},
    {"name": "Sneakers", "unit": "pairs", "category": "Footwear", "perishable": False, "reorder": 5},
    {"name": "Sandals", "unit": "pairs", "category": "Footwear", "perishable": False, "reorder": 5},
    {"name": "Belts", "unit": "pieces", "category": "Accessories", "perishable": False, "reorder": 5},
    {"name": "Bags", "unit": "pieces", "category": "Accessories", "perishable": False, "reorder": 3},
    {"name": "Socks", "unit": "packs", "category": "Accessories", "perishable": False, "reorder": 10},
]

PHARMACY_TEMPLATE_LIST = [
    {"name": "Paracetamol", "unit": "strips", "category": "Medicine", "perishable": True, "reorder": 20},
    {"name": "Ibuprofen", "unit": "strips", "category": "Medicine", "perishable": True, "reorder": 15},
    {"name": "Cough Syrup", "unit": "bottles", "category": "Medicine", "perishable": True, "reorder": 10},
    {"name": "Antacid", "unit": "strips", "category": "Medicine", "perishable": True, "reorder": 10},
    {"name": "ORS Sachets", "unit": "pieces", "category": "Medicine", "perishable": True, "reorder": 20},
    {"name": "Vitamin C", "unit": "bottles", "category": "Vitamins", "perishable": True, "reorder": 5},
    {"name": "Bandages", "unit": "packs", "category": "First Aid", "perishable": False, "reorder": 10},
    {"name": "Hand Sanitizer", "unit": "bottles", "category": "First Aid", "perishable": True, "reorder": 5},
    {"name": "Thermometer", "unit": "pieces", "category": "Devices", "perishable": False, "reorder": 3},
    {"name": "Sanitary Pads", "unit": "packs", "category": "Hygiene", "perishable": False, "reorder": 10},
    {"name": "Toothpaste", "unit": "pieces", "category": "Hygiene", "perishable": False, "reorder": 10},
    {"name": "Soap", "unit": "pieces", "category": "Hygiene", "perishable": False, "reorder": 10},
]

ELECTRONICS_TEMPLATE_LIST = [
    {"name": "USB-C Charger", "unit": "pieces", "category": "Chargers", "perishable": False, "reorder": 5},
    {"name": "Lightning Cable", "unit": "pieces", "category": "Cables", "perishable": False, "reorder": 10},
    {"name": "USB-C Cable", "unit": "pieces", "category": "Cables", "perishable": False, "reorder": 10},
    {"name": "Power Bank", "unit": "pieces", "category": "Chargers", "perishable": False, "reorder": 3},
    {"name": "Bluetooth Earbuds", "unit": "pieces", "category": "Audio", "perishable": False, "reorder": 5},
    {"name": "Phone Cases", "unit": "pieces", "category": "Phone", "perishable": False, "reorder": 10},
    {"name": "Screen Protectors", "unit": "pieces", "category": "Phone", "perishable": False, "reorder": 10},
    {"name": "Memory Cards", "unit": "pieces", "category": "Phone", "perishable": False, "reorder": 5},
    {"name": "Mouse", "unit": "pieces", "category": "Computer", "perishable": False, "reorder": 3},
    {"name": "AA Batteries", "unit": "packs", "category": "Batteries", "perishable": False, "reorder": 10},
    {"name": "LED Bulbs", "unit": "pieces", "category": "Batteries", "perishable": False, "reorder": 5},
]

ONLINE_CLOTHING_TEMPLATE_LIST = [
    {"name": "T-Shirts", "unit": "pieces", "category": "Tops", "perishable": False, "reorder": 15},
    {"name": "Hoodies", "unit": "pieces", "category": "Tops", "perishable": False, "reorder": 10},
    {"name": "Jeans", "unit": "pieces", "category": "Bottoms", "perishable": False, "reorder": 10},
    {"name": "Dresses", "unit": "pieces", "category": "Dresses", "perishable": False, "reorder": 10},
    {"name": "Kurta / Salwar", "unit": "pieces", "category": "Traditional", "perishable": False, "reorder": 10},
    {"name": "Saree", "unit": "pieces", "category": "Traditional", "perishable": False, "reorder": 5},
    {"name": "Sneakers", "unit": "pairs", "category": "Footwear", "perishable": False, "reorder": 5},
    {"name": "Bags", "unit": "pieces", "category": "Accessories", "perishable": False, "reorder": 5},
    {"name": "Shipping Boxes", "unit": "pieces", "category": "Packaging", "perishable": False, "reorder": 50},
    {"name": "Bubble Wrap", "unit": "rolls", "category": "Packaging", "perishable": False, "reorder": 5},
    {"name": "Poly Mailers", "unit": "pieces", "category": "Packaging", "perishable": False, "reorder": 50},
    {"name": "Thank You Cards", "unit": "pieces", "category": "Packaging", "perishable": False, "reorder": 30},
]

TEA_SHOP_TEMPLATE_LIST = [
    {"name": "Tea Leaves", "unit": "kg", "category": "Tea", "perishable": False, "reorder": 5},
    {"name": "Milk", "unit": "liters", "category": "Dairy", "perishable": True, "reorder": 10},
    {"name": "Sugar", "unit": "kg", "category": "Pantry", "perishable": False, "reorder": 5},
    {"name": "Ginger", "unit": "kg", "category": "Spices", "perishable": True, "reorder": 1},
    {"name": "Cardamom", "unit": "kg", "category": "Spices", "perishable": False, "reorder": 1},
    {"name": "Biscuits", "unit": "packs", "category": "Snacks", "perishable": False, "reorder": 20},
    {"name": "Samosa", "unit": "pieces", "category": "Snacks", "perishable": True, "reorder": 20},
    {"name": "Bread / Pauroti", "unit": "pieces", "category": "Snacks", "perishable": True, "reorder": 10},
    {"name": "Paper Cups", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 100},
    {"name": "Instant Noodles", "unit": "pieces", "category": "Snacks", "perishable": False, "reorder": 20},
]

COSMETICS_TEMPLATE_LIST = [
    {"name": "Face Cream", "unit": "pieces", "category": "Skincare", "perishable": True, "reorder": 10},
    {"name": "Lipstick", "unit": "pieces", "category": "Makeup", "perishable": False, "reorder": 10},
    {"name": "Foundation", "unit": "pieces", "category": "Makeup", "perishable": True, "reorder": 5},
    {"name": "Nail Polish", "unit": "pieces", "category": "Nails", "perishable": False, "reorder": 10},
    {"name": "Shampoo", "unit": "pieces", "category": "Hair Care", "perishable": False, "reorder": 10},
    {"name": "Hair Oil", "unit": "pieces", "category": "Hair Care", "perishable": False, "reorder": 10},
    {"name": "Perfume", "unit": "pieces", "category": "Fragrance", "perishable": False, "reorder": 5},
    {"name": "Sunscreen", "unit": "pieces", "category": "Skincare", "perishable": True, "reorder": 5},
    {"name": "Face Wash", "unit": "pieces", "category": "Skincare", "perishable": True, "reorder": 10},
    {"name": "Eyeliner", "unit": "pieces", "category": "Makeup", "perishable": False, "reorder": 10},
]

STATIONERY_TEMPLATE_LIST = [
    {"name": "Notebooks", "unit": "pieces", "category": "Paper", "perishable": False, "reorder": 20},
    {"name": "Pens", "unit": "pieces", "category": "Writing", "perishable": False, "reorder": 30},
    {"name": "Pencils", "unit": "pieces", "category": "Writing", "perishable": False, "reorder": 20},
    {"name": "Erasers", "unit": "pieces", "category": "Writing", "perishable": False, "reorder": 10},
    {"name": "Printer Paper (A4)", "unit": "reams", "category": "Paper", "perishable": False, "reorder": 10},
    {"name": "Markers", "unit": "packs", "category": "Writing", "perishable": False, "reorder": 5},
    {"name": "Glue Sticks", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 10},
    {"name": "Files & Folders", "unit": "pieces", "category": "Paper", "perishable": False, "reorder": 10},
    {"name": "School Bags", "unit": "pieces", "category": "Bags", "perishable": False, "reorder": 5},
    {"name": "Scissors", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 5},
]

HARDWARE_TEMPLATE_LIST = [
    {"name": "Cement", "unit": "bags", "category": "Construction", "perishable": False, "reorder": 20},
    {"name": "Iron Rod", "unit": "pieces", "category": "Construction", "perishable": False, "reorder": 10},
    {"name": "Paint", "unit": "liters", "category": "Paint", "perishable": False, "reorder": 10},
    {"name": "Nails", "unit": "kg", "category": "Fasteners", "perishable": False, "reorder": 5},
    {"name": "Screws", "unit": "packs", "category": "Fasteners", "perishable": False, "reorder": 10},
    {"name": "PVC Pipes", "unit": "pieces", "category": "Plumbing", "perishable": False, "reorder": 10},
    {"name": "Electric Wire", "unit": "meters", "category": "Electrical", "perishable": False, "reorder": 50},
    {"name": "Switches & Sockets", "unit": "pieces", "category": "Electrical", "perishable": False, "reorder": 10},
    {"name": "Locks", "unit": "pieces", "category": "Hardware", "perishable": False, "reorder": 5},
    {"name": "Tape", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 10},
]

FLOWER_SHOP_TEMPLATE_LIST = [
    {"name": "Roses", "unit": "bunches", "category": "Flowers", "perishable": True, "reorder": 10},
    {"name": "Lilies", "unit": "bunches", "category": "Flowers", "perishable": True, "reorder": 5},
    {"name": "Tulips", "unit": "bunches", "category": "Flowers", "perishable": True, "reorder": 5},
    {"name": "Mixed Bouquet", "unit": "pieces", "category": "Arrangements", "perishable": True, "reorder": 5},
    {"name": "Wrapping Paper", "unit": "rolls", "category": "Supplies", "perishable": False, "reorder": 5},
    {"name": "Ribbon", "unit": "rolls", "category": "Supplies", "perishable": False, "reorder": 5},
    {"name": "Vases", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 5},
    {"name": "Potted Plants", "unit": "pieces", "category": "Plants", "perishable": True, "reorder": 5},
    {"name": "Greeting Cards", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 20},
]

JEWELRY_TEMPLATE_LIST = [
    {"name": "Gold Rings", "unit": "pieces", "category": "Gold", "perishable": False, "reorder": 3},
    {"name": "Gold Necklaces", "unit": "pieces", "category": "Gold", "perishable": False, "reorder": 3},
    {"name": "Silver Rings", "unit": "pieces", "category": "Silver", "perishable": False, "reorder": 5},
    {"name": "Earrings", "unit": "pairs", "category": "Accessories", "perishable": False, "reorder": 10},
    {"name": "Bangles", "unit": "pieces", "category": "Accessories", "perishable": False, "reorder": 10},
    {"name": "Watches", "unit": "pieces", "category": "Watches", "perishable": False, "reorder": 3},
    {"name": "Beads / Mala", "unit": "pieces", "category": "Accessories", "perishable": False, "reorder": 5},
    {"name": "Gift Boxes", "unit": "pieces", "category": "Packaging", "perishable": False, "reorder": 20},
]

MOBILE_REPAIR_TEMPLATE_LIST = [
    {"name": "Phone Screens", "unit": "pieces", "category": "Screens", "perishable": False, "reorder": 5},
    {"name": "Phone Batteries", "unit": "pieces", "category": "Parts", "perishable": False, "reorder": 10},
    {"name": "Charging Ports", "unit": "pieces", "category": "Parts", "perishable": False, "reorder": 10},
    {"name": "Back Covers", "unit": "pieces", "category": "Parts", "perishable": False, "reorder": 10},
    {"name": "Screwdriver Kit", "unit": "sets", "category": "Tools", "perishable": False, "reorder": 2},
    {"name": "Adhesive Tape", "unit": "rolls", "category": "Tools", "perishable": False, "reorder": 5},
    {"name": "Screen Protectors", "unit": "pieces", "category": "Accessories", "perishable": False, "reorder": 20},
    {"name": "Phone Cases", "unit": "pieces", "category": "Accessories", "perishable": False, "reorder": 15},
]

OTHER_TEMPLATE_LIST = [
    {"name": "Office Supplies", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 10},
    {"name": "Printer Paper", "unit": "boxes", "category": "Supplies", "perishable": False, "reorder": 3},
    {"name": "Pens & Markers", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 10},
    {"name": "Cleaning Supplies", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 5},
    {"name": "Trash Bags", "unit": "boxes", "category": "Supplies", "perishable": False, "reorder": 2},
    {"name": "Hand Tools", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 2},
    {"name": "Tape & Glue", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 5},
    {"name": "Batteries", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 10},
    {"name": "Light Bulbs", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 5},
    {"name": "Extension Cords", "unit": "pieces", "category": "Tools", "perishable": False, "reorder": 2},
    {"name": "Raw Materials", "unit": "kg", "category": "Materials", "perishable": False, "reorder": 10},
    {"name": "Packaging Boxes", "unit": "pieces", "category": "Materials", "perishable": False, "reorder": 20},
    {"name": "Plastic Bags", "unit": "pieces", "category": "Materials", "perishable": False, "reorder": 50},
    {"name": "Labels & Stickers", "unit": "pieces", "category": "Materials", "perishable": False, "reorder": 50},
    {"name": "Bubble Wrap", "unit": "pieces", "category": "Materials", "perishable": False, "reorder": 5},
    {"name": "Delivery Service", "unit": "pieces", "category": "Services", "perishable": False, "reorder": 0},
    {"name": "Repair Parts", "unit": "pieces", "category": "Services", "perishable": False, "reorder": 5},
    {"name": "Fuel / Petrol", "unit": "liters", "category": "Services", "perishable": False, "reorder": 10},
    {"name": "Uniforms", "unit": "pieces", "category": "Services", "perishable": False, "reorder": 2},
    {"name": "Safety Equipment", "unit": "pieces", "category": "Services", "perishable": False, "reorder": 3},
]

SALON_TEMPLATE_LIST = [
    {"name": "Shampoo", "unit": "bottles", "category": "Products", "perishable": False, "reorder": 5},
    {"name": "Conditioner", "unit": "bottles", "category": "Products", "perishable": False, "reorder": 5},
    {"name": "Hair Color / Dye", "unit": "boxes", "category": "Products", "perishable": False, "reorder": 3},
    {"name": "Hair Oil", "unit": "bottles", "category": "Products", "perishable": False, "reorder": 3},
    {"name": "Gel / Wax", "unit": "pieces", "category": "Products", "perishable": False, "reorder": 3},
    {"name": "Razor Blades", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 20},
    {"name": "Towels", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 5},
    {"name": "Nail Polish", "unit": "bottles", "category": "Nail", "perishable": False, "reorder": 5},
    {"name": "Nail Remover", "unit": "bottles", "category": "Nail", "perishable": False, "reorder": 2},
    {"name": "Face Cream / Mask", "unit": "pieces", "category": "Skin", "perishable": True, "reorder": 3},
    {"name": "Disposable Gloves", "unit": "boxes", "category": "Supplies", "perishable": False, "reorder": 3},
    {"name": "Cape / Apron", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 2},
]

LAUNDRY_TEMPLATE_LIST = [
    {"name": "Detergent", "unit": "kg", "category": "Chemicals", "perishable": False, "reorder": 5},
    {"name": "Fabric Softener", "unit": "liters", "category": "Chemicals", "perishable": False, "reorder": 3},
    {"name": "Bleach", "unit": "liters", "category": "Chemicals", "perishable": False, "reorder": 2},
    {"name": "Stain Remover", "unit": "bottles", "category": "Chemicals", "perishable": False, "reorder": 2},
    {"name": "Hangers", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 50},
    {"name": "Plastic Covers", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 100},
    {"name": "Laundry Bags", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 20},
    {"name": "Tags / Labels", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 100},
    {"name": "Iron Spray / Starch", "unit": "bottles", "category": "Chemicals", "perishable": False, "reorder": 3},
    {"name": "Lint Rollers", "unit": "pieces", "category": "Supplies", "perishable": False, "reorder": 5},
]

THRIFT_TEMPLATE_LIST = [
    {"name": "T-Shirts", "unit": "pieces", "category": "Clothing", "perishable": False, "reorder": 10},
    {"name": "Jeans / Pants", "unit": "pieces", "category": "Clothing", "perishable": False, "reorder": 5},
    {"name": "Jackets / Coats", "unit": "pieces", "category": "Clothing", "perishable": False, "reorder": 3},
    {"name": "Shoes", "unit": "pairs", "category": "Footwear", "perishable": False, "reorder": 5},
    {"name": "Bags / Purses", "unit": "pieces", "category": "Accessories", "perishable": False, "reorder": 3},
    {"name": "Books", "unit": "pieces", "category": "Media", "perishable": False, "reorder": 10},
    {"name": "Electronics (Used)", "unit": "pieces", "category": "Electronics", "perishable": False, "reorder": 2},
    {"name": "Household Items", "unit": "pieces", "category": "Home", "perishable": False, "reorder": 5},
    {"name": "Kids Clothing", "unit": "pieces", "category": "Clothing", "perishable": False, "reorder": 5},
    {"name": "Dresses / Skirts", "unit": "pieces", "category": "Clothing", "perishable": False, "reorder": 5},
]

@router.get("/templates", response_model=list[TemplateResponse])
def list_templates(
    template_type: str = Query(None),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    HARDCODED_TEMPLATES = {
        "bar": ("Bar / Cocktail", BAR_TEMPLATE_LIST),
        "restaurant": ("Restaurant & Cafe", RESTAURANT_TEMPLATE_LIST),
        "cafe": ("Cafe / Coffee Shop", RESTAURANT_TEMPLATE_LIST),
        "bakery": ("Bakery / Sweet Shop", RESTAURANT_TEMPLATE_LIST),
        "food_truck": ("Food Truck", RESTAURANT_TEMPLATE_LIST),
        "veggie_shop": ("Veggie / Fruit Shop", VEGGIE_SHOP_TEMPLATE_LIST),
        "kiosk": ("Danish Kiosk", KIOSK_TEMPLATE_LIST),
        "grocery": ("Grocery / Mini-Mart", GROCERY_TEMPLATE_LIST),
        "clothing": ("Clothing Store", CLOTHING_TEMPLATE_LIST),
        "online_clothing": ("Online Clothing Store", ONLINE_CLOTHING_TEMPLATE_LIST),
        "pharmacy": ("Pharmacy", PHARMACY_TEMPLATE_LIST),
        "electronics": ("Electronics & Mobile", ELECTRONICS_TEMPLATE_LIST),
        "tea_shop": ("Tea Shop / Chiya Pasal", TEA_SHOP_TEMPLATE_LIST),
        "cosmetics": ("Cosmetics / Beauty Supply", COSMETICS_TEMPLATE_LIST),
        "stationery": ("Stationery / Book Shop", STATIONERY_TEMPLATE_LIST),
        "hardware": ("Hardware / Construction", HARDWARE_TEMPLATE_LIST),
        "flower_shop": ("Flower Shop", FLOWER_SHOP_TEMPLATE_LIST),
        "jewelry": ("Jewelry / Accessories", JEWELRY_TEMPLATE_LIST),
        "mobile_repair": ("Mobile Repair", MOBILE_REPAIR_TEMPLATE_LIST),
        "salon": ("Salon / Barber / Nail", SALON_TEMPLATE_LIST),
        "laundry": ("Laundry / Dry Cleaning", LAUNDRY_TEMPLATE_LIST),
        "thrift": ("Thrift / Second-hand", THRIFT_TEMPLATE_LIST),
        "other": ("Other / Custom", OTHER_TEMPLATE_LIST),
    }
    if template_type in HARDCODED_TEMPLATES:
        tpl_name, tpl_list = HARDCODED_TEMPLATES[template_type]
        return [
            {"id": i + 1, "template_name": tpl_name, "template_type": template_type,
             "item_name": t["name"], "default_unit": t["unit"], "default_category": t["category"],
             "is_perishable": t["perishable"], "default_reorder_level": t["reorder"]}
            for i, t in enumerate(tpl_list)
        ]
    query = db.query(InventoryTemplate)
    if template_type:
        query = query.filter(InventoryTemplate.template_type == template_type)
    return query.all()


@router.post("/templates/load", response_model=list[InventoryItemResponse], status_code=201)
def load_template(
    data: TemplateLoadRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    HARDCODED_TEMPLATES = {
        "bar": BAR_TEMPLATE_LIST,
        "restaurant": RESTAURANT_TEMPLATE_LIST,
        "cafe": RESTAURANT_TEMPLATE_LIST,
        "bakery": RESTAURANT_TEMPLATE_LIST,
        "food_truck": RESTAURANT_TEMPLATE_LIST,
        "veggie_shop": VEGGIE_SHOP_TEMPLATE_LIST,
        "kiosk": KIOSK_TEMPLATE_LIST,
        "grocery": GROCERY_TEMPLATE_LIST,
        "clothing": CLOTHING_TEMPLATE_LIST,
        "online_clothing": ONLINE_CLOTHING_TEMPLATE_LIST,
        "pharmacy": PHARMACY_TEMPLATE_LIST,
        "electronics": ELECTRONICS_TEMPLATE_LIST,
        "tea_shop": TEA_SHOP_TEMPLATE_LIST,
        "cosmetics": COSMETICS_TEMPLATE_LIST,
        "stationery": STATIONERY_TEMPLATE_LIST,
        "hardware": HARDWARE_TEMPLATE_LIST,
        "flower_shop": FLOWER_SHOP_TEMPLATE_LIST,
        "jewelry": JEWELRY_TEMPLATE_LIST,
        "mobile_repair": MOBILE_REPAIR_TEMPLATE_LIST,
        "salon": SALON_TEMPLATE_LIST,
        "laundry": LAUNDRY_TEMPLATE_LIST,
        "thrift": THRIFT_TEMPLATE_LIST,
        "other": OTHER_TEMPLATE_LIST,
    }
    if data.template_type in HARDCODED_TEMPLATES:
        tpl_list = HARDCODED_TEMPLATES[data.template_type]
        created = []
        for t in tpl_list:
            existing = db.query(InventoryItem).filter(
                InventoryItem.user_id == user.id,
                InventoryItem.name == t["name"],
            ).first()
            if existing:
                continue
            item = InventoryItem(
                user_id=user.id, name=t["name"], quantity=0, unit=t["unit"],
                cost_per_unit=0, min_threshold=t["reorder"], category=t["category"],
                is_perishable=t["perishable"],
                bottle_size=t.get("bottle_size"),
                pour_size=t.get("pour_size"),
                pour_unit=t.get("pour_unit"),
            )
            db.add(item)
            created.append(item)
        db.commit()
        for c in created:
            db.refresh(c)
        return created

    templates = (
        db.query(InventoryTemplate)
        .filter(InventoryTemplate.template_type == data.template_type)
        .all()
    )
    if not templates:
        raise HTTPException(status_code=404, detail="Template not found")

    created = []
    for t in templates:
        existing = db.query(InventoryItem).filter(
            InventoryItem.user_id == user.id,
            InventoryItem.name == t.item_name,
        ).first()
        if existing:
            continue
        item = InventoryItem(
            user_id=user.id,
            name=t.item_name,
            quantity=0,
            unit=t.default_unit,
            cost_per_unit=0,
            min_threshold=t.default_reorder_level,
            category=t.default_category,
            is_perishable=t.is_perishable,
        )
        db.add(item)
        created.append(item)

    db.commit()
    for item in created:
        db.refresh(item)
    return created


# ═══════════════════════════════════════════════════════════════════════════
#  Smart Inventory consumption metadata
# ═══════════════════════════════════════════════════════════════════════════
#
# Multi-layer:
#   L1 — get_current_user gates every endpoint
#   L2 — service layer enforces tenant scoping on every read + write
#   L3 — service validates pattern / unit / serving / keywords; one
#        invalid field rejects the whole call (no partial state)

from app.services.inventory_consumption_service import (
    InventoryConsumptionError as _ICError,
    find_matching_items_for_sale as _find_matching_items,
    predict_days_until_depletion as _predict_depletion,
    update_consumption_metadata as _update_consumption,
)


class _ConsumptionUpdateBody(BaseModel):
    consumption_pattern: str | None = None
    consumption_unit: str | None = None
    serving_size: float | None = None
    usage_keywords: str | None = None


class _ConsumptionResponse(BaseModel):
    id: str
    consumption_pattern: str | None
    consumption_unit: str | None
    serving_size: float | None
    usage_keywords: str | None
    days_until_depletion: float | None


def _consumption_response(item: InventoryItem, db: Session) -> _ConsumptionResponse:
    return _ConsumptionResponse(
        id=str(item.id),
        consumption_pattern=item.consumption_pattern,
        consumption_unit=item.consumption_unit,
        serving_size=float(item.serving_size) if item.serving_size is not None else None,
        usage_keywords=item.usage_keywords,
        days_until_depletion=_predict_depletion(db, item=item),
    )


@router.patch("/{item_id}/consumption", response_model=_ConsumptionResponse)
def update_inventory_consumption(
    item_id: str,
    body: _ConsumptionUpdateBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner sets/updates consumption metadata on an inventory item.

    Pass `null` for any field to leave it unchanged. Pass `""` (empty
    string) to clear it. Service enforces tenant scope + validation.
    """
    import uuid as _uuid
    try:
        item_uuid = _uuid.UUID(item_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid item_id")
    try:
        item = _update_consumption(
            db,
            owner_id=user.id,
            item_id=item_uuid,
            consumption_pattern=body.consumption_pattern,
            consumption_unit=body.consumption_unit,
            serving_size=body.serving_size,
            usage_keywords=body.usage_keywords,
        )
    except _ICError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return _consumption_response(item, db)


@router.get("/{item_id}/consumption", response_model=_ConsumptionResponse)
def get_inventory_consumption(
    item_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Read consumption metadata + current depletion estimate for one
    item. Used by the inventory edit modal to render the existing
    config + the prediction freshly each open."""
    import uuid as _uuid
    try:
        item_uuid = _uuid.UUID(item_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid item_id")
    item = db.query(InventoryItem).filter(
        InventoryItem.id == item_uuid,
        InventoryItem.user_id == user.id,  # tenant gate
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Inventory item not found")
    return _consumption_response(item, db)


@router.get("/match-sale")
def match_sale_to_items(
    sale_item_name: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Preview helper: 'these are the items your current keywords
    would auto-decrement for this sale name'. Useful while the owner
    is editing keywords so they can see the impact before saving."""
    if not sale_item_name or len(sale_item_name) > 200:
        raise HTTPException(status_code=422, detail="sale_item_name out of bounds")
    matches = _find_matching_items(
        db, owner_id=user.id, sale_item_name=sale_item_name,
    )
    return [
        {
            "id": str(m.id),
            "name": m.name,
            "consumption_pattern": m.consumption_pattern,
            "serving_size": float(m.serving_size) if m.serving_size is not None else None,
            "consumption_unit": m.consumption_unit,
        }
        for m in matches
    ]


@router.get("/{item_id}/usage-suggestion")
def get_inventory_usage_suggestion(
    item_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The "we recognise this item" proposal. Looks up the item's
    name in a curated per-vertical recipe dictionary, cross-checks
    keywords against recent sales, returns a complete consumption
    proposal. Owner reviews → taps "looks right" → frontend PATCHes
    the existing /{id}/consumption endpoint with the proposed shape.
    """
    import uuid as _uuid
    try:
        item_uuid = _uuid.UUID(item_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid item_id")
    item = db.query(InventoryItem).filter(
        InventoryItem.id == item_uuid,
        InventoryItem.user_id == user.id,  # tenant gate
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Inventory item not found")
    from app.services.inventory_inference import infer_inventory_consumption
    return infer_inventory_consumption(db, user=user, item=item)


# ═══════════════════════════════════════════════════════════════════════════
#  Inventory Ordering Autopilot — Task #63 (Pro tier killer feature)
# ═══════════════════════════════════════════════════════════════════════════
#
# Two endpoints:
#   POST /inventory/autopilot/suggest  — produce reorder plan (read-only)
#   POST /inventory/autopilot/apply    — group by supplier + send order emails
#
# Multi-layer defense:
#   L1 — Auth gate (Depends(get_current_user))
#   L2 — Pro tier gate (_enforce_inventory_autopilot_tier)
#   L3 — Tenant scope (service enforces user_id on every query)
#   L4 — Input bounds (Pydantic Field bounds + service-level clamps)
#   L5 — Rate limit (suggestion is cheap-ish but forecast call hits the
#        external network; apply sends real emails so we cap aggressively)
#   L6 — Audit log entry for every suggest + every apply
#
# Returning 402 (Payment Required) on tier-locked aligns with the same
# structured detail shape used by schedule_autopilot, tax_filing_pdf,
# etc. so the frontend renders ONE UpgradeNudge from ONE error contract.


def _enforce_inventory_autopilot_tier(user: User) -> None:
    """402 plan_required if the user doesn't have Pro entitlements.
    Same payload shape as schedule_autopilot's gate so the frontend
    renders the upgrade prompt from one contract."""
    if not has_feature(user, "inventory_autopilot"):
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "error": "feature_locked",
                "feature": "inventory_autopilot",
                "required_plan": "pro",
                "upgrade_to": "pro",
                "current_plan": effective_plan(user),
                "plan": effective_plan(user),
                "message": (
                    "Order Autopilot is on Pro. You can still review the "
                    "low-stock list and place orders manually."
                ),
            },
        )


class _AutopilotSuggestBody(BaseModel):
    days_ahead: int = Field(7, ge=1, le=30)
    branch_id: Optional[uuid.UUID] = None


class _AutopilotApplyLine(BaseModel):
    # Tight bounds — defense-in-depth. The service ALSO clamps these.
    item_id: uuid.UUID
    qty: float = Field(..., gt=0, le=10_000)
    supplier_name: Optional[str] = Field(None, max_length=120)
    supplier_email: Optional[str] = Field(None, max_length=255)
    unit: Optional[str] = Field(None, max_length=20)
    name: Optional[str] = Field(None, max_length=255)
    cost_per_unit: Optional[float] = Field(None, ge=0, le=1_000_000)


class _AutopilotApplyBody(BaseModel):
    # Cap items per apply call — bulk-send guardrail. 500 is far above
    # any plausible single-order list (Mirabelle has ~80 SKUs total).
    items: list[_AutopilotApplyLine] = Field(..., min_length=1, max_length=500)


@router.post("/autopilot/suggest")
@_limiter.limit("12/minute")
def inventory_autopilot_suggest(
    request: Request,
    body: _AutopilotSuggestBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Produce a structured reorder plan grouped by supplier.

    Read-only — never writes Schedule, InventoryLog, or Item rows. The
    owner reviews + edits qty before calling /autopilot/apply to send.

    Tier-gated: Pro+ only.
    """
    _enforce_inventory_autopilot_tier(user)

    from app.services import inventory_autopilot

    suggestion = inventory_autopilot.suggest_reorder_plan(
        db,
        user=user,
        days_ahead=body.days_ahead,
        branch_id=body.branch_id,
    )
    payload = suggestion.to_dict()

    # Audit — never let an audit-log failure block the suggestion
    # (audit_service.record already wraps in try/except).
    audit_service.record(
        db,
        user=user,
        action="inventory.autopilot_suggested",
        entity_type="inventory",
        entity_id=None,
        after={
            "branch_id": payload["branch_id"],
            "days_ahead": payload["days_ahead"],
            "confidence": payload["confidence"],
            "items_suggested": len(payload["items"]),
            "supplier_groups": len(payload["suppliers"]),
            "total_cost": payload["total_cost"],
            "compliance_warning_count": len(payload["compliance_warnings"]),
        },
        ip_address=getattr(request.client, "host", None) if request and request.client else None,
    )
    db.commit()
    return payload


@router.post("/autopilot/apply")
@_limiter.limit("4/minute")
def inventory_autopilot_apply(
    request: Request,
    body: _AutopilotApplyBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Group items by supplier_email and send one consolidated order
    email per supplier. Items without a supplier_email are returned in
    the skipped bucket so the UI can prompt the owner to add one.

    The user's own email is used as Reply-To so the supplier can hit
    Reply and reach the owner directly (not noreply@bonbox.dk).

    Tier-gated: Pro+ only.
    """
    _enforce_inventory_autopilot_tier(user)

    # Audit P3 (Task #81): per-user daily cap on distinct supplier
    # recipients.  Stops a hostile owner from using BonBox's Resend
    # trust score as a spam relay (4/min × 60 minutes × supplier_count
    # = thousands of inboxes/hour reachable from one account).
    # Genuine cafés have at most ~10 unique suppliers; 50/day leaves
    # a 5x safety margin for restaurants with deeper supply chains
    # while shutting down the abuse vector decisively.
    _MAX_RECIPIENTS_PER_DAY = 50
    from datetime import datetime, timedelta
    from sqlalchemy import and_
    from app.models.audit_log import AuditLog
    since = datetime.utcnow() - timedelta(hours=24)
    rows = (
        db.query(AuditLog)
        .filter(
            and_(
                AuditLog.user_id == user.id,
                AuditLog.action == "inventory.autopilot_applied",
                AuditLog.created_at >= since,
            )
        )
        .all()
    )
    # AuditLog.after_state is JSON text — count unique supplier_email values
    import json as _json
    recipients_today: set[str] = set()
    for r in rows:
        try:
            data = _json.loads(r.after_state or "{}")
            se = (data.get("supplier_email") or "").strip().lower()
            if se:
                recipients_today.add(se)
        except Exception:  # noqa: BLE001
            # Defensive: a malformed audit row should never bring down
            # the apply path.  Treat as "no recipient recorded".
            continue
    # Also count the unique recipients in THIS request so a single
    # giant batch can't bypass the cap.
    incoming_recipients = {
        (line.supplier_email or "").strip().lower()
        for line in body.items
        if (getattr(line, "supplier_email", None) or "").strip()
    }
    projected = len(recipients_today | incoming_recipients)
    if projected > _MAX_RECIPIENTS_PER_DAY:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "daily_recipient_cap",
                "message": (
                    f"Daily cap of {_MAX_RECIPIENTS_PER_DAY} unique supplier "
                    "recipients reached. Try again tomorrow or contact "
                    "support if you legitimately need a higher limit."
                ),
                "recipients_today": len(recipients_today),
                "projected": projected,
            },
        )

    from app.services import inventory_autopilot

    payload_items = [line.model_dump() for line in body.items]

    try:
        result = inventory_autopilot.apply_reorder(
            db,
            user=user,
            items=payload_items,
        )
    except ValueError as e:
        # ValueError from the service = tenant-boundary violation
        # (foreign item_id) or invalid uuid format. Return 400.
        raise HTTPException(status_code=400, detail=str(e))

    # Per-supplier audit row so any future "who emailed whom" investigation
    # can reconstruct the activity from the audit_logs table.
    for entry in result.get("audit", []):
        audit_service.record(
            db,
            user=user,
            action="inventory.autopilot_applied",
            entity_type="inventory_order",
            entity_id=None,
            after={
                "supplier_email": entry.get("supplier_email"),
                "item_count": entry.get("item_count"),
                "total_cost": entry.get("total_cost"),
            },
            ip_address=getattr(request.client, "host", None) if request and request.client else None,
        )
    db.commit()
    return {
        "sent": result["sent"],
        "skipped_no_supplier": result["skipped_no_supplier"],
        "failures": result["failures"],
        "groups": result["groups"],
    }
