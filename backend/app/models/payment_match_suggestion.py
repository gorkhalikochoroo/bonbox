"""
PaymentMatchSuggestion — pending auto-match decisions that need owner review.

Why this exists:
  The previous auto-match flipped invoices to 'paid' the moment a bank
  transaction's amount matched (±2 kr). Real-world test: a coincidental
  loan repayment for 7.125 kr could wrongly mark a B2B faktura paid.
  Wrong revenue → wrong Moms → real tax penalties.

The fix is confidence-based:
  • HIGH   (amount match + customer name OR fakturanummer in description)
           → auto-flip to 'paid', mark auto_match_reversible=True
  • MEDIUM (amount match within payment window, no text confirm)
           → create a row here, status='pending', do NOT flip status
  • LOW    (amount match + outside payment window) or NO MATCH
           → ignored

Owner reviews MEDIUM-confidence rows on /faktura/review, tapping
Accept (calls mark_paid) or Reject (sets status='rejected').

Migration 034.
"""
import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Text, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class PaymentMatchSuggestion(Base):
    __tablename__ = "payment_match_suggestions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # Tenant scope — every query filters by this. Indexed for the inbox
    # query "give me pending suggestions for this user".
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False, index=True,
    )

    # The two records this suggestion links. Cascade-deleted with parent
    # so we don't leak suggestion rows when an invoice is hard-deleted
    # (which can happen for drafts).
    sale_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("sales.id", ondelete="CASCADE"), nullable=False,
    )
    invoice_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("invoices.id", ondelete="CASCADE"), nullable=False,
    )

    # 'high' | 'medium' | 'low'. HIGH never lives here — it auto-flips
    # the invoice directly. MEDIUM is the typical case. LOW exists so
    # we can surface "amount-only matches outside payment window" in a
    # less-prominent place if owner wants to scan them.
    confidence: Mapped[str] = mapped_column(String(10), nullable=False)

    # Human-readable explanation of why we picked this match. Shown in
    # the review inbox so the owner can decide intelligently:
    #   "Amount 7.125,00 kr · 'Lyngby' found in transaction text"
    #   "Amount 7.125,00 kr · no text confirmation"
    reason: Mapped[str] = mapped_column(Text, nullable=False)

    # 'pending' | 'accepted' | 'rejected'. Once accepted/rejected the
    # row stays in the DB as audit trail — never deleted on action.
    status: Mapped[str] = mapped_column(String(10), default="pending", nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now,
    )

    __table_args__ = (
        # Inbox query: pending suggestions for this user, newest first.
        Index("ix_payment_match_user_status", "user_id", "status", "created_at"),
        # Reverse lookup: did this invoice already get a suggestion?
        Index("ix_payment_match_invoice", "invoice_id", "status"),
    )

    def __repr__(self) -> str:
        return (
            f"<PaymentMatchSuggestion {self.confidence}/{self.status} "
            f"sale={self.sale_id} invoice={self.invoice_id}>"
        )
