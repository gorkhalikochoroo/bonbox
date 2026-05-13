"""
Invoice (faktura) — Danish-standard formal invoicing.

Compliance anchors:
  - fakturanummer is gap-less per (user_id, branch_id, year). Never reused.
    Voiding generates a kreditnota (credit note Invoice with negative
    totals + credited_by_id pointer); the original stays in place.
  - locked=true once status leaves 'draft'. The invoice + all its lines
    become immutable. Mistakes are corrected via kreditnota, not edits.
  - 5-year retention is implicit via voucher_service's per-year ledger,
    same archive infrastructure as sales and expenses.

Status state machine:
    draft  ──send──►  sent  ──pay──►   paid
                       │
                       └──void──►  credited  (and a new kreditnota is created)
"""
import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from sqlalchemy import (
    String, Integer, Numeric, Date, DateTime, Boolean, ForeignKey, Text,
    UniqueConstraint, Index,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class Invoice(Base):
    __tablename__ = "invoices"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    branch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("branches.id"), nullable=True, index=True
    )
    customer_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("customers.id"), index=True
    )

    # Numbering — gap-less per Bogføringsloven §7. Allocated via voucher_service.
    fakturanummer: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    # Displayed as "2026-0042" via format helper; stored as int for ordering.

    # Dates
    issue_date: Mapped[date] = mapped_column(Date, nullable=False, default=date.today)
    due_date: Mapped[date] = mapped_column(Date, nullable=False)
    # Leveringsdato — when the goods/service was actually delivered.
    # Required on a Danish faktura *only when* it differs from issue_date
    # (Momsbekendtgørelsen §57 stk. 1 nr. 6). For same-day work this is
    # always null and the PDF falls back to issue_date. For event/catering
    # gigs invoiced the next week, this is the actual event date.
    delivery_date: Mapped[Optional[date]] = mapped_column(Date, nullable=True)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    paid_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Status
    status: Mapped[str] = mapped_column(String(20), default="draft")
    # 'draft' | 'sent' | 'paid' | 'overdue' | 'credited'
    # Composite index ix_invoices_status on (user_id, status) lives in __table_args__.

    # Monetary totals (computed from lines, denormalized for query speed)
    subtotal_net: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    moms_total: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    total_gross: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0"))
    paid_amount: Mapped[Optional[Decimal]] = mapped_column(Numeric(12, 2), nullable=True)
    # Payment provenance (migration 034). Tracks HOW the invoice was marked
    # paid so we can:
    #   • Audit incorrect auto-matches by paid_via='auto_match' filter
    #   • Show "marked by you" vs "matched from bank" UX hints
    #   • Reverse only auto-matches if a bug is found, never manual marks
    paid_via: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    # 'manual' | 'bank_csv' | 'auto_match' | 'mobilepay' | 'open_banking'
    paid_reference: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Free-text — bank transaction description if auto/CSV-matched, or
    # owner-typed note if manual ("Paid via MobilePay 12345").
    auto_match_reversible: Mapped[bool] = mapped_column(Boolean, default=False)
    # Set true when auto-match flips status. UI surfaces an "Undo" button
    # for 7 days after this is set; service layer enforces the 7-day window.
    currency: Mapped[str] = mapped_column(String(3), default="DKK")

    # Content
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    customer_lang: Mapped[str] = mapped_column(String(2), default="da")
    # Snapshot of customer's preferred lang at issue time — once locked, never changes.

    # Credit-note linkage
    credited_by_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("invoices.id"), nullable=True
    )
    # If set: this invoice was voided; credited_by_id points to the kreditnota.
    is_credit_note: Mapped[bool] = mapped_column(Boolean, default=False)
    # True for the kreditnota itself.

    # Immutability flag
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    # Flipped to True the moment status leaves 'draft'. All edit endpoints
    # must reject locked=True invoices.

    # Audit
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    # Relationships
    customer: Mapped["Customer"] = relationship(back_populates="invoices")  # type: ignore
    lines: Mapped[list["InvoiceLine"]] = relationship(
        back_populates="invoice",
        cascade="all, delete-orphan",
        order_by="InvoiceLine.line_order",
    )

    __table_args__ = (
        UniqueConstraint(
            "user_id", "branch_id", "fakturanummer",
            name="uq_invoices_seq_per_branch",
        ),
        Index("ix_invoices_status", "user_id", "status"),
        Index("ix_invoices_due", "user_id", "due_date"),
    )

    def __repr__(self) -> str:
        return f"<Invoice 2026-{self.fakturanummer:04d} {self.status} {self.total_gross} {self.currency}>"


class InvoiceLine(Base):
    """A single line on a faktura. Sum of line_gross = parent invoice.total_gross."""
    __tablename__ = "invoice_lines"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    invoice_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("invoices.id", ondelete="CASCADE"), index=True
    )
    line_order: Mapped[int] = mapped_column(Integer, default=0)

    description: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal("1"))
    unit: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    # e.g. "stk", "timer", "kg", "kasse"
    unit_price_net: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)

    # Moms — defaults to standard 25%. 0% for fritaget, also legal.
    moms_rate: Mapped[Decimal] = mapped_column(Numeric(4, 3), default=Decimal("0.250"))

    # Computed at write-time. Kept in DB so reports don't re-compute.
    line_net: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    line_moms: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    line_gross: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)

    invoice: Mapped["Invoice"] = relationship(back_populates="lines")

    def __repr__(self) -> str:
        return f"<InvoiceLine #{self.line_order} {self.description[:30]} {self.line_gross}>"
