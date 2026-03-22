import uuid
import datetime
from pydantic import BaseModel


class CashTransactionCreate(BaseModel):
    date: datetime.date
    type: str  # "cash_in" or "cash_out"
    amount: float
    description: str
    category: str | None = None
    reference_id: str | None = None


class CashTransactionUpdate(BaseModel):
    date: datetime.date | None = None
    type: str | None = None
    amount: float | None = None
    description: str | None = None
    category: str | None = None


class CashTransactionResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    type: str
    amount: float
    description: str
    category: str | None
    reference_id: str | None
    is_deleted: bool = False
    deleted_at: datetime.datetime | None = None
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
