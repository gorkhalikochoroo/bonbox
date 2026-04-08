"""Daily Close (Kasserapport) model — structured end-of-day reporting."""

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Numeric, String, Text, Boolean, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class DailyClose(Base):
    __tablename__ = "daily_closes"
    __table_args__ = (
        UniqueConstraint("user_id", "branch_id", "date", name="uq_daily_close_user_branch_date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    branch_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True)
    date: Mapped[date] = mapped_column(Date)

    # Revenue breakdown — stored as pipe-delimited key:value pairs for SQLite compat
    # e.g. "food:12400|drinks:5800|takeaway:1200"
    revenue_categories: Mapped[str | None] = mapped_column(Text, nullable=True)
    revenue_total: Mapped[float] = mapped_column(Numeric(12, 2), default=0)

    # Payment breakdown — same format
    # e.g. "cash:4200|card:13500|mobilepay:3150"
    payment_categories: Mapped[str | None] = mapped_column(Text, nullable=True)
    payment_total: Mapped[float] = mapped_column(Numeric(12, 2), default=0)

    # Cash drawer
    cash_expected: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    cash_counted: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    cash_difference: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    # Tips
    tips_total: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    tips_staff_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tips_per_person: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    # Meta
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    closed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Soft delete
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


def encode_breakdown(data: dict | None) -> str | None:
    """Convert dict like {"food": 12400, "drinks": 5800} to pipe-delimited string."""
    if not data:
        return None
    return "|".join(f"{k}:{v}" for k, v in data.items() if v)


def decode_breakdown(raw: str | None) -> dict:
    """Convert pipe-delimited string back to dict."""
    if not raw:
        return {}
    result = {}
    for pair in raw.split("|"):
        if ":" in pair:
            key, val = pair.split(":", 1)
            try:
                result[key.strip()] = round(float(val.strip()), 2)
            except ValueError:
                pass
    return result
