import uuid
from datetime import date, datetime

from sqlalchemy import String, Date, DateTime, Numeric, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class InventoryItem(Base):
    __tablename__ = "inventory_items"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    unit: Mapped[str] = mapped_column(String(20), default="pieces")
    cost_per_unit: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    min_threshold: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    user: Mapped["User"] = relationship(back_populates="inventory_items")
    logs: Mapped[list["InventoryLog"]] = relationship(back_populates="item")


class InventoryLog(Base):
    __tablename__ = "inventory_logs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    item_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("inventory_items.id"))
    change_qty: Mapped[float] = mapped_column(Numeric(10, 2))
    reason: Mapped[str] = mapped_column(String(50), default="adjustment")
    date: Mapped[date] = mapped_column(Date)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    item: Mapped["InventoryItem"] = relationship(back_populates="logs")
