import uuid
from datetime import date, datetime

from sqlalchemy import String, Date, DateTime, Numeric, Boolean, Text, ForeignKey, Index, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class ExpenseCategory(Base):
    __tablename__ = "expense_categories"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[str] = mapped_column(String(7), default="#3B82F6")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    user: Mapped["User"] = relationship(back_populates="expense_categories")
    expenses: Mapped[list["Expense"]] = relationship(back_populates="category")


class Expense(Base):
    __tablename__ = "expenses"
    __table_args__ = (
        Index("ix_expense_user_date", "user_id", "date", "is_deleted"),
        Index("ix_expense_user_category", "user_id", "category_id", "date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    category_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("expense_categories.id"))
    branch_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True)
    date: Mapped[date] = mapped_column(Date)
    amount: Mapped[float] = mapped_column(Numeric(12, 2))
    description: Mapped[str] = mapped_column(String(255))
    is_recurring: Mapped[bool] = mapped_column(Boolean, default=False)
    payment_method: Mapped[str | None] = mapped_column(String(20), nullable=True, default="card")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_personal: Mapped[bool] = mapped_column(Boolean, default=False)
    reference_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Bilagsnummer — sequential voucher per fiscal year per user (DK
    # Bogføringsloven 2024 compliance). Auto-allocated on creation.
    voucher_number: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    is_tax_exempt: Mapped[bool] = mapped_column(Boolean, default=False)
    # Path / URL to the receipt photo (when this expense came from a Snap
    # Receipt OCR upload, or was manually attached later). The DB column
    # already exists via the IF NOT EXISTS migration — we just expose it
    # in the model so the create + read paths can populate / surface it.
    # VARCHAR(500) at the SQL level matches the migration in main.py.
    receipt_photo: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # 'scan' = receipt came from an OCR scan (counts toward the monthly scan
    # cap); 'attach' = bilag stapled onto an existing row (no OCR → excluded
    # from the cap); NULL = legacy/scan-created (counts, conservative).
    receipt_source: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Godkend-kø gate: 'approved' = a real, owner-confirmed expense that
    # enters MOMS/Foresight/reports; 'pending' = an AI-proposed draft (snap,
    # forwarded email, recurring) the owner has NOT yet approved — it must
    # stay OUT of every money total until a human taps Godkend. Defaults to
    # 'approved' so all legacy + manually-entered rows are live (NULL also
    # coalesces to 'approved' in the shared not_pending() gate). See
    # app/services/expense_status.py.
    status: Mapped[str | None] = mapped_column(String(12), nullable=True, default="approved")
    # ── Foreign-currency capture (migration 014) ──────────────────────
    # Bogføringsloven §10 / SKAT cross-border guidance requires the
    # original-currency record to be retained alongside the DKK
    # conversion. `amount` (above) STAYS in the user's account currency
    # so all existing MOMS math, dashboards, and bilag-voucher logic
    # keep working byte-for-byte for single-currency entries.
    #
    # Semantics:
    #   • Null `currency` ⇒ amount is implicitly in the account
    #     currency (default for every legacy row).
    #   • Non-null `currency` that DIFFERS from the account currency
    #     ⇒ `fx_rate` and `original_amount` are also populated. The
    #     router enforces the three-fields-together rule on write.
    #   • `fx_rate` precision is 10,6 because DKK/NPR rates run ~0.05;
    #     4 decimals isn't enough headroom for low-value currencies.
    #   • `original_amount` precision is 14,2 — comfortably above any
    #     realistic SMB cross-border invoice in any currency.
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    fx_rate: Mapped[float | None] = mapped_column(Numeric(10, 6), nullable=True)
    original_amount: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    user: Mapped["User"] = relationship(back_populates="expenses")
    category: Mapped["ExpenseCategory"] = relationship(back_populates="expenses")
