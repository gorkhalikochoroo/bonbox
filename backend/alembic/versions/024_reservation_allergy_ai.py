"""reservation allergy-AI suggestion + note intent columns

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    change is the `ALTER TABLE reservations ADD COLUMN IF NOT EXISTS ...` block in
    app/main.py::_run_migrations() (Migration 035). `Base.metadata.create_all()`
    also adds these columns from app/models/reservation.py on a fresh DB; the
    _run_migrations ALTERs are the canonical record + the emergency-restore path
    and satisfy the pre-commit migration guard + schema-drift self-test. This file
    is the human-readable Alembic record. See CLAUDE.md -> "Schema changes — DO
    NOT use Alembic".

Migration 035 adds SIX nullable columns to `reservations`, backing the AI
allergy suggestion + note-intent feature (both RULE-BASED, not LLM — see
app/services/allergy_detector.py + app/services/note_intent.py):

  allergy_ai_tags (JSONB)       — UNCONFIRMED allergen keys the detector read
                                  out of the free-text note. NEVER overwrites the
                                  guest's confirmed allergen_tags; a separate
                                  channel the owner confirms/dismisses.
  allergy_ai_severity (VARCHAR) — 'severe' when severity language was present.
  allergy_ai_generic (BOOL)     — allergy language, no specific allergen matched.
  allergy_ai_confirmed (BOOL)   — owner has actioned the suggestion (confirm OR
                                  dismiss) → the "muligt: X — bekræft?" prompt
                                  stops re-surfacing. Default false.
  allergy_ai_matched (JSONB)    — the literal matched terms (audit trail of WHY
                                  it fired) — never a fabricated confidence score.
  note_intent (VARCHAR)         — one operational bucket (accessibility /
                                  celebration_birthday / celebration_anniversary
                                  / business / large_group) so the owner can
                                  FILTER the book. A hint for prep, never a re-sort.

All are guest-derived Art. 9-adjacent data → nulled by the same nightly
reservation PII purge (app/jobs/reservation_jobs.py) and deleted with the row on
account erasure (metadata-driven delete_account sweep).

Mirrors app/models/reservation.py::Reservation.

Revision ID: x1y2z3a4b5c6
Revises: w2x3y4z5a6b7
"""

from alembic import op
import sqlalchemy as sa

revision = "x1y2z3a4b5c6"
down_revision = "w2x3y4z5a6b7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — columns are added by Base.metadata.create_all() /
    _run_migrations() (Migration 035) at startup. Never run live."""
    op.add_column("reservations", sa.Column("allergy_ai_tags", sa.JSON(), nullable=True))
    op.add_column("reservations", sa.Column("allergy_ai_severity", sa.String(length=20), nullable=True))
    op.add_column("reservations", sa.Column("allergy_ai_generic", sa.Boolean(), server_default=sa.text("false")))
    op.add_column("reservations", sa.Column("allergy_ai_confirmed", sa.Boolean(), server_default=sa.text("false")))
    op.add_column("reservations", sa.Column("allergy_ai_matched", sa.JSON(), nullable=True))
    op.add_column("reservations", sa.Column("note_intent", sa.String(length=40), nullable=True))
    op.create_index(
        "ix_reservations_note_intent", "reservations", ["user_id", "note_intent"],
    )


def downgrade() -> None:
    op.drop_index("ix_reservations_note_intent", table_name="reservations")
    op.drop_column("reservations", "note_intent")
    op.drop_column("reservations", "allergy_ai_matched")
    op.drop_column("reservations", "allergy_ai_confirmed")
    op.drop_column("reservations", "allergy_ai_generic")
    op.drop_column("reservations", "allergy_ai_severity")
    op.drop_column("reservations", "allergy_ai_tags")
