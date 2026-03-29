import uuid
from datetime import date, datetime

from sqlalchemy import String, Date, DateTime, Numeric, Text, Boolean, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class SickCall(Base):
    __tablename__ = "sick_calls"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_name: Mapped[str] = mapped_column(String(255))
    date: Mapped[date] = mapped_column(Date)
    weather_condition: Mapped[str | None] = mapped_column(String(50), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
