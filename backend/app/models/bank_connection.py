"""
BankConnection — Aiia (Mastercard Open Banking) consent + account link
per task #67.

Why this exists:
  Owners currently upload bank CSV exports manually (BankImportPage).
  PSD2 / Aiia gives us a 90-day refresh-token-based read-only feed —
  one consent, daily auto-sync, transactions flow into the existing
  Sale/Expense tables + reconciliation engine with no manual step.

Lifecycle:
  pending  — owner clicked "Connect bank"; we created this row + a
             random consent_state, redirected to Aiia. We're waiting
             for the callback.
  active   — callback came back with a code, we exchanged it for a
             refresh token (AES-encrypted in refresh_token_enc), and
             stamped aiia_account_id from the account-list response.
  expired  — 90-day SCA consent lapsed (DK PSD2). Cron flips this on
             401-after-refresh. Re-consent flow needed to revive.
  revoked  — owner clicked Disconnect. We called Aiia revoke. Row
             stays for audit but no further syncs happen.

Tier: Starter+ via `bank_auto_reconcile` feature flag — Free users
still get the CSV upload path. The init/sync endpoints enforce the
gate; the callback is public (state-token validated) so the bank's
redirect can land without a session.

Multi-tenant safety: UNIQUE(user_id, aiia_account_id) means re-
connecting the same bank account doesn't create a duplicate row —
the init path either revives an existing row or creates a fresh one.

Bogføringsloven: every state change writes audit_logs via
audit_service so the owner can later prove who connected the bank,
when, and which transactions were synced via Aiia vs typed manually.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    String, DateTime, Boolean, LargeBinary, ForeignKey, Index, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class BankConnection(Base):
    __tablename__ = "bank_connections"
    __table_args__ = (
        # Idempotency — re-connecting the same Aiia account flips the
        # existing row rather than inserting a duplicate. Allows NULL
        # aiia_account_id during pending state (before callback resolved).
        UniqueConstraint(
            "user_id", "aiia_account_id",
            name="uq_bank_connection_user_account",
        ),
        # Most-common cron query: "all active connections, oldest sync first"
        Index(
            "ix_bank_connections_user_status",
            "user_id", "status",
        ),
        # Cron sweep: "all active connections across all tenants"
        Index(
            "ix_bank_connections_status_synced",
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

    # Provider. Valid values: 'aiia', 'gocardless', 'saltedge', 'yapily'.
    # Stamped by the router at /init time from BANK_PROVIDER env so the
    # callback + sync handlers know which client to instantiate.
    provider: Mapped[str] = mapped_column(
        String(20), nullable=False, default="aiia",
    )

    # Aiia's identifier for the linked account. NULL until the OAuth
    # callback resolves (we know the account at exchange-code time).
    aiia_account_id: Mapped[str | None] = mapped_column(
        String(100), nullable=True,
    )

    # Bank slug — 'danske_bank', 'nordea', 'jyske_bank', 'lunar', etc.
    # Captured at init time from the owner's bank picker selection.
    bank_slug: Mapped[str | None] = mapped_column(String(60), nullable=True)

    # Human-readable label. Pulled from Aiia's account name on callback
    # if available; otherwise we leave it null and the UI falls back to
    # bank_slug for display.
    account_label: Mapped[str | None] = mapped_column(String(120), nullable=True)

    # pending | active | expired | revoked. Constants used in the
    # router + cron. We deliberately don't enum-constrain so a future
    # value can ship without a migration.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending",
    )

    # Random hex token bound to this init request. Carried through the
    # consent URL as the OAuth `state` param and verified on callback.
    # CSRF defense for the Aiia → us hop. Cleared once activated.
    consent_state: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Audit P1 (Task #75): the consent_state is short-lived to prevent
    # an attacker from replaying a phished state value days later.
    # Stamped at /init for now + 10 minutes; refused at /callback when
    # past expiry.  Distinct from `consent_expires_at` which is the
    # downstream 90-day Aiia SCA window.
    consent_state_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )

    # SCA / 90-day consent expiry (DK PSD2). NULL until callback comes
    # back; we copy expires_in into a real datetime so cron can warn
    # the owner ahead of time.
    consent_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )

    # Last successful sync. NULL on a fresh connection. Cron filters
    # on last_synced_at < now() - 12h so we don't double-sync.
    last_synced_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )

    # Refresh token — AES (Fernet) encrypted bytes. Never logged,
    # never returned by any API endpoint. Decrypted only inside
    # aiia_client.refresh() at sync time.
    refresh_token_enc: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True,
    )

    # Sandbox mode — defaults to True until we wire real Aiia creds.
    # When True, sync uses SandboxAiiaClient + the row is harmless to
    # delete / replay.
    sandbox_mode: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True,
    )

    # GoCardless / multi-provider support — Task #104.
    # The provider's own identifier for the long-lived consent.  For
    # GoCardless: the requisition UUID (grants 90-day access to one or
    # more accounts under a single SCA).  Threaded from /init to
    # /callback so the callback handler can ask the provider which
    # accounts the user just linked.  NULL for Aiia (uses the code-
    # exchange OAuth flow instead).
    provider_requisition_id: Mapped[str | None] = mapped_column(
        String(100), nullable=True,
    )
    # The provider's identifier for the institution (bank).  GoCardless
    # uses things like "DANSKEBANK_DABADKKK".  Distinct from `bank_slug`
    # which is our internal short name — kept separately so we can
    # display the provider's canonical bank label without round-trips.
    provider_institution_id: Mapped[str | None] = mapped_column(
        String(100), nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<BankConnection id={self.id} user={self.user_id} "
            f"bank={self.bank_slug} status={self.status}>"
        )
