import uuid
from datetime import date, datetime
from typing import Optional

from sqlalchemy import String, Boolean, Date, DateTime, Numeric, ForeignKey, Text, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class InventoryItem(Base):
    __tablename__ = "inventory_items"
    __table_args__ = (
        Index("ix_inventory_user_stock", "user_id", "quantity", "min_threshold"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    branch_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True)
    name: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    unit: Mapped[str] = mapped_column(String(20), default="pieces")
    cost_per_unit: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    min_threshold: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    category: Mapped[Optional[str]] = mapped_column(Text, default="General")
    sell_price: Mapped[Optional[float]] = mapped_column(Numeric(12, 2), nullable=True)
    sell_unit: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)        # e.g. "pieces" when stocked in "dozen"
    pieces_per_unit: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)  # e.g. 12 for dozen->pieces
    barcode: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    expiry_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    image_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    is_perishable: Mapped[bool] = mapped_column(Boolean, default=False)
    bottle_size: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)   # e.g. 750 ml per bottle
    pour_size: Mapped[Optional[float]] = mapped_column(Numeric(10, 2), nullable=True)     # e.g. 30 ml per shot
    pour_unit: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)           # e.g. "ml", "cl"
    sell_price_per_pour: Mapped[Optional[float]] = mapped_column(Numeric(12, 2), nullable=True)  # price per glass/shot
    # ── Smart Inventory consumption metadata (May 2026) ──
    # Powers the "auto-decrement stock when sales happen" + "predict
    # depletion timing" features. Same item-shape works across verticals:
    #
    #   Cafe coffee bag:
    #     unit="kg", quantity=5, consumption_pattern="per_serving",
    #     consumption_unit="g", serving_size=20,
    #     usage_keywords="espresso,cappuccino,latte,americano"
    #     → 5kg = 5000g = 250 espressos worth.
    #
    #   Bar gin bottle (already covered by bottle_size+pour_size, but
    #   the new fields express the same model uniformly):
    #     consumption_pattern="per_pour", serving_size=30 (overrides
    #     pour_size if both set; new fields win).
    #
    #   Restaurant flour:
    #     consumption_pattern="per_dish", consumption_unit="g",
    #     serving_size=120 (per pizza), usage_keywords="pizza,bread"
    #
    #   Hair salon shampoo:
    #     consumption_pattern="per_service", consumption_unit="ml",
    #     serving_size=15, usage_keywords="cut,wash"
    #
    #   Cleaning cloth pack:
    #     consumption_pattern="per_use", consumption_unit="pieces",
    #     serving_size=1
    #
    # All four fields are optional — items without them stay on the
    # legacy quantity-tracking path. The smart auto-decrement service
    # only activates when consumption_pattern is set + usage_keywords
    # match the Sale.item_name.
    consumption_pattern: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    consumption_unit: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    serving_size: Mapped[Optional[float]] = mapped_column(Numeric(12, 4), nullable=True)
    # Comma-separated keywords. Matched (case-insensitive substring) against
    # Sale.item_name to auto-decrement stock. Bounded to 500 chars at the
    # schema layer. Stored as text rather than a join table because the
    # vocabulary is owner-private + small (≤20 keywords typical).
    usage_keywords: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
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
    batch_id: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    item: Mapped["InventoryItem"] = relationship(back_populates="logs")


class InventoryTemplate(Base):
    __tablename__ = "inventory_templates"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    template_name: Mapped[str] = mapped_column(Text)
    template_type: Mapped[str] = mapped_column(Text)
    item_name: Mapped[str] = mapped_column(Text)
    default_unit: Mapped[str] = mapped_column(Text, default="pcs")
    default_category: Mapped[str] = mapped_column(Text, default="General")
    is_perishable: Mapped[bool] = mapped_column(Boolean, default=False)
    default_reorder_level: Mapped[int] = mapped_column(default=5)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
