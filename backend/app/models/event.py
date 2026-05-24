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

from sqlalchemy import String, Date, DateTime, Text, Boolean, ForeignKey, Index
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
