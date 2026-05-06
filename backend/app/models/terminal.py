"""Terminal model — one per physical POS station per branch.

A real Danish restaurant rarely has just one terminal. Mirabelle (Silberbauer)
runs 4: front bar, back bar, terrace POS, takeaway. Each terminal produces
its own kasserapport at end of day; the daily close aggregates across all of
them. Each terminal also has its own payment-method capabilities (only some
take Amex, some don't accept MobilePay, etc.).

Per-tenant + per-branch scoping:
  • user_id     — owner; required for tenant isolation
  • branch_id   — nullable; if the user has multiple branches, each terminal
                  belongs to one specifically. Single-branch users skip this.

Capability flags drive the daily-close UI: scan slots only appear for the
payment methods the terminal actually accepts. No more empty Amex columns
on terminals that don't take Amex (the Mirabelle Excel had this exact
problem — 3 of 4 terminals had Amex rows full of zeros every week).
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class Terminal(Base):
    __tablename__ = "terminals"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    branch_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # Human-readable name shown in the daily-close scan flow.
    # e.g. "Front bar", "Terrace", "Takeaway", "Bar 2".
    name: Mapped[str] = mapped_column(String(80))

    # Order in which to show this terminal's scan slot. Lower numbers
    # render first. Default 0; UI tie-breaker is `created_at`.
    display_order: Mapped[int] = mapped_column(Integer, default=0)

    # Payment-method capability flags. Defaults match the typical Danish
    # café/restaurant: every terminal takes Dankort, most take MobilePay,
    # only a subset take Amex.
    accepts_dankort: Mapped[bool] = mapped_column(Boolean, default=True)
    accepts_mobilepay: Mapped[bool] = mapped_column(Boolean, default=True)
    accepts_amex: Mapped[bool] = mapped_column(Boolean, default=False)

    # Free-text label visible on the kasserapport itself (e.g. "Term 1").
    # Used to auto-route an OCR scan to the correct terminal_id when the
    # owner snaps multiple kasserapports back-to-back: if the receipt
    # text contains this label, we tag the scan automatically. Kept
    # nullable for the migration window; owner sets it manually.
    receipt_label: Mapped[str | None] = mapped_column(String(40), nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
