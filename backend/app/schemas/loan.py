import uuid
import datetime
from pydantic import BaseModel


class LoanPersonCreate(BaseModel):
    name: str
    phone: str | None = None
    notes: str | None = None


class LoanPersonUpdate(BaseModel):
    name: str | None = None
    phone: str | None = None
    notes: str | None = None


class LoanPersonResponse(BaseModel):
    id: uuid.UUID
    name: str
    phone: str | None
    notes: str | None
    created_at: datetime.datetime | None = None
    borrowed_balance: float = 0
    lent_balance: float = 0
    net_balance: float = 0  # positive = they owe me

    model_config = {"from_attributes": True}


class LoanTransactionCreate(BaseModel):
    person_id: uuid.UUID
    date: datetime.date
    type: str  # "borrowed" or "lent"
    amount: float
    is_repayment: bool = False
    notes: str | None = None


class LoanTransactionUpdate(BaseModel):
    date: datetime.date | None = None
    type: str | None = None
    amount: float | None = None
    is_repayment: bool | None = None
    notes: str | None = None


class LoanTransactionResponse(BaseModel):
    id: uuid.UUID
    person_id: uuid.UUID
    date: datetime.date
    type: str
    amount: float
    is_repayment: bool
    notes: str | None
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
