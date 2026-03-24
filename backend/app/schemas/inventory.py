import uuid
import datetime
from pydantic import BaseModel


class InventoryItemCreate(BaseModel):
    name: str
    quantity: float = 0
    unit: str = "pieces"
    cost_per_unit: float = 0
    min_threshold: float = 0
    category: str = "General"
    sell_price: float | None = None
    barcode: str | None = None
    expiry_date: datetime.date | None = None
    is_perishable: bool = False


class InventoryItemUpdate(BaseModel):
    name: str | None = None
    quantity: float | None = None
    unit: str | None = None
    cost_per_unit: float | None = None
    min_threshold: float | None = None
    category: str | None = None
    sell_price: float | None = None
    barcode: str | None = None
    expiry_date: datetime.date | None = None
    is_perishable: bool | None = None


class InventoryItemResponse(BaseModel):
    id: uuid.UUID
    name: str
    quantity: float
    unit: str
    cost_per_unit: float
    min_threshold: float
    category: str | None = "General"
    sell_price: float | None = None
    barcode: str | None = None
    expiry_date: datetime.date | None = None
    is_perishable: bool = False
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}


class InventoryLogCreate(BaseModel):
    item_id: uuid.UUID
    change_qty: float
    reason: str = "adjustment"
    date: datetime.date
    batch_id: str | None = None


class InventoryLogResponse(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID
    change_qty: float
    reason: str
    date: datetime.date
    batch_id: str | None = None

    model_config = {"from_attributes": True}


class TemplateResponse(BaseModel):
    id: int
    template_name: str
    template_type: str
    item_name: str
    default_unit: str
    default_category: str
    is_perishable: bool
    default_reorder_level: int

    model_config = {"from_attributes": True}


class TemplateLoadRequest(BaseModel):
    template_type: str
