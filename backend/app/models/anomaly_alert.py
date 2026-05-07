"""AnomalyAlert — flagged unusual events the owner should review.

One row per detected anomaly. Detection runs daily on the previous day's
data; rows are deduped so the same anomaly isn't surfaced twice. Owners
dismiss alerts when reviewed (or "snooze" them) — dismissed alerts stay
in the table for analytics but are filtered out of the dashboard view.

Kept as a separate table from EventLog because:
  • Different access pattern: alerts are queried "open + recent", not by
    timestamp range. Dedicated indexes on (user_id, dismissed_at,
    scan_date) are tighter.
  • Dismissals are write-heavy on a small subset; mixing with the
    high-volume EventLog would bloat its indexes.
  • Each row has structured severity/kind/reference_id columns the
    dashboard can pivot on without parsing JSON.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import Date, DateTime, String, Text, ForeignKey, Index, Boolean
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


# Allowed values — checked at write time. Frontend ships a matching enum
# for icon/color rendering. Extending the list is safe; removing values
# requires a migration to fix any in-flight rows.
ALLOWED_KINDS = (
    "sale_outlier",         # single sale way above normal range
    "unusual_hour",         # sale logged outside the user's normal hours
    "velocity_burst",       # many sales in a tight window
    "expense_outlier",      # single expense way above normal range
    "failed_logins",        # many failed login attempts on the account
    "many_deletions",       # unusual number of soft-deletes
    "khata_large",          # new khata customer with very large opening
    "margin_drop",          # profit margin fell sharply vs trailing avg
)
ALLOWED_SEVERITIES = ("low", "medium", "high")


class AnomalyAlert(Base):
    __tablename__ = "anomaly_alerts"
    __table_args__ = (
        Index("ix_anomaly_user_date", "user_id", "scan_date"),
        Index("ix_anomaly_user_open", "user_id", "dismissed_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    # The DAY the scan runs for (typically "yesterday in user TZ"). Multiple
    # alerts can share the same scan_date.
    scan_date: Mapped[date] = mapped_column(Date)
    kind: Mapped[str] = mapped_column(String(40))
    severity: Mapped[str] = mapped_column(String(16), default="medium")
    # Headline shown in the card. ≤ 140 chars (validated server-side).
    title: Mapped[str] = mapped_column(String(140))
    # Longer explanation. Plain text — no HTML rendered. ≤ 600 chars validated.
    detail: Mapped[str] = mapped_column(Text, default="")
    # Optional pointer to the source record so the frontend can link out.
    reference_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reference_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Whether the AI polish pass succeeded (vs. deterministic phrasing).
    polished_by_ai: Mapped[bool] = mapped_column(Boolean, default=False)
    # Dismissal state — null means open.
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Reason categories: "not_anomalous", "fixed", "snoozed", "ignore".
    dismissed_reason: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
