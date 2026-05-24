"""
ReceiptIntake — per-attachment row from a forwarded receipt email.

One EmailMessage spawns 0..N ReceiptIntake rows (one per accepted
attachment). The blob itself lives Fernet-encrypted at
``storage_path`` — the column holds the on-disk relative path under
``uploads/receipts/`` plus a `.enc` suffix. The sha256 is computed
over the PLAINTEXT bytes so dedup works regardless of the per-call
Fernet nonce. Retention mirrors EmailMessage (5y on accounting hit,
30d on rejected/quarantined).

Lifecycle (`ocr_status`):
  queued    — attachment persisted, OCR not yet run (default)
  ok        — OCR succeeded + draft expense created (`expense_id` set)
  low_conf  — OCR ran but confidence < threshold → blank-amount draft
  failed    — OCR exception or empty result → blank draft (fail-soft L8)
  skipped   — global INBOX_ENABLED off or user.inbox_enabled off

The Expense FK is nullable because at insert-time we may not yet
know the draft id (we create the Intake row, then the Expense row,
then back-fill expense_id in the same transaction).

Migration 016.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    String, DateTime, Text, Integer, Float, ForeignKey, Index,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class ReceiptIntake(Base):
    __tablename__ = "receipt_intake"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    email_message_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("email_messages.id", ondelete="CASCADE"), nullable=False,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
    )
    # Relative path under uploads/receipts/. The Fernet-encrypted file
    # has a `.enc` suffix. Storage layer (LocalStorageBackend) can swap
    # this to a Supabase Storage key without code churn here.
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    filename: Mapped[str | None] = mapped_column(Text, nullable=True)
    mime_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    byte_size: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # SHA-256 of the *plaintext* attachment bytes (NOT the ciphertext)
    # — same blob from a re-forwarded email is detectable even with a
    # fresh Fernet nonce each encryption.
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    ocr_status: Mapped[str] = mapped_column(Text, nullable=False, default="queued")
    ocr_confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    expense_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("expenses.id", ondelete="SET NULL"), nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)

    __table_args__ = (
        Index("ix_ri_user_status", "user_id", "ocr_status"),
    )

    def __repr__(self) -> str:
        return (
            f"<ReceiptIntake {self.id} user={self.user_id} "
            f"status={self.ocr_status} sha={self.sha256[:8]}>"
        )
