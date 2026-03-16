from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.waste import WasteLog
from app.schemas.waste import WasteLogCreate, WasteLogResponse, WasteSummary
from app.services.auth import get_current_user

router = APIRouter()


@router.get("", response_model=list[WasteLogResponse])
def list_waste(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    query = db.query(WasteLog).filter(WasteLog.user_id == user.id)
    if from_date:
        query = query.filter(WasteLog.date >= from_date)
    if to_date:
        query = query.filter(WasteLog.date <= to_date)
    return query.order_by(WasteLog.date.desc()).all()


@router.post("", response_model=WasteLogResponse, status_code=201)
def create_waste(
    data: WasteLogCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    log = WasteLog(
        user_id=user.id,
        date=data.date or date.today(),
        item_name=data.item_name,
        quantity=data.quantity,
        unit=data.unit,
        estimated_cost=data.estimated_cost,
        reason=data.reason,
    )
    db.add(log)
    db.commit()
    db.refresh(log)
    return log


@router.get("/summary", response_model=WasteSummary)
def waste_summary(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    month_start = date.today().replace(day=1)

    total_cost = float(
        db.query(func.coalesce(func.sum(WasteLog.estimated_cost), 0))
        .filter(WasteLog.user_id == user.id, WasteLog.date >= month_start)
        .scalar()
    )
    total_items = (
        db.query(func.count(WasteLog.id))
        .filter(WasteLog.user_id == user.id, WasteLog.date >= month_start)
        .scalar()
    )
    by_reason_rows = (
        db.query(WasteLog.reason, func.sum(WasteLog.estimated_cost).label("total"))
        .filter(WasteLog.user_id == user.id, WasteLog.date >= month_start)
        .group_by(WasteLog.reason)
        .all()
    )
    by_reason = {r: float(t) for r, t in by_reason_rows}

    return WasteSummary(total_cost=total_cost, total_items=total_items, by_reason=by_reason)
