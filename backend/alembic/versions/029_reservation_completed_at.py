"""reservations.completed_at — when the host marked a party finished

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    change is the `ALTER TABLE reservations ADD COLUMN IF NOT EXISTS
    completed_at ...` statement in app/main.py::_run_migrations(), with its
    SQLite mirror in the same function. `Base.metadata.create_all()` also adds
    the column from app/models/reservation.py on a fresh DB. This file is the
    human-readable Alembic record. See CLAUDE.md -> "Schema changes — DO NOT
    use Alembic".

One nullable column:

  reservations.completed_at (TIMESTAMP, UTC like seated_at) — stamped when the
    status becomes "completed", cleared when a finished table is reopened. The
    host stand's history reads "seated → left" and how long the party sat from
    seated_at and this. NULL on every row finished before it: the history then
    shows no time rather than a guessed one.

Nullable, no default, no backfill, so on Postgres the ALTER is a catalog-only
change — no table rewrite. Tenant-scoped through reservations.user_id; carries
no personal data.

Mirrors app/models/reservation.py::Reservation.completed_at.

Revision ID: c6d7e8f9a0b1
Revises: b5c6d7e8f9a0
"""

from alembic import op
import sqlalchemy as sa

revision = "c6d7e8f9a0b1"
down_revision = "b5c6d7e8f9a0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — the column is added by Base.metadata.create_all() /
    _run_migrations() at startup. Never run live."""
    op.add_column("reservations", sa.Column("completed_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("reservations", "completed_at")
