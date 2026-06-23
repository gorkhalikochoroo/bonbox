"""behandlinger — salon service (Behandlinger) catalog

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    creation is the `CREATE TABLE IF NOT EXISTS behandlinger (...)` block in
    app/main.py::_run_migrations() (Migration 025) — same pattern as
    `bookable_resources` / `open_shifts`. `Base.metadata.create_all()` also
    creates the table from app/models/behandling.py::Behandling on a fresh DB;
    the _run_migrations CREATE is the canonical record + the emergency-restore
    path (where create_all is bypassed) and satisfies the pre-commit migration
    guard. This file is the human-readable Alembic record. See CLAUDE.md ->
    "Schema changes — DO NOT use Alembic".

Migration 020 lands "Behandlinger": S2 of the salon-appointments feature. A
salon owner curates a list of services (treatments) they offer, each with a
duration + an OPTIONAL display price. Owner CRUD via the reservations router,
gated behind the "reservations" feature flag + a `salon_services_max` tier cap
(Free 5 / Starter 25 / Pro 100).

Honesty gate (carried from the model):
  • price_kr is DISPLAY-ONLY — it never charges money, never feeds MOMS / Tax.
  • duration_min is informational until S3 wires it into the booking slot.

Columns (all on a fresh `behandlinger` table — nothing is altered):
  • id            GUID  PK
  • user_id       GUID  FK users.id — the OWNER / tenant (indexed)
  • name          VARCHAR(120)  NOT NULL — Behandling stays Danish
  • duration_min  INTEGER  DEFAULT 30
  • price_kr      INTEGER  NULL — DISPLAY-ONLY
  • active        BOOLEAN  DEFAULT TRUE
  • sort_order    INTEGER  DEFAULT 0
  • created_at    TIMESTAMP  DEFAULT now()

Mirrors app/models/behandling.py::Behandling.

Revision ID: t9u0v1w2x3y4
Revises: s8t9u0v1w2x3 (Migration 019 — open_shifts)
Create Date: 2026-06-23
"""
from alembic import op
import sqlalchemy as sa


revision = "t9u0v1w2x3y4"
down_revision = "s8t9u0v1w2x3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — behandlinger is created by Base.metadata.create_all()
    at startup. This mirrors that table for the human record / a from-scratch
    Alembic rebuild; it is never run against the live DB."""
    op.create_table(
        "behandlinger",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("duration_min", sa.Integer(), nullable=False, server_default="30"),
        # DISPLAY-ONLY — never charges money / feeds MOMS.
        sa.Column("price_kr", sa.Integer(), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_behandlinger_user_id", "behandlinger", ["user_id"])
    op.create_index("ix_behandlinger_user_active", "behandlinger", ["user_id", "active"])


def downgrade() -> None:
    op.drop_index("ix_behandlinger_user_active", table_name="behandlinger")
    op.drop_index("ix_behandlinger_user_id", table_name="behandlinger")
    op.drop_table("behandlinger")
