"""Pydantic schemas for Daily Close (Kasserapport)."""

import uuid
import datetime
from pydantic import BaseModel


class DailyCloseCreate(BaseModel):
    date: datetime.date
    branch_id: uuid.UUID | None = None
    revenue_breakdown: dict | None = None   # {"food": 12400, "drinks": 5800, ...}
    payment_breakdown: dict | None = None   # {"cash": 4200, "card": 13500, ...}
    tips_total: float | None = None
    tips_staff_count: int | None = None
    cash_counted: float | None = None
    notes: str | None = None
    closed_by: str | None = None


class DailyCloseResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    branch_id: uuid.UUID | None = None
    revenue_breakdown: dict | None = None
    revenue_total: float
    payment_breakdown: dict | None = None
    payment_total: float
    cash_expected: float | None = None
    cash_counted: float | None = None
    cash_difference: float | None = None
    tips_total: float | None = None
    tips_staff_count: int | None = None
    tips_per_person: float | None = None
    notes: str | None = None
    closed_by: str | None = None
    closed_at: datetime.datetime | None = None
    is_deleted: bool = False
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
