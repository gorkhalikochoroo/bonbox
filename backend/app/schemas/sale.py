import uuid
import datetime
from pydantic import BaseModel


class SaleCreate(BaseModel):
    date: datetime.date
    amount: float
    payment_method: str = "mixed"
    notes: str | None = None


class SaleUpdate(BaseModel):
    date: datetime.date | None = None
    amount: float | None = None
    payment_method: str | None = None
    notes: str | None = None


class SaleResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    amount: float
    payment_method: str
    notes: str | None

    model_config = {"from_attributes": True}
