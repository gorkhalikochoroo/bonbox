"""
WebhookEvent — idempotency / replay-protection ledger for inbound Stripe
webhooks.

Stripe explicitly warns that it MAY deliver the same event more than once
(retries after a slow 2xx, at-least-once delivery semantics). Without a
dedup guard, a replayed `customer.subscription.updated` / `invoice.payment_
failed` would re-run the per-event handler and could re-mutate plan / status
or double-write audit rows. This table is the single source of truth for
"have we already processed event X".

Write contract:
  • The webhook handler INSERTs (event_id, event_type) BEFORE dispatching to
    the per-event handler. event_id is the PRIMARY KEY, so a duplicate insert
    is a no-op (Postgres: ON CONFLICT DO NOTHING; SQLite: INSERT OR IGNORE /
    SELECT-then-INSERT guard). If the insert affected 0 rows, the event was
    already seen → the handler is skipped and we return 200 {"status":
    "duplicate"}.
  • Append-only in practice — there is no UPDATE/DELETE surface.

Schema parity:
  • Canonical creation lives in app/main.py::_run_migrations() `_migrations`
    list (Postgres: CREATE TABLE IF NOT EXISTS). On SQLite (tests) the table
    is built by Base.metadata.create_all() from THIS model. See alembic
    versions/021_webhook_events.py for the human-readable record.
"""
from datetime import datetime

from sqlalchemy import String, DateTime
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.time import utc_now


class WebhookEvent(Base):
    __tablename__ = "webhook_events"

    # Stripe's event id (evt_...). PRIMARY KEY → a second insert of the same
    # event is rejected, which is exactly the replay guard we want.
    event_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    event_type: Mapped[str | None] = mapped_column(String(120), nullable=True)
    processed_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False
    )

    def __repr__(self) -> str:
        return f"<WebhookEvent {self.event_id} type={self.event_type}>"
