"""add terminals table + terminal_id on kasserapport_extractions

A real Danish restaurant runs multiple POS stations. Each terminal
produces its own kasserapport at end of day, and the daily close
aggregates across them. This migration:

  1. Creates `terminals` table — one row per physical POS station,
     scoped per-user-per-branch.
  2. Adds `terminal_id` (nullable FK) to kasserapport_extractions so
     each scan can be tagged with which terminal it came from. NULL
     stays valid for single-terminal venues + legacy rows.

Revision ID: g7h8i9j0k1l2
Revises: f6g7h8i9j0k1
Create Date: 2026-05-06

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "g7h8i9j0k1l2"
down_revision = "f6g7h8i9j0k1"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "terminals",
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
        sa.Column(
            "branch_id",
            sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"),
            sa.ForeignKey("branches.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("display_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("accepts_dankort", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("accepts_mobilepay", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("accepts_amex", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("receipt_label", sa.String(40), nullable=True),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("ix_terminals_user_id", "terminals", ["user_id"])
    op.create_index("ix_terminals_branch_id", "terminals", ["branch_id"])

    # Add terminal_id to kasserapport_extractions (nullable; existing
    # rows stay NULL = legacy single-terminal close).
    op.add_column(
        "kasserapport_extractions",
        sa.Column(
            "terminal_id",
            sa.dialects.postgresql.UUID(as_uuid=True).with_variant(sa.String(36), "sqlite"),
            sa.ForeignKey("terminals.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_kasse_extractions_terminal_id",
        "kasserapport_extractions",
        ["terminal_id"],
    )


def downgrade():
    op.drop_index("ix_kasse_extractions_terminal_id", table_name="kasserapport_extractions")
    op.drop_column("kasserapport_extractions", "terminal_id")
    op.drop_index("ix_terminals_branch_id", table_name="terminals")
    op.drop_index("ix_terminals_user_id", table_name="terminals")
    op.drop_table("terminals")
