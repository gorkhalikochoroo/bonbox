import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Numeric, Integer, ForeignKey
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
