"""
Pydantic schemas for the Event entity (cultural events / pop-up engagements).

EventCreate — input on POST /api/events.
EventUpdate — partial fields for PATCH /api/events/{id}.
EventResponse — output shape for every GET / POST / PATCH response.
EventSummary — output shape for GET /api/events/{id}/summary.
EventCashupRequest — input for POST /api/events/{id}/cashup (migration 015).
EventCashupResponse — output shape after a successful cash-up.

See `app.models.event` for the column-level docstrings and the
distinction from `app.models.event_log.EventLog`.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.sale import SaleResponse


# ─── Ticket tiers (migration 015 — cash-up event ticket sheet) ────────


class TicketTier(BaseModel):
    """One ticket-price tier on an event (e.g. Voksen 150 kr).

    Bounds discussion:
      • `label` 1..40 chars — fits "Studerende m. studiekort" comfortably,
        rejects pathological inputs without restricting legitimate labels.
      • `price_dkk` int 0..999_999 — round kroner only per Manoj's brief.
        Cinema-night tickets are always whole-DKK; we'd add an øre field
        if/when a customer needs fractional pricing. Cap at 999_999 to
        prevent integer-overflow shenanigans on the gross computation
        (qty * price still fits comfortably under 2^31 even at max).
      • Label is stripped on input. Empty-after-strip is rejected at
        the validator layer.
    """

    label: str = Field(..., min_length=1, max_length=40)
    price_dkk: int = Field(..., ge=0, le=999_999)

    @field_validator("label", mode="before")
    @classmethod
    def _strip_label(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if not v:
                raise ValueError("label cannot be empty or whitespace")
        return v


class TierCashupRow(BaseModel):
    """One row of the cash-up sheet — "X tickets sold at this tier".

    `label` matches the event's stored `ticket_tiers[].label` (case-
    insensitive at the router layer). `qty` is bounded so an attacker
    can't blow up the gross compute by passing 10^9.
    """

    label: str = Field(..., min_length=1, max_length=40)
    qty: int = Field(..., ge=0, le=9_999)

    @field_validator("label", mode="before")
    @classmethod
    def _strip_label(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if not v:
                raise ValueError("label cannot be empty or whitespace")
        return v


class PaymentSplit(BaseModel):
    """Optional per-method DKK split for the cash-up. Sums to the gross
    (validated at the router with a ±1 DKK tolerance for rounding).

    Every field optional — owner can submit just the methods they
    actually took. Negative amounts rejected. Stored as floats because
    that's the Sale-row convention (Numeric(12,2) at the DB layer),
    but the cash-up itself is computed in DKK whole numbers so the
    sum check tolerates minor float-rep noise within 1 kr.
    """

    cash: float | None = Field(None, ge=0)
    card: float | None = Field(None, ge=0)
    mobilepay: float | None = Field(None, ge=0)
    online: float | None = Field(None, ge=0)
    mixed: float | None = Field(None, ge=0)

    def non_zero_total(self) -> float:
        return float(
            (self.cash or 0)
            + (self.card or 0)
            + (self.mobilepay or 0)
            + (self.online or 0)
            + (self.mixed or 0)
        )

    def dominant_method(self) -> str | None:
        """The single method that took the biggest share, or None if
        every method is empty / zero. Used to set Sale.payment_method
        when a single method dominates the split; otherwise the
        caller falls back to 'mixed'."""
        candidates = {
            "cash": self.cash or 0.0,
            "card": self.card or 0.0,
            "mobilepay": self.mobilepay or 0.0,
            "online": self.online or 0.0,
            "mixed": self.mixed or 0.0,
        }
        non_zero = {k: v for k, v in candidates.items() if v > 0}
        if not non_zero:
            return None
        return max(non_zero, key=non_zero.get)


# ─── CRUD ────────────────────────────────────────────────────────────


class EventCreate(BaseModel):
    """Owner creates a new event (or pre-registers one in advance)."""

    name: str = Field(..., min_length=1, max_length=255)
    event_date: date
    venue: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = None
    # Ticket-tier sheet (migration 015). Optional — events without
    # ticketed pricing keep working (the cash-up button stays disabled
    # for them; tooltip explains).
    ticket_tiers: Optional[list[TicketTier]] = Field(None, max_length=6)
    is_tax_exempt: bool = False

    @model_validator(mode="after")
    def _check_unique_labels(self) -> "EventCreate":
        """Tier labels must be unique within an event (case-insensitive).
        Two "Voksen" rows would make the cash-up sheet ambiguous — which
        Voksen does the qty refer to? Reject at the schema layer so the
        router never needs to deal with the case."""
        if self.ticket_tiers:
            seen = set()
            for tier in self.ticket_tiers:
                lc = tier.label.casefold()
                if lc in seen:
                    raise ValueError(
                        f"Duplicate ticket tier label: {tier.label!r} "
                        "(case-insensitive). Tier labels must be unique "
                        "within an event."
                    )
                seen.add(lc)
        return self


class EventUpdate(BaseModel):
    """Partial update — every field optional, blanket model_dump(exclude_unset).

    Soft-delete uses DELETE /api/events/{id} — not a flag flip via PATCH.
    """

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    event_date: Optional[date] = None
    venue: Optional[str] = Field(None, max_length=255)
    notes: Optional[str] = None
    # Same shape as EventCreate — pass an empty list `[]` to clear tiers;
    # omit the field to leave them unchanged.
    ticket_tiers: Optional[list[TicketTier]] = Field(None, max_length=6)
    is_tax_exempt: Optional[bool] = None

    @model_validator(mode="after")
    def _check_unique_labels(self) -> "EventUpdate":
        if self.ticket_tiers:
            seen = set()
            for tier in self.ticket_tiers:
                lc = tier.label.casefold()
                if lc in seen:
                    raise ValueError(
                        f"Duplicate ticket tier label: {tier.label!r} "
                        "(case-insensitive). Tier labels must be unique "
                        "within an event."
                    )
                seen.add(lc)
        return self


class EventResponse(BaseModel):
    """The shape every event-returning endpoint emits."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    name: str
    event_date: date
    venue: Optional[str] = None
    notes: Optional[str] = None
    ticket_tiers: Optional[list[TicketTier]] = None
    is_tax_exempt: bool = False
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


# ─── Cash-up (migration 015) ─────────────────────────────────────────


class EventCashupRequest(BaseModel):
    """Body for POST /api/events/{id}/cashup.

    Owner taps "💰 Cash up event" after the event finishes, fills in
    quantities per ticket tier, and optionally splits by payment method.
    BonBox computes the gross, validates the split against the gross,
    and writes one Sale row tagged to the event with the per-tier
    breakdown captured in Sale.ticket_breakdown.
    """

    # tier_counts must cover at least one tier; max 6 mirrors the
    # event's ticket_tiers max. The router does the cross-check that
    # every label exists on the event's stored ticket_tiers list.
    tier_counts: list[TierCashupRow] = Field(..., min_length=1, max_length=6)
    payment_split: Optional[PaymentSplit] = None
    # Optional override of the event's date — useful for back-filling
    # cash-up after the fact (e.g. owner forgot for a week). Defaults
    # to event.event_date at the router layer.
    #
    # NOTE: field-name `sale_date` not `date` to avoid shadowing the
    # `date` import inside the class scope — Pydantic's annotation
    # resolver gets confused otherwise and raises
    # "unsupported operand type(s) for |: 'NoneType' and 'NoneType'"
    # at class-definition time. The router maps this to Sale.date.
    sale_date: Optional[date] = None
    # Free-form notes appended to the Sale row. Capped at 500 chars so
    # nothing crazy lands in the audit row's after-state.
    notes: Optional[str] = Field(None, max_length=500)

    @model_validator(mode="after")
    def _check_unique_and_positive(self) -> "EventCashupRequest":
        # No duplicate labels within tier_counts — two "Voksen" rows
        # would otherwise silently double-count. Case-insensitive.
        seen = set()
        for row in self.tier_counts:
            lc = row.label.casefold()
            if lc in seen:
                raise ValueError(
                    f"Duplicate tier label in cash-up: {row.label!r} "
                    "(case-insensitive). One row per tier."
                )
            seen.add(lc)
        # At least one tier with qty > 0 — otherwise the cash-up
        # would create a zero-gross Sale row, which is meaningless
        # and would pollute the audit trail. Reject early.
        if not any(r.qty > 0 for r in self.tier_counts):
            raise ValueError(
                "At least one tier must have qty > 0 for a cash-up."
            )
        return self


class EventCashupResponse(BaseModel):
    """Returned after a successful cash-up. The caller gets both the
    new Sale row (so it can navigate to /sales?event_id=… or render
    the toast with the bilagsnummer) AND the refreshed event summary
    so the EventsPage detail panel updates without a second fetch."""

    model_config = ConfigDict(from_attributes=False)

    sale: SaleResponse
    summary: EventSummary
