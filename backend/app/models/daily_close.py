"""Daily Close (Kasserapport) model — structured end-of-day reporting."""

import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, Numeric, String, Text, Boolean, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class DailyClose(Base):
    __tablename__ = "daily_closes"
    __table_args__ = (
        UniqueConstraint("user_id", "branch_id", "date", name="uq_daily_close_user_branch_date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    branch_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True)
    date: Mapped[date] = mapped_column(Date)

    # Revenue breakdown — stored as pipe-delimited key:value pairs for SQLite compat
    # e.g. "food:12400|drinks:5800|takeaway:1200"
    revenue_categories: Mapped[str | None] = mapped_column(Text, nullable=True)
    revenue_total: Mapped[float] = mapped_column(Numeric(12, 2), default=0)

    # Payment breakdown — same format
    # e.g. "cash:4200|card:13500|mobilepay:3150"
    payment_categories: Mapped[str | None] = mapped_column(Text, nullable=True)
    payment_total: Mapped[float] = mapped_column(Numeric(12, 2), default=0)

    # Cash drawer
    cash_expected: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    cash_counted: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    cash_difference: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    # MOMS / VAT
    moms_total: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    revenue_ex_moms: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    moms_mode: Mapped[str | None] = mapped_column(String(10), nullable=True)  # "auto" | "manual"

    # Tips
    tips_total: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    tips_staff_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tips_per_person: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    # Status & Lock
    status: Mapped[str] = mapped_column(String(20), default="confirmed")  # "draft" | "confirmed"
    unlock_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    unlocked_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    unlocked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Meta
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    closed_by: Mapped[str | None] = mapped_column(String(255), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # Z-report / kasserapport photo — set when the owner uses the
    # "Snap report" UI to OCR the close. Stores either a Supabase
    # signed URL (prod, ~700 chars) or a local filepath (dev). TEXT,
    # not VARCHAR — same lesson as Sale.receipt_photo (commit 2816393).
    # Bogføringsloven §10 source-document retention — the photo IS
    # the source document for the close.
    receipt_photo: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Migration 082 — the lasting send status of the lock mail. It lived only
    # in the lock response and an audit row the owner cannot see, so after a
    # reload History could not say whether a day ever reached the revisor.
    #   email_status   sent | partial | send_failed | failed_skipped |
    #                  skipped_* (see routers/daily_close._fire_close_auto_email)
    #   email_error    the honest cause (email_not_configured, pdf_build_failed,
    #                  attachment_too_large, send_error, accountant_opted_out …)
    #   email_sent_at  when it last reached someone; email_sent_to who
    #   email_send_key idempotency key of the last explicit resend — one
    #                  click can never become two mails
    email_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    email_error: Mapped[str | None] = mapped_column(String(64), nullable=True)
    email_attempt_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    email_sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    email_sent_to: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_send_key: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Migration 083 — what the kasserapport needs to say where its figures
    # came from. cash_float: the byttepenge taken off the drawer count (the
    # form always did this; the server never saw the float, so the PDF could
    # not show it). source_meta: JSON {"kind": "zbon"|"typed", "scans": n,
    # "terminal_totals": [..] when tills were added together, "corrected":
    # ["rev:food", "pay:card", "revenue_total"] — fields the owner changed
    # after the scan}. Both nullable; old closes print what is known.
    cash_float: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    source_meta: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Soft delete
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)


def encode_breakdown(data: dict | None) -> str | None:
    """Convert dict like {"food": 12400, "drinks": 5800} to pipe-delimited string."""
    if not data:
        return None
    return "|".join(f"{k}:{v}" for k, v in data.items() if v)


def decode_breakdown(raw: str | None) -> dict:
    """Convert pipe-delimited string back to dict."""
    if not raw:
        return {}
    result = {}
    for pair in raw.split("|"):
        if ":" in pair:
            key, val = pair.split(":", 1)
            try:
                result[key.strip()] = round(float(val.strip()), 2)
            except ValueError:
                pass
    return result
