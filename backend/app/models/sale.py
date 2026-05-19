import uuid
from datetime import date, datetime

from sqlalchemy import String, Date, DateTime, Numeric, Text, Boolean, ForeignKey, Index, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class Sale(Base):
    __tablename__ = "sales"
    __table_args__ = (
        Index("ix_sale_user_date", "user_id", "date", "is_deleted"),
        Index("ix_sale_user_payment", "user_id", "payment_method", "date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    branch_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True)
    # Optional terminal scoping. When the venue has multiple POS stations
    # (Mirabelle has 4) each sale can be tagged with which terminal rang
    # it up — enables per-terminal revenue / staff productivity reports.
    # Auto-routed by terminal_inference.find_terminal_for_label() when
    # the sale source carries a terminal label (POS exports, kasserapport
    # ingest). NULL is fine — most owners are single-terminal and never
    # set this. ondelete=SET NULL so deleting a terminal preserves the
    # historical sale.
    terminal_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("terminals.id", ondelete="SET NULL"), nullable=True, index=True,
    )
    date: Mapped[date] = mapped_column(Date)
    amount: Mapped[float] = mapped_column(Numeric(12, 2))
    payment_method: Mapped[str] = mapped_column(String(20), default="mixed")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Stores either a local filepath (dev) or a Supabase signed URL (prod).
    # Signed URLs include a JWT token and run ~700 chars total — TEXT, not
    # VARCHAR(500), so the long URL doesn't overflow on insert.
    receipt_photo: Mapped[str | None] = mapped_column(Text, nullable=True)
    reference_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Bilagsnummer — sequential voucher number per fiscal year per user.
    # Required by Bogføringsloven 2024 (DK Bookkeeping Act): every transaction
    # must have a unique sequential ID with no gaps. Format: 4-digit per year
    # (e.g. S-2026-0001). Auto-allocated on creation by voucher_service.
    voucher_number: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    # ── Danish restaurant operations ────────────────────────────────────
    # Modeled after the Sticks'n'Sushi Property Financial Report. Most Danish
    # restaurants split revenue across 4-6 channels and need per-channel
    # reporting for daily close + bookkeeping export.
    #
    # Channels: dine_in | takeaway | wolt | uber_eats | foodora | web | phone | catering | other
    # Legacy: just_eat (closed DK 2024) — historical rows preserved, not new-selectable.
    # Default 'dine_in' is safe for non-restaurant businesses (retail, etc.)
    # who never set this field — the dashboard treats it as plain revenue.
    order_channel: Mapped[str] = mapped_column(String(20), default="dine_in")
    # Number of guests/covers for in-restaurant orders — drives per-guest
    # average ($AV per GST in Aloha/Restwave reports). Null = no cover info.
    guest_count: Mapped[int | None] = mapped_column(nullable=True)
    # Service charge ("drikkepenge" auto-added in some Danish venues). Stored
    # separately so reports can show "ex-service-charge" gross sales.
    service_charge_amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    # Discount applied to this sale (gift card, manager comp, loyalty)
    discount_amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    # Operational exception flags — used for Voids/Manager-Voids/Error-Correct ladder
    is_void: Mapped[bool] = mapped_column(Boolean, default=False)
    is_manager_void: Mapped[bool] = mapped_column(Boolean, default=False)
    is_error_correct: Mapped[bool] = mapped_column(Boolean, default=False)
    # Item sale fields (linked to inventory)
    inventory_item_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("inventory_items.id", ondelete="SET NULL"), nullable=True)
    quantity_sold: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    unit_price: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    cost_at_sale: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    item_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_tax_exempt: Mapped[bool] = mapped_column(Boolean, default=False)
    # Return / exchange tracking
    status: Mapped[str] = mapped_column(String(20), default="completed")  # completed | returned | exchanged | return-pending
    return_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    return_action: Mapped[str | None] = mapped_column(String(20), nullable=True)  # refund | replace | exchange | restock
    return_amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    returned_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Soft delete
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Faktura linkage — populated when bank-import or manual-match links this
    # Sale to an outgoing Invoice. Used by revenue queries to dedupe:
    # Sale.invoice_id IS NOT NULL → invoice is the source-of-truth revenue
    # event (accrual basis, recognized on issue_date) and this Sale exists
    # only as a payment receipt, not as revenue. Migration 034.
    invoice_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("invoices.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    user: Mapped["User"] = relationship(back_populates="sales")
