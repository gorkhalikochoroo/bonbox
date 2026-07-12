import re
import uuid
import datetime
from pydantic import BaseModel, Field, field_validator, model_validator

# Strict "HH:MM" — hours 00-23, minutes 00-59. Single-digit hour tolerated
# ("9:05") to match _parse_hhmm; anything else (e.g. "", "25:00", "16:60") is
# rejected at the schema layer as a clean 422 rather than crashing _parse_hhmm
# with an unhandled ValueError → 500 deep in the endpoint.
_HHMM_RE = re.compile(r"^([01]?\d|2[0-3]):[0-5]\d$")


# ── Staff Members ──────────────────────────────────────────────────────────


_TAX_CARD_TYPES = {"hovedkort", "bikort", "frikort"}


def _validate_tax_card_type(v: str | None) -> str | None:
    """Multi-barrier validator: accept None, normalize case, reject unknown values."""
    if v is None or v == "":
        return None
    v = str(v).strip().lower()
    if v not in _TAX_CARD_TYPES:
        return None  # silently ignore unknown — defaults to hovedkort downstream
    return v


def _validate_tax_card_rate(v: float | None) -> float | None:
    """Clamp to 0.0–0.6 (max realistic Danish A-skat including topskat ~52%).
    Returns None for unparseable / out-of-range input."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f < 0.0 or f > 0.6:
        return None
    return f


def _clean_address_field(v: str | None, max_len: int) -> str | None:
    """Trim + length-cap a free-text address field. Empty → None so a blank
    field truthfully clears the value rather than storing "". Tolerant by
    design: an address is contact info, never a gate — we never reject it."""
    if v is None:
        return None
    v = str(v).strip()
    if not v:
        return None
    return v[:max_len]


class StaffMemberCreate(BaseModel):
    name: str
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    postal_code: str | None = None
    city: str | None = None
    role: str = "server"
    contract_type: str = "full"
    base_rate: float | None = None
    evening_rate: float | None = None
    weekend_rate: float | None = None
    holiday_rate: float | None = None
    max_hours_month: float | None = None
    max_hours_week: float | None = None
    tax_card_type: str | None = None
    tax_card_rate: float | None = None


class StaffMemberUpdate(BaseModel):
    name: str | None = None
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    postal_code: str | None = None
    city: str | None = None
    role: str | None = None
    contract_type: str | None = None
    base_rate: float | None = None
    evening_rate: float | None = None
    weekend_rate: float | None = None
    holiday_rate: float | None = None
    max_hours_month: float | None = None
    max_hours_week: float | None = None
    tax_card_type: str | None = None
    tax_card_rate: float | None = None
    active: bool | None = None


class StaffMemberResponse(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None = None
    email: str | None = None
    address: str | None = None
    postal_code: str | None = None
    city: str | None = None
    address_updated_at: datetime.datetime | None = None
    role: str
    contract_type: str
    base_rate: float | None = None
    evening_rate: float | None = None
    weekend_rate: float | None = None
    holiday_rate: float | None = None
    max_hours_month: float | None = None
    max_hours_week: float | None = None
    tax_card_type: str | None = None
    tax_card_rate: float | None = None
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

    @field_validator("start_time", "end_time")
    @classmethod
    def _valid_hhmm(cls, v: str) -> str:
        v = (v or "").strip()
        if not _HHMM_RE.match(v):
            raise ValueError("must be in HH:MM format (00:00–23:59)")
        return v

    @model_validator(mode="after")
    def _start_not_equal_end(self):
        # A shift can cross midnight (end < start, e.g. 22:00–02:00), but start
        # and end identical is a zero-length shift — a fat-finger, never intended.
        # Reject it clearly here instead of storing a 0-hour row that would also
        # confuse the overlap guard and the cost ledger.
        if self.start_time == self.end_time:
            raise ValueError("start_time and end_time can't be the same")
        return self


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
    # Staff-side "Jeg har set det" acknowledgement — surfaced as the owner-grid
    # confirmation badge. None = published-but-unconfirmed.
    confirmed_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


# ── Open shifts (Åbne vagter) ──────────────────────────────────────────────


class OpenShiftCreate(BaseModel):
    """Owner posts an unassigned roster slot. No staff_id — that's the point."""
    date: datetime.date
    start_time: str
    end_time: str
    break_minutes: int = 0
    role_on_shift: str | None = None
    notes: str | None = None

    @field_validator("start_time", "end_time")
    @classmethod
    def _valid_hhmm(cls, v: str) -> str:
        v = (v or "").strip()
        if not _HHMM_RE.match(v):
            raise ValueError("must be in HH:MM format (00:00–23:59)")
        return v

    @model_validator(mode="after")
    def _start_not_equal_end(self):
        if self.start_time == self.end_time:
            raise ValueError("start_time and end_time can't be the same")
        return self


class OpenShiftResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    start_time: str
    end_time: str
    break_minutes: int = 0
    role_on_shift: str | None = None
    notes: str | None = None
    status: str
    claimed_by_staff_id: uuid.UUID | None = None
    # Resolved name of the claimer (owner-side display only) — never the staff's
    # contact details. None while the slot is still open.
    claimed_by_name: str | None = None
    claimed_at: datetime.datetime | None = None
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
