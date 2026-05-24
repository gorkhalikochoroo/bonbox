"""
Pydantic schemas for the Event entity (cultural events / pop-up engagements).

EventCreate — input on POST /api/events.
EventUpdate — partial fields for PATCH /api/events/{id}.
EventResponse — output shape for every GET / POST / PATCH response.
EventSummary — output shape for GET /api/events/{id}/summary.

See `app.models.event` for the column-level docstrings and the
distinction from `app.models.event_log.EventLog`.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class EventCreate(BaseModel):
    """Owner creates a new event (or pre-registers one in advance)."""

    name: str = Field(..., min_length=1, max_length=255)
    event_date: date
    venue: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = None


class EventUpdate(BaseModel):
    """Partial update — every field optional, blanket model_dump(exclude_unset).

    Soft-delete uses DELETE /api/events/{id} — not a flag flip via PATCH.
    """

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    event_date: Optional[date] = None
    venue: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = None


class EventResponse(BaseModel):
    """The shape every event-returning endpoint emits."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    name: str
    event_date: date
    venue: Optional[str] = None
    notes: Optional[str] = None
    is_deleted: bool = False
    deleted_at: Optional[datetime] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class EventSummary(BaseModel):
    """Aggregate read-only payload for GET /api/events/{id}/summary.

    Computed entirely from the owner's existing Sales + Expenses
    rows tagged with this event_id — no caching, no stored aggregates
    so the numbers always reflect the latest mutations.
    """

    model_config = ConfigDict(from_attributes=False)

    event: EventResponse
    # Money + tax — float for simplicity at the response boundary (the
    # accountant-grade PDFs compute their own canonical Decimal totals
    # via the bookkeeping_export service; this summary is the *owner's*
    # in-app view).
    total_sales_amount: float = 0.0
    total_moms: float = 0.0
    total_exempt_amount: float = 0.0
    # Guests = sum of ticket_breakdown counts across all sales tagged for
    # the event. Falls back to sum of Sale.guest_count for sales that
    # don't carry a ticket_breakdown.
    total_guests: int = 0
    # Counts so the UI can say "12 sales linked".
    sale_count: int = 0
    # Expense ties: only populated when the Expense model carries an
    # event_id column (Agent Z owns that migration). Until then this
    # field stays 0 — and the API stays forwards-compatible so when
    # Z lands the column, the wire shape doesn't change.
    expense_count: int = 0
    total_expense_amount: float = 0.0
