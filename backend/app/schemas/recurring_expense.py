"""
Pydantic schemas for recurring expense rules (Task #47).

Validation guardrails (multi-layer defense):
  • amount > 0 — no zero / negative recurring expenses
  • day_of_month bounded 1..28 — capping at 28 means Feb works without
    any "31 → last-day-of-month" fallback logic, AND it gracefully
    handles users typing 31 by clamping rather than rejecting.
  • payment_method whitelist — same set the Expense table accepts
  • name >= 2 chars — prevents "  " / single-char rules
  • frequency must be "monthly" for v1 (extensible later)

Why these guardrails repeat the model constraints: defense in depth.
A malicious request that bypasses the schema (impossible via FastAPI
but defensive) still hits the model column types + DB CHECK
constraints. A buggy frontend that sends amount=0 fails here cleanly
with 422 instead of writing a useless row.
"""
from __future__ import annotations

import datetime
import uuid
from typing import Optional

from pydantic import BaseModel, Field, field_validator


_ALLOWED_PAYMENT_METHODS = {"cash", "card", "mobilepay", "bank_transfer"}
_ALLOWED_FREQUENCIES = {"monthly"}  # v1; extend with weekly/yearly later


def _normalize_payment_method(v: str | None) -> str | None:
    """Mirror ExpenseCreate.normalize_payment_method — "kontant" → "cash"."""
    if v is None:
        return None
    if isinstance(v, str) and v.lower() == "kontant":
        return "cash"
    return v


def _validate_payment_method_in_whitelist(v: str | None) -> str | None:
    if v is None:
        return v
    if v not in _ALLOWED_PAYMENT_METHODS:
        raise ValueError(
            f"payment_method must be one of {sorted(_ALLOWED_PAYMENT_METHODS)}; got {v!r}"
        )
    return v


class RecurringExpenseCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    description: Optional[str] = Field(None, max_length=200)
    amount: float
    payment_method: str = "card"
    day_of_month: int = 1
    frequency: str = "monthly"
    category_id: Optional[uuid.UUID] = None
    branch_id: Optional[uuid.UUID] = None
    is_personal: bool = False
    notes: Optional[str] = None
    # Optional explicit first run — defaults to next occurrence of
    # day_of_month in router. Owner might want to override to "post the
    # first one today" for retro-active setup.
    next_run_date: Optional[datetime.date] = None

    @field_validator("amount")
    @classmethod
    def amount_must_be_positive(cls, v: float) -> float:
        if v is None or float(v) <= 0:
            raise ValueError("amount must be > 0")
        return float(v)

    @field_validator("day_of_month")
    @classmethod
    def cap_day_of_month(cls, v: int) -> int:
        # Cap at 28 so Feb always has the day. Owners typing 31 see their
        # input silently clamped — better UX than a hard rejection on a
        # value they probably entered without thinking about Feb.
        if v is None:
            return 1
        if v < 1:
            return 1
        if v > 28:
            return 28
        return int(v)

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_pm(cls, v):
        return _normalize_payment_method(v)

    @field_validator("payment_method")
    @classmethod
    def whitelist_pm(cls, v: str) -> str:
        return _validate_payment_method_in_whitelist(v)

    @field_validator("frequency")
    @classmethod
    def whitelist_frequency(cls, v: str) -> str:
        if v not in _ALLOWED_FREQUENCIES:
            raise ValueError(
                f"frequency must be one of {sorted(_ALLOWED_FREQUENCIES)}; got {v!r}"
            )
        return v

    @field_validator("name")
    @classmethod
    def name_must_have_content(cls, v: str) -> str:
        v2 = (v or "").strip()
        if len(v2) < 2:
            raise ValueError("name must be at least 2 non-whitespace characters")
        return v2


class RecurringExpenseUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=2, max_length=100)
    description: Optional[str] = Field(None, max_length=200)
    amount: Optional[float] = None
    payment_method: Optional[str] = None
    day_of_month: Optional[int] = None
    frequency: Optional[str] = None
    category_id: Optional[uuid.UUID] = None
    branch_id: Optional[uuid.UUID] = None
    is_personal: Optional[bool] = None
    is_active: Optional[bool] = None
    notes: Optional[str] = None
    next_run_date: Optional[datetime.date] = None

    @field_validator("amount")
    @classmethod
    def amount_must_be_positive(cls, v: float | None) -> float | None:
        if v is None:
            return v
        if float(v) <= 0:
            raise ValueError("amount must be > 0")
        return float(v)

    @field_validator("day_of_month")
    @classmethod
    def cap_day_of_month(cls, v: int | None) -> int | None:
        if v is None:
            return v
        if v < 1:
            return 1
        if v > 28:
            return 28
        return int(v)

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_pm(cls, v):
        return _normalize_payment_method(v)

    @field_validator("payment_method")
    @classmethod
    def whitelist_pm(cls, v: str | None) -> str | None:
        return _validate_payment_method_in_whitelist(v)

    @field_validator("frequency")
    @classmethod
    def whitelist_frequency(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if v not in _ALLOWED_FREQUENCIES:
            raise ValueError(
                f"frequency must be one of {sorted(_ALLOWED_FREQUENCIES)}; got {v!r}"
            )
        return v

    @field_validator("name")
    @classmethod
    def name_must_have_content(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v2 = v.strip()
        if len(v2) < 2:
            raise ValueError("name must be at least 2 non-whitespace characters")
        return v2


class RecurringExpenseResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    branch_id: Optional[uuid.UUID] = None
    category_id: Optional[uuid.UUID] = None
    name: str
    description: Optional[str] = None
    amount: float
    payment_method: str
    frequency: str
    day_of_month: int
    next_run_date: datetime.date
    last_run_date: Optional[datetime.date] = None
    is_active: bool
    is_personal: bool
    notes: Optional[str] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime
    # Computed convenience for the UI — "Next: 1 June 2026" or "Paused".
    # Built in the router so the schema stays pure (no business logic).
    next_run_human: str = ""

    model_config = {"from_attributes": True}
