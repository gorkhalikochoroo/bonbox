"""inbox v0.1 — alias + email_messages + receipt_intake

Migration 016 lands the receipt-forwarding email inbox: owners forward
supplier receipts to ``<alias>@in.bonbox.dk``, Postmark Inbound calls
our webhook, we extract the attachment + drop a draft Expense.

Three concerns:

  1. users — three additive columns. The alias is the user-facing
     unique address; inbox_enabled is the per-user kill switch (default
     True so the feature is discoverable); inbox_alias_rotated_at is
     reserved for v0.2's rotate endpoint.

  2. email_messages — one row per inbound webhook hit. Status enum
     enforced at the DB layer via CHECK so a buggy router can never
     write a stray value. The (alias, message_id) UNIQUE pair is the
     idempotency key — same email replayed is a no-op.

  3. receipt_intake — one row per accepted attachment. ``storage_path``
     points at a Fernet-encrypted blob under ``uploads/receipts/``.
     The sha256 is over the PLAINTEXT bytes (Fernet uses a fresh nonce
     per encrypt() call, so ciphertext sha would defeat dedup).

VARCHAR(36) for every id — matches the GUID() TypeDecorator that
maps to String(36) on both SQLite and Postgres. Native UUID would
FK-fail with "foreign key constraint type mismatch" on prod (see
Migration 034 comment in main.py).

Retention:
  • Bogføringsloven §10 — accounting source documents must be
    retained for 5 years. Rows with status in ('received','queued',
    'processed') count as accounting source.
  • Spam / orphan / rejected / quarantined / throttled fall under
    30-day spam retention.
  • The purge job is v0.2 — for v0.1 we just keep the rows and
    flag the retention policy via the column comments.

Revision ID: p5q6r7s8t9u0
Revises: n4o5p6q7r8s9 (Migration 015 — events.ticket_tiers)
Create Date: 2026-05-24
"""
from alembic import op
import sqlalchemy as sa


revision = "p5q6r7s8t9u0"
down_revision = "n4o5p6q7r8s9"
branch_labels = None
depends_on = None


def upgrade():
    # ── 1. users — three additive columns ─────────────────────────
    # Nullable inbox_alias because legacy rows have no alias until
    # the first /api/inbox/me hit lazy-allocates one.
    op.add_column(
        "users",
        sa.Column("inbox_alias", sa.String(length=40), nullable=True),
    )
    op.create_unique_constraint(
        "uq_users_inbox_alias", "users", ["inbox_alias"],
    )
    # Per-user kill switch. Default TRUE on existing rows so they get
    # the feature on the next /me hit without any backfill.
    op.add_column(
        "users",
        sa.Column(
            "inbox_enabled",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
    )
    # Reserved for v0.2's rotate endpoint — set when an owner asks for
    # a fresh alias (e.g. the current one leaked to a hostile list).
    op.add_column(
        "users",
        sa.Column("inbox_alias_rotated_at", sa.DateTime(), nullable=True),
    )
    # Partial index for the hot path (alias → user_id on every
    # webhook hit). The WHERE clause keeps NULL aliases out of the
    # index so it stays small on a freshly migrated DB.
    #
    # Note: alembic's `create_index` doesn't accept a WHERE clause
    # cross-engine. We emit raw SQL for Postgres and let SQLite skip
    # the partial — SQLite's index without WHERE is fine at our scale.
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_users_inbox_alias "
            "ON users (inbox_alias) WHERE inbox_alias IS NOT NULL"
        )
    else:
        op.create_index(
            "ix_users_inbox_alias", "users", ["inbox_alias"],
        )

    # ── 2. email_messages ─────────────────────────────────────────
    op.create_table(
        "email_messages",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("alias", sa.String(length=40), nullable=False),
        sa.Column("from_addr", sa.Text(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=True),
        sa.Column("message_id", sa.Text(), nullable=True),
        sa.Column("body_text_hash", sa.CHAR(length=64), nullable=True),
        sa.Column("spf_pass", sa.Boolean(), nullable=True),
        sa.Column("dkim_pass", sa.Boolean(), nullable=True),
        sa.Column("dmarc_pass", sa.Boolean(), nullable=True),
        sa.Column(
            "attachment_ct",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "received_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.current_timestamp(),
        ),
        sa.UniqueConstraint("alias", "message_id", name="uq_em_alias_msgid"),
        sa.CheckConstraint(
            "status IN ('received','queued','processed','quarantined',"
            "'throttled','rejected','orphan')",
            name="ck_em_status",
        ),
    )
    op.create_index(
        "ix_em_user_status", "email_messages", ["user_id", "status"],
    )

    # ── 3. receipt_intake ─────────────────────────────────────────
    op.create_table(
        "receipt_intake",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column(
            "email_message_id",
            sa.String(length=36),
            sa.ForeignKey("email_messages.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=True),
        sa.Column("mime_type", sa.Text(), nullable=True),
        sa.Column("byte_size", sa.Integer(), nullable=True),
        sa.Column("sha256", sa.CHAR(length=64), nullable=False),
        sa.Column(
            "ocr_status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'queued'"),
        ),
        sa.Column("ocr_confidence", sa.Float(), nullable=True),
        sa.Column(
            "expense_id",
            sa.String(length=36),
            sa.ForeignKey("expenses.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.current_timestamp(),
        ),
    )
    op.create_index(
        "ix_ri_user_status", "receipt_intake", ["user_id", "ocr_status"],
    )


def downgrade():
    op.drop_index("ix_ri_user_status", table_name="receipt_intake")
    op.drop_table("receipt_intake")
    op.drop_index("ix_em_user_status", table_name="email_messages")
    op.drop_table("email_messages")
    op.drop_index("ix_users_inbox_alias", table_name="users")
    op.drop_column("users", "inbox_alias_rotated_at")
    op.drop_column("users", "inbox_enabled")
    op.drop_constraint("uq_users_inbox_alias", "users", type_="unique")
    op.drop_column("users", "inbox_alias")
