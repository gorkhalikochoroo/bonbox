import uuid
import datetime
from pydantic import BaseModel


# ── Staff Members ──────────────────────────────────────────────────────────


class StaffMemberCreate(BaseModel):
    name: str
    phone: str | None = None
    email: str | None = None
    role: str = "server"
    contract_type: str = "full"
    base_rate: float | None = None
    evening_rate: float | None = None
    weekend_rate: float | None = None
    holiday_rate: float | None = None
    max_hours_month: float | None = None
    max_hours_week: float | None = None


class StaffMemberUpdate(BaseModel):
    name: str | None = None
    phone: str | None = None
    email: str | None = None
    role: str | None = None
    contract_type: str | None = None
    base_rate: float | None = None
    evening_rate: float | None = None
    weekend_rate: float | None = None
    holiday_rate: float | None = None
    max_hours_month: float | None = None
    max_hours_week: float | None = None
    active: bool | None = None


class StaffMemberResponse(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None = None
    email: str | None = None
    role: str
    contract_type: str
    base_rate: float | None = None
    evening_rate: float | None = None
    weekend_rate: float | None = None
    holiday_rate: float | None = None
    max_hours_month: float | None = None
    max_hours_week: float | None = None
    active: bool = True
    is_deleted: bool = False
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


# ── Pay Period Config ──────────────────────────────────────────────────────


class PayPeriodConfigCreate(BaseModel):
    period_type: str
    custom_start_day: int | None = None


class PayPeriodConfigResponse(BaseModel):
    id: uuid.UUID
    period_type: str
    custom_start_day: int | None = None
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


# ── Schedules ──────────────────────────────────────────────────────────────


class ScheduleCreate(BaseModel):
    staff_id: uuid.UUID
    date: datetime.date
    start_time: str
    end_time: str
    break_minutes: int = 0
    role_on_shift: str | None = None
    status: str = "draft"
    notes: str | None = None


class ScheduleResponse(BaseModel):
    id: uuid.UUID
    staff_id: uuid.UUID
    date: datetime.date
    start_time: str
    end_time: str
    break_minutes: int = 0
    role_on_shift: str | None = None
    status: str
    notes: str | None = None
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


# ── Hours Logged ───────────────────────────────────────────────────────────


class HoursLogCreate(BaseModel):
    staff_id: uuid.UUID
    date: datetime.date
    start_time: str | None = None
    end_time: str | None = None
    break_minutes: int = 0
    total_hours: float
    rate_applied: float | None = None
    earned: float | None = None
    entry_method: str = "quick"
    is_overtime: bool = False
    notes: str | None = None


class HoursLogResponse(BaseModel):
    id: uuid.UUID
    staff_id: uuid.UUID
    date: datetime.date
    start_time: str | None = None
    end_time: str | None = None
    break_minutes: int = 0
    total_hours: float
    rate_applied: float | None = None
    earned: float | None = None
    entry_method: str
    is_overtime: bool = False
    notes: str | None = None
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


# ── Tips ───────────────────────────────────────────────────────────────────


class StaffHoursForTip(BaseModel):
    """Helper used inside TipCreate to distribute tips."""
    staff_id: uuid.UUID
    hours: float


class TipCreate(BaseModel):
    date: datetime.date
    total_amount: float
    split_method: str = "by_hours"
    notes: str | None = None
    staff_hours: list[StaffHoursForTip] = []


class TipDistributionResponse(BaseModel):
    id: uuid.UUID
    tip_id: uuid.UUID
    staff_id: uuid.UUID
    share_pct: float | None = None
    amount: float

    model_config = {"from_attributes": True}


class TipResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    total_amount: float
    split_method: str
    confirmed: bool = False
    notes: str | None = None
    distributions: list[TipDistributionResponse] = []
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
