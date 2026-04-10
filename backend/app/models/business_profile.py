import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Text, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class BusinessProfile(Base):
    __tablename__ = "business_profiles"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), unique=True, index=True)
    # Core fields
    company_name: Mapped[str] = mapped_column(String(300), default="")
    org_number: Mapped[str | None] = mapped_column(String(50), nullable=True)  # CVR, org nr, company number
    vat_number: Mapped[str | None] = mapped_column(String(50), nullable=True)  # May differ from org number
    country: Mapped[str] = mapped_column(String(5), default="DK")
    # Address
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    zipcode: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Industry
    industry: Mapped[str | None] = mapped_column(String(200), nullable=True)
    industry_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    company_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Contact
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Operations
    day_cutoff_hour: Mapped[int] = mapped_column(Integer, default=0)  # 0-6; hour before which "today" = yesterday (night shift)
    # Meta
    source: Mapped[str | None] = mapped_column(String(50), nullable=True)  # cvrapi.dk, companies_house, manual
    founded: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
