"""team invite tokens — magic-link flow for /api/team/invite

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    The canonical schema delta lives in
    `backend/app/main.py:_run_migrations()` ALTER list.
    This file is kept as a human-readable record of the schema change.
    BonBox runs migrations in-process at startup, not via Alembic.
    See CLAUDE.md -> "Schema changes — DO NOT use Alembic" for the rule
    and commit d3dc5ae for the in-process ALTER statements that this
    file documents.

Migration 017 lands the magic-link flow that replaces the plaintext
temp_password leak on the Team page (P0 security finding):

  • POST /api/team/invite no longer returns a plaintext password in the
    response body and no longer creates the User row with a server-set
    password. Instead it mints a single-use, sha256-hashed magic-link
    token + 7-day TTL, emails the invitee a /accept-invite/team/<token>
    link, and the invitee chooses their own password on that page.
  • The User row is created LAZILY at accept time so the email
    enumeration leak is also closed (POST /invite returns success
    regardless of whether the email exists).

Three additive columns on `users`, all nullable so existing rows are
untouched and the migration is non-locking:

  • invite_token_hash   CHAR(64)   sha256 hex of the raw token. Stored
                                  hashed so a DB dump never reveals a
                                  usable invite link. Single-use:
                                  cleared at accept time.
  • invite_expires_at   DATETIME   7 days from invite time; the accept
                                  endpoint refuses tokens past TTL.
  • invited_by_user_id  GUID(36)  FK to users.id — the owner who minted
                                  the invite. Drives tenant scope on
                                  the accept endpoint AND is the
                                  fallback owner_id wiring when the
                                  invitee row is created (the accept
                                  endpoint sets owner_id = invited_by).

VARCHAR(36) for the FK column matches the GUID() TypeDecorator that
maps to String(36) on both SQLite and Postgres (same convention as
migration 016 — native UUID would FK-fail in prod).

Revision ID: q6r7s8t9u0v1
Revises: p5q6r7s8t9u0 (Migration 016 — inbox v0.1)
Create Date: 2026-05-25
"""
from alembic import op
import sqlalchemy as sa


revision = "q6r7s8t9u0v1"
down_revision = "p5q6r7s8t9u0"
branch_labels = None
depends_on = None


def upgrade():
    # All three columns nullable + no server_default so existing rows
    # have NULL values and nothing about the existing team flow changes
    # until the next /invite mints a token. Backward compat is the
    # explicit goal here (per the P0 brief — "existing team members
    # keep working").
    op.add_column(
        "users",
        sa.Column("invite_token_hash", sa.CHAR(length=64), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("invite_expires_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column(
            "invited_by_user_id",
            sa.String(length=36),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    # Hot-path lookup: the public /accept-invite endpoint hashes the
    # incoming raw token and finds the row by hash. Single column, no
    # WHERE clause — index stays small because most rows have NULL hash
    # (only pending invites carry a value).
    op.create_index(
        "ix_users_invite_token_hash",
        "users",
        ["invite_token_hash"],
    )


def downgrade():
    op.drop_index("ix_users_invite_token_hash", table_name="users")
    op.drop_column("users", "invited_by_user_id")
    op.drop_column("users", "invite_expires_at")
    op.drop_column("users", "invite_token_hash")
