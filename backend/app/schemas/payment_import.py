"""Schemas for payment provider connections and transaction imports."""
import uuid
from datetime import datetime
from pydantic import BaseModel


# ── Provider info ───────────────────────────────────────────
class ProviderInfo(BaseModel):
    id: str
    name: str
    country: str  # DK, NO, NP, IN, etc.
    countries: list[str]  # all supported countries
    description: str
    fields: list[dict]  # [{key, label, type, placeholder}]
    logo_emoji: str  # simple emoji fallback


# ── Connection management ───────────────────────────────────
class ConnectRequest(BaseModel):
    provider: str
    label: str = ""
    credentials: dict  # provider-specific keys


class ConnectionResponse(BaseModel):
    id: uuid.UUID
    provider: str
    label: str
    is_active: bool
    auto_sync: bool = True
    last_synced_at: datetime | None = None
    last_auto_imported: int = 0
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Transaction sync ────────────────────────────────────────
class PaymentTransaction(BaseModel):
    date: str
    description: str
    amount: float
    type: str  # "income" | "expense"
    ref_hash: str
    payment_method: str
    provider: str
    suggested_category: str | None = None
    confidence: float | None = None


class SyncResponse(BaseModel):
    provider: str
    transactions: list[PaymentTransaction]
    total_count: int
    date_from: str | None = None
    date_to: str | None = None


class SyncConfirmRequest(BaseModel):
    connection_id: uuid.UUID
    transactions: list[PaymentTransaction]


class SyncConfirmResponse(BaseModel):
    imported: int
    skipped: int
    errors: list[str]
