"""dk cutoff default 6 — restaurant-day rollover for DKK tenants

Closes the residual drift left by the TZ centralization commit (b2e227a).

That commit wired BusinessProfile.day_cutoff_hour through every router and
introduced `tz_utils._DEFAULT_CUTOFF_HOUR = 6` as the Danish restaurant
convention default (service ending 02:00 belongs to yesterday's business
day). But the underlying DB column default stayed at 0 — so every DK
profile created before this migration has `day_cutoff_hour = 0` stored,
and their dashboards rolled over at midnight instead of 06:00. The helper
promised one thing while the data said another.

What this migration does (3 layers, in order):

1. ALTER COLUMN ... SET DEFAULT 6 — new rows now match the helper.
2. Backfill DKK tenants that still hold the historical 0 — they were
   never the user's choice, they were the old column default leaking
   through. NULL currency is treated as DKK because that's the prod
   default (User.currency = "DKK") and the column is NOT NULL with
   a default at the SQLAlchemy layer, but old rows or test fixtures
   may still slip through.
3. Non-DKK tenants are left untouched. A NOK / SEK / EUR owner who has
   day_cutoff_hour = 0 may have set it explicitly (midnight = office
   hours convention) or kept the old default — either way we can't
   safely flip the meaning of stored values on their behalf. They
   keep what they have and can override via the Profile editor.

Why the downgrade doesn't revert the backfill:

The whole point of this change is that "6" was always the intended
default for DK tenants — the column default was stale, not the user's
choice. Reverting the backfill on downgrade would undo a correctness
fix and re-introduce the drift in any DB rolled back to this point.
The downgrade only flips the column default back to 0 (so the schema
matches what it was before this migration). Data stays clean.

Multi-layer protection:
- Idempotent: the UPDATE only matches `day_cutoff_hour = 0` rows so
  re-running the migration is a no-op on already-backfilled tenants.
- Scoped: WHERE clauses on currency keep non-DK tenants untouched.
- Reversible default: the column default flip is symmetric — upgrade
  sets 6, downgrade sets 0 — so the schema can be rolled back without
  touching data.

NOTE — Postgres-only DDL: `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT`
works on Postgres (prod). SQLite (dev fixtures) recreates the table on
DDL changes and doesn't honor SET DEFAULT for existing tables — the
SQLAlchemy model default (set on the column object in
`business_profile.py`) is what fresh SQLite tables pick up. For SQLite
the UPDATE backfill is still applied via SQLAlchemy execution.

Revision ID: l2m3n4o5p6q7
Revises: k1l2m3n4o5p6
Create Date: 2026-05-24
"""
from alembic import op
import sqlalchemy as sa


revision = "l2m3n4o5p6q7"
down_revision = "k1l2m3n4o5p6"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    dialect = bind.dialect.name

    # ── 1. Column default flip ────────────────────────────────────────
    # Postgres honors ALTER COLUMN ... SET DEFAULT; SQLite does not for
    # existing tables (and is dev-only). On SQLite the SQLAlchemy model
    # default already produces the right value for new rows.
    if dialect == "postgresql":
        op.execute(
            "ALTER TABLE business_profiles "
            "ALTER COLUMN day_cutoff_hour SET DEFAULT 6"
        )

    # ── 2. Backfill DKK tenants stuck on the stale default ───────────
    # Only touch rows where:
    #   • the stored cutoff is still 0 (untouched-by-user state), AND
    #   • the owning user is on DKK (or NULL currency, which is DKK
    #     per the prod default — COALESCE matches this defensively).
    #
    # A subquery is used instead of a JOIN so this works identically on
    # Postgres and SQLite (SQLite doesn't support UPDATE … FROM in older
    # versions).
    op.execute(
        sa.text(
            """
            UPDATE business_profiles
            SET day_cutoff_hour = 6
            WHERE day_cutoff_hour = 0
              AND user_id IN (
                SELECT id FROM users
                WHERE COALESCE(currency, 'DKK') = 'DKK'
              )
            """
        )
    )


def downgrade():
    bind = op.get_bind()
    dialect = bind.dialect.name

    # Revert the column default only. We intentionally do NOT undo the
    # data backfill — see the module docstring. The backfilled rows
    # reflect what was always supposed to be stored for DKK tenants;
    # reverting them would re-introduce the midnight-vs-06:00 drift
    # this migration was created to fix.
    if dialect == "postgresql":
        op.execute(
            "ALTER TABLE business_profiles "
            "ALTER COLUMN day_cutoff_hour SET DEFAULT 0"
        )
