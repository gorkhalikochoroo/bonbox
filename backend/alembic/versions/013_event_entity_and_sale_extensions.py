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

JSON column choice:
  • `sa.JSON().with_variant(JSONB, "postgresql")` — matches migration 006's
    pattern (kasserapport_extractions). SQLite gets TEXT; Postgres gets
    native JSONB (we never query INTO the dict so the binary advantage
    isn't load-bearing — but it costs nothing to use the right type).

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
    bind = op.get_bind()
    dialect = bind.dialect.name

    # ── 1. Create the events table ────────────────────────────────────
    # UUID-on-PG / String(36)-on-SQLite, same idiom as every other table.
    op.create_table(
        "events",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"),
            primary_key=True,
        ),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"),
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

    # ── 2 + 3. Sale.event_id + Sale.ticket_breakdown ─────────────────
    # Use batch_alter_table so SQLite (dev) handles the FK column via
    # the copy-and-move strategy. Postgres (prod) sees the same logical
    # ADD COLUMN op without the table rewrite. Both dialects end up with
    # `event_id` (FK, ondelete=SET NULL, nullable, indexed) and
    # `ticket_breakdown` (JSON / JSONB, nullable) on `sales`.
    #
    # Note on the named FK: batch mode requires constraints to be named
    # (alembic re-emits them when copying-and-moving). The name is also
    # a nicer hook for prod-side `DROP CONSTRAINT` if we ever need it.
    json_type = sa.JSON().with_variant(JSONB, "postgresql")
    with op.batch_alter_table("sales") as batch_op:
        batch_op.add_column(
            sa.Column(
                "event_id",
                sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"),
                sa.ForeignKey(
                    "events.id",
                    ondelete="SET NULL",
                    name="fk_sales_event_id_events",
                ),
                nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column("ticket_breakdown", json_type, nullable=True),
        )
        batch_op.create_index("ix_sale_event_id", ["event_id"])


def downgrade():
    # Reverse order — drop dependent columns first, then the events table.
    # batch_alter_table to keep SQLite + Postgres on the same code path.
    with op.batch_alter_table("sales") as batch_op:
        batch_op.drop_index("ix_sale_event_id")
        batch_op.drop_column("ticket_breakdown")
        batch_op.drop_column("event_id")

    op.drop_index("ix_event_user_date", table_name="events")
    op.drop_table("events")
