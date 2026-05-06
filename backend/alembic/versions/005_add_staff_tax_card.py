"""add tax_card_type + tax_card_rate to staff_members

Adds per-employee Danish trækkort fields so payroll estimates can use
hovedkort (36% w/ personfradrag), bikort (42% no personfradrag), or
frikort (0%) — defaulting to NULL (treated as hovedkort) for existing
rows so this migration is fully backwards-compatible.

Revision ID: e5f6g7h8i9j0
Revises: d4e5f6g7h8i9
Create Date: 2026-05-06

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "e5f6g7h8i9j0"
down_revision = "d4e5f6g7h8i9"
branch_labels = None
depends_on = None


def upgrade():
    # NULL is a valid value (treated as hovedkort by service layer). No
    # server_default needed — existing rows stay NULL until owner edits them.
    op.add_column(
        "staff_members",
        sa.Column("tax_card_type", sa.String(length=20), nullable=True),
    )
    op.add_column(
        "staff_members",
        sa.Column("tax_card_rate", sa.Numeric(5, 4), nullable=True),
    )


def downgrade():
    op.drop_column("staff_members", "tax_card_rate")
    op.drop_column("staff_members", "tax_card_type")
