"""
MonitorState — singleton live status for background synthetic monitors.

One row per monitored service (today: "frontend_prod"). The prod frontend
monitor (jobs/frontend_monitor_job) reads/writes this every 5 min so the
super-admin panel can render "prod frontend: healthy / BROKEN since HH:MM".

fail_streak / consecutive_ok live HERE, not in process memory, so a Render
dyno restart mid-incident doesn't reset the flap counters (survives cold-start
cycling). The table is created by Base.metadata.create_all on startup — it is
registered in app/models/__init__.py so the metadata sees it.
"""
from datetime import datetime

from sqlalchemy import String, DateTime, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class MonitorState(Base):
    __tablename__ = "monitor_state"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    service: Mapped[str] = mapped_column(String(50), unique=True, default="frontend_prod")
    state: Mapped[str] = mapped_column(String(20), default="HEALTHY")  # HEALTHY | BROKEN
    fail_streak: Mapped[int] = mapped_column(Integer, default=0)
    consecutive_ok: Mapped[int] = mapped_column(Integer, default=0)
    broken_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_check_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_alert_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    incident_entry: Mapped[str | None] = mapped_column(String(120), nullable=True)
    incident_chunk: Mapped[str | None] = mapped_column(String(120), nullable=True)
    last_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
