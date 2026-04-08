"""Branch model — allows one owner account to manage multiple locations with separate bookkeeping.

Each branch can have its own business_type so a single owner can run a café AND
an auto-workshop (or retail shop, etc.) under one login.  The sidebar, daily-close
defaults, and KPI cards adapt based on the active branch's type.
"""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Text, Boolean, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID

# Allowed business types — expand as needed
BUSINESS_TYPES = ("restaurant", "workshop", "retail", "service", "general")


class Branch(Base):
    __tablename__ = "branches"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))  # owner
    name: Mapped[str] = mapped_column(String(255))
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    business_type: Mapped[str] = mapped_column(String(50), default="general")  # restaurant | workshop | retail | service | general
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    user: Mapped["User"] = relationship()
