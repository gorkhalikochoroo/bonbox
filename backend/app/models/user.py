import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Numeric, Boolean, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    business_name: Mapped[str] = mapped_column(String(255))
    business_type: Mapped[str] = mapped_column(String(50), default="restaurant")
    currency: Mapped[str] = mapped_column(String(10), default="DKK")
    daily_goal: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    monthly_goal: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    daily_digest_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    expense_alerts_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # GDPR — owner can opt out of product analytics (event_log writes).
    # Default OFF (analytics ON) under legitimate-interest basis; user can flip
    # at any time via Profile → Privacy. When True, no events are persisted.
    analytics_opt_out: Mapped[bool] = mapped_column(Boolean, default=False)
    latitude: Mapped[float | None] = mapped_column(Numeric(10, 6), nullable=True)
    longitude: Mapped[float | None] = mapped_column(Numeric(10, 6), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="owner")  # owner | manager | cashier | viewer
    # IANA timezone identifier (e.g. "Europe/Copenhagen"). Used for "today",
    # "this week" computations so anomaly detection doesn't fire false
    # positives when UTC midnight rolls over but it's still business hours
    # locally. Default Copenhagen since most users are Danish.
    timezone: Mapped[str] = mapped_column(String(64), default="Europe/Copenhagen")
    # Subscription / trial state.
    #   trial_ends_at: when the auto-started 14-day Pro trial expires.
    #     null = no trial (legacy users) — they keep Free indefinitely.
    #   plan: free | trial | pro | business
    #     Source of truth for what features the user can access. Once
    #     payments are wired, the upgrade flow flips this to "pro".
    trial_ends_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    plan: Mapped[str] = mapped_column(String(20), default="free")
    owner_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)  # NULL for owners
    reset_token: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reset_token_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verification_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    verification_code_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    sales: Mapped[list["Sale"]] = relationship(back_populates="user")
    expense_categories: Mapped[list["ExpenseCategory"]] = relationship(back_populates="user")
    expenses: Mapped[list["Expense"]] = relationship(back_populates="user")
    inventory_items: Mapped[list["InventoryItem"]] = relationship(back_populates="user")
