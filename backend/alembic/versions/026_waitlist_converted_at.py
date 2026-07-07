"""reservation_waitlist.converted_at — honest period basis for Genvundet

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    change is the `ALTER TABLE reservation_waitlist ADD COLUMN IF NOT EXISTS ...`
    block in app/main.py::_run_migrations() (Migration 059). `Base.metadata.
    create_all()` also adds this column from app/models/reservation_waitlist.py
    on a fresh DB; the _run_migrations ALTER is the canonical record + the
    emergency-restore path and satisfies the pre-commit migration guard +
    schema-drift self-test. This file is the human-readable Alembic record. See
    CLAUDE.md -> "Schema changes — DO NOT use Alembic".

Migration 059 adds ONE nullable column to `reservation_waitlist`:

  converted_at (TIMESTAMP) — the moment a waiting party was actually converted
    into a real (seated) booking. Stamped at the convert site alongside
    status='converted' + converted_reservation_id. This is the ONLY truthful
    period basis for the "Genvundet" recovered-covers Insights card: bucketing
    the recovered count on created_at (when they joined the waitlist) or
    updated_at (mutated by anything) would misattribute recovery to the wrong
    period. The card counts a row as recovered only when converted_at falls in
    the window AND the linked reservation is truly seated (not cancelled/
    no_show/deleted) — converted_at supplies the "when".

Mirrors app/models/reservation_waitlist.py::ReservationWaitlistEntry.

Revision ID: z3a4b5c6d7e8
Revises: y2z3a4b5c6d7
"""

from alembic import op
import sqlalchemy as sa

revision = "z3a4b5c6d7e8"
down_revision = "y2z3a4b5c6d7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — the column is added by Base.metadata.create_all() /
    _run_migrations() (Migration 059) at startup. Never run live."""
    op.add_column(
        "reservation_waitlist",
        sa.Column("converted_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("reservation_waitlist", "converted_at")
