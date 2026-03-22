import uuid
import datetime
from pydantic import BaseModel


class InventoryItemCreate(BaseModel):
    name: str
    quantity: float = 0
    unit: str = "pieces"
    cost_per_unit: float = 0
    min_threshold: float = 0


class InventoryItemUpdate(BaseModel):
    quantity: float | None = None
    cost_per_unit: float | None = None
    min_threshold: float | None = None


class InventoryItemResponse(BaseModel):
    id: uuid.UUID
    name: str
    quantity: float
    unit: str
    cost_per_unit: float
    min_threshold: float
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


class InventoryLogCreate(BaseModel):
    item_id: uuid.UUID
    change_qty: float
    reason: str = "adjustment"
    date: datetime.date


class InventoryLogResponse(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID
    change_qty: float
    reason: str
    date: datetime.date

    model_config = {"from_attributes": True}
