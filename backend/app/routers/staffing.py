from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.staffing import StaffingRule
from app.schemas.staffing import (
    StaffingRuleCreate, StaffingRuleResponse, StaffingForecast,
)
from app.services.auth import get_current_user
from app.services.prediction import get_staffing_recommendations, get_sales_patterns

router = APIRouter()


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
