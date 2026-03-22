import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.waste import WasteLog
from app.schemas.waste import WasteLogCreate, WasteLogUpdate, WasteLogResponse, WasteSummary
from app.services.auth import get_current_user

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
    return query.order_by(WasteLog.date.desc(), WasteLog.id.desc()).all()


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
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(log, field, value)
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
    log.is_deleted = True
    log.deleted_at = datetime.utcnow()
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
