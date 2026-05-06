"""add output_channels table

Configurable per-restaurant recipients for the share-to-team flow.

Revision ID: h8i9j0k1l2m3
Revises: g7h8i9j0k1l2
Create Date: 2026-05-07
"""
from alembic import op
import sqlalchemy as sa


revision = "h8i9j0k1l2m3"
down_revision = "g7h8i9j0k1l2"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "output_channels",
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
        sa.Column("channel_type", sa.String(40), nullable=False),
        sa.Column("target", sa.Text(), nullable=True),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("display_order", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("CURRENT_TIMESTAMP"), nullable=False),
    )
    op.create_index("ix_output_channels_user_id", "output_channels", ["user_id"])


def downgrade():
    op.drop_index("ix_output_channels_user_id", table_name="output_channels")
    op.drop_table("output_channels")
