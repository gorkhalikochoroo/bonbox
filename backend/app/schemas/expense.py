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
    is_deleted: bool = False
    deleted_at: datetime.datetime | None = None
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
