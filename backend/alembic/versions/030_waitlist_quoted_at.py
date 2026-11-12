"""reservation_waitlist.quoted_at — the time the door told a waiting party

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    change is the `ALTER TABLE reservation_waitlist ADD COLUMN IF NOT EXISTS
    quoted_at ...` statement in app/main.py::_run_migrations() (Migration 087),
    with its SQLite mirror in the same function. `Base.metadata.create_all()`
    also adds the column from app/models/reservation_waitlist.py on a fresh DB.
    This file is the human-readable Alembic record. See CLAUDE.md -> "Schema
    changes — DO NOT use Alembic".

One nullable column:

  reservation_waitlist.quoted_at (TIMESTAMP, naive UTC like created_at) — the
    time the host stand's estimate gave when the party was written down
    ("ca. 17.19"). The row shows "lovet ca. 17.19" and turns amber once that
    time has passed while the party still waits. NULL when no estimate was
    known. It is a promise the next host can see, never a hold: it reserves
    no table and writes no occupancy row.

Nullable, no default, no backfill, so on Postgres the ALTER is a catalog-only
change — no table rewrite. Tenant-scoped through reservation_waitlist.user_id;
carries no personal data.

Mirrors app/models/reservation_waitlist.py::ReservationWaitlistEntry.quoted_at.

Revision ID: d7e8f9a0b1c2
Revises: c6d7e8f9a0b1
"""

from alembic import op
import sqlalchemy as sa

revision = "d7e8f9a0b1c2"
down_revision = "c6d7e8f9a0b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — the column is added by Base.metadata.create_all() /
    _run_migrations() at startup. Never run live."""
    op.add_column("reservation_waitlist", sa.Column("quoted_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("reservation_waitlist", "quoted_at")
