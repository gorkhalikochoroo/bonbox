"""add payment_method, notes to expenses and soft delete columns to all tables

Revision ID: b2c3d4e5f6g7
Revises: a1b2c3d4e5f6
Create Date: 2026-03-22

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "b2c3d4e5f6g7"
down_revision = "a1b2c3d4e5f6"
branch_labels = None
depends_on = None


def upgrade():
    # Expenses: add payment_method and notes
    op.add_column("expenses", sa.Column("payment_method", sa.String(20), nullable=True, server_default="card"))
    op.add_column("expenses", sa.Column("notes", sa.Text(), nullable=True))

    # Soft delete columns for all tables
    for table in ["sales", "expenses", "waste_logs", "cash_transactions"]:
        op.add_column(table, sa.Column("is_deleted", sa.Boolean(), nullable=True, server_default=sa.text("false")))
        op.add_column(table, sa.Column("deleted_at", sa.DateTime(), nullable=True))


def downgrade():
    for table in ["sales", "expenses", "waste_logs", "cash_transactions"]:
        op.drop_column(table, "deleted_at")
        op.drop_column(table, "is_deleted")

    op.drop_column("expenses", "notes")
    op.drop_column("expenses", "payment_method")
