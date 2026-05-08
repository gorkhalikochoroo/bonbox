"""SmartDriftFinding — surfaces "things have changed" suggestions on
the dashboard.

Once a week the daily cron re-runs the Smart inference services
(staffing for v1; inventory & terminals later) against fresh data and
compares the proposal to what's currently saved on the owner's
profile. If the proposal materially differs, we insert one finding
row. The dashboard fetches open findings and shows a calm banner:

  "Your Friday hours look different lately — open until 23:00 now.
   Update?"  [Apply]  [Dismiss]

Why a separate table (not just a re-render):
  • Idempotent — running the scan twice doesn't duplicate the banner.
  • Auditable — we can see "we suggested X, owner dismissed it" later
    and learn (was the inference noisy? did they not trust us?).
  • Scoped — owners can dismiss without re-detecting forever.
  • GDPR — purgable on a retention cycle alongside event_logs.

Tenant scoping: user_id is required and indexed. Every read/write
filters on it.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class SmartDriftFinding(Base):
    __tablename__ = "smart_drift_findings"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    # Coarse kind enum so the UI can pick the right surface to nudge
    # the owner toward. Currently only "staffing"; "inventory" and
    # "terminals" land later.
    kind: Mapped[str] = mapped_column(String(20))

    # Short human title shown in the banner. Example:
    # "Your Friday hours look different lately"
    title: Mapped[str] = mapped_column(String(140))

    # Detail payload — kind-specific shape, examples:
    #   {"changed": ["fri_hours"], "old": {...}, "new": {...},
    #    "summary": "Friday open until 23:00 now (was 21:00)"}
    # Stored as JSON so we don't have to schema-migrate for every new
    # detector. The endpoint validates shape on read.
    payload_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    # Optional human one-liner for the banner. Falls back to `title`
    # if absent.
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Lifecycle. detected_at is when the cron found it. dismissed_at
    # set when the owner taps "not now" (we suppress this finding for
    # a cooldown period). applied_at set when the owner accepts the
    # suggestion (we'd write the inferred profile and mark the finding
    # closed).
    detected_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, index=True)
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    __table_args__ = (
        Index("ix_smart_drift_user_kind_open", "user_id", "kind", "dismissed_at"),
    )
