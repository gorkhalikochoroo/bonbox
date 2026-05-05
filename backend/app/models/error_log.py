"""
ErrorLog — server-side observability without external dependencies.

Every uncaught 500-class exception in the API gets a row here. Surfaces
in the super-admin panel so the operator can see what's failing in
production without paying for Sentry / Datadog.

Why not Sentry?
  Solo-founder pre-launch. Sentry's free tier caps at 5K events/month
  which is fine but adds an external account, DSN env vars, and a $26/mo
  upgrade path the moment we cross the cap. Internal logging is zero
  cost, lives in the same Postgres, and we already have the SuperAdmin
  panel as the consumption surface. Upgradeable later — schema is a
  superset of what Sentry stores.
"""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Text, Integer, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class ErrorLog(Base):
    __tablename__ = "error_logs"
    __table_args__ = (
        # Most queries are "recent errors" — composite index on created_at
        Index("ix_error_logs_created", "created_at"),
        # Lookup by user is occasional — separate index, sparse since most
        # rows are anonymous (auth failure, public probe, etc.)
        Index("ix_error_logs_user", "user_id"),
        # Filtering by status_code is common in admin UI
        Index("ix_error_logs_status", "status_code"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # HTTP context
    method: Mapped[str | None] = mapped_column(String(10), nullable=True)
    path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    status_code: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Who hit it (NULL when unauthenticated or pre-auth)
    user_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # The error itself
    error_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # First N lines of traceback — full stack is too noisy for the panel UI
    traceback: Mapped[str | None] = mapped_column(Text, nullable=True)
