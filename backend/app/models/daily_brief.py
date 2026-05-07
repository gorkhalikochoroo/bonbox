"""DailyBrief — cached AI-generated daily summary per user.

One row per (user, brief_date). The brief is generated on-demand the first
time the user hits /api/dashboard/daily-brief on a given day, then served
from this cache for the rest of the day. Regenerating ON EVERY page load
would burn AI tokens for no gain — the underlying business stats only
change a few times per day.

Brief storage is plain JSON in the payload column so the schema can evolve
(more candidate types, weather context, etc.) without requiring migrations.
The model field records which Claude model produced this row, so we can
A/B test or roll out new models per-user later.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, String, Text, ForeignKey, UniqueConstraint, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class DailyBrief(Base):
    __tablename__ = "daily_briefs"
    __table_args__ = (
        UniqueConstraint("user_id", "brief_date", name="uq_daily_brief_user_date"),
        Index("ix_daily_brief_user_date", "user_id", "brief_date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    brief_date: Mapped[date] = mapped_column(Date)
    payload_json: Mapped[str] = mapped_column(Text)
    # Plan tier the brief was generated under — useful for cost analysis and
    # for showing "Upgrade for AI polish" hints to free users on cached briefs
    tier: Mapped[str] = mapped_column(String(16), default="free")
    # Which model produced this row. "deterministic" for free-tier no-LLM briefs.
    model: Mapped[str] = mapped_column(String(64), default="deterministic")
    # Token usage — null when LLM was skipped due to cap. Used for cost tracking.
    input_tokens: Mapped[int | None] = mapped_column(default=None, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(default=None, nullable=True)
    # How many times this brief was regenerated today. Used to enforce the
    # per-tier daily refresh cap (free=0, pro=5). Auto-generation on first
    # visit doesn't count — only explicit refresh calls do.
    refresh_count: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)
