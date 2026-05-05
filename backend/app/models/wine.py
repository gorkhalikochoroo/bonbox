"""Wine catalog model — wine list management with stock, margins, and tasting notes."""

import uuid
from datetime import datetime

from sqlalchemy import (
    String, DateTime, Date, Numeric, Text, Boolean, Integer, ForeignKey,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


WINE_TYPES = ("red", "white", "rosé", "sparkling", "natural", "dessert", "orange")


class Wine(Base):
    """Single wine entry — combines catalog info + inventory in one table."""
    __tablename__ = "wines"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    branch_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True,
    )

    # ── Catalog ──────────────────────────────────────────────
    name: Mapped[str] = mapped_column(String(255))
    menu_name: Mapped[str | None] = mapped_column(String(255), nullable=True)  # Display name on printed menu
    winery: Mapped[str | None] = mapped_column(String(255), nullable=True)
    vintage: Mapped[int | None] = mapped_column(Integer, nullable=True)
    grape_variety: Mapped[str | None] = mapped_column(String(255), nullable=True)
    region: Mapped[str | None] = mapped_column(String(255), nullable=True)
    country: Mapped[str | None] = mapped_column(String(255), nullable=True)
    wine_type: Mapped[str] = mapped_column(String(30), default="red")  # red | white | rosé | sparkling | natural | dessert | orange
    tasting_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    food_pairing: Mapped[str | None] = mapped_column(Text, nullable=True)
    staff_description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── Inventory / Pricing ──────────────────────────────────
    cost_price: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    sell_price: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    glass_price: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)  # By-the-glass price
    margin_pct: Mapped[float] = mapped_column(Numeric(5, 1), default=0)
    stock_qty: Mapped[int] = mapped_column(Integer, default=0)
    reorder_level: Mapped[int] = mapped_column(Integer, default=2)
    supplier: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # ── Meta ─────────────────────────────────────────────────
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )


class WineSale(Base):
    """Individual wine sale event — tracks which wines sell and when."""
    __tablename__ = "wine_sales"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    wine_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("wines.id"))
    branch_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True,
    )
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    # "bottle" or "glass" — for glass sales, quantity is glasses and stock is
    # decremented by ceil(quantity / glasses_per_bottle). Default "bottle"
    # preserves legacy behaviour for any pre-existing rows.
    unit_type: Mapped[str] = mapped_column(String(10), default="bottle")
    sale_price: Mapped[float] = mapped_column(Numeric(12, 2))
    sold_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
