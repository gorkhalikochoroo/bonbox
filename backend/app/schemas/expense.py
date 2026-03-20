import uuid
import datetime
from pydantic import BaseModel


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


class ExpenseUpdate(BaseModel):
    category_id: uuid.UUID | None = None
    date: datetime.date | None = None
    amount: float | None = None
    description: str | None = None
    is_recurring: bool | None = None


class ExpenseResponse(BaseModel):
    id: uuid.UUID
    category_id: uuid.UUID
    date: datetime.date
    amount: float
    description: str
    is_recurring: bool

    model_config = {"from_attributes": True}
