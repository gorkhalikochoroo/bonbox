import uuid
import datetime
from pydantic import BaseModel, field_validator


class SaleCreate(BaseModel):
    date: datetime.date
    amount: float | None = None  # optional for item sales (auto-calculated)
    payment_method: str = "mixed"
    notes: str | None = None
    is_tax_exempt: bool = False
    # Item sale fields
    inventory_item_id: uuid.UUID | None = None
    quantity_sold: float | None = None
    unit_price: float | None = None

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
        return v


class SaleUpdate(BaseModel):
    date: datetime.date | None = None
    amount: float | None = None
    payment_method: str | None = None
    notes: str | None = None
    is_tax_exempt: bool | None = None

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
        return v


class SaleReturnRequest(BaseModel):
    reason: str
    action: str  # refund | replace | exchange | restock
    amount: float | None = None  # override refund amount (defaults to sale.amount for refunds)


class SaleResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    amount: float
    payment_method: str
    notes: str | None
    is_tax_exempt: bool = False
    is_deleted: bool = False
    deleted_at: datetime.datetime | None = None
    created_at: datetime.datetime | None = None
    # Item sale fields
    inventory_item_id: uuid.UUID | None = None
    quantity_sold: float | None = None
    unit_price: float | None = None
    cost_at_sale: float | None = None
    item_name: str | None = None
    # Return fields
    status: str = "completed"
    return_reason: str | None = None
    return_action: str | None = None
    return_amount: float | None = None
    returned_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
