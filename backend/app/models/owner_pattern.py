"""
OwnerPattern — detected behavioural / business patterns per user.

Detected by the owner_patterns service (cheap statistics first, optional Claude
analysis second). Each pattern is a recommendation that has been computed for a
specific owner from their recent activity. The 👍 / 👎 feedback column doubles
as a thesis instrument for RQ1 (which feature signals predict retention).

Patterns are write-only from the AI side and read+feedback from the user side.
There are intentionally no general edit endpoints — patterns are immutable once
detected; users can only dismiss / mark useful / mark acted.
"""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Text, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class OwnerPattern(Base):
    __tablename__ = "owner_patterns"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    # Type of pattern detected. Add new ones here as the engine grows.
    #   usage_routine        — recurring time-of-day / day-of-week behaviour
    #   revenue_anomaly      — today's revenue diverges materially from historical baseline
    #   expense_spike        — expense category up materially vs trailing window
    #   dormant_feature      — owner used a feature historically but stopped
    #   inventory_low_repeat — same item repeatedly low (chronic underordering)
    #   wage_pct_anomaly     — wage / revenue ratio spike
    pattern_type: Mapped[str] = mapped_column(String(64), index=True)

    # info | warning | critical — drives UI tone
    severity: Mapped[str] = mapped_column(String(20), default="info")

    title: Mapped[str] = mapped_column(String(200))
    detail: Mapped[str] = mapped_column(Text)
    suggested_action: Mapped[str | None] = mapped_column(Text, nullable=True)

    detected_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    # When this pattern's recommendation goes stale (e.g. a daily revenue
    # anomaly is irrelevant after 24h)
    valid_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # active | dismissed | acted | expired
    state: Mapped[str] = mapped_column(String(20), default="active", index=True)

    # User feedback — RQ1 thesis signal
    # null | "useful" | "not_useful"
    feedback: Mapped[str | None] = mapped_column(String(20), nullable=True)
    feedback_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # JSON-serialised raw data the pattern was computed from (kept short).
    # Stored as TEXT so we don't depend on a JSON column type.
    raw_data: Mapped[str | None] = mapped_column(Text, nullable=True)

    __table_args__ = (
        Index("ix_owner_patterns_user_state", "user_id", "state"),
        Index("ix_owner_patterns_user_type", "user_id", "pattern_type"),
    )
