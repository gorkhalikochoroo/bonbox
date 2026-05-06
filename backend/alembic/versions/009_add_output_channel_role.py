"""add role column to output_channels

Stakes the two-actor segment in the data model: a recipient can now be
explicitly tagged as a "closer" (front-of-house, the actor doing the work),
"owner" (the buyer / business owner), or "revisor" (Danish accountant /
bookkeeper). Captures the closer ≠ owner distinction that defines our
segment vs. competing categories.

Nullable + no default so existing rows are untouched and the column is
purely additive. Frontend gradually adopts it; legacy rows stay as
"unspecified" until owners revisit recipient settings.

Revision ID: i9j0k1l2m3n4
Revises: h8i9j0k1l2m3
Create Date: 2026-05-07
"""
from alembic import op
import sqlalchemy as sa


revision = "i9j0k1l2m3n4"
down_revision = "h8i9j0k1l2m3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "output_channels",
        sa.Column("role", sa.String(20), nullable=True),
    )


def downgrade():
    op.drop_column("output_channels", "role")
