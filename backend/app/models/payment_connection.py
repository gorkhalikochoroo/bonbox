"""Payment provider connections — store merchant credentials per user."""
import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Text, Boolean
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class PaymentConnection(Base):
    __tablename__ = "payment_connections"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    provider: Mapped[str] = mapped_column(String(50))  # vipps_mobilepay, esewa, khalti
    label: Mapped[str] = mapped_column(String(200), default="")  # user-friendly name

    # Encrypted credentials (stored as JSON-encoded string)
    # Each provider uses different fields — we store them generically
    credentials: Mapped[str] = mapped_column(Text, default="{}")

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    auto_sync: Mapped[bool] = mapped_column(Boolean, default=True)  # auto-import daily
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_auto_imported: Mapped[int] = mapped_column(default=0)  # count from last auto-run
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
