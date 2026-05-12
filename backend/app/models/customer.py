"""
Customer (debitor) — for B2B and B2C invoicing.

Distinct from KhataCustomer (which is informal credit tracking / regning).
A Customer here is a formal billing entity that can receive a faktura with
CVR, address, and statutory data fields per Bogføringsloven.

Same physical person may exist as both a KhataCustomer (running tab) AND a
Customer (occasional faktura) — different relationships, different lifecycle.
We don't auto-merge; users can de-dupe later in a settings flow if they want.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import String, Integer, DateTime, Boolean, ForeignKey, Text, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class Customer(Base):
    """A debitor record — for issuing fakturas to."""
    __tablename__ = "customers"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    branch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("branches.id"), nullable=True, index=True
    )

    # Identity
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    cvr: Mapped[Optional[str]] = mapped_column(String(8), nullable=True, index=True)
    # For B2B: CVR required (validates via existing business_lookup service).
    # For B2C: CVR null, just name + address.
    is_company: Mapped[bool] = mapped_column(Boolean, default=False)

    # Contact
    email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    phone: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)

    # Address (DAWA-verified if available)
    address: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    zipcode: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    city: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    country: Mapped[str] = mapped_column(String(2), default="DK")
    dawa_address_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)

    # Billing preferences
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=14)
    default_lang: Mapped[str] = mapped_column(String(2), default="da")
    # Invoice PDF + email template localization. Independent of UI locale.

    # Status
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)

    # Audit
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    # Relationships
    invoices: Mapped[list["Invoice"]] = relationship(back_populates="customer")  # type: ignore

    __table_args__ = (
        Index("ix_customers_user_name", "user_id", "name"),
        Index("ix_customers_user_cvr", "user_id", "cvr"),
    )

    def __repr__(self) -> str:
        return f"<Customer {self.name}{' (CVR ' + self.cvr + ')' if self.cvr else ''}>"
