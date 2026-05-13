"""
Pydantic schemas for Customer + Invoice + Mileage endpoints.

Kept in one module because the three concerns share validators (CVR format,
moms rate, kr currency rounding) and the API layer treats them as one
feature set ("Invoicing").
"""
from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator, ConfigDict


# ─── Validators reused across schemas ────────────────────────────────

_CVR_RE = re.compile(r"^\d{8}$")
_ZIP_DK_RE = re.compile(r"^\d{4}$")


def _validate_cvr(v: Optional[str]) -> Optional[str]:
    """Danish CVR: exactly 8 digits, no spaces, no leading zeros stripped."""
    if v is None or v == "":
        return None
    v = v.strip().replace(" ", "")
    if not _CVR_RE.match(v):
        raise ValueError("CVR must be exactly 8 digits")
    return v


def _validate_moms_rate(v: Decimal) -> Decimal:
    """0.0, 0.25, or in rare cases other rates. Block negative/over 1.0."""
    if v < 0 or v > 1:
        raise ValueError("moms_rate must be between 0 and 1")
    return v


# ─── Customer (debitor) schemas ──────────────────────────────────────

class CustomerBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    cvr: Optional[str] = None
    is_company: bool = False
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(None, max_length=50)
    address: Optional[str] = None
    zipcode: Optional[str] = None
    city: Optional[str] = Field(None, max_length=100)
    country: str = Field(default="DK", min_length=2, max_length=2)
    dawa_address_id: Optional[str] = Field(None, max_length=36)
    payment_terms_days: int = Field(default=14, ge=0, le=180)
    default_lang: str = Field(default="da", min_length=2, max_length=2)
    # Public-sector EAN — 13 digits when present, optional otherwise.
    ean_nummer: Optional[str] = Field(None, max_length=13)
    is_public_sector: bool = False

    @field_validator("cvr")
    @classmethod
    def check_cvr(cls, v):
        return _validate_cvr(v)

    @field_validator("ean_nummer")
    @classmethod
    def check_ean(cls, v):
        if v is None or v == "":
            return None
        digits = "".join(c for c in v if c.isdigit())
        if len(digits) != 13:
            raise ValueError("EAN-nummer must be 13 digits")
        return digits


class CustomerCreate(CustomerBase):
    branch_id: Optional[UUID] = None


class CustomerUpdate(BaseModel):
    """Partial update — all fields optional."""
    name: Optional[str] = None
    cvr: Optional[str] = None
    is_company: Optional[bool] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    zipcode: Optional[str] = None
    city: Optional[str] = None
    country: Optional[str] = None
    dawa_address_id: Optional[str] = None
    payment_terms_days: Optional[int] = None
    default_lang: Optional[str] = None
    ean_nummer: Optional[str] = None
    is_public_sector: Optional[bool] = None

    @field_validator("cvr")
    @classmethod
    def check_cvr(cls, v):
        return _validate_cvr(v)

    @field_validator("ean_nummer")
    @classmethod
    def check_ean(cls, v):
        if v is None or v == "":
            return None
        digits = "".join(c for c in v if c.isdigit())
        if len(digits) != 13:
            raise ValueError("EAN-nummer must be 13 digits")
        return digits


class CustomerResponse(CustomerBase):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    branch_id: Optional[UUID]
    is_deleted: bool
    created_at: datetime
    updated_at: datetime


# ─── Invoice line schemas ────────────────────────────────────────────

class InvoiceLineInput(BaseModel):
    """A single line as the client sends it. Server computes totals."""
    description: str = Field(..., min_length=1)
    quantity: Decimal = Field(default=Decimal("1"), gt=0)
    unit: Optional[str] = Field(None, max_length=20)
    unit_price_net: Decimal = Field(..., ge=0)
    moms_rate: Decimal = Field(default=Decimal("0.250"))

    @field_validator("moms_rate")
    @classmethod
    def check_moms(cls, v):
        return _validate_moms_rate(v)


class InvoiceLineResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    line_order: int
    description: str
    quantity: Decimal
    unit: Optional[str]
    unit_price_net: Decimal
    moms_rate: Decimal
    line_net: Decimal
    line_moms: Decimal
    line_gross: Decimal


# ─── Invoice schemas ─────────────────────────────────────────────────

class InvoiceCreate(BaseModel):
    customer_id: UUID
    branch_id: Optional[UUID] = None
    issue_date: Optional[date] = None  # defaults to today server-side
    due_days: Optional[int] = None  # if None, uses customer.payment_terms_days
    # Optional separate leveringsdato — only required on the PDF when it
    # differs from issue_date (Momsbekendtgørelsen §57). Leave null for
    # same-day work; set it for events invoiced after delivery.
    delivery_date: Optional[date] = None
    notes: Optional[str] = None
    currency: str = Field(default="DKK", min_length=3, max_length=3)
    lines: list[InvoiceLineInput] = Field(..., min_length=1)


class InvoiceResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: UUID
    branch_id: Optional[UUID]
    customer_id: UUID
    fakturanummer: int
    fakturanummer_formatted: str  # populated by service: "2026-0042"
    issue_date: date
    due_date: date
    delivery_date: Optional[date] = None
    sent_at: Optional[datetime]
    paid_at: Optional[datetime]
    status: str
    subtotal_net: Decimal
    moms_total: Decimal
    total_gross: Decimal
    paid_amount: Optional[Decimal]
    # Payment provenance (migration 034). Surfaced so the frontend can
    # render the "Undo" button conditionally — auto-matches show it only
    # while auto_match_reversible is True (server resets after 7 days).
    paid_via: Optional[str] = None
    paid_reference: Optional[str] = None
    auto_match_reversible: bool = False
    currency: str
    notes: Optional[str]
    customer_lang: str
    credited_by_id: Optional[UUID]
    is_credit_note: bool
    locked: bool
    created_at: datetime
    updated_at: datetime
    lines: list[InvoiceLineResponse] = []


class InvoiceMarkPaid(BaseModel):
    amount: Decimal = Field(..., gt=0)
    # 'manual' | 'bank_csv' | 'auto_match' | 'mobilepay' | 'open_banking'
    # Frontend defaults to 'manual'; bank import / auto-match passes their
    # own source. Strictly enum-like but kept as str for forward-compat
    # if we add more provenance sources later.
    source: str = Field(default="manual", max_length=20)
    # Optional note / bank reference. Free-text, capped to prevent abuse.
    paid_reference: Optional[str] = Field(default=None, max_length=500)


class InvoiceVoid(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)


# ─── Mileage schemas ─────────────────────────────────────────────────

class MileageEntryCreate(BaseModel):
    trip_date: Optional[date] = None  # defaults to today
    from_address: str = Field(..., min_length=1)
    to_address: str = Field(..., min_length=1)
    km: Decimal = Field(..., gt=0)
    purpose: str = Field(..., min_length=1, max_length=500)
    vehicle_reg: Optional[str] = Field(None, max_length=20)
    branch_id: Optional[UUID] = None
    notes: Optional[str] = None


class MileageEntryResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    user_id: UUID
    branch_id: Optional[UUID]
    trip_date: date
    from_address: str
    to_address: str
    km: Decimal
    purpose: str
    vehicle_reg: Optional[str]
    rate_per_km: Decimal
    deduction_amount: Decimal
    invoice_id: Optional[UUID]
    locked: bool
    notes: Optional[str]
    created_at: datetime
    updated_at: datetime


class MileageYearSummary(BaseModel):
    """Annual summary for the dashboard card."""
    year: int
    total_km: Decimal
    total_deduction: Decimal
    entries_count: int
    rate_tier: str  # "low" (3.79/km) | "high" (mixed, crossed 20.000 km threshold)
