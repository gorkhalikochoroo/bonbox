"""
MobilePayConnection — MobilePay Erhverv (Business) merchant agreement
per task #71. Sibling of BankConnection (Aiia) for the OTHER half of
the payment story.

Why this exists separately from BankConnection:
  Aiia gives us the FULL bank feed — every Dankort tap, salary out,
  rent debit AND the daily MobilePay payout as one aggregate line.
  That aggregate hides per-settlement detail: fees, individual
  payments, faster-than-T+1 latency. The MobilePay merchant API
  exposes those settlements directly so reconciliation can match a
  specific MobilePay payment against a specific open faktura.

Lifecycle:
  pending      — owner clicked "Connect MobilePay"; we created the row +
                 a random consent state, redirected them to MobilePay's
                 MitID Business consent screen. Waiting for callback.
  active       — callback came back with a code; we exchanged it for
                 (access_token, refresh_token) and stamped mp_merchant_id.
                 Both tokens are Fernet-encrypted in *_enc columns.
  expired      — refresh failed (revoked / consent TTL lapsed). Cron
                 flips this. UI shows "needs re-consent".
  disconnected — owner clicked Disconnect or row was deleted. Kept as
                 audit reference if Sale/Expense rows still link to it;
                 otherwise hard-deleted via DELETE /connection.

Tier: Starter+ via `mobilepay_autosync` feature flag — Free users
still see MobilePay totals via the daily-close OCR path; the granular
per-settlement auto-sync is the paid value-add.

Multi-tenant safety: UNIQUE(user_id) means one MobilePay merchant
connection per BonBox user for v1. The spec leaves room for multiple
in v2 (a chain with multiple MobilePay merchant agreements) by relaxing
this constraint later.

Bogføringsloven: every state change writes audit_logs via
audit_service so the owner can later prove who connected MobilePay,
when, which payments were synced via direct API vs typed manually.

Security:
  - access_token_enc + refresh_token_enc are Fernet-encrypted BYTEA.
    Never returned by any endpoint, never logged in plaintext.
  - scopes column stores the space-separated OAuth scopes the
    consent granted (e.g. "payments:read merchant:read") so a future
    "this connection can't see X" guard has a server-side source of
    truth instead of trusting the client.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    String, DateTime, LargeBinary, ForeignKey, Index, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class MobilePayConnection(Base):
    __tablename__ = "mobilepay_connections"
    __table_args__ = (
        # One MobilePay connection per user in v1. A future multi-merchant
        # tenant (chain with separate MobilePay agreements per outlet)
        # would relax this — until then, re-connecting reuses the row.
        UniqueConstraint("user_id", name="uq_mobilepay_connection_user"),
        # Cron sweep: "all active connections, oldest sync first"
        Index(
            "ix_mobilepay_connections_status_synced",
            "status", "last_synced_at",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        GUID(), primary_key=True, default=uuid.uuid4,
    )

    # Tenant scope — every read/write filters here.
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False, index=True,
    )

    # MobilePay's identifier for the linked merchant agreement. NULL
    # only while status='pending' (before callback resolved).
    mp_merchant_id: Mapped[str | None] = mapped_column(
        String(100), nullable=True,
    )

    # Human-readable label from MobilePay's merchant lookup response.
    # Falls back to the user's business_name in the UI when null.
    merchant_name: Mapped[str | None] = mapped_column(String(160), nullable=True)

    # pending | active | expired | disconnected.
    # Deliberately not enum-constrained so a future value (e.g. 'paused')
    # can ship without a migration.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending",
    )

    # Random hex token bound to this init request. Carried through the
    # consent URL as the OAuth `state` param and verified on callback.
    # CSRF defense for the MobilePay -> us hop. Cleared once activated.
    consent_state: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # OAuth scopes granted at consent time. Space-separated. Used by
    # downstream guards: a connection without "payments:read" can't be
    # sync'd, so we surface that as a re-consent flow.
    scopes: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Access token — Fernet-encrypted bytes. Short-lived (typically
    # 1h per OAuth conventions), refreshed on-demand from refresh_token.
    # Cached here to save a round-trip when multiple endpoints hit the
    # client in quick succession.
    access_token_enc: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True,
    )

    # Refresh token — Fernet-encrypted bytes. Long-lived per MobilePay's
    # OAuth implementation. Never logged, never returned by any endpoint.
    refresh_token_enc: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True,
    )

    # When the cached access_token expires. Router/cron refresh when
    # within 1 day of this timestamp — wider than strict-expiry so a
    # cron run that misses a tick (or a /payments call that comes a few
    # hours stale) still has a live token. NULL means "needs refresh
    # now" or "never been activated".
    token_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )

    # When the OAuth consent itself expires (separate from access_token
    # TTL — MobilePay's docs to be verified; spec inferred ~90d /
    # SCA-aligned). NULL when we don't know.
    consent_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )

    # Last successful sync. NULL on a fresh connection. Cron filters
    # on last_synced_at < now() - 12h so we don't double-sync.
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )

    connected_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<MobilePayConnection id={self.id} user={self.user_id} "
            f"merchant={self.mp_merchant_id} status={self.status}>"
        )
