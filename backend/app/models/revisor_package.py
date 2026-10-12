"""RevisorPackageSend — one revisor package e-mailed for a period.

The ledger behind "Send revisorpakke": every send (owner-tapped or scheduled)
is a row, written BEFORE anything is mailed, so

  • a scheduled package goes out at most ONCE per period per recipient — the
    row's `dedup_key` ("sched:<start>:<end>:<address fingerprint>") is UNIQUE
    per owner, so a second worker, a redeploy overlap or a retried run can
    never claim the same period again (manual sends carry no key: an owner
    may send again on purpose);
  • the signed download link resolves to exactly the ZIP that was sent
    (`storage_key` + `zip_sha256`), not to whatever the books say later;
  • the owner sees what went, when, to whom — and what was skipped and why
    (an unconfirmed e-mail, the revisor's opt-out, no revisor saved).

No document content lives here: the ZIP is in storage (kind
"revisor_package", purged after the link expires), the row holds ids,
counts and the address it went to. user_id → users.id, so the metadata-driven
GDPR export and erasure include it.
"""

import uuid
from datetime import date, datetime
from typing import Optional

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class RevisorPackageSend(Base):
    __tablename__ = "revisor_package_sends"
    __table_args__ = (
        UniqueConstraint("user_id", "dedup_key", name="ux_revisor_package_dedup"),
        Index("ix_revisor_package_user_period", "user_id", "period_start", "period_end"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False, index=True,
    )
    period_kind: Mapped[str] = mapped_column(String(10), nullable=False)    # week | month | custom
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    send_trigger: Mapped[str] = mapped_column(String(10), nullable=False)   # manual | scheduled
    recipient: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    recipient_fp: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    # Scheduled sends only: "sched:<start>:<end>:<fp>". NULL for manual sends
    # (NULLs never collide in the unique index, on Postgres or SQLite).
    dedup_key: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    # claimed → sent | skipped | failed
    status: Mapped[str] = mapped_column(String(12), nullable=False, default="claimed")
    skip_reason: Mapped[Optional[str]] = mapped_column(String(40), nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    storage_key: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    zip_sha256: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    zip_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    n_bilag: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    open_items: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    link_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True, onupdate=utc_now)
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # The ZIP was removed from storage after the link expired.
    purged_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # A package over the link cap goes as numbered ZIP parts, one link each:
    # [{part, key, sha256, size, n_bilag, name}] (part 1 = storage_key).
    parts_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # The figures the package stated and their fingerprint — a period that
    # changes after the send shows "Ændret efter afsendelse" (12 Oct M7).
    figures_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    figures_fp: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    # This send replaced a sent package whose figures had changed (RETTELSE).
    is_correction: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
