import uuid
import datetime
from pydantic import BaseModel, field_validator


# Channel synonym map — accept Aloha/Restwave/Pos+ wording from CSV imports etc.
_CHANNEL_SYNONYMS = {
    "restaurant": "dine_in",
    "in_house": "dine_in",
    "ta_pickup": "takeaway",
    "ta": "takeaway",
    "pickup": "takeaway",
    "wolt_del": "wolt",
    "wolt_delivery": "wolt",
    "justeat": "just_eat",
    "online": "web",
    "webcloseorder": "web",
    "web_close_order": "web",
    "web_prepaid": "web",
}


def _normalize_channel(v):
    if not isinstance(v, str):
        return "dine_in"
    v = v.strip().lower().replace("-", "_").replace(" ", "_")
    return _CHANNEL_SYNONYMS.get(v, v) or "dine_in"


class SaleCreate(BaseModel):
    date: datetime.date
    amount: float | None = None  # optional for item sales (auto-calculated)
    payment_method: str = "mixed"
    notes: str | None = None
    is_tax_exempt: bool = False
    # Item sale fields
    inventory_item_id: uuid.UUID | None = None
    quantity_sold: float | None = None
    unit_price: float | None = None
    # ── Danish restaurant ops (Property Financial Report fields) ──
    # All optional with safe defaults so non-restaurant flows are unaffected.
    order_channel: str = "dine_in"  # dine_in|takeaway|wolt|just_eat|web|phone|catering|other
    guest_count: int | None = None
    service_charge_amount: float | None = None
    discount_amount: float | None = None
    # Operational exceptions — typically only flipped via admin/edit flow
    is_void: bool = False
    is_manager_void: bool = False
    is_error_correct: bool = False

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
        return v

    @field_validator("order_channel", mode="before")
    @classmethod
    def normalize_channel(cls, v):
        return _normalize_channel(v)


class SaleUpdate(BaseModel):
    date: datetime.date | None = None
    amount: float | None = None
    payment_method: str | None = None
    notes: str | None = None
    is_tax_exempt: bool | None = None
    # Restaurant ops fields — all optional on update
    order_channel: str | None = None
    guest_count: int | None = None
    service_charge_amount: float | None = None
    discount_amount: float | None = None
    is_void: bool | None = None
    is_manager_void: bool | None = None
    is_error_correct: bool | None = None

    @field_validator("payment_method", mode="before")
    @classmethod
    def normalize_payment_method(cls, v):
        if isinstance(v, str) and v.lower() == "kontant":
            return "cash"
        return v

    @field_validator("order_channel", mode="before")
    @classmethod
    def normalize_channel(cls, v):
        if v is None:
            return None
        return _normalize_channel(v)


class SaleReturnRequest(BaseModel):
    reason: str
    action: str  # refund | replace | exchange | restock
    amount: float | None = None  # override refund amount (defaults to sale.amount for refunds)


class SaleResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    amount: float
    payment_method: str
    notes: str | None
    is_tax_exempt: bool = False
    is_deleted: bool = False
    deleted_at: datetime.datetime | None = None
    created_at: datetime.datetime | None = None
    # Item sale fields
    inventory_item_id: uuid.UUID | None = None
    quantity_sold: float | None = None
    unit_price: float | None = None
    cost_at_sale: float | None = None
    item_name: str | None = None
    # Return fields
    status: str = "completed"
    return_reason: str | None = None
    return_action: str | None = None
    return_amount: float | None = None
    returned_at: datetime.datetime | None = None
    # Restaurant ops fields
    order_channel: str = "dine_in"
    guest_count: int | None = None
    service_charge_amount: float | None = None
    discount_amount: float | None = None
    is_void: bool = False
    is_manager_void: bool = False
    is_error_correct: bool = False

    model_config = {"from_attributes": True}
