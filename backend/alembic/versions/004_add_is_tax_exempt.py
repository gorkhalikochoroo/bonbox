"""add is_tax_exempt column to sales and expenses

Revision ID: d4e5f6g7h8i9
Revises: c3d4e5f6g7h8
Create Date: 2026-04-02

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "d4e5f6g7h8i9"
down_revision = "c3d4e5f6g7h8"
branch_labels = None
depends_on = None


def upgrade():
    for table in ["sales", "expenses"]:
        op.add_column(table, sa.Column("is_tax_exempt", sa.Boolean(), nullable=True, server_default=sa.text("false")))


def downgrade():
    for table in ["sales", "expenses"]:
        op.drop_column(table, "is_tax_exempt")
