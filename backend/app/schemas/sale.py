import uuid
import datetime
from pydantic import BaseModel, field_validator


class SaleCreate(BaseModel):
    date: datetime.date
    amount: float
    payment_method: str = "mixed"
    notes: str | None = None

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

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
        return v


class SaleResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    amount: float
    payment_method: str
    notes: str | None
    is_deleted: bool = False
    deleted_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
