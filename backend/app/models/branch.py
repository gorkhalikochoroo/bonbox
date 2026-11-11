"""Branch model — allows one owner account to manage multiple locations with separate bookkeeping.

Each branch can have its own business_type so a single owner can run a café AND
an auto-workshop (or retail shop, etc.) under one login.  The sidebar, daily-close
defaults, and KPI cards adapt based on the active branch's type.
"""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Text, Boolean, ForeignKey, Float
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now

# Allowed business types — expand as needed
BUSINESS_TYPES = ("restaurant", "workshop", "retail", "grocery", "ecommerce", "service", "general")


class Branch(Base):
    __tablename__ = "branches"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))  # owner
    name: Mapped[str] = mapped_column(String(255))
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    business_type: Mapped[str] = mapped_column(String(50), default="general")  # restaurant | workshop | retail | service | general
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Migration 085 — the location's own map pin, same meaning as
    # BusinessProfile.venue_* (see there). NULL = use the venue's pin. Reset
    # when the address changes (models/venue_map.py listener).
    geo_lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    geo_lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    geo_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    geo_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    geo_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    user: Mapped["User"] = relationship()
