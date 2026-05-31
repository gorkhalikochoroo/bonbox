"""Pydantic schemas for Daily Close (Kasserapport)."""

import uuid
import datetime
from pydantic import BaseModel, Field


class DailyCloseCreate(BaseModel):
    date: datetime.date
    branch_id: uuid.UUID | None = None
    status: str = "confirmed"               # "draft" (auto-save) | "confirmed" (final submit)
    revenue_breakdown: dict | None = None   # {"food": 12400, "drinks": 5800, ...}
    payment_breakdown: dict | None = None   # {"cash": 4200, "card": 13500, ...}
    # Override for the breakdown-sum. Set when the OCR detected only the
    # bottom-line total but couldn't split into food/drinks/takeaway.
    # The router uses this when revenue_breakdown is empty so the close
    # still saves the real revenue (instead of the previous 0 DKK bug).
    revenue_total_override: float | None = Field(None, ge=0, le=1_000_000_000)
    moms_total: float | None = None         # VAT amount — auto-calculated or from receipt
    moms_mode: str | None = None            # "auto" | "manual"
    # Per-close override for the user's prices_include_moms preference.
    # Set when the OCR scan UI offered a "with MOMS / without MOMS" toggle
    # and the owner picked one. Lets B2C (gross input) and B2B (net
    # input) modes coexist on the same account day-by-day.
    prices_include_moms_override: bool | None = None
    tips_total: float | None = None
    tips_staff_count: int | None = None
    cash_counted: float | None = None
    notes: str | None = None
    closed_by: str | None = None
    # Z-report photo URL — set when the owner used "Snap report" in the
    # close flow. Backend persists it on DailyClose.receipt_photo so
    # the photo can be re-viewed later. 2000-char cap is well above
    # signed-URL length (~700) but keeps payload bombs out.
    receipt_photo: str | None = Field(None, max_length=2000)
    # Detective control acknowledgement. Default False → the router runs
    # the close_sanity anomaly check before committing a *confirmed* close
    # and, if today's total is far off the recent same-weekday baseline,
    # returns {requires_confirmation: true} WITHOUT saving so the frontend
    # can show a soft "double-check" dialog. The owner either fixes the
    # numbers or re-submits with this set True to skip the guard and lock.
    acknowledge_anomaly: bool = False


class DailyCloseUnlock(BaseModel):
    reason: str                             # required — "Accountant found error", etc.


class DailyCloseResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    branch_id: uuid.UUID | None = None
    revenue_breakdown: dict | None = None
    revenue_total: float
    payment_breakdown: dict | None = None
    payment_total: float
    moms_total: float | None = None
    revenue_ex_moms: float | None = None
    moms_mode: str | None = None
    cash_expected: float | None = None
    cash_counted: float | None = None
    cash_difference: float | None = None
    tips_total: float | None = None
    tips_staff_count: int | None = None
    tips_per_person: float | None = None
    status: str = "confirmed"
    notes: str | None = None
    closed_by: str | None = None
    closed_at: datetime.datetime | None = None
    unlock_reason: str | None = None
    unlocked_by: str | None = None
    unlocked_at: datetime.datetime | None = None
    is_deleted: bool = False
    created_at: datetime.datetime | None = None
    receipt_photo: str | None = None

    model_config = {"from_attributes": True}
