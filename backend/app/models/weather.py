import uuid
from datetime import date, datetime

from sqlalchemy import String, Date, DateTime, Numeric, Text, Boolean, ForeignKey, Integer, UniqueConstraint
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


class DailyWeather(Base):
    """Store historical weather per user/location per day for correlation analysis."""
    __tablename__ = "daily_weather"
    __table_args__ = (
        UniqueConstraint("user_id", "date", name="uq_daily_weather_user_date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    date: Mapped[date] = mapped_column(Date, nullable=False)
    temp_max: Mapped[float | None] = mapped_column(Numeric(5, 1), nullable=True)
    temp_min: Mapped[float | None] = mapped_column(Numeric(5, 1), nullable=True)
    rain_mm: Mapped[float | None] = mapped_column(Numeric(6, 1), default=0)
    wind_max_kmh: Mapped[float | None] = mapped_column(Numeric(5, 1), nullable=True)
    weather_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    condition: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
