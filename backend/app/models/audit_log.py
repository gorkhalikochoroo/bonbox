"""
AuditLog — append-only record of every financial mutation.

Purpose:
  • Bogføringsloven §9 — every accounting entry must be traceable to
    its source, with an immutable audit trail.
  • Skattestyrelsen disputes — if asked to defend a Moms calculation
    five years from now, we need to show exactly when each faktura
    was marked paid, by whom, from which IP, and the before/after
    state of the record.
  • Reversibility — if a bug ships and wrongly auto-flips invoices to
    'paid', we can identify and reverse those mutations without
    touching manual marks.

Append-only enforcement:
  • Postgres: a RULE rejects UPDATE/DELETE at the DB layer (defense-in-
    depth, in case application code has a bug).
  • SQLite: enforced at the application layer — only the audit service
    has write access, all other code paths are blocked by review/lint.
  • Both: no UI surface for editing/deleting these rows. Ever.

Retention: 10 years (Skatteforvaltningsloven §31 — longest applicable
audit window for tax disputes). Longer than invoice retention (6y)
because the audit trail must survive the source record by buffer.

Migration 034.
"""
import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Text, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)

    # Tenant scope. Indexed because the most-common query is "show me
    # audit history for this user's invoices".
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False, index=True,
    )

    # Who made the request. Same as user_id for self-initiated actions
    # but differs when admin (future) or scheduled job ('system') acts.
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=True,
    )
    # Free-text actor description for non-user actors:
    # 'user', 'system.retention_scheduler', 'system.payment_match', 'admin'
    actor_type: Mapped[str] = mapped_column(String(50), default="user")

    # Where the request came from. IPv4 (15 chars) or IPv6 (45 chars).
    # Null when no HTTP context (e.g., scheduled jobs).
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)

    # The action. Namespaced 'entity.verb' for grep-ability.
    # Examples:
    #   'invoice.mark_paid', 'invoice.unmark_paid', 'invoice.void',
    #   'invoice.send', 'business_profile.logo_upload',
    #   'business_profile.logo_delete', 'business_profile.brand_update',
    #   'payment_suggestion.accept', 'payment_suggestion.reject',
    #   'data_retention.archive'
    action: Mapped[str] = mapped_column(String(80), nullable=False, index=True)

    # The entity affected. Lets us answer "show me everything that
    # happened to invoice X" with one indexed query.
    entity_type: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True)

    # Full state snapshots before + after the mutation. Stored as TEXT
    # (JSON) so SQLite + Postgres both work without a JSONB-on-PG /
    # TEXT-on-SQLite split. Read back via json.loads.
    #
    # Size discipline: store only the fields that changed plus identity
    # fields (id, user_id, status). Don't snapshot 50-field blobs —
    # this table would balloon and never be paginated efficiently.
    before_state: Mapped[str | None] = mapped_column(Text, nullable=True)
    after_state: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False,
    )

    __table_args__ = (
        # "What happened to entity X?" — by entity, newest first.
        Index("ix_audit_entity", "entity_type", "entity_id", "created_at"),
        # "Show me this user's history" — by user, newest first.
        Index("ix_audit_user_time", "user_id", "created_at"),
        # "Find all auto-matches in the last 30 days" — by action.
        Index("ix_audit_action_time", "action", "created_at"),
    )

    def __repr__(self) -> str:
        return (
            f"<AuditLog {self.action} entity={self.entity_type}:{self.entity_id} "
            f"user={self.user_id} at={self.created_at}>"
        )
