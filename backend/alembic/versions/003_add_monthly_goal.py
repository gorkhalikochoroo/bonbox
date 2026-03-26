"""add monthly_goal to users

Revision ID: c3d4e5f6g7h8
Revises: b2c3d4e5f6g7
Create Date: 2026-03-26

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "c3d4e5f6g7h8"
down_revision = "b2c3d4e5f6g7"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("monthly_goal", sa.Numeric(12, 2), nullable=True, server_default="0"))


def downgrade():
    op.drop_column("users", "monthly_goal")
