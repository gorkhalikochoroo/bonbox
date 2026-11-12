"""
Request bodies for Egenkontrol (owner router + kitchen router share EntryIn).

NO `from __future__ import annotations` here: both routers that import these
models carry slowapi @limiter decorators, and string annotations there make
FastAPI read the body as a query parameter — a silent 422 on every save
(memory: future-annotations + slowapi).

EntryIn IGNORES unknown fields (pydantic's default "ignore"): in_limit, late,
recorded_at, slot_due_at, deviation_state, staff_name or via sent by a client
never reach the row. The server decides all of them.
"""

import uuid
from datetime import date
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class EntryIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    client_id: str = Field(min_length=1, max_length=36)
    check_id: uuid.UUID
    # Validated by egenkontrol_rules.validate_value (−40..120, one decimal), so
    # the client gets "value_out_of_range" / "too_many_decimals" codes.
    value_c: Any = None
    product_type: Optional[str] = Field(default=None, max_length=12)
    product_note: Optional[str] = Field(default=None, max_length=80)
    label_ok: Optional[bool] = None
    action_code: Optional[str] = Field(default=None, max_length=32)
    action_other: Optional[str] = Field(default=None, max_length=80)
    fate_code: Optional[str] = Field(default=None, max_length=32)
    fate_other: Optional[str] = Field(default=None, max_length=80)
    action_note: Optional[str] = Field(default=None, max_length=280)
    staff_id: Optional[uuid.UUID] = None
    # 40 is enforced by the rules (code "name_invalid"); this only bounds the body.
    typed_name: Optional[str] = Field(default=None, max_length=200)
    # Device clock, untrusted, display only. Unparseable → stored NULL.
    client_typed_at: Any = None
    # R1b ticks (cleaning, thermometer): must be true; value_c must be null.
    done: Optional[bool] = None
    # R1b offline queue: the business day the reading was TYPED on (from the
    # today payload). A queued reading replayed on a later business day is
    # refused 409 business_day_changed — it never lands on the wrong day.
    # Absent (old clients) → no check.
    client_business_date: Optional[date] = None


class PaperEntryIn(EntryIn):
    """R1b "Fra papir" (owner only): every EntryIn field + when it was
    measured (venue-local calendar date and "HH:MM") + why it comes from
    paper (≤ 120, verbatim; 400 here only bounds the body)."""
    measured_date: date
    measured_time: str = Field(max_length=16)
    paper_reason: str = Field(max_length=400)


class CorrectionIn(BaseModel):
    """R1b correction of a saved reading (owner only). The rules decide the
    rest (egenkontrol_records.correct_entry)."""
    model_config = ConfigDict(extra="ignore")

    client_id: str = Field(min_length=1, max_length=36)
    entry_id: uuid.UUID
    reason_code: str = Field(max_length=16)
    # ≤ 120 by the rules ("reason_too_long", never truncated); bounds the body.
    reason_text: Optional[str] = Field(default=None, max_length=400)
    value_c: Any = None
    done: Optional[bool] = None
    check_id: Optional[uuid.UUID] = None
    product_type: Optional[str] = Field(default=None, max_length=12)
    action_code: Optional[str] = Field(default=None, max_length=32)
    action_other: Optional[str] = Field(default=None, max_length=80)
    fate_code: Optional[str] = Field(default=None, max_length=32)
    fate_other: Optional[str] = Field(default=None, max_length=80)
    action_note: Optional[str] = Field(default=None, max_length=280)


class SettingsIn(BaseModel):
    """PARTIAL: only the fields sent change. findsmiley_url's real rule is
    egenkontrol_rules.validate_findsmiley_url (400 only bounds the body)."""
    model_config = ConfigDict(extra="ignore")

    findsmiley_url: Optional[str] = Field(default=None, max_length=400)
    opted_in: Optional[bool] = None


class ReviewIn(BaseModel):
    """The weekly review: an optional typed name (≤ 80) and note (≤ 280),
    verbatim; the limits are the rules' codes, these only bound the body."""
    model_config = ConfigDict(extra="ignore")

    name: Optional[str] = Field(default=None, max_length=400)
    note: Optional[str] = Field(default=None, max_length=1000)


class ProductLimitsIn(BaseModel):
    chilled: Optional[float] = None
    fish: Optional[float] = None
    frozen: Optional[float] = None


class SetupItemIn(BaseModel):
    template_key: str = Field(max_length=16)
    name: str = Field(min_length=1, max_length=60)
    note: Optional[str] = Field(default=None, max_length=80)
    limit_c: Optional[float] = None
    product_limits: Optional[ProductLimitsIn] = None
    schedule: Optional[dict] = None


class SetupIn(BaseModel):
    items: list[SetupItemIn] = Field(min_length=1, max_length=20)
    branch_id: Optional[uuid.UUID] = None


class CheckIn(BaseModel):
    template_key: str = Field(max_length=16)
    name: str = Field(min_length=1, max_length=60)
    note: Optional[str] = Field(default=None, max_length=80)
    limit_c: Optional[float] = None
    product_limits: Optional[ProductLimitsIn] = None
    schedule: Optional[dict] = None
    recheck_min: Optional[int] = Field(default=None, ge=5, le=240)
    branch_id: Optional[uuid.UUID] = None


class CheckPatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=60)
    note: Optional[str] = Field(default=None, max_length=80)
    limit_c: Optional[float] = None
    product_limits: Optional[ProductLimitsIn] = None
    schedule: Optional[dict] = None
    recheck_min: Optional[int] = Field(default=None, ge=5, le=240)
    active: Optional[bool] = None
    sort_order: Optional[int] = Field(default=None, ge=0, le=10000)


class DeviceIn(BaseModel):
    label: Optional[str] = Field(default=None, max_length=80)
    branch_id: Optional[uuid.UUID] = None


ScheduleType = Literal["daily", "weekly", "on_event"]
