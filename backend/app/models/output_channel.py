"""OutputChannel — configurable recipients for daily-close reports.

Manoj's "not everyone will work like this" insight made operational.
A small bakery emails the owner; Silberbauer posts to a Messenger
group; a wine bar emails 3 investors; a catering company emails their
revisor. Each restaurant has its own ritual; BonBox doesn't impose
one.

Owner sets up channels once in settings:
  • channel_type — "email" | "whatsapp" | "messenger" | "sms" | "slack"
                   | "pdf_only" | "csv_to_accountant"
  • target — channel-specific destination string:
      email      → "lars@cafe.dk" (or comma-separated list)
      whatsapp   → "+4512345678" or group ID
      messenger  → group ID or contact handle
      sms        → "+4512345678"
      slack      → webhook URL or channel
      pdf_only   → null (just generate)
      csv_*      → email of accountant
  • label — human label visible in UI ("Lars (WhatsApp)", "Revisor")
  • is_active — soft-delete pattern; preserves history

After a daily close, the share-to-team flow either:
  - preselects these recipients in the native share sheet (where the
    OS allows), OR
  - shows them as quick-tap buttons next to the "Send" action

For v1 we don't AUTO-SEND. Tjener still sees the formatted preview
and explicitly taps each channel. Auto-send comes when we trust
the data path end-to-end.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


# Allowed channel_type values. Update both this set AND the schema/router
# validators when adding a new type — multi-barrier guard against typos.
CHANNEL_TYPES = (
    "email",
    "whatsapp",
    "messenger",
    "sms",
    "slack",
    "pdf_only",         # generate PDF, no auto-send
    "csv_to_accountant",
)


class OutputChannel(Base):
    """One row per configured recipient/channel for daily-close reports."""
    __tablename__ = "output_channels"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    channel_type: Mapped[str] = mapped_column(String(40))
    target: Mapped[str | None] = mapped_column(Text, nullable=True)
    label: Mapped[str] = mapped_column(String(120))

    # Display order — lower numbers shown first. Two recipients with the
    # same order tie-break on created_at so behaviour is deterministic.
    display_order: Mapped[int] = mapped_column(Integer, default=0)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
