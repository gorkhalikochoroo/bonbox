"""OrderChannelConfig — per-tenant catalogue of order channels (aggregators
and venue-internal channels) the owner accepts orders through.

Why this exists
---------------
Before this table, order-channel slugs (dine_in / wolt / uber_eats / etc.)
were hardcoded across 9 files. Adding a new aggregator (Foodpanda, Hungry.dk,
a regional player) required a code change and redeploy.

A Danish hospitality SaaS sells to restaurants across 5+ countries — each
market has its own delivery aggregator mix. Hardcoding doesn't scale.

Model
-----
One row per CUSTOM channel a tenant has added or overridden. Tenants don't
need to seed the system defaults — those live in
`services/channel_defaults.py:SYSTEM_CHANNELS` and are merged in at read
time by `GET /api/order-channels`. The table only stores:

  • Brand-new channels (slug not in SYSTEM_CHANNELS)
  • Overrides of system labels / emojis / colors

Sales rows reference channels by their slug string (`Sale.order_channel`),
NOT by FK to this table — so archive/delete here NEVER detaches historical
data. A row with `is_archived=True` is hidden from the new-sale dropdown
but its slug still resolves to a label for reports / history.

Tenant isolation
----------------
user_id NOT NULL + UNIQUE(user_id, slug) so the same slug can be defined
per-tenant. Every router query filters by user_id; no admin escape.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class OrderChannelConfig(Base):
    """Per-tenant order-channel catalogue entry (custom or override)."""

    __tablename__ = "order_channel_configs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), index=True, nullable=False
    )

    # Slug — lowercase snake_case. Used to tag Sale.order_channel and to
    # match against SYSTEM_CHANNELS for the override flow. Validated by
    # the schema (^[a-z][a-z0-9_]{1,49}$) so it's a safe URL segment AND
    # a safe Python dict key.
    slug: Mapped[str] = mapped_column(String(50), nullable=False)
    # Display label — shown in the UI; what the owner sees on the daily
    # close, channel breakdown bars, and the new-sale dropdown.
    label: Mapped[str] = mapped_column(String(100), nullable=False)
    # Optional emoji used as a visual identifier in the channel pill / bar.
    # Single grapheme; up to 8 bytes is enough for any single emoji incl.
    # zero-width-joiner sequences (e.g. flag emojis).
    emoji: Mapped[str | None] = mapped_column(String(8), nullable=True)
    # Tailwind color fragment, e.g. "stone-900". Combined client-side
    # into the full class ("bg-stone-900", "text-stone-900-foreground").
    # Stored as a fragment so the same value drives both light + dark
    # variants in the React palette helper.
    color: Mapped[str | None] = mapped_column(String(32), nullable=True, default="gray-500")
    # Render order. Lower numbers shown first; tie-break on slug for
    # deterministic ordering.
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    # Soft-delete. Once an owner has tagged sales with this channel we
    # never destroy the row — archiving hides it from new-entry dropdowns
    # while preserving attribution on historical sales.
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    __table_args__ = (
        UniqueConstraint("user_id", "slug", name="uq_order_channel_user_slug"),
    )
