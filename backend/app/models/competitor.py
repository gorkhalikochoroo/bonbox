"""Competitor model — track nearby competitors and their pricing."""

import uuid
from datetime import datetime, date

from sqlalchemy import String, DateTime, Date, Numeric, Text, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class Competitor(Base):
    __tablename__ = "competitors"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(255))
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)  # cafe, restaurant, etc.
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship()
    price_checks: Mapped[list["CompetitorPrice"]] = relationship(back_populates="competitor", cascade="all, delete-orphan")


class CompetitorPrice(Base):
    __tablename__ = "competitor_prices"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    competitor_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("competitors.id", ondelete="CASCADE"))
    item_name: Mapped[str] = mapped_column(String(255))
    their_price: Mapped[float] = mapped_column(Numeric(12, 2))
    our_price: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    date_checked: Mapped[date] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    competitor: Mapped["Competitor"] = relationship(back_populates="price_checks")
