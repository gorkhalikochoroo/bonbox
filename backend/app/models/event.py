"""Event model — cultural events / pop-up shops / one-off engagements.

Built for the Sudip-style customer: cultural-event organizers, mobile
vendors, and pop-up shops who run 10-15 standalone events per year and
need a way to slice their Sales/Expenses ledger by "which event was this".

Distinct from `event_log.EventLog` (analytics telemetry — page_views,
feature usage) — completely different concept despite the name overlap.
This `Event` is a real-world business event with a date, a venue and a
guest count. EventLog is what we use to track app usage.

Lifecycle:
  • Owner creates an Event ahead of time (e.g. "Nepali Movie Night, 4 Apr").
  • While the event runs, each Sale POST can pass `event_id` so the row is
    tagged. Multi-tier pricing flows through Sale.ticket_breakdown (JSON).
  • After the event, the owner opens /events/<id> and reads the summary:
    total sales, MOMS, exempt revenue, guests, expense ties.

Soft-delete only (is_deleted flag) because past Sales reference event_id
via `ON DELETE SET NULL` — hard-deleting an event would unceremoniously
strip the link from history but the audit trail (AuditLog rows) would
keep the original UUID. Soft-delete keeps everything coherent.

DK note: 'Event' / 'Begivenhed' are interchangeable in the UI; we prefer
'Event' even in Danish copy because it's a clean loan-word in DK business
contexts (kulturarrangør, eventarrangør) — Manoj's Sudip interviews
confirmed owners say "event" out loud, not "begivenhed".
"""
import uuid
from datetime import date, datetime

from sqlalchemy import String, Date, DateTime, Text, Boolean, ForeignKey, Index, JSON
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class Event(Base):
    """A cultural / pop-up / one-off business event the owner runs."""

    __tablename__ = "events"
    __table_args__ = (
        # Sort-and-filter index: "newest events first for this owner".
        # Drives the EventsPage list view + the SalesPage filter chip's
        # dropdown that fetches `/api/events?sort=date_desc`.
        Index("ix_event_user_date", "user_id", "event_date", "is_deleted"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    name: Mapped[str] = mapped_column(String(255))
    event_date: Mapped[date] = mapped_column(Date)
    venue: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── Cash-up ticket sheet (migration 015) ──────────────────────────
    # Optional list of ticket tiers defined at event-create time.
    # Drives the "💰 Cash up event" modal — the owner types quantity
    # per tier, BonBox computes gross and writes ONE Sale row tagged
    # to the event with the per-tier breakdown captured in
    # Sale.ticket_breakdown.
    #
    # Stored shape (Pydantic-validated at the API edge, free-form here
    # for forward-compat):
    #   [
    #     {"label": "Voksen",     "price_dkk": 150},
    #     {"label": "Studerende", "price_dkk": 100},
    #     {"label": "Barn",       "price_dkk":  50}
    #   ]
    #
    # JSON column → SQLite TEXT, Postgres JSONB. We never query into
    # the array — always loaded with the parent row. Matches the
    # Sale.ticket_breakdown variant pattern from migration 013.
    ticket_tiers: Mapped[list | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True,
    )

    # Whole-event MOMS-fri toggle. Set TRUE for events that qualify
    # under Momsloven §13 (live theatre, museum). The cash-up handler
    # reads this and stamps every resulting Sale row's `is_tax_exempt`
    # so the accountant-grade MOMS extract is correct. Default FALSE
    # = standard 25% MOMS posture (what cinema-night events use).
    # No per-tier MOMS UI in v1 — per Manoj's brief, the posture is
    # whole-event, not per-row.
    is_tax_exempt: Mapped[bool] = mapped_column(Boolean, default=False)

    # ── Public-bookable surface (v3 event-booking spec §5.2) ─────────
    # The columns below extend the Event model so the same row can
    # power both the existing cash-up flow AND the new public booking
    # page at /e/{slug}. Each is optional — events created before the
    # booking sprint stay valid + the existing cash-up code path
    # continues to work without these populated.
    #
    # `slug` is the kebab-case URL handle ("nepali-movie-night-14-7k4q")
    # allocated by routers/events.py:publish_event when the organizer
    # taps "Make publicly bookable". UNIQUE — collision retry up to 3
    # times in the allocator. NULL = event is private (cash-up only,
    # no public URL).
    slug: Mapped[str | None] = mapped_column(
        String(80), nullable=True, unique=True,
    )
    # `published` is the kill-switch the organizer flips via the
    # /publish + /unpublish endpoints. False (default) keeps the event
    # private even if a slug was previously allocated. The /e/{slug}
    # SSR + JSON detail routes both check this flag and 410-Gone
    # when False (L9 graceful fallback per spec §7).
    published: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Wall-clock start/end. event_date (above) is the legacy DATE
    # column the cash-up flow uses; starts_at/ends_at carry the full
    # timestamp needed for the public page ("18:00 – 21:00") and for
    # the ticket-JWT expiry (event.ends_at + 6h grace).
    starts_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # 16:9 cover photo — uploaded to Supabase Storage `event-covers/`
    # bucket (public-read ACL per spec §4 "The 'more dramatic' public
    # event page"). TEXT not VARCHAR so a long signed URL fits.
    cover_image_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Optional subtitle ("Lakhey · A Kathmandu Classic"). Distinct
    # from `notes` (which is body markdown rendered below the meta
    # strip). 255-char cap because it sits on one H2 line.
    subtitle: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Booking window — opens by default at publish-time, closes 1h
    # before start (router computes the defaults from starts_at). NULL
    # = no window enforcement (always open between publish + start).
    bookings_open_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    bookings_close_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Per-event capacity ceiling. Free tier hard-caps to 30 (enforced
    # at the public-booking-create router via PLAN_CAPS); past 30 sold
    # tickets, visitors see "Dette arrangement er fuldt booket" (L7
    # fail-closed). Starter+ have unlimited, but organizers can set a
    # value here to reflect venue capacity ("Bremen Teater = 80").
    # NULL = no organizer-set cap (only the tier cap applies).
    capacity_total: Mapped[int | None] = mapped_column(nullable=True)

    # Optional add-on / upsell catalogue. Shape mirrors ticket_tiers
    # but per-spec §2 Starter+ feature only (Free has add-ons OFF;
    # the public-booking router rejects addons on Free events).
    #
    # Schema:
    #   [
    #     {"label": "Nepali momo plate", "price_dkk": 60},
    #     {"label": "Chai",              "price_dkk": 20},
    #   ]
    addons: Mapped[list | None] = mapped_column(
        JSON().with_variant(JSONB, "postgresql"), nullable=True,
    )

    # Refund policy. Default 'organizer' (manual per-booking approval
    # — Sudip's mental model). 'no_refund' / '7day' are explicit
    # opt-ins. Surfaced on the visitor checkout page (L10 honest
    # claim — visitor knows the rules before paying).
    refund_policy: Mapped[str] = mapped_column(
        String(20), nullable=False, default="organizer",
    )

    # Optional URL to the organizer's terms-of-booking page. Surfaced
    # as a "Læs vilkår" link on the checkout step. NULL = use BonBox
    # default Danish T&Cs (rendered by the frontend).
    booking_terms_url: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Soft-delete — see module docstring. The flag is independent of
    # whether sales linked to this event still exist; soft-deleting an
    # event keeps the historical Sale.event_id FK intact so the
    # accountant-grade PDFs still show "Sale was tied to event X".
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now,
    )

    user: Mapped["User"] = relationship()  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<Event {self.name} @ {self.event_date}>"
