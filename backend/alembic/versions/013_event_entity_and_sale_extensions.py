"""event entity + Sale.event_id + Sale.ticket_breakdown — kulturarrangør sprint

Sudip-style customers (cultural-event organizers running 10-15 events/year)
need a way to slice Sales by "which event was this". Three schema deltas,
all in ONE migration so the rollback story is atomic:

  1. CREATE TABLE `events` — Event entity (id, user_id, name, event_date,
     venue, notes, is_deleted, timestamps). One index on (user_id,
     event_date, is_deleted) for the "newest events first" list query.

  2. ALTER TABLE `sales` ADD COLUMN `event_id` — nullable FK to events.id
     with ON DELETE SET NULL. Existing Sale rows stay valid; the column
     starts NULL for every row, populated going forward on POST /sales
     when the owner picks an event.

  3. ALTER TABLE `sales` ADD COLUMN `ticket_breakdown` — JSON / JSONB.
     Stores `{tier: {price, count}}` for multi-tier event sales. Nullable;
     defaults to NULL for every existing and most new rows.

Backwards-compatibility guarantees:
  • Every existing Sale keeps working — no NOT NULL constraints introduced.
  • `event_id` is nullable AND `ON DELETE SET NULL` so deleting an event
    never orphans a sale; the sale just loses its tag. Soft-delete on the
    Event table is the canonical pattern (preserves audit trail) but the
    hard-delete safety net keeps test fixtures + admin tooling clean.
  • Sale FK references events.id — we create the events table first, then
    the sales column. Always-safe order.

Multi-tenant hygiene:
  • events.user_id is FK to users.id (cascading scope follows the User).
  • No global / shared events — every row is per-tenant from day one.
  • Indexes scoped to (user_id, ...) so query plans stay tenant-local.

Type choices (lessons paid for):
  • All `id` / FK columns are **String(36)**, NOT native postgresql.UUID.
    The GUID() TypeDecorator in app/database.py maps to VARCHAR(36) on
    both SQLite AND Postgres (it does NOT use native UUID). Declaring
    UUID(as_uuid=True) here would create a column type that doesn't
    match what `Base.metadata.create_all()` produces — and the FK
    constraint to events.id would fail with "foreign key constraint
    type mismatch". See main.py:_migrations Migration 034 comment for
    the back-story (sales.invoice_id had this exact bug).
  • JSON column uses `sa.JSON().with_variant(JSONB, "postgresql")` —
    matches migration 006's kasserapport_extractions pattern. SQLite
    gets TEXT, Postgres gets native JSONB.

Why direct `op.add_column` instead of `batch_alter_table`:
  • `batch_alter_table` is needed for SQLite when DROP/ALTER COLUMN
    semantics aren't natively supported. For a plain nullable ADD COLUMN
    (with no NOT NULL backfill) SQLite supports the operation directly.
  • On Postgres, batch mode adds no value here and historically masked
    a silent skip during the 2026-05-24 kulturarrangør deploy (the
    events table got created but the sales ADD COLUMN ops never landed
    on prod, taking the home page offline). Direct `op.add_column` makes
    the failure path visible.

Revision ID: m3n4o5p6q7r8
Revises: l2m3n4o5p6q7
Create Date: 2026-05-24
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "m3n4o5p6q7r8"
down_revision = "l2m3n4o5p6q7"
branch_labels = None
depends_on = None


def upgrade():
    # ── 1. Create the events table ────────────────────────────────────
    # String(36) for ids on both dialects — matches GUID() TypeDecorator.
    # See module docstring "Type choices" for why we don't use UUID here.
    op.create_table(
        "events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("event_date", sa.Date, nullable=False),
        sa.Column("venue", sa.String(255), nullable=True),
        sa.Column("notes", sa.Text, nullable=True),
        sa.Column(
            "is_deleted",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_event_user_date",
        "events",
        ["user_id", "event_date", "is_deleted"],
    )

    # ── 2. Sale.event_id (nullable FK, ON DELETE SET NULL) ────────────
    # Direct op.add_column — batch_alter_table is unnecessary for
    # nullable ADD COLUMN on either dialect and historically masked a
    # silent skip on Postgres prod (see module docstring).
    op.add_column(
        "sales",
        sa.Column(
            "event_id",
            sa.String(36),
            sa.ForeignKey(
                "events.id",
                ondelete="SET NULL",
                name="fk_sales_event_id_events",
            ),
            nullable=True,
        ),
    )
    op.create_index("ix_sale_event_id", "sales", ["event_id"])

    # ── 3. Sale.ticket_breakdown — multi-tier ticket prices/counts ────
    json_type = sa.JSON().with_variant(JSONB, "postgresql")
    op.add_column(
        "sales",
        sa.Column("ticket_breakdown", json_type, nullable=True),
    )


def downgrade():
    # Reverse order — drop dependent columns first, then the events table.
    # Direct ops (no batch mode) — see upgrade() comment.
    op.drop_index("ix_sale_event_id", table_name="sales")
    op.drop_column("sales", "ticket_breakdown")
    op.drop_column("sales", "event_id")

    op.drop_index("ix_event_user_date", table_name="events")
    op.drop_table("events")
