import uuid
from datetime import date, datetime

from sqlalchemy import String, Date, DateTime, Numeric, Integer, Text, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class StaffingRule(Base):
    """Defines how many staff are needed at different revenue levels."""
    __tablename__ = "staffing_rules"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    label: Mapped[str] = mapped_column(String(50))  # e.g. "Slow", "Normal", "Busy"
    revenue_min: Mapped[float] = mapped_column(Numeric(12, 2))  # lower bound
    revenue_max: Mapped[float] = mapped_column(Numeric(12, 2))  # upper bound
    recommended_staff: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship()


class DailyStaffing(Base):
    """Log actual staff count per day for revenue-per-staff analysis."""
    __tablename__ = "daily_staffing"
    __table_args__ = (
        UniqueConstraint("user_id", "date", name="uq_daily_staffing_user_date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    date: Mapped[date] = mapped_column(Date, nullable=False)
    staff_count: Mapped[int] = mapped_column(Integer, nullable=False)
    total_hours: Mapped[float | None] = mapped_column(Numeric(6, 1), nullable=True)
    labor_cost: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
