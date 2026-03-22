import uuid
import datetime
from pydantic import BaseModel


class KhataCustomerCreate(BaseModel):
    name: str
    phone: str | None = None
    address: str | None = None


class KhataCustomerUpdate(BaseModel):
    name: str | None = None
    phone: str | None = None
    address: str | None = None


class KhataCustomerResponse(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    address: str | None
    created_at: datetime.datetime | None = None
    is_deleted: bool = False
    balance: float = 0

    model_config = {"from_attributes": True}


class KhataTransactionCreate(BaseModel):
    customer_id: uuid.UUID
    date: datetime.date
    purchase_amount: float = 0
    paid_amount: float = 0
    notes: str | None = None


class KhataTransactionUpdate(BaseModel):
    date: datetime.date | None = None
    purchase_amount: float | None = None
    paid_amount: float | None = None
    notes: str | None = None


class KhataTransactionResponse(BaseModel):
    id: uuid.UUID
    customer_id: uuid.UUID
    date: datetime.date
    purchase_amount: float
    paid_amount: float
    notes: str | None
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
