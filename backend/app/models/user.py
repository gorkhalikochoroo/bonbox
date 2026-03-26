import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Numeric, Boolean
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
    reset_token: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reset_token_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    sales: Mapped[list["Sale"]] = relationship(back_populates="user")
    expense_categories: Mapped[list["ExpenseCategory"]] = relationship(back_populates="user")
    expenses: Mapped[list["Expense"]] = relationship(back_populates="user")
    inventory_items: Mapped[list["InventoryItem"]] = relationship(back_populates="user")
