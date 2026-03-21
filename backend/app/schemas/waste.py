import uuid
import datetime
from pydantic import BaseModel


class WasteLogCreate(BaseModel):
    item_name: str
    quantity: float
    unit: str = "kg"
    estimated_cost: float = 0
    reason: str = "expired"
    date: datetime.date | None = None


class WasteLogUpdate(BaseModel):
    item_name: str | None = None
    quantity: float | None = None
    unit: str | None = None
    estimated_cost: float | None = None
    reason: str | None = None
    date: datetime.date | None = None


class WasteLogResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    item_name: str
    quantity: float
    unit: str
    estimated_cost: float
    reason: str

    model_config = {"from_attributes": True}


class WasteSummary(BaseModel):
    total_cost: float
    total_items: int
    by_reason: dict[str, float]
