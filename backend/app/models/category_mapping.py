import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Integer, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID


class CategoryMapping(Base):
    __tablename__ = "category_mappings"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)  # NULL = global
    keyword: Mapped[str] = mapped_column(String(100))  # lowercase
    category_name: Mapped[str] = mapped_column(String(100))  # category name (not ID, for portability)
    usage_count: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
