"""gift_cards + gift_card_transactions — gavekort issue / track / redeem ledger

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    creation is the `CREATE TABLE IF NOT EXISTS gift_cards (...)` +
    `gift_card_transactions (...)` blocks in app/main.py::_run_migrations()
    (Migration 027). `Base.metadata.create_all()` also creates both tables from
    app/models/gift_card.py on a fresh DB; the _run_migrations CREATE is the
    canonical record + the emergency-restore path (where create_all is bypassed)
    and satisfies the pre-commit migration guard + schema-drift self-test. This
    file is the human-readable Alembic record. See CLAUDE.md ->
    "Schema changes — DO NOT use Alembic".

Migration 027 lands the gavekort (gift card) slice. Two tables:

  gift_cards — the card. MONEY IS INTEGER ØRE.
    • balance_minor is a CACHE the append-only ledger reconciles to on every
      write — they can never disagree.
    • Identity stores ONLY code_hash (HMAC-SHA256 of the secret code, UNIQUE) +
      short_code (UNIQUE, "GK-XXXX-XXXX-C" w/ mod-37 check char) + code_last4.
      The plaintext code is NEVER persisted.
    • No soft-delete column — a card is VOIDED (status='voided' + a compensating
      ledger row), never deleted, preserving the transaktionsspor.

  gift_card_transactions — the append-only LEDGER, source of truth.
    • One row per issue / redeem / void. amount_minor is SIGNED (redeem = neg).
    • UNIQUE(gift_card_id, idempotency_key) makes a replayed redeem return the
      ORIGINAL result, never a 2nd debit (NULL keys on issue/void rows are
      exempt — SQL UNIQUE treats NULLs as distinct).
    • Captures the LINK fields (created_by_user_id, sale_ref, daily_close_id,
      business_day, idempotency_key). NOT wired into the daily-close MOMS calc
      in this slice — recorded so it can be later.

Redeem's single-spend guarantee is the CONDITIONAL ATOMIC decrement in
app/routers/gavekort.py (UPDATE ... WHERE balance_minor >= :amt AND
status='active' RETURNING balance_minor), NOT a DB CHECK constraint here.

Mirrors app/models/gift_card.py::{GiftCard, GiftCardTransaction}.

Revision ID: v1w2x3y4z5a6
Revises: u0v1w2x3y4z5 (Migration 021 — webhook_events)
Create Date: 2026-06-27
"""
from alembic import op
import sqlalchemy as sa


revision = "v1w2x3y4z5a6"
down_revision = "u0v1w2x3y4z5"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — both tables are created by
    Base.metadata.create_all() / _run_migrations() at startup. This mirrors them
    for the human record / a from-scratch Alembic rebuild; never run live."""
    op.create_table(
        "gift_cards",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("short_code", sa.String(length=20), nullable=False),
        sa.Column("code_last4", sa.String(length=4), nullable=False),
        sa.Column("face_value_minor", sa.Integer(), nullable=False),
        sa.Column("balance_minor", sa.Integer(), nullable=False),
        sa.Column("voucher_class", sa.String(length=8), nullable=False, server_default="mpv"),
        sa.Column("status", sa.String(length=12), nullable=False, server_default="active"),
        sa.Column("recipient_name", sa.String(length=120), nullable=True),
        sa.Column("note", sa.String(length=280), nullable=True),
        sa.Column("issued_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("expires_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("code_hash", name="uq_gift_cards_code_hash"),
        sa.UniqueConstraint("short_code", name="uq_gift_cards_short_code"),
    )
    op.create_index("ix_gift_cards_user_id", "gift_cards", ["user_id"])
    op.create_index("ix_gift_cards_user_status", "gift_cards", ["user_id", "status"])

    op.create_table(
        "gift_card_transactions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("gift_card_id", sa.String(length=36), sa.ForeignKey("gift_cards.id"), nullable=False),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("amount_minor", sa.Integer(), nullable=False),
        sa.Column("balance_after_minor", sa.Integer(), nullable=False),
        sa.Column("created_by_user_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("sale_ref", sa.String(length=120), nullable=True),
        sa.Column("daily_close_id", sa.String(length=36), nullable=True),
        sa.Column("business_day", sa.DateTime(), nullable=True),
        sa.Column("idempotency_key", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")),
        sa.UniqueConstraint("gift_card_id", "idempotency_key", name="uq_gift_card_tx_idem"),
    )
    op.create_index("ix_gift_card_tx_gift_card_id", "gift_card_transactions", ["gift_card_id"])
    op.create_index("ix_gift_card_tx_user", "gift_card_transactions", ["user_id"])
    op.create_index("ix_gift_card_tx_card_created", "gift_card_transactions", ["gift_card_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_gift_card_tx_card_created", table_name="gift_card_transactions")
    op.drop_index("ix_gift_card_tx_user", table_name="gift_card_transactions")
    op.drop_index("ix_gift_card_tx_gift_card_id", table_name="gift_card_transactions")
    op.drop_table("gift_card_transactions")
    op.drop_index("ix_gift_cards_user_status", table_name="gift_cards")
    op.drop_index("ix_gift_cards_user_id", table_name="gift_cards")
    op.drop_table("gift_cards")
