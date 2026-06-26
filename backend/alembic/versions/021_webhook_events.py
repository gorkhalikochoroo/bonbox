"""webhook_events — Stripe webhook idempotency / replay-protection ledger

WARNING: DOCUMENTATION ONLY — DO NOT RUN `alembic upgrade head`.
    BonBox runs migrations in-process at startup, not via Alembic. The canonical
    creation is the `CREATE TABLE IF NOT EXISTS webhook_events (...)` block in
    app/main.py::_run_migrations() (Migration 026) — same pattern as
    `audit_logs` / `security_events`. `Base.metadata.create_all()` also creates
    the table from app/models/webhook_event.py::WebhookEvent on a fresh DB; the
    _run_migrations CREATE is the canonical record + the emergency-restore path
    (where create_all is bypassed) and satisfies the pre-commit migration guard.
    This file is the human-readable Alembic record. See CLAUDE.md ->
    "Schema changes — DO NOT use Alembic".

Migration 021 lands the Stripe webhook idempotency ledger. Stripe delivers
events with at-least-once semantics (it retries after a slow or failed 2xx),
so the same `customer.subscription.updated` / `invoice.payment_failed` can
arrive more than once. The webhook handler INSERTs (event_id, event_type)
BEFORE dispatching to the per-event handler:

  • event_id is the PRIMARY KEY, so the second insert of the same event is a
    no-op — Postgres uses `ON CONFLICT (event_id) DO NOTHING`, SQLite uses
    `INSERT OR IGNORE` (dialect-aware in stripe_billing.handle_webhook).
  • If the insert affected 0 rows, the event was already processed → the
    per-event handler is SKIPPED and the endpoint returns 200
    {"status": "duplicate"}. No double mutation of user.plan /
    user.subscription_status, no double audit row.

Append-only in practice — there is NO UPDATE/DELETE surface.

Columns (all on a fresh `webhook_events` table — nothing is altered):
  • event_id      VARCHAR(255)  PK — Stripe's evt_... id
  • event_type    VARCHAR(120)  NULL — e.g. 'invoice.payment_failed'
  • processed_at  TIMESTAMP  NOT NULL DEFAULT now()

Mirrors app/models/webhook_event.py::WebhookEvent.

Revision ID: u0v1w2x3y4z5
Revises: t9u0v1w2x3y4 (Migration 020 — behandlinger)
Create Date: 2026-06-26
"""
from alembic import op
import sqlalchemy as sa


revision = "u0v1w2x3y4z5"
down_revision = "t9u0v1w2x3y4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """DOCUMENTATION ONLY — webhook_events is created by
    Base.metadata.create_all() at startup. This mirrors that table for the
    human record / a from-scratch Alembic rebuild; it is never run against the
    live DB."""
    op.create_table(
        "webhook_events",
        sa.Column("event_id", sa.String(length=255), primary_key=True),
        sa.Column("event_type", sa.String(length=120), nullable=True),
        sa.Column(
            "processed_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )
    op.create_index(
        "ix_webhook_events_processed", "webhook_events", ["processed_at"]
    )


def downgrade() -> None:
    op.drop_index("ix_webhook_events_processed", table_name="webhook_events")
    op.drop_table("webhook_events")
