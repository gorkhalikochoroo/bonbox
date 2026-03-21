from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
from pydantic import BaseModel

from app.database import get_db
from app.models.user import User
from app.models.event_log import EventLog
from app.services.auth import get_current_user

router = APIRouter()


class EventCreate(BaseModel):
    event: str
    page: str | None = None
    detail: str | None = None


class EventBatch(BaseModel):
    events: list[EventCreate]


@router.post("", status_code=201)
def log_event(
    data: EventCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    log = EventLog(user_id=user.id, event=data.event, page=data.page, detail=data.detail)
    db.add(log)
    db.commit()
    return {"ok": True}


@router.post("/batch", status_code=201)
def log_events_batch(
    data: EventBatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    for e in data.events:
        db.add(EventLog(user_id=user.id, event=e.event, page=e.page, detail=e.detail))
    db.commit()
    return {"ok": True, "count": len(data.events)}


@router.get("/summary")
def event_summary(
    from_date: date = Query(None, alias="from"),
    to_date: date = Query(None, alias="to"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get event counts grouped by event type — for thesis analysis."""
    query = db.query(
        EventLog.event,
        func.count(EventLog.id).label("count")
    ).filter(EventLog.user_id == user.id)

    if from_date:
        query = query.filter(EventLog.created_at >= from_date)
    if to_date:
        query = query.filter(EventLog.created_at <= to_date)

    rows = query.group_by(EventLog.event).order_by(func.count(EventLog.id).desc()).all()
    return [{"event": e, "count": c} for e, c in rows]


@router.get("/page-views")
def page_view_summary(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get page view counts — which features are most used."""
    rows = (
        db.query(EventLog.page, func.count(EventLog.id).label("count"))
        .filter(EventLog.user_id == user.id, EventLog.event == "page_view")
        .group_by(EventLog.page)
        .order_by(func.count(EventLog.id).desc())
        .all()
    )
    return [{"page": p, "count": c} for p, c in rows]
