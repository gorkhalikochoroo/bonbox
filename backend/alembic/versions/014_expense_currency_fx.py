"""expense foreign-currency capture (Bogføringsloven §10 cross-border)

Background: Sudip Sam, a Nepali-DK event organiser, pays his Nepali film
distributor in USD/EUR/NPR. Today BonBox's `expenses` table stores ONE
number — `amount` — implicitly in the user's account currency (DKK for
DK tenants). The original foreign-currency figure and the FX rate that
produced the DKK conversion are nowhere on the record.

Bogføringsloven §10 (and the underlying SKAT guidance for cross-border
transactions) requires the original-currency amount to be retained on
the bookkeeping voucher alongside the DKK conversion. If the revisor
ever has to defend a deduction, they need the receipt's native number,
the rate used, and the date — not just the DKK figure.

This migration adds three nullable columns so existing single-currency
entries continue to work unchanged, and new cross-border expenses can
record:

  • currency        — VARCHAR(3) ISO 4217 (DKK, USD, EUR, NPR, GBP, SEK, …)
                      Null means "same as user's account currency"
                      (backward-compat for every row that exists today).
  • fx_rate         — Decimal(10,6). The rate that was used to convert
                      `original_amount` into the stored `amount`. Kept
                      at 6-decimal precision so the revisor can re-verify
                      the math (DKK/NPR rates run ~0.05-ish, so 4 dec
                      isn't enough headroom).
  • original_amount — Decimal(14,2). The raw foreign-currency number the
                      user actually typed. 14 digits gives us 999 999 999
                      999.99 of any currency — comfortably above any
                      realistic SMB expense.

Semantics confirmed in the model docstring:
  • `amount` STAYS in the user's account currency (DKK for DK), so all
    existing MOMS math, dashboard aggregations, and Bogføringsloven
    voucher logic keep working byte-for-byte.
  • If `currency` is null OR equals the user's account currency,
    `fx_rate` and `original_amount` are also null. No FX trail needed.
  • If `currency` differs from the account currency, all three FX
    fields are populated together. The router validates this at write
    time so we never end up with a half-populated row.

Postgres-only DDL (prod). Dev SQLite picks the same columns up via the
ad-hoc `IF NOT EXISTS` block we keep in `app/main.py` and via the
SQLAlchemy model defaults on fresh table creation.

Revision ID: n4o5p6q7r8s9
Revises: m3n4o5p6q7r8
Create Date: 2026-05-24
"""
from alembic import op
import sqlalchemy as sa


revision = "n4o5p6q7r8s9"
# Chains off Agent Y's 013_event_entity_and_sale_extensions
# (revision = m3n4o5p6q7r8). If 013 hasn't landed yet, swap this to
# "l2m3n4o5p6q7" (012's revision) — the two migrations are independent
# from a schema-touch perspective (013 = sales + events; 014 = expenses)
# so the ordering doesn't affect correctness.
down_revision = "m3n4o5p6q7r8"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    dialect = bind.dialect.name

    # All three columns are nullable — every existing row keeps its
    # implicit "same as account currency" semantics with no backfill.
    # We use add_column (works on both dialects) rather than raw SQL so
    # SQLite dev fixtures pick the change up without an ALTER round-trip.
    op.add_column(
        "expenses",
        sa.Column("currency", sa.String(length=3), nullable=True),
    )
    op.add_column(
        "expenses",
        sa.Column("fx_rate", sa.Numeric(10, 6), nullable=True),
    )
    op.add_column(
        "expenses",
        sa.Column("original_amount", sa.Numeric(14, 2), nullable=True),
    )

    # Postgres: lightweight cross-currency index so the bookkeeping
    # exporter / revisor reports can pull all foreign-currency rows for
    # a tenant + period without a sequential scan. SQLite skips — it
    # rarely matters at dev-fixture scale.
    if dialect == "postgresql":
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_expenses_user_currency "
            "ON expenses (user_id, currency) WHERE currency IS NOT NULL"
        )


def downgrade():
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        op.execute("DROP INDEX IF EXISTS ix_expenses_user_currency")

    # Drop in reverse add order — safe even if a partial upgrade left
    # rows with FX data: we lose the FX trail on downgrade but the
    # `amount` column (in account currency) is untouched, so MOMS math
    # and dashboards continue to work. The L7 audit_log row written at
    # create time preserves the original FX values forever even after
    # this downgrade — no data is lost from the audit perspective.
    op.drop_column("expenses", "original_amount")
    op.drop_column("expenses", "fx_rate")
    op.drop_column("expenses", "currency")
