"""Pydantic shapes for the Booking endpoints (v3 ledger-only).

Per `docs/event-booking-product-spec.md` §4.5 + §5.3. Three surface
groups:

  • Public — visitor-facing (no auth). Hard input bounds (L3) live
    here because the Pydantic layer is the first stop on the public
    POST /api/public/bookings path.

  • Organizer — authenticated guest list + mark-paid + publish.

  • Internal — read-side projections for the front-end SPA.

Tight bounds on Public schemas (spec §7 L3):
  • Max 50 tickets total per booking (anti-bot).
  • Max 50 per individual tier.
  • Max 6 distinct addon lines × 50 each.
  • Email regex via Pydantic's EmailStr.
  • Name max 160 chars, phone max 40, notes 4 KB.

NOTE: We deliberately do NOT `from __future__ import annotations` in
this module. FastAPI's body-resolver sometimes fails to dereference
ForwardRefs when the SCHEMA module uses PEP 563 strings AND the route
function references the schema as `data: PublicBookingCreate = Body(...)`.
Keeping eager annotations here side-steps that quirk for the public
booking endpoint.
"""
from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
    model_validator,
)


# ─── Public booking input ────────────────────────────────────────────


class BookingLineCreate(BaseModel):
    """One ticket-tier line on the public booking POST.

    The label must match one of `event.ticket_tiers[].label` (case-
    insensitive). The router validates that — Pydantic just enforces
    the per-line numeric bounds.
    """

    label: str = Field(..., min_length=1, max_length=40)
    # Bounded 1..50 per tier (anti-bot — see spec §7 L3). qty=0 is
    # rejected here because the visitor's stepper never sends 0; if
    # they want to remove a tier they remove the row entirely.
    qty: int = Field(..., ge=1, le=50)

    @field_validator("label", mode="before")
    @classmethod
    def _strip_label(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if not v:
                raise ValueError("label cannot be empty or whitespace")
        return v


class BookingAddonCreate(BaseModel):
    """One addon (upsell) line on the public booking POST.

    Same shape as a ticket line; kept distinct so the route handler
    knows which array to file the line under for the Sale-row
    breakdown. Free-tier events reject any non-empty addons[] at the
    router (L7 PLAN_FEATURES `event_addons`).
    """

    label: str = Field(..., min_length=1, max_length=40)
    qty: int = Field(..., ge=1, le=50)

    @field_validator("label", mode="before")
    @classmethod
    def _strip_label(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if not v:
                raise ValueError("label cannot be empty or whitespace")
        return v


class PublicBookingCreate(BaseModel):
    """Body for POST /api/public/bookings.

    No user auth on this surface (visitor checkout). Identity is
    captured per-booking + the response carries a booking-token JWT
    the visitor's SPA uses for subsequent GET /bookings/{id} polls.
    """

    # Event reference — we accept slug here (not event_id) so the
    # public SPA can drive the booking flow from the URL without
    # leaking the internal UUID. Router resolves slug → event.
    event_slug: str = Field(..., min_length=1, max_length=80)

    # Visitor identity
    customer_email: EmailStr
    customer_name: str = Field(..., min_length=1, max_length=160)
    customer_phone: Optional[str] = Field(None, max_length=40)
    # Default False — opt-in checkbox on the form (GDPR).
    customer_consent_marketing: bool = False

    # Line items — at least one ticket. Pydantic enforces the
    # per-line bounds; the model_validator below enforces the
    # cross-line "max 50 total tickets" rule.
    ticket_lines: list[BookingLineCreate] = Field(
        ..., min_length=1, max_length=6,
    )
    # Add-ons optional; max 6 distinct lines (spec §7 L3).
    addon_lines: Optional[list[BookingAddonCreate]] = Field(
        None, max_length=6,
    )

    # Idempotency key — visitor's client sends this so a retry doesn't
    # produce a duplicate booking. 64-char cap matches the DB column.
    idempotency_key: Optional[str] = Field(None, min_length=8, max_length=64)

    @model_validator(mode="after")
    def _check_total_ticket_count(self) -> "PublicBookingCreate":
        """L3 — max 50 tickets across all tier lines."""
        total = sum(line.qty for line in self.ticket_lines)
        if total > 50:
            raise ValueError(
                "Du kan højst booke 50 billetter ad gangen. "
                "Kontakt arrangøren direkte for større grupper."
            )
        # Unique tier labels (case-insensitive) — two "Voksen" rows
        # would silently combine into double-charge bookings.
        seen = set()
        for line in self.ticket_lines:
            lc = line.label.casefold()
            if lc in seen:
                raise ValueError(
                    f"Duplicate ticket tier in booking: {line.label!r}. "
                    "One row per tier."
                )
            seen.add(lc)
        if self.addon_lines:
            seen_addons = set()
            for ad in self.addon_lines:
                lc = ad.label.casefold()
                if lc in seen_addons:
                    raise ValueError(
                        f"Duplicate add-on in booking: {ad.label!r}."
                    )
                seen_addons.add(lc)
        return self

    @field_validator("customer_email", mode="before")
    @classmethod
    def _normalize_email(cls, v):
        if isinstance(v, str):
            v = v.strip().lower()
        return v

    @field_validator("customer_name", mode="before")
    @classmethod
    def _strip_name(cls, v):
        if isinstance(v, str):
            v = v.strip()
            if not v:
                raise ValueError("name cannot be empty")
        return v


# ─── Public booking output ───────────────────────────────────────────


class PublicBookingResponse(BaseModel):
    """Returned to the visitor after POST /api/public/bookings.

    Distinct from the organizer-facing BookingResponse: no
    organizer_user_id, no sale_id, no payment provider refs. Visitor
    sees only what they need to render the success state + poll.
    """

    model_config = ConfigDict(from_attributes=False)

    id: UUID
    status: str
    event_slug: str
    event_name: str
    customer_email: str
    customer_name: str
    ticket_lines: list[BookingLineCreate]
    addon_lines: Optional[list[BookingAddonCreate]] = None
    total_amount_dkk: int
    currency: str = "DKK"
    is_tax_exempt: bool = False
    expires_at: Optional[datetime] = None
    paid_at: Optional[datetime] = None
    # Short-lived JWT the visitor's SPA stores in localStorage to
    # poll GET /api/public/bookings/{id}. Signed with BOOKING_TOKEN_KEY;
    # 24h TTL per spec §7 L1.
    booking_token: Optional[str] = None
    # Ticket UUIDs surface on success-state so the SPA can render
    # one row per individual ticket with the /t/{id} deep-link.
    ticket_ids: list[UUID] = Field(default_factory=list)


# ─── Organizer surfaces ──────────────────────────────────────────────


class BookingResponse(BaseModel):
    """Full organizer view of a booking row.

    Includes the tenant-scoped fields (organizer_user_id, sale_id,
    payment refs) the public response intentionally hides.
    """

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    event_id: UUID
    organizer_user_id: UUID
    customer_email: str
    customer_name: str
    customer_phone: Optional[str] = None
    customer_consent_marketing: bool = False
    ticket_lines: list[dict]
    addon_lines: Optional[list[dict]] = None
    total_amount_dkk: int
    currency: str = "DKK"
    is_tax_exempt: bool = False
    status: str
    payment_provider: Optional[str] = None
    payment_provider_ref: Optional[str] = None
    paid_at: Optional[datetime] = None
    sale_id: Optional[UUID] = None
    refund_sale_id: Optional[UUID] = None
    attended_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class BookingListResponse(BaseModel):
    """Paginated organizer guest list (GET /api/events/{id}/bookings)."""

    bookings: list[BookingResponse]
    total: int
    page: int
    page_size: int
    # Aggregate signals the EventDetail header surfaces:
    #   ● 47 / 80 booked · 6.450 kr forventet
    paid_count: int
    pending_count: int
    paid_revenue_dkk: int


class MarkPaidRequest(BaseModel):
    """Body for POST /api/bookings/{id}/mark-paid.

    Optional payment provenance — organizer can tag the manual mark
    with which method they accepted (MobilePay / Dankort / cash).
    Surfaced in the revisor PDF provenance footer.
    """

    # 'mobilepay' | 'card' | 'cash' | 'mixed'
    payment_method: Optional[str] = Field(None, max_length=20)
    # Free-form reference the organizer pastes from their MobilePay
    # app or Dankort terminal receipt. Capped at 120 to match the
    # column.
    provider_ref: Optional[str] = Field(None, max_length=120)


class BulkMarkPaidRequest(BaseModel):
    """Body for POST /api/bookings/bulk-mark-paid.

    Used when the organizer ticks many rows in the guest list and
    bulk-confirms. Bounded at 100 per call to keep the request payload
    + DB transaction reasonable.
    """

    booking_ids: list[UUID] = Field(..., min_length=1, max_length=100)
    payment_method: Optional[str] = Field(None, max_length=20)


class MarkRefundedRequest(BaseModel):
    """Body for POST /api/bookings/{id}/mark-refunded.

    BonBox doesn't move money — the organizer refunded the customer via
    their own rails. This call just records the kreditnota Sale in the
    ledger. `reason` is optional free-text for the audit trail.
    `refund_amount_dkk` defaults to full booking total; supply a smaller
    value for partial refunds (the kreditnota Sale will use that value
    as the negative amount; booking.status stays 'paid' but with a
    refund_sale_id pointer).
    """

    reason: Optional[str] = Field(None, max_length=500)
    refund_amount_dkk: Optional[int] = Field(None, gt=0)


class TicketScanResponse(BaseModel):
    """Returned from POST /api/tickets/{id}/scan."""

    ticket_id: UUID
    booking_id: UUID
    event_id: UUID
    tier_label: str
    customer_name: str
    # Status carries the idempotency outcome:
    #   "ok"           — fresh scan; row stamped attended_at
    #   "already"      — was already scanned; returning the prior stamp
    #   "void"         — ticket is void (booking refunded/cancelled)
    #   "wrong_event"  — the QR's eid doesn't match the URL's event
    status: str
    scanned_at: Optional[datetime] = None
