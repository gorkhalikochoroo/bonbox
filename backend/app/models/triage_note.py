"""TriageNote — AI-generated first-responder summary for an error group.

When a new (or resurgent) error fingerprint is detected, the triage
service writes a row here capturing:
  • the fingerprint (so we don't re-triage the same error endlessly)
  • the count of occurrences in the scan window
  • the AI's probable cause / blast radius / suggested actions
  • a pointer to a representative ErrorLog row for drill-down

The "fingerprint cooldown" (default 24h) prevents email spam: even if
the same error keeps firing, we only email once per fingerprint per
cooldown period, and bump `latest_count` / `latest_seen_at` on
re-detection.
"""
import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Text, Integer, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class TriageNote(Base):
    __tablename__ = "triage_notes"
    __table_args__ = (
        Index("ix_triage_fingerprint", "fingerprint"),
        Index("ix_triage_created", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # 16-char hex hash of (error_type | path_template | top_traceback_line).
    # The dedupe key — same shape error reuses the same fingerprint regardless
    # of which user / ID / timestamp triggered it.
    fingerprint: Mapped[str] = mapped_column(String(32), index=True)

    # Severity: "low" | "medium" | "high" | "critical"
    severity: Mapped[str] = mapped_column(String(16), default="medium")
    error_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    path_template: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sample_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    # AI output — already sanitized + length-capped before storage.
    probable_cause: Mapped[str] = mapped_column(Text, default="")
    blast_radius: Mapped[str] = mapped_column(Text, default="")
    suggested_actions: Mapped[str] = mapped_column(Text, default="")
    polished_by_ai: Mapped[bool] = mapped_column(default=False)

    # Pointer to a representative error_log row — admin can click through
    sample_error_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True)

    # Window stats — how many occurrences within the scan that produced this note
    occurrence_count: Mapped[int] = mapped_column(Integer, default=1)
    affected_users: Mapped[int] = mapped_column(Integer, default=0)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    latest_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    # Whether the admin email was sent (so we can verify in the panel)
    email_sent: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
