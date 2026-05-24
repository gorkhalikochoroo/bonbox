"""event.ticket_tiers + event.is_tax_exempt — Cash-up event ticket sheet

Sudip-style event organizers (Copenhagen Nepali movie nights, diaspora
cultural shows, pop-up markets) sell tickets at 2-6 price tiers (Voksen
/ Studerende / Pensionist / Barn / Familie / Gratis) and need a way to
log a whole event's takings in 30 seconds rather than typing each
ticket sale one by one.

Two additive columns on `events`:

  1. `ticket_tiers` — JSON / JSONB array of `{label, price_dkk}` rows.
     Defined at event-create time. The Cash-up modal reads this back
     and presents the tiers as a count-per-tier sheet. Nullable so
     pre-migration events (and events without ticketed pricing — e.g.
     a free community open-house) keep working.

     Schema (validated at Pydantic layer, free-form here):
       [
         {"label": "Voksen",     "price_dkk": 150},
         {"label": "Studerende", "price_dkk": 100},
         {"label": "Barn",       "price_dkk":  50}
       ]

     Bounds enforced by Pydantic (NOT the DB): length 1..6 entries,
     label 1..40 chars non-empty/unique-case-insensitive, price_dkk
     0..999_999. We keep the DB schema loose so unusual edge cases
     (one-tier "free" sheet) work without a schema change.

  2. `is_tax_exempt` — Boolean default FALSE. Whole-event toggle for
     MOMS-fri tax posture. Set at event-create time when the event
     falls under e.g. Momsloven §13 (live theatre, museum, etc — note
     that cinema does NOT qualify; this is for the legitimate exempt
     cases like community-run cultural events). The cash-up flow
     reads this and stamps every resulting Sale row with the same
     tax-exempt flag, so the revisor-bound MOMS extraction is correct.

Backwards-compat:
  • Both columns nullable / default values, no NOT NULL added retro.
  • Every existing Event row keeps working — ticket_tiers stays NULL
    until the owner edits the event, and the cash-up button stays
    disabled (tooltip explains why) when no tiers are defined.

JSON column choice — matches migration 013's `sales.ticket_breakdown`:
  `sa.JSON().with_variant(JSONB, "postgresql")` → SQLite stores TEXT,
  Postgres uses native JSONB. We don't query into the dict; reads
  always fetch the whole event row.

Multi-tenant hygiene:
  • Tier definitions are stored on the event row, so the existing
    event.user_id tenant scope automatically owns the tiers. No new
    indexes needed (the tiers JSONB is small and never queried by
    content — only loaded with the parent row).

Revision ID: n4o5p6q7r8s9
Revises: m3n4o5p6q7r8 (Migration 013)
Create Date: 2026-05-24

NOTE on numbering: Alembic chains by revision-id, not by filename
prefix. Filename uses "015_" because the prior numeric ordering had
"013" + "014" (expense FX). Filename numbering is purely for human
readability — alembic itself reads `down_revision`.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


revision = "n4o5p6q7r8s9"
down_revision = "m3n4o5p6q7r8"
branch_labels = None
depends_on = None


def upgrade():
    # JSON variant matches migration 013's ticket_breakdown — SQLite
    # gets TEXT, Postgres gets JSONB. The variant is keyed off the
    # dialect at column-build time so it works for both engines without
    # a runtime branch.
    json_type = sa.JSON().with_variant(JSONB, "postgresql")

    # ── 1. events.ticket_tiers — array of {label, price_dkk} ──────────
    # Nullable so existing rows stay valid. Pydantic enforces the
    # `[{label, price_dkk}]` schema at the API edge; the DB is
    # intentionally loose to keep this column flexible (e.g. future
    # "qty_cap" or "color" tier metadata can ship without a schema
    # change).
    op.add_column(
        "events",
        sa.Column("ticket_tiers", json_type, nullable=True),
    )

    # ── 2. events.is_tax_exempt — whole-event MOMS-fri flag ───────────
    # Default FALSE so pre-existing rows keep their implicit "standard
    # MOMS" posture. The cash-up endpoint reads this and stamps each
    # resulting Sale row, so the per-event tax posture is the source
    # of truth (no per-tier toggle in v1).
    op.add_column(
        "events",
        sa.Column(
            "is_tax_exempt",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade():
    # Direct ops — both are nullable / defaulted columns so SQLite +
    # Postgres handle DROP COLUMN cleanly without batch mode (mirrors
    # migration 013's reasoning — direct ops surface failure visibly).
    op.drop_column("events", "is_tax_exempt")
    op.drop_column("events", "ticket_tiers")
