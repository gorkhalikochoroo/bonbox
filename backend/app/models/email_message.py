"""
EmailMessage — receipt-forwarding inbox log row.

One row per inbound Postmark webhook hit. Carries the from-address,
subject, SPF/DKIM/DMARC posture, and the lifecycle status. Children
(`receipt_intake`) reference this back by `email_message_id`.

Retention: Bogføringsloven §10 requires the original source email +
attachments to be retained for 5 years when the email yielded an
accounting entry. Quarantined/rejected/orphan rows fall under the
30-day spam retention policy. A scheduled purge job will live under
`accounting_retention` in v0.2 — for now we just keep the column
shape and let the rows accumulate. See the README in the inbox
router for the policy.

Status enum:
  received  — Postmark hit landed, not yet processed
  queued    — at least one attachment is queued for OCR
  processed — all attachments processed, draft expenses created
  quarantined — fail-closed (user.inbox_enabled=False or globally off)
  throttled — over the per-month tier cap
  rejected  — SPF/DKIM/DMARC hard fail OR mime-allowlist refused
  orphan    — alias did not resolve to a user (logged, then dropped)

Migration 016.
"""
import uuid
from datetime import datetime

from sqlalchemy import (
    String, DateTime, Text, Integer, Boolean, ForeignKey, Index,
    UniqueConstraint, CheckConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


_STATUSES = (
    "received", "queued", "processed", "quarantined",
    "throttled", "rejected", "orphan",
)


class EmailMessage(Base):
    __tablename__ = "email_messages"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # Tenant scope. Nullable for orphan rows (alias did not resolve) so
    # we can still keep the audit row + count it against future abuse-
    # detection signals without forcing a foreign-key violation.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=True,
    )
    # The alias the email was sent TO. Always populated, even when the
    # alias didn't resolve (orphan rows still know the address that was
    # probed — useful for spotting enumeration attempts).
    alias: Mapped[str] = mapped_column(String(40), nullable=False)
    from_addr: Mapped[str] = mapped_column(Text, nullable=False)
    subject: Mapped[str | None] = mapped_column(Text, nullable=True)
    # `message_id` is Postmark's `MessageID`. Used with `alias` as a
    # composite unique key so the same email replayed (legitimate retry
    # or hostile replay) is a no-op rather than a duplicate expense
    # draft. Nullable because legacy/malformed inbound rarely omits it.
    message_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # SHA-256 of the plaintext body — proves the same email body never
    # got processed twice even if Postmark resends with a different
    # message id. 64 hex chars.
    body_text_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Postmark-supplied authentication posture. Nullable because
    # Postmark fills these in best-effort.
    spf_pass: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    dkim_pass: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    dmarc_pass: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    attachment_ct: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="received")
    # Optional free-text reason (e.g. "mime_rejected", "over_cap",
    # "spf_fail") to surface in `/inbox/messages` in v0.2.
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)

    __table_args__ = (
        # Idempotency — same alias + same message_id is the same email.
        # Nulls don't collide (Postgres + SQLite both allow multiple
        # NULLs in a unique constraint).
        UniqueConstraint("alias", "message_id", name="uq_em_alias_msgid"),
        Index("ix_em_user_status", "user_id", "status"),
        # Defense-in-depth — at the DB layer, refuse any status outside
        # the documented set. Catches a future buggy router that tries
        # to insert e.g. status='spam'.
        CheckConstraint(
            "status IN ('received','queued','processed','quarantined',"
            "'throttled','rejected','orphan')",
            name="ck_em_status",
        ),
    )

    def __repr__(self) -> str:
        return (
            f"<EmailMessage {self.id} alias={self.alias} "
            f"status={self.status} from={self.from_addr}>"
        )
