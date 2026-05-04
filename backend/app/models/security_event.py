import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Text, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class SecurityEvent(Base):
    """
    Audit log for security-sensitive events (admin access attempts, role
    elevation attempts, suspicious activity). Never written from user input —
    only from server-side guards. Read-only from the application's perspective
    (no UPDATE / DELETE endpoints).
    """

    __tablename__ = "security_events"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=True, index=True
    )
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    # Examples:
    #   admin_access_granted
    #   admin_denied_wrong_role
    #   admin_denied_email_mismatch
    #   admin_denied_email_unverified
    #   admin_denied_account_too_new
    #   admin_denied_no_allowlist
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, index=True
    )

    __table_args__ = (
        Index("ix_security_events_event_created", "event_type", "created_at"),
    )
