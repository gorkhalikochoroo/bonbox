"""
Automobile Workshop models — Vehicle, JobCard, JobCardPart, JobCardLabor.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Date, DateTime, Numeric, String, Text, Boolean, Integer,
    ForeignKey, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class Vehicle(Base):
    __tablename__ = "vehicles"
    __table_args__ = (
        UniqueConstraint("user_id", "plate_number", name="uq_vehicle_user_plate"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    branch_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True)
    plate_number: Mapped[str] = mapped_column(String(30))
    make: Mapped[str | None] = mapped_column(String(100), nullable=True)   # Toyota, Honda, Bajaj
    model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    color: Mapped[str | None] = mapped_column(String(50), nullable=True)
    customer_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    customer_phone: Mapped[str | None] = mapped_column(String(30), nullable=True)
    customer_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    customer_type: Mapped[str] = mapped_column(String(20), default="individual")  # individual | company
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    job_cards: Mapped[list["JobCard"]] = relationship(back_populates="vehicle")


class JobCard(Base):
    __tablename__ = "job_cards"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    branch_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True)
    job_number: Mapped[str] = mapped_column(String(20))  # JOB-0001
    vehicle_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("vehicles.id"))
    assigned_mechanic: Mapped[str | None] = mapped_column(String(255), nullable=True)

    status: Mapped[str] = mapped_column(String(30), default="received")
    # received → diagnosing → waiting_parts → in_progress → completed → delivered → invoiced

    complaint_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    diagnosis: Mapped[str | None] = mapped_column(Text, nullable=True)
    estimated_cost: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    final_cost: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    received_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    estimated_completion: Mapped[date | None] = mapped_column(Date, nullable=True)
    completed_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    delivered_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    invoiced_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    payment_status: Mapped[str] = mapped_column(String(20), default="unpaid")  # unpaid | partial | paid
    payment_method: Mapped[str | None] = mapped_column(String(20), nullable=True)
    amount_paid: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    vehicle: Mapped["Vehicle"] = relationship(back_populates="job_cards")
    parts: Mapped[list["JobCardPart"]] = relationship(back_populates="job_card", cascade="all, delete-orphan")
    labor: Mapped[list["JobCardLabor"]] = relationship(back_populates="job_card", cascade="all, delete-orphan")


class JobCardPart(Base):
    __tablename__ = "job_card_parts"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    job_card_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("job_cards.id", ondelete="CASCADE"))
    inventory_item_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("inventory_items.id", ondelete="SET NULL"), nullable=True)
    part_name: Mapped[str] = mapped_column(String(255))
    part_number: Mapped[str | None] = mapped_column(String(100), nullable=True)
    quantity: Mapped[float] = mapped_column(Numeric(10, 2), default=1)
    unit_cost: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    total_cost: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    is_from_stock: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    job_card: Mapped["JobCard"] = relationship(back_populates="parts")


class JobCardLabor(Base):
    __tablename__ = "job_card_labor"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    job_card_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("job_cards.id", ondelete="CASCADE"))
    description: Mapped[str] = mapped_column(Text)
    mechanic_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    hours: Mapped[float] = mapped_column(Numeric(6, 2), default=0)
    hourly_rate: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    total_cost: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    job_card: Mapped["JobCard"] = relationship(back_populates="labor")
