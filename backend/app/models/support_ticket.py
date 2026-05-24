"""SupportTicket — in-app support requests routed to the founder.

Why this exists (May 2026):
  Without an in-app support channel, owners hit a friction point and
  silently churn instead of complaining. The first 100 customers will
  ALL have edge cases — Frankenpos systems, weird Danish hospitality
  edge cases, accidental triple-dismissals — and we need to learn
  from each one.

Kept distinct from `Feedback` (which is NPS-shaped: rating + category
+ message) because:
  • Lifecycle differs — feedback is fire-and-forget; tickets need
    open/responded/closed states.
  • Tickets carry context (current page, browser, version) for triage.
  • Founder needs to respond — feedback doesn't.

Multi-layer:
  • Tenant-scoped: user_id + indexed.
  • Rate-limited at router level (5/hour/user) so a misbehaving
    client can't spam.
  • Body cap (5KB) to prevent payload bombs.
  • No PII allowed in subject — short title only; details go in body.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class SupportTicket(Base):
    __tablename__ = "support_tickets"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    # Free-text categorisation by the owner — not enforced as enum so
    # we can learn what categories matter without a migration. Common:
    # bug | question | feature | export | scan | billing | other.
    kind: Mapped[str] = mapped_column(String(40), default="other")

    # Subject line — short, shown in the founder's triage list.
    subject: Mapped[str] = mapped_column(String(140))

    # Body — full description.
    body: Mapped[str] = mapped_column(Text)

    # Optional context — page they were on, version, etc. Captured by
    # the frontend automatically so the owner doesn't have to type it.
    # Kept in TEXT to avoid schema-migrating for every new context key.
    context: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Lifecycle: open → responded → closed. Closed includes both
    # "resolved" and "dismissed" — distinguished by response_text
    # (non-null = answered, null = closed without response).
    status: Mapped[str] = mapped_column(String(20), default="open")
    response_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    # P10 — Pro tier priority flag. Set TRUE when has_feature(user,
    # "priority_support") is true at submit-time. Independent of the
    # current effective_plan() because we want the triage queue to
    # honor the priority tag even if the user downgrades AFTER
    # submitting (a Pro user's open ticket stays priority). Indexed
    # alongside status for the founder's "open priority tickets first"
    # query.
    is_priority: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, index=True)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_support_user_created", "user_id", "created_at"),
        Index("ix_support_open_status", "status", "created_at"),
        # P10 — priority-first triage. Composite index so the founder's
        # admin queue can list open priority tickets ahead of regular
        # ones with no extra scan cost.
        Index("ix_support_priority_status", "is_priority", "status", "created_at"),
    )
