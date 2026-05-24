import uuid
import datetime
from typing import Any
from pydantic import BaseModel, field_validator


# Channel synonym map — accept Aloha/Restwave/Pos+ wording from CSV imports etc.
# DK 2026 note: Just Eat exited Denmark in 2024 → kept as legacy synonym for
# historical data continuity; new entries should use uber_eats / wolt / foodora.
_CHANNEL_SYNONYMS = {
    "restaurant": "dine_in",
    "in_house": "dine_in",
    "ta_pickup": "takeaway",
    "ta": "takeaway",
    "pickup": "takeaway",
    "wolt_del": "wolt",
    "wolt_delivery": "wolt",
    # Uber Eats (entered DK 2024)
    "ubereats": "uber_eats",
    "uber": "uber_eats",
    "uber_eats_dk": "uber_eats",
    # Foodora (still active in DK)
    "foodora_dk": "foodora",
    # Legacy — Just Eat closed in DK; keep mapping so old rows still resolve.
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


# ── ticket_breakdown validator (migration 013) ────────────────────────
# Shape:
#   {
#     "adult":   {"price": 250, "count": 30},
#     "student": {"price": 150, "count": 12},
#     "family":  {"price": 500, "count":  4},
#   }
# Tier label is free-form (matches the owner's wording — "adult", "kid",
# "earlybird"…); the only contract is each tier has numeric `price` >= 0
# and integer `count` >= 0. We deliberately do NOT cross-check
# sum-product == sale.amount here — the router does that with the actual
# Sale.amount in hand. Pure Pydantic-level checks only.
_MAX_TIERS = 20  # sanity cap — no event has 20 distinct ticket tiers


def _validate_ticket_breakdown(v: Any) -> Any:
    if v is None:
        return None
    if not isinstance(v, dict):
        raise ValueError("ticket_breakdown must be an object")
    if len(v) == 0:
        # An empty dict is meaningless — treat as None so we don't store
        # `{}` and confuse downstream consumers.
        return None
    if len(v) > _MAX_TIERS:
        raise ValueError(f"ticket_breakdown has too many tiers (max {_MAX_TIERS})")
    cleaned: dict[str, dict[str, float]] = {}
    for tier, payload in v.items():
        if not isinstance(tier, str) or not tier.strip():
            raise ValueError("ticket_breakdown tier label must be a non-empty string")
        if len(tier) > 40:
            raise ValueError("ticket_breakdown tier label too long (max 40 chars)")
        if not isinstance(payload, dict):
            raise ValueError(f"ticket_breakdown[{tier!r}] must be an object")
        try:
            price = float(payload.get("price", 0))
            count = int(payload.get("count", 0))
        except (TypeError, ValueError) as e:
            raise ValueError(
                f"ticket_breakdown[{tier!r}] needs numeric price + integer count"
            ) from e
        if price < 0:
            raise ValueError(f"ticket_breakdown[{tier!r}].price must be >= 0")
        if count < 0:
            raise ValueError(f"ticket_breakdown[{tier!r}].count must be >= 0")
        cleaned[tier.strip()] = {"price": price, "count": count}
    return cleaned


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
    order_channel: str = "dine_in"  # dine_in|takeaway|wolt|uber_eats|foodora|web|phone|catering|other (just_eat=legacy, DK closed 2024)
    guest_count: int | None = None
    service_charge_amount: float | None = None
    discount_amount: float | None = None
    # Operational exceptions — typically only flipped via admin/edit flow
    is_void: bool = False
    is_manager_void: bool = False
    is_error_correct: bool = False
    # Multi-terminal scoping. Two ways in:
    #   1. terminal_id — explicit (router validates ownership)
    #   2. terminal_label — string from a POS export ("Term 2"); the
    #      router runs find_terminal_for_label() and auto-tags the sale
    # If both supplied, terminal_id wins. Both NULL = single-terminal venue.
    terminal_id: uuid.UUID | None = None
    terminal_label: str | None = None
    # Cultural event tagging (migration 013) — optional FK. Router checks
    # the event belongs to the same user before persisting (defense vs IDOR).
    event_id: uuid.UUID | None = None
    # Multi-tier ticket pricing breakdown — see helper docstring above.
    ticket_breakdown: dict | None = None

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

    @field_validator("ticket_breakdown", mode="before")
    @classmethod
    def normalize_ticket_breakdown(cls, v):
        return _validate_ticket_breakdown(v)


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
    # Cultural event tagging (migration 013) — both optional. Passing
    # event_id=None on PATCH explicitly clears the tag (router uses
    # `model_dump(exclude_unset=True)` so omitting the key keeps the
    # existing value untouched).
    event_id: uuid.UUID | None = None
    ticket_breakdown: dict | None = None

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

    @field_validator("ticket_breakdown", mode="before")
    @classmethod
    def normalize_ticket_breakdown(cls, v):
        return _validate_ticket_breakdown(v)


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
    # Receipt photo URL — surfaced on the row so the Sales-list UI can
    # render a thumbnail + open the receipt-review modal. Sale model has
    # carried this column for a while; the schema just hadn't exposed it.
    receipt_photo: str | None = None
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
    # Cultural event tagging (migration 013) — surfaced so the Sales-list
    # UI can render the event chip and the EventsPage detail view can
    # show each sale's breakdown without a second fetch.
    event_id: uuid.UUID | None = None
    ticket_breakdown: dict | None = None

    model_config = {"from_attributes": True}
