"""reservation_waitlist — Venteliste (reservation waitlist + auto-fill surfacing)

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    creation is the `CREATE TABLE IF NOT EXISTS reservation_waitlist (...)` block
    in app/main.py::_run_migrations() (Migration 057). `Base.metadata.create_all()`
    also creates it from app/models/reservation_waitlist.py on a fresh DB; the
    _run_migrations CREATE is the canonical record + the emergency-restore path
    (where create_all is bypassed) and satisfies the pre-commit migration guard +
    schema-drift self-test. This file is the human-readable Alembic record. See
    CLAUDE.md -> "Schema changes — DO NOT use Alembic".

Migration 057 lands the Venteliste (reservation waitlist). ONE table:

  reservation_waitlist — a party the venue could not seat, parked here instead
    of a paper pad. DELIBERATELY NOT a Reservation with status='waitlisted':
    a waitlist row holds NO resource (no resource_id) and writes NO
    reservation_occupancy row, so it is structurally incapable of holding a
    table or leaking into the availability engine / the book / the live-alert
    feed / Insights — Migration 055's no-double-booking EXCLUDE constraint stays
    untouched. Converting a waiting party into a real booking goes through the
    ordinary create-with-occupancy path, so no-double-booking still governs.

    • user_id FK -> users.id puts the table in the metadata-driven
      delete_account GDPR sweep automatically.
    • converted_reservation_id FK -> reservations.id is set ONLY on convert and
      links the waitlist row to the booking it became — so status='converted'
      is a MEASURED fact (the linked row exists), never a claim.
    • purge_after mirrors Reservation.purge_after: the nightly job nulls the PII
      columns (guest_name/phone/email) on rows past it and stamps purged_at,
      keeping the row for aggregate demand stats.

    Distinct from the pre-existing `waitlist_entries` table (paid-tier interest
    capture) — different feature, different table.

Mirrors app/models/reservation_waitlist.py::ReservationWaitlistEntry.

Revision ID: w2x3y4z5a6b7
Revises: v1w2x3y4z5a6
"""

from alembic import op
import sqlalchemy as sa

revision = "w2x3y4z5a6b7"
down_revision = "v1w2x3y4z5a6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — the table is created by Base.metadata.create_all()
    / _run_migrations() (Migration 057) at startup. This mirrors it for the
    human record / a from-scratch Alembic rebuild; never run live."""
    op.create_table(
        "reservation_waitlist",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("guest_name", sa.String(length=160), nullable=True),
        sa.Column("guest_phone", sa.String(length=40), nullable=True),
        sa.Column("guest_email", sa.String(length=255), nullable=True),
        sa.Column("party_size", sa.Integer(), nullable=False, server_default="2"),
        sa.Column("waitlist_date", sa.Date(), nullable=False),
        sa.Column("desired_from", sa.DateTime(), nullable=True),
        sa.Column("desired_to", sa.DateTime(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="waiting"),
        sa.Column("source", sa.String(length=20), nullable=False, server_default="manual"),
        sa.Column("note", sa.String(length=500), nullable=True),
        sa.Column("notified_at", sa.DateTime(), nullable=True),
        sa.Column("notify_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "converted_reservation_id", sa.String(length=36),
            sa.ForeignKey("reservations.id"), nullable=True,
        ),
        sa.Column("cancelled_at", sa.DateTime(), nullable=True),
        sa.Column("expired_at", sa.DateTime(), nullable=True),
        sa.Column("purge_after", sa.DateTime(), nullable=True),
        sa.Column("purged_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
    )
    op.create_index(
        "ix_rsvp_waitlist_user_day", "reservation_waitlist",
        ["user_id", "waitlist_date", "status"],
    )
    op.create_index(
        "ix_rsvp_waitlist_purge", "reservation_waitlist", ["purge_after"],
    )


def downgrade() -> None:
    op.drop_index("ix_rsvp_waitlist_purge", table_name="reservation_waitlist")
    op.drop_index("ix_rsvp_waitlist_user_day", table_name="reservation_waitlist")
    op.drop_table("reservation_waitlist")
