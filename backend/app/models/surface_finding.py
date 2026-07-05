"""
SurfaceFinding — per-slug live status for the public-surface quality monitor.

One row per public booking slug. The public_surface_monitor_job writes it every
~15 min; the super-admin panel (/admin/public-surface-health) reads it, and the
owner "Needs du nu" queue nudges off it. Detects SILENT quality defects a diner
would hit (a booking page dead for 14 days, an app-default page title) that the
crash monitor can't see because they throw nothing.

Flap columns (fail_streak / consecutive_ok / degraded_since) mirror MonitorState
so a single transient miss never flips DEGRADED. Table created by
Base.metadata.create_all on startup (registered in app/models/__init__.py) +
a canonical CREATE TABLE in main.py _migrations (belt-and-suspenders).
"""
import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Integer, Text, JSON, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class SurfaceFinding(Base):
    __tablename__ = "surface_finding"
    __table_args__ = (
        Index("ix_surface_finding_slug", "slug"),
        Index("ix_surface_finding_state", "state"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String(120), unique=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True)  # for the owner nudge join

    state: Mapped[str] = mapped_column(String(20), default="OK")     # OK | DEGRADED
    severity: Mapped[str | None] = mapped_column(String(20), nullable=True)  # urgent | warn | info
    codes: Mapped[list | None] = mapped_column(JSON, nullable=True)   # e.g. ["dead_on_arrival"]
    detail: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    fail_streak: Mapped[int] = mapped_column(Integer, default=0)
    consecutive_ok: Mapped[int] = mapped_column(Integer, default=0)
    degraded_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_scanned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
