import uuid
from datetime import date, datetime

from sqlalchemy import String, Date, DateTime, Numeric, Text, Boolean, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class KhataCustomer(Base):
    __tablename__ = "khata_customers"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # Indexed: every Khata query in dashboard.py filters by user_id;
    # without the index Postgres seq-scans on every dashboard load.
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)

    user: Mapped["User"] = relationship()
    transactions: Mapped[list["KhataTransaction"]] = relationship(back_populates="customer")


class KhataTransaction(Base):
    __tablename__ = "khata_transactions"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # Composite-friendly indexes: dashboard receivable query filters
    # (user_id) and joins on customer_id. Two single-column indexes
    # cover both lookup patterns without needing a multi-column one.
    customer_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("khata_customers.id"), index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    date: Mapped[date] = mapped_column(Date)
    purchase_amount: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    paid_amount: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    user: Mapped["User"] = relationship()
    customer: Mapped["KhataCustomer"] = relationship(back_populates="transactions")
