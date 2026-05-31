"""bookable_resources — persistent 2D floor-plan layout (pos + shape)

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    The canonical schema delta lives in
    `backend/app/main.py:_run_migrations()` ALTER list (Migration 023
    block — the three `ALTER TABLE bookable_resources ADD COLUMN IF NOT
    EXISTS …` statements). This file is kept as a human-readable record
    of the schema change. BonBox runs migrations in-process at startup,
    not via Alembic. See CLAUDE.md -> "Schema changes — DO NOT use
    Alembic" for the rule and commit d3dc5ae for the in-process pattern.

Migration 018 lands the persistent floor-plan: the owner drags the room's
tables into a 2D arrangement and it sticks to the venue. `BookableResource`
(the reservation table / provider / room) gains position + shape so the
frontend can render and re-load the same map on any device.

Three additive columns on `bookable_resources`, all nullable so existing
rows are untouched and the migration is non-locking on a large prod table:

  • pos_x   DOUBLE PRECISION  Horizontal position as a PERCENT (0–100) of
                             the room canvas width. NULL = "not placed on
                             the canvas yet" — a first-class state (legacy
                             rows + freshly-created tables) that the
                             frontend renders in an auto-grow grid until
                             the owner drags the table onto the map. No
                             server default for exactly that reason.
  • pos_y   DOUBLE PRECISION  Vertical position as a PERCENT (0–100) of the
                             room canvas height. Same NULL semantics.
  • shape   VARCHAR(12)       Render shape on the map: 'round' | 'square'.
                             Cosmetic only — does NOT affect seating or the
                             availability engine. server_default 'round' is
                             a constant, so the ADD COLUMN backfills existing
                             rows metadata-only (no table rewrite on PG 11+).

DOUBLE PRECISION matches the Float TypeDecorator mapping on Postgres
(REAL on SQLite — both fine; we store a 0–100 percent, precision is
irrelevant). Mirrors app/models/bookable_resource.py.

Revision ID: r7s8t9u0v1w2
Revises: q6r7s8t9u0v1 (Migration 017 — team invite tokens)
Create Date: 2026-05-31
"""
from alembic import op
import sqlalchemy as sa


revision = "r7s8t9u0v1w2"
down_revision = "q6r7s8t9u0v1"
branch_labels = None
depends_on = None


def upgrade():
    # pos_x / pos_y: nullable, NO server_default — NULL means "not yet
    # placed on the floor canvas", which the frontend treats as a distinct
    # state (auto-grid) rather than a coordinate. Backward compat is the
    # explicit goal: existing floors keep working untouched until the owner
    # arranges them.
    op.add_column(
        "bookable_resources",
        sa.Column("pos_x", sa.Float(), nullable=True),
    )
    op.add_column(
        "bookable_resources",
        sa.Column("pos_y", sa.Float(), nullable=True),
    )
    # shape: server_default 'round' so existing rows adopt a sane default
    # and the ADD COLUMN is a metadata-only change on Postgres (constant
    # default, no table rewrite). Kept nullable to match the model and to
    # keep the change maximally non-locking.
    op.add_column(
        "bookable_resources",
        sa.Column(
            "shape",
            sa.String(length=12),
            server_default="round",
            nullable=True,
        ),
    )


def downgrade():
    op.drop_column("bookable_resources", "shape")
    op.drop_column("bookable_resources", "pos_y")
    op.drop_column("bookable_resources", "pos_x")
