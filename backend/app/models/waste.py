import uuid
from datetime import date, datetime

from sqlalchemy import String, Date, DateTime, Numeric, Text, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class WasteLog(Base):
    __tablename__ = "waste_logs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    date: Mapped[date] = mapped_column(Date)
    item_name: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[float] = mapped_column(Numeric(10, 2))
    unit: Mapped[str] = mapped_column(String(20), default="kg")
    estimated_cost: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    reason: Mapped[str] = mapped_column(String(50), default="expired")  # expired, overcooked, damaged, other
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship()
