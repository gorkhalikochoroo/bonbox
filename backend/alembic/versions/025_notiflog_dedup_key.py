"""notification_log.dedup_key — idempotency key for event-driven owner pushes

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    change is the `ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS ...`
    block in app/main.py::_run_migrations() (Migration 058). `Base.metadata.
    create_all()` also adds this column from app/models/staff.py on a fresh DB;
    the _run_migrations ALTER is the canonical record + the emergency-restore
    path and satisfies the pre-commit migration guard + schema-drift self-test.
    This file is the human-readable Alembic record. See CLAUDE.md -> "Schema
    changes — DO NOT use Alembic".

Migration 058 adds ONE nullable, indexed column to `notification_log`:

  dedup_key (VARCHAR(120)) — idempotency key for de-duplicating event-driven
    owner pushes. The freed-table waitlist-recovery ping writes
    dedup_key = "freed:<freed_reservation_id>:<match_id>" so a double-cancel of
    the same table (owner cancel + guest self-cancel, or a double-tap) never
    double-buzzes the owner: the notifier checks for an existing recent row with
    the same dedup_key + event_type before sending. NULL for the many rows that
    don't need de-dup (schedule pushes, reminders, etc.).

Mirrors app/models/staff.py::NotificationLog.

Revision ID: y2z3a4b5c6d7
Revises: x1y2z3a4b5c6
"""

from alembic import op
import sqlalchemy as sa

revision = "y2z3a4b5c6d7"
down_revision = "x1y2z3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — the column is added by Base.metadata.create_all() /
    _run_migrations() (Migration 058) at startup. Never run live."""
    op.add_column(
        "notification_log",
        sa.Column("dedup_key", sa.String(length=120), nullable=True),
    )
    op.create_index(
        "ix_notiflog_dedup", "notification_log", ["dedup_key"],
    )


def downgrade() -> None:
    op.drop_index("ix_notiflog_dedup", table_name="notification_log")
    op.drop_column("notification_log", "dedup_key")
