"""tips.period_start + tip_distributions.hours — a tip pool covers a period

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    change is the pair of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`
    statements in app/main.py::_run_migrations() (Migration 081), with their
    SQLite mirror in the same function. `Base.metadata.create_all()` also adds
    these columns from app/models/staff.py on a fresh DB; the _run_migrations
    ALTER is the canonical record + the emergency-restore path and satisfies the
    pre-commit migration guard + schema-drift self-test. This file is the
    human-readable Alembic record. See CLAUDE.md -> "Schema changes — DO NOT use
    Alembic".

Migration 081 adds TWO nullable columns:

  tips.period_start (DATE)               — the pool's FIRST day. A tip jar fills
    over a week, not an evening, so the Drikkepenge form now splits a pool over
    a from/to range and sums each person's hours across it. `tips.date` stays
    the pool's LAST day, so payroll, the hours summary and the lønseddel keep
    bucketing pools exactly as before. NULL = a one-day pool on `date`, which
    is every row written before this column.
  tip_distributions.hours (NUMERIC 6,2)  — the hours a person's share was worked
    out from (the period's logged hours, or what the owner typed over them).
    The history used to show a name-less amount and nothing else; this is what
    lets it say "37,5 t · 62,5 %". NULL on rows written before it. 62 days x
    24 h = 1488 h fits in (6, 2).

Both nullable with no default and no backfill, so on Postgres each ALTER is a
catalog-only change — no table rewrite. Both tables are tenant-scoped through
tips.user_id; neither column carries personal data beyond what the rows
already held.

Mirrors app/models/staff.py::Tip and ::TipDistribution.

Revision ID: b5c6d7e8f9a0
Revises: a4b5c6d7e8f9
"""

from alembic import op
import sqlalchemy as sa

revision = "b5c6d7e8f9a0"
down_revision = "a4b5c6d7e8f9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — the columns are added by Base.metadata.create_all() /
    _run_migrations() (Migration 081) at startup. Never run live."""
    op.add_column("tips", sa.Column("period_start", sa.Date(), nullable=True))
    op.add_column("tip_distributions", sa.Column("hours", sa.Numeric(6, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("tip_distributions", "hours")
    op.drop_column("tips", "period_start")
