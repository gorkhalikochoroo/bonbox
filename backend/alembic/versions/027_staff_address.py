"""staff_members home address — staff self-edit contact address for the owner

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    change is the `ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS ...` block
    in app/main.py::_run_migrations() (Migration 060). `Base.metadata.
    create_all()` also adds these columns from app/models/staff.py on a fresh DB;
    the _run_migrations ALTER is the canonical record + the emergency-restore
    path and satisfies the pre-commit migration guard + schema-drift self-test.
    This file is the human-readable Alembic record. See CLAUDE.md ->
    "Schema changes — DO NOT use Alembic".

Migration 060 adds FOUR nullable columns to `staff_members`:

  address (VARCHAR 200)          — gade + husnummer (+ etage/dør). Free text so
    it also fits non-DK / informal addresses. Never required.
  postal_code (VARCHAR 20)       — postnr. String (not int) to tolerate leading
    zeros + international formats; validated tolerantly at the schema layer.
  city (VARCHAR 120)             — by.
  address_updated_at (TIMESTAMP) — stamped whenever any address field changes
    (portal self-edit OR owner edit) so the owner sees "Opdateret {dato}" at a
    glance — the whole point of the feature: current address on file without
    chasing the staffer.

Staff edit their own address from the portal (self-service, token-scoped);
the owner reads/edits it in the staff-detail sheet. PII lives on the
tenant-scoped staff_members row — erased by the metadata-driven GDPR
delete-account sweep (auth.py) and NOT a payroll field
(decision_staff_scope_not_payroll).

Mirrors app/models/staff.py::StaffMember.

Revision ID: a4b5c6d7e8f9
Revises: z3a4b5c6d7e8
"""

from alembic import op
import sqlalchemy as sa

revision = "a4b5c6d7e8f9"
down_revision = "z3a4b5c6d7e8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — the columns are added by Base.metadata.create_all() /
    _run_migrations() (Migration 060) at startup. Never run live."""
    op.add_column("staff_members", sa.Column("address", sa.String(length=200), nullable=True))
    op.add_column("staff_members", sa.Column("postal_code", sa.String(length=20), nullable=True))
    op.add_column("staff_members", sa.Column("city", sa.String(length=120), nullable=True))
    op.add_column("staff_members", sa.Column("address_updated_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("staff_members", "address_updated_at")
    op.drop_column("staff_members", "city")
    op.drop_column("staff_members", "postal_code")
    op.drop_column("staff_members", "address")
