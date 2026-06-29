import uuid
import datetime
from pydantic import BaseModel, field_validator


class ExpenseCategoryCreate(BaseModel):
    name: str
    color: str = "#3B82F6"


class ExpenseCategoryResponse(BaseModel):
    id: uuid.UUID
    name: str
    color: str

    model_config = {"from_attributes": True}


class ExpenseCreate(BaseModel):
    category_id: uuid.UUID
    date: datetime.date
    amount: float
    description: str
    is_recurring: bool = False
    payment_method: str = "card"
    notes: str | None = None
    is_personal: bool = False
    is_tax_exempt: bool = False
    # Optional receipt photo path returned by /expenses/upload-receipt.
    # When set, the expense row carries the URL so the user can re-view
    # the receipt after save (matches Sale.receipt_photo behaviour).
    # Bounded to 500 chars to match the DB column width.
    receipt_photo: str | None = None
    # ── Foreign-currency capture (migration 014) ──────────────────────
    # All three are nullable. The router enforces the all-or-nothing
    # rule (if currency is non-null and differs from the user's account
    # currency, fx_rate and original_amount must also be populated).
    # `amount` above remains in the user's account currency so MOMS
    # math and dashboards stay correct.
    currency: str | None = None
    fx_rate: float | None = None
    original_amount: float | None = None

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
        return v

    @field_validator("receipt_photo", mode="before")
    @classmethod
    def cap_receipt_photo_length(cls, v):
        if v is None or v == "":
            return None
        if isinstance(v, str) and len(v) > 500:
            # Defense — DB column is VARCHAR(500). Reject obviously
            # malformed input rather than truncating silently.
            raise ValueError("receipt_photo path too long (max 500 chars)")
        return v

    @field_validator("currency", mode="before")
    @classmethod
    def normalize_currency(cls, v):
        # ISO 4217 = 3 letters, uppercase. Empty string => null
        # (frontend sends "" when the toggle is closed).
        if v is None or v == "":
            return None
        if not isinstance(v, str):
            raise ValueError("currency must be an ISO 4217 string")
        v = v.strip().upper()
        if len(v) != 3 or not v.isalpha():
            raise ValueError("currency must be a 3-letter ISO 4217 code")
        return v

    @field_validator("fx_rate", mode="before")
    @classmethod
    def validate_fx_rate(cls, v):
        if v is None or v == "":
            return None
        try:
            rv = float(v)
        except (TypeError, ValueError):
            raise ValueError("fx_rate must be a number")
        # Reject obviously bogus rates. 0.0001 ≤ rate ≤ 100000 covers
        # every realistic ISO 4217 pair (DKK-NPR ≈ 0.05, DKK-IDR ≈ 0.0004
        # if anyone ever needs it, NPR-DKK ≈ 16, IDR-DKK ≈ 2500).
        if rv <= 0 or rv > 100000:
            raise ValueError("fx_rate out of plausible range")
        return rv

    @field_validator("original_amount", mode="before")
    @classmethod
    def validate_original_amount(cls, v):
        if v is None or v == "":
            return None
        try:
            ov = float(v)
        except (TypeError, ValueError):
            raise ValueError("original_amount must be a number")
        if ov < 0:
            raise ValueError("original_amount must be non-negative")
        return ov


class ExpenseUpdate(BaseModel):
    category_id: uuid.UUID | None = None
    date: datetime.date | None = None
    amount: float | None = None
    description: str | None = None
    is_recurring: bool | None = None
    payment_method: str | None = None
    notes: str | None = None
    is_personal: bool | None = None
    is_tax_exempt: bool | None = None

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
        return v


class ExpenseResponse(BaseModel):
    id: uuid.UUID
    category_id: uuid.UUID
    date: datetime.date
    amount: float
    description: str
    is_recurring: bool
    payment_method: str | None
    notes: str | None
    is_personal: bool = False
    is_tax_exempt: bool = False
    receipt_photo: str | None = None
    # ── Foreign-currency capture (migration 014) ──────────────────────
    # All three are null for single-currency entries — backward compat.
    currency: str | None = None
    fx_rate: float | None = None
    original_amount: float | None = None
    is_deleted: bool = False
    deleted_at: datetime.datetime | None = None
    created_at: datetime.datetime | None = None
    # Godkend-kø: 'approved' = booked; 'pending' = unapproved draft (excluded
    # from every money total until the owner approves). NULL/legacy → approved.
    status: str | None = None

    model_config = {"from_attributes": True}


class ExpenseApproveBatch(BaseModel):
    """Bulk-approve request — the ids the owner tapped 'Godkend alle klar' on."""
    ids: list[str]
