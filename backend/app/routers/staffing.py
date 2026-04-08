import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.staffing import StaffingRule, DailyStaffing
from app.schemas.staffing import (
    StaffingRuleCreate, StaffingRuleResponse, StaffingForecast,
)
from app.services.auth import get_current_user
from app.services.prediction import get_staffing_recommendations, get_sales_patterns
from app.services.staffing_intelligence import get_staff_insights

router = APIRouter()


class DailyStaffingLog(BaseModel):
    date: date
    staff_count: int
    total_hours: float | None = None
    labor_cost: float | None = None
    notes: str | None = None


@router.get("/forecast", response_model=StaffingForecast)
def get_forecast(
    days: int = Query(14, ge=1, le=30),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = get_staffing_recommendations(db, str(user.id), days)
    return StaffingForecast(
        recommendations=result["recommendations"],
        patterns=result["patterns"],
    )


@router.get("/rules", response_model=list[StaffingRuleResponse])
def list_rules(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return db.query(StaffingRule).filter(StaffingRule.user_id == user.id).order_by(StaffingRule.revenue_min).all()


@router.post("/rules", response_model=StaffingRuleResponse, status_code=201)
def create_rule(
    data: StaffingRuleCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rule = StaffingRule(user_id=user.id, **data.model_dump())
    db.add(rule)
    db.commit()
    db.refresh(rule)
    return rule


@router.delete("/rules/{rule_id}", status_code=204)
def delete_rule(
    rule_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rule = db.query(StaffingRule).filter(
        StaffingRule.id == rule_id,
        StaffingRule.user_id == user.id,
    ).first()
    if rule:
        db.delete(rule)
        db.commit()


# ─── STAFF LOGGING & INTELLIGENCE ───────────────────────────────

@router.post("/log")
def log_daily_staff(
    data: DailyStaffingLog,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Log or update daily staff count for a given date."""
    existing = db.query(DailyStaffing).filter(
        DailyStaffing.user_id == user.id,
        DailyStaffing.date == data.date,
    ).first()

    if existing:
        existing.staff_count = data.staff_count
        existing.total_hours = data.total_hours
        existing.labor_cost = data.labor_cost
        existing.notes = data.notes
    else:
        existing = DailyStaffing(
            id=uuid.uuid4(),
            user_id=user.id,
            date=data.date,
            staff_count=data.staff_count,
            total_hours=data.total_hours,
            labor_cost=data.labor_cost,
            notes=data.notes,
        )
        db.add(existing)

    db.commit()
    return {"status": "ok", "date": str(data.date), "staff_count": data.staff_count}


@router.get("/logs")
def list_staff_logs(
    days: int = Query(30, ge=1, le=90),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get recent staff logs."""
    from datetime import timedelta
    cutoff = date.today() - timedelta(days=days)
    logs = (
        db.query(DailyStaffing)
        .filter(DailyStaffing.user_id == user.id, DailyStaffing.date >= cutoff)
        .order_by(DailyStaffing.date.desc())
        .all()
    )
    return [
        {
            "id": str(log.id),
            "date": str(log.date),
            "staff_count": log.staff_count,
            "total_hours": float(log.total_hours) if log.total_hours else None,
            "labor_cost": float(log.labor_cost) if log.labor_cost else None,
            "notes": log.notes,
        }
        for log in logs
    ]


@router.get("/insights")
def staffing_insights(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get staff-revenue intelligence analysis."""
    return get_staff_insights(str(user.id), db)
