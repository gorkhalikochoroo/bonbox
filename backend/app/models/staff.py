"""Staff Module models — staff members, schedules, hours, tips."""

import uuid
from datetime import date, datetime
from typing import Optional

from sqlalchemy import (
    String, Boolean, Date, DateTime, Numeric, ForeignKey, Text, Integer,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class StaffMember(Base):
    __tablename__ = "staff_members"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(255))
    phone: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    role: Mapped[str] = mapped_column(String(50), default="server")
    contract_type: Mapped[str] = mapped_column(String(20), default="full")
    base_rate: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    evening_rate: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    weekend_rate: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    holiday_rate: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    max_hours_month: Mapped[Optional[float]] = mapped_column(Numeric(6, 1), nullable=True)
    max_hours_week: Mapped[Optional[float]] = mapped_column(Numeric(5, 1), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    schedules: Mapped[list["Schedule"]] = relationship(back_populates="staff_member")
    hours_logged: Mapped[list["HoursLogged"]] = relationship(back_populates="staff_member")
    tip_distributions: Mapped[list["TipDistribution"]] = relationship(back_populates="staff_member")


class PayPeriodConfig(Base):
    __tablename__ = "pay_period_configs"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_pay_period_config_user"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), unique=True)
    period_type: Mapped[str] = mapped_column(String(20), nullable=False)
    custom_start_day: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class Schedule(Base):
    __tablename__ = "schedules"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    date: Mapped[date] = mapped_column(Date)
    start_time: Mapped[str] = mapped_column(String(5))
    end_time: Mapped[str] = mapped_column(String(5))
    break_minutes: Mapped[int] = mapped_column(Integer, default=0)
    role_on_shift: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="draft")
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    staff_member: Mapped["StaffMember"] = relationship(back_populates="schedules")


class HoursLogged(Base):
    __tablename__ = "hours_logged"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    date: Mapped[date] = mapped_column(Date)
    start_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)
    end_time: Mapped[Optional[str]] = mapped_column(String(5), nullable=True)
    break_minutes: Mapped[int] = mapped_column(Integer, default=0)
    total_hours: Mapped[float] = mapped_column(Numeric(5, 1))
    rate_applied: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    earned: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)
    entry_method: Mapped[str] = mapped_column(String(20), default="quick")
    is_overtime: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    staff_member: Mapped["StaffMember"] = relationship(back_populates="hours_logged")


class Tip(Base):
    __tablename__ = "tips"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    date: Mapped[date] = mapped_column(Date)
    total_amount: Mapped[float] = mapped_column(Numeric(10, 2))
    split_method: Mapped[str] = mapped_column(String(20), default="by_hours")
    confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    distributions: Mapped[list["TipDistribution"]] = relationship(
        back_populates="tip", cascade="all, delete-orphan"
    )


class TipDistribution(Base):
    __tablename__ = "tip_distributions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    tip_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("tips.id", ondelete="CASCADE")
    )
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    share_pct: Mapped[Optional[float]] = mapped_column(Numeric(5, 2), nullable=True)
    amount: Mapped[float] = mapped_column(Numeric(10, 2))

    tip: Mapped["Tip"] = relationship(back_populates="distributions")
    staff_member: Mapped["StaffMember"] = relationship(back_populates="tip_distributions")


class StaffLink(Base):
    """Magic link for staff self-service portal — no login needed."""
    __tablename__ = "staff_links"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    pin_hash: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_accessed: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
