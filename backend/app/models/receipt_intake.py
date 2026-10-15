"""
ReceiptIntake — per-attachment row from a forwarded receipt email.

One EmailMessage spawns 0..N ReceiptIntake rows (one per accepted
attachment). ``storage_path`` is the blob's key in the storage
abstraction (services/storage.py, kind "inbox_receipt"):
``<user_id>/inbox_receipt/<sha>.<ext>`` since Push 8 (12 Oct 2026).
A row written before that holds ``uploads/receipts/<sha>.enc`` — a
Fernet-encrypted file on the instance's own disk, still read by
inbox_service.load_attachment_blob. The sha256 is computed over the
attachment's bytes. Retention mirrors EmailMessage (5y on accounting
hit, 30d on rejected/quarantined).

Lifecycle (`ocr_status`):
  queued    — attachment persisted, OCR not yet run (default)
  ok        — OCR succeeded + draft expense created (`expense_id` set)
  low_conf  — OCR ran but confidence < threshold → blank-amount draft
  failed    — OCR exception or empty result → blank draft (fail-soft L8)
  skipped   — global INBOX_ENABLED off or user.inbox_enabled off; or the
              attachment was not stored (type outside the allowlist, too
              large, or an image type with no storable extension)

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
    # The storage key (<user_id>/inbox_receipt/<sha>.<ext>; services/
    # storage.py), or a pre-Push-8 uploads/receipts/<sha>.enc disk path.
    # Empty when nothing was stored (a skipped or rejected attachment).
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
