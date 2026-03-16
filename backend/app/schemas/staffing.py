import uuid
from pydantic import BaseModel


class StaffingRuleCreate(BaseModel):
    label: str
    revenue_min: float
    revenue_max: float
    recommended_staff: int


class StaffingRuleResponse(BaseModel):
    id: uuid.UUID
    label: str
    revenue_min: float
    revenue_max: float
    recommended_staff: int

    model_config = {"from_attributes": True}


class DayRecommendation(BaseModel):
    date: str
    day: str
    predicted_revenue: float
    confidence: str
    business_level: str
    recommended_staff: int


class SalesPatterns(BaseModel):
    day_of_week: dict[str, float]
    monthly: dict[int, float]
    overall_avg: float
    total_days_analyzed: int


class StaffingForecast(BaseModel):
    recommendations: list[DayRecommendation]
    patterns: SalesPatterns | None
