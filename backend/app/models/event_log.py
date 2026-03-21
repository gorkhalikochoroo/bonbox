import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Text, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class EventLog(Base):
    __tablename__ = "event_logs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    event: Mapped[str] = mapped_column(String(100))  # e.g. "page_view", "sale_logged", "receipt_scanned"
    page: Mapped[str | None] = mapped_column(String(50), nullable=True)  # e.g. "dashboard", "sales"
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)  # any extra context
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    user: Mapped["User"] = relationship()
