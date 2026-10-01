import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.waste import WasteLog
from app.models.expense import Expense, ExpenseCategory
from app.schemas.waste import WasteLogCreate, WasteLogUpdate, WasteLogResponse, WasteSummary
from app.services.auth import get_current_user
from app.services.tz_utils import business_today_local
from app.utils.time import utc_now


# The expense this books is read by the owner and the revisor in Danish.
_REASON_DA = {
    "expired": "udløbet", "spoiled": "fordærvet", "damaged": "beskadiget",
    "overproduction": "overproduktion", "dropped": "tabt", "other": "andet",
    # The waste form's own reasons — "overcooked" booked "Svind: X
    # (overcooked)", the line the revisor reads.
    "overcooked": "overkogt", "burnt": "brændt", "returned": "returneret",
    "contaminated": "forurenet", "theft": "svind/tyveri",
}


def _stock_item(db: Session, log: WasteLog):
    """The stock line this waste row came off, if any (tenant-scoped)."""
    if not getattr(log, "inventory_item_id", None):
        return None
    from app.models.inventory import InventoryItem
    return db.query(InventoryItem).filter(
        InventoryItem.id == log.inventory_item_id,
        InventoryItem.user_id == log.user_id,
    ).first()


def _give_back(db: Session, log: WasteLog) -> None:
    """Put the stock this waste took back on the shelf (delete)."""
    inv = _stock_item(db, log)
    if inv is not None and log.stock_deducted:
        inv.quantity = float(inv.quantity or 0) + float(log.stock_deducted)


def _take_again(db: Session, log: WasteLog) -> None:
    """Take it off the shelf again (restore after a delete)."""
    inv = _stock_item(db, log)
    if inv is not None and log.stock_deducted:
        before = float(inv.quantity or 0)
        inv.quantity = max(0.0, before - float(log.stock_deducted))
        log.stock_deducted = before - float(inv.quantity)


def _get_or_create_waste_category(db: Session, user_id) -> ExpenseCategory:
    """Get or create a 'Waste' expense category for the user."""
    cat = db.query(ExpenseCategory).filter(
        ExpenseCategory.user_id == user_id,
        # Existing accounts have "Waste"; new ones get the Danish "Svind".
        func.lower(ExpenseCategory.name).in_(("waste", "svind")),
    ).first()
    if not cat:
        cat = ExpenseCategory(user_id=user_id, name="Svind")
        db.add(cat)
        db.commit()
        db.refresh(cat)
    return cat


def _sync_expense_for_waste(db: Session, log: WasteLog):
    """Create or update an expense entry synced to a waste log."""
    if float(log.estimated_cost) <= 0:
        return
    ref_id = f"waste_{log.id}"
    existing = db.query(Expense).filter(Expense.reference_id == ref_id).first()
    if existing:
        existing.amount = float(log.estimated_cost)
        existing.date = log.date
        existing.description = f"Svind: {log.item_name} ({_REASON_DA.get(log.reason, log.reason)})"
        return
    cat = _get_or_create_waste_category(db, log.user_id)
    expense = Expense(
        id=uuid.uuid4(),
        user_id=log.user_id,
        category_id=cat.id,
        date=log.date,
        amount=float(log.estimated_cost),
        description=f"Svind: {log.item_name} ({_REASON_DA.get(log.reason, log.reason)})",
        # Not a card payment — a loss of goods already bought.
        payment_method="other",
        reference_id=ref_id,
    )
    db.add(expense)


def _delete_expense_for_waste(db: Session, log_id, user_id):
    """Delete expense entry linked to a waste log."""
    db.query(Expense).filter(
        Expense.reference_id == f"waste_{log_id}",
        Expense.user_id == user_id,
    ).delete()

router = APIRouter()


@router.get("", response_model=list[WasteLogResponse])
def list_waste(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(WasteLog).filter(WasteLog.user_id == user.id).filter(WasteLog.is_deleted.isnot(True))
    if from_date:
        query = query.filter(WasteLog.date >= from_date)
    if to_date:
        query = query.filter(WasteLog.date <= to_date)
    return query.order_by(WasteLog.date.desc(), WasteLog.created_at.desc()).all()


@router.get("/recently-deleted", response_model=list[WasteLogResponse])
def list_deleted_waste(
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    return db.query(WasteLog).filter(WasteLog.user_id == user.id, WasteLog.is_deleted == True).order_by(WasteLog.deleted_at.desc()).all()


@router.put("/{log_id}/restore", response_model=WasteLogResponse)
def restore_waste(
    log_id: uuid.UUID,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    log = db.query(WasteLog).filter(WasteLog.id == log_id, WasteLog.user_id == user.id, WasteLog.is_deleted == True).first()
    if not log:
        raise HTTPException(status_code=404, detail="Deleted waste log not found")
    log.is_deleted = False
    log.deleted_at = None
    _take_again(db, log)
    # Re-sync expense on restore
    _sync_expense_for_waste(db, log)
    db.commit()
    db.refresh(log)
    return log


@router.delete("/{log_id}/permanent", status_code=204)
def permanent_delete_waste(
    log_id: uuid.UUID,
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    log = db.query(WasteLog).filter(WasteLog.id == log_id, WasteLog.user_id == user.id, WasteLog.is_deleted == True).first()
    if not log:
        raise HTTPException(status_code=404, detail="Deleted waste log not found")
    _delete_expense_for_waste(db, log.id, user.id)
    db.delete(log)
    db.commit()


@router.post("", response_model=WasteLogResponse, status_code=201)
def create_waste(
    data: WasteLogCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    log = WasteLog(
        user_id=user.id,
        # business_today_local, not date.today(). The DK business day rolls at
        # 06:00 Europe/Copenhagen, and revenue for the same service is already
        # dated that way. A venue closing at 01:00 and binning the milk while
        # cashing up booked the takings to Thursday and the milk to Friday — so
        # Thursday showed revenue with no waste against it and Friday carried a
        # cost from a service it never had. The landing page promises the exact
        # opposite: "the milk that goes out on Thursday shows up in Thursday's
        # numbers".
        date=data.date or business_today_local(user),
        item_name=data.item_name,
        quantity=data.quantity,
        unit=data.unit,
        estimated_cost=data.estimated_cost,
        reason=data.reason,
    )
    db.add(log)
    if data.inventory_item_id:
        try:
            from app.models.inventory import InventoryItem
            inv = db.query(InventoryItem).filter(
                InventoryItem.id == data.inventory_item_id,
                InventoryItem.user_id == user.id,
            ).first()
        except Exception:  # noqa: BLE001 — a bad id never blocks the waste log
            inv = None
        # Only in the item's own unit: "1 portion" of a kg item took 1 kg.
        same_unit = inv is not None and (
            not (data.unit or "").strip()
            or (data.unit or "").strip().lower() == (inv.unit or "").strip().lower()
        )
        if inv is not None and same_unit:
            before = float(inv.quantity or 0)
            inv.quantity = max(0.0, before - float(data.quantity or 0))
            # What actually came off — never more than was on the shelf — so
            # a delete gives back exactly that.
            log.inventory_item_id = inv.id
            log.stock_deducted = before - float(inv.quantity)
    db.commit()
    db.refresh(log)
    # Sync to expenses
    _sync_expense_for_waste(db, log)
    db.commit()
    return log


@router.put("/{log_id}", response_model=WasteLogResponse)
def update_waste(
    log_id: str,
    data: WasteLogUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    log = db.query(WasteLog).filter(WasteLog.id == log_id, WasteLog.user_id == user.id).first()
    if not log:
        raise HTTPException(status_code=404, detail="Waste log not found")
    old_qty = float(log.quantity or 0)
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(log, field, value)
    # A corrected quantity moves the stock by the difference.
    if log.stock_deducted is not None and not log.is_deleted and float(log.quantity or 0) != old_qty:
        inv = _stock_item(db, log)
        if inv is not None:
            _give_back(db, log)
            before = float(inv.quantity or 0)
            inv.quantity = max(0.0, before - float(log.quantity or 0))
            log.stock_deducted = before - float(inv.quantity)
    # Update synced expense
    _sync_expense_for_waste(db, log)
    db.commit()
    db.refresh(log)
    return log


@router.delete("/{log_id}", status_code=204)
def delete_waste(
    log_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    log = db.query(WasteLog).filter(WasteLog.id == log_id, WasteLog.user_id == user.id).first()
    if not log:
        raise HTTPException(status_code=404, detail="Waste log not found")
    if log.is_deleted:
        return  # already in the papirkurv — its stock went back then
    log.is_deleted = True
    log.deleted_at = utc_now()
    # The stock goes back on the shelf with it.
    _give_back(db, log)
    # Remove synced expense
    _delete_expense_for_waste(db, log.id, user.id)
    db.commit()


@router.get("/summary", response_model=WasteSummary)
def waste_summary(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    month_start = date.today().replace(day=1)

    total_cost = float(
        db.query(func.coalesce(func.sum(WasteLog.estimated_cost), 0))
        .filter(WasteLog.user_id == user.id, WasteLog.date >= month_start)
        .filter(WasteLog.is_deleted.isnot(True))
        .scalar()
    )
    total_items = (
        db.query(func.count(WasteLog.id))
        .filter(WasteLog.user_id == user.id, WasteLog.date >= month_start)
        .filter(WasteLog.is_deleted.isnot(True))
        .scalar()
    )
    by_reason_rows = (
        db.query(WasteLog.reason, func.sum(WasteLog.estimated_cost).label("total"))
        .filter(WasteLog.user_id == user.id, WasteLog.date >= month_start)
        .filter(WasteLog.is_deleted.isnot(True))
        .group_by(WasteLog.reason)
        .all()
    )
    by_reason = {r: float(t) for r, t in by_reason_rows}

    return WasteSummary(total_cost=total_cost, total_items=total_items, by_reason=by_reason)
