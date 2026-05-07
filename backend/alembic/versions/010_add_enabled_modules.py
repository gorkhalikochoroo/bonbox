"""add enabled_modules column to users

Stakes vertical-module gating in the data model so the marketing claim
"Free: 1 vertical module (pick one) / Pro: ALL at once" becomes a
structural property — not a fictional one (which it was before this
shipped).

Storage: comma-separated module ID string ("" = none picked yet).
Allowlist enforced at the service layer, cap enforced at the router
layer via PLAN_CAPS["modules"].

Nullable + empty default → fully additive, no data loss for existing
rows. Owners who never visit the modules picker stay in the "no modules
selected" state and the frontend defaults to showing core close-flow
features only (which already worked before this column existed).

Revision ID: j0k1l2m3n4o5
Revises: i9j0k1l2m3n4
Create Date: 2026-05-07
"""
from alembic import op
import sqlalchemy as sa


revision = "j0k1l2m3n4o5"
down_revision = "i9j0k1l2m3n4"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "users",
        sa.Column("enabled_modules", sa.Text(), nullable=True),
    )


def downgrade():
    op.drop_column("users", "enabled_modules")
