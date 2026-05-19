"""add daily_brief_email_enabled + last_brief_emailed_at to users

Task #54 — ship the 8am Daily Brief email digest. Owners get the same
brief that appears on /dashboard, delivered to their inbox at 06:30 UTC
(≈ 07:30–08:30 Copenhagen depending on CET/CEST). Default ON: opt-out
retention play, not opt-in. Free tier included — it's a daily-active
retention lever, not an upsell.

Two columns:
  • daily_brief_email_enabled — preference toggle. Existing users default
    to True via server_default so we don't have to backfill, and so
    legacy users opt INTO the experience without explicit consent fatigue.
  • last_brief_emailed_at — idempotency stamp. The cron reads this to
    skip already-sent rows on the same day (process restart, retry,
    manual /send-now call colliding with cron).

Both columns are additive — no data loss for existing rows; nullable +
server_default chosen so the migration is safe to apply hot.

Revision ID: k1l2m3n4o5p6
Revises: j0k1l2m3n4o5
Create Date: 2026-05-19
"""
from alembic import op
import sqlalchemy as sa


revision = "k1l2m3n4o5p6"
down_revision = "j0k1l2m3n4o5"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users",
        sa.Column(
            "daily_brief_email_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "users",
        sa.Column("last_brief_emailed_at", sa.DateTime(), nullable=True),
    )


def downgrade():
    op.drop_column("users", "last_brief_emailed_at")
    op.drop_column("users", "daily_brief_email_enabled")
