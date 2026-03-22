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

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
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
    is_deleted: bool = False
    deleted_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
