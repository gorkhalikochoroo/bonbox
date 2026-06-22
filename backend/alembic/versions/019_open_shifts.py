"""open_shifts — unassigned roster slots (Åbne vagter) staff claim one-tap

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    creation is the `CREATE TABLE IF NOT EXISTS open_shifts (...)` block in
    app/main.py::_run_migrations() (Migration 024) — same pattern as
    `shift_swap_requests` / `staff_absences`. `Base.metadata.create_all()` also
    creates the table from app/models/staff.py::OpenShift on a fresh DB; the
    _run_migrations CREATE is the canonical record + the emergency-restore path
    (where create_all is bypassed) and satisfies the pre-commit migration guard.
    This file is the human-readable Alembic record. See CLAUDE.md -> "Schema
    changes — DO NOT use Alembic".

Migration 019 lands "Åbne vagter": the owner posts an UNASSIGNED shift (a hole
in the roster / a cover need) and any eligible staffer claims it one-tap from
the portal. Kept as its own table — NOT a `schedules` row with a nullable
staff_id — so the cost / payroll / overlap-guard surface (all of which assume a
shift HAS a staffer) stays untouched. On claim the OpenShift atomically flips to
'filled' and spawns a real PUBLISHED `schedules` row for the claimer.

Columns (all on a fresh `open_shifts` table — nothing is altered):
  • id                   GUID  PK
  • user_id              GUID  FK users.id — the OWNER / tenant
  • date                 DATE
  • start_time           VARCHAR(5)   'HH:MM'
  • end_time             VARCHAR(5)   'HH:MM'  (end < start = crosses midnight)
  • break_minutes        INTEGER DEFAULT 0
  • role_on_shift        VARCHAR(50)  NULL
  • notes                TEXT         NULL
  • status               VARCHAR(20)  DEFAULT 'open'  ('open'|'filled'|'cancelled')
  • claimed_by_staff_id  GUID  FK staff_members.id  NULL (set on claim)
  • claimed_schedule_id  GUID  NULL — the schedules row the claim spawned
  • claimed_at           TIMESTAMP    NULL
  • created_at           TIMESTAMP    DEFAULT now()

Mirrors app/models/staff.py::OpenShift.

Revision ID: s8t9u0v1w2x3
Revises: r7s8t9u0v1w2 (Migration 018 — bookable_resource floor plan)
Create Date: 2026-06-22
"""
from alembic import op
import sqlalchemy as sa


revision = "s8t9u0v1w2x3"
down_revision = "r7s8t9u0v1w2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — open_shifts is created by Base.metadata.create_all()
    at startup. This mirrors that table for the human record / a from-scratch
    Alembic rebuild; it is never run against the live DB."""
    op.create_table(
        "open_shifts",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("start_time", sa.String(length=5), nullable=False),
        sa.Column("end_time", sa.String(length=5), nullable=False),
        sa.Column("break_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("role_on_shift", sa.String(length=50), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), nullable=False, server_default="open"),
        sa.Column("claimed_by_staff_id", sa.String(length=36),
                  sa.ForeignKey("staff_members.id"), nullable=True),
        sa.Column("claimed_schedule_id", sa.String(length=36), nullable=True),
        sa.Column("claimed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("open_shifts")
