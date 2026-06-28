"""Gavekort online order — a customer's REQUEST to buy a gift card online,
collected by the owner out-of-band.

THE RED LINE: BonBox never takes custody of money. This table models a
PENDING REQUEST, not a paid order. The buyer fills a public form
(/g/buy/<slug>); the owner sees the request, collects payment their own
way (MobilePay box, bank transfer, in person), and taps "Mark paid →
issue". Only then is a real GiftCard minted (via the same issue path as a
counter sale) and the buyer emailed its /g/ link.

So this is deliberately NOT a payment record:
  • No card number, no payment token, no money ever flows through us.
  • status='pending' means "owner has not yet confirmed payment". The
    customer is told, honestly, that the business confirms payment and
    THEN sends the gavekort — never "paid" or "instant".
  • A GiftCard exists ONLY after the owner issues; `gift_card_id` links
    the two once that happens.

Lifecycle:
  pending  → owner has a request, payment not yet confirmed
  issued   → owner confirmed payment + minted the card (gift_card_id set)
  declined → owner rejected (no payment received / spam)

Mirrors the canonical CREATE TABLE in app/main.py::_run_migrations()
(Migration 029 block) + the documentation-only alembic counterpart.
"""
import uuid
from datetime import datetime

from sqlalchemy import String, Integer, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


# 'pending' = awaiting the owner's payment confirmation. 'issued' = owner
# confirmed + minted the card. 'declined' = owner rejected the request.
GIFT_CARD_ORDER_STATUSES = ("pending", "issued", "declined")


class GiftCardOrder(Base):
    """A customer's online request to buy a gavekort, owner-fulfilled."""

    __tablename__ = "gift_card_orders"
    __table_args__ = (
        # The owner's inbox query shape: their pending requests, newest first.
        Index("ix_gift_card_orders_user_status", "user_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # The OWNER/business this request is for — the tenant key. Every query
    # filters by this and the issue handler re-checks it (tenant isolation).
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), index=True, nullable=False,
    )

    # ── What the buyer asked for ──────────────────────────────────────
    amount_minor: Mapped[int] = mapped_column(Integer, nullable=False)   # face value, øre
    voucher_class: Mapped[str] = mapped_column(String(8), nullable=False, default="mpv")

    # ── Who's buying / who it's for ───────────────────────────────────
    # buyer_email is where the issued /g/ link gets sent. The rest is optional.
    buyer_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    buyer_email: Mapped[str] = mapped_column(String(255), nullable=False)
    recipient_name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    message: Mapped[str | None] = mapped_column(String(280), nullable=True)

    # ── Lifecycle ─────────────────────────────────────────────────────
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="pending")
    # Set ONLY when the owner issues — links the request to the minted card.
    gift_card_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("gift_cards.id"), nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)

    user: Mapped["User"] = relationship()  # type: ignore[name-defined]

    def __repr__(self) -> str:
        return f"<GiftCardOrder {self.amount_minor}øre {self.status} buyer={self.buyer_email}>"
