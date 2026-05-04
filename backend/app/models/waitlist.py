import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class WaitlistEntry(Base):
    """
    Capture interest in paid tiers (founding-member Pro, etc.) before
    payment processing is wired. Each entry records:
      - which user (if logged in) or email (if anonymous)
      - which tier they're interested in
      - source page (subscription / dashboard banner / etc.)
      - timestamp

    No PII beyond an email is stored. When a tier launches we email
    waitlist members in chronological order so they can lock in
    founding pricing.
    """

    __tablename__ = "waitlist_entries"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=True, index=True
    )
    email: Mapped[str] = mapped_column(String(255), index=True)
    tier: Mapped[str] = mapped_column(String(32))  # free | starter | pro | business
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)
    notes: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    __table_args__ = (
        Index("ix_waitlist_email_tier", "email", "tier"),
    )
