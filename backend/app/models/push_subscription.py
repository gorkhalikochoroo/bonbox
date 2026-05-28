"""
PushSubscription — Web Push (VAPID) endpoint per user device per Task #72.

Why this exists:
  The 8am Daily Brief currently arrives only via email (Task #54).
  Email open-rate is ~25%. A native push pop on iOS/Android (delivered
  via the existing service worker we already ship at /sw.js) lands at
  60-70% open within ten minutes — the difference between "advisor
  that arrives" and "tab the owner forgot to open today".

Lifecycle:
  • Created when the owner taps "Enable push" in the Profile page or
    the dashboard opt-in card. The browser's PushManager mints an
    endpoint URL + p256dh / auth keypair; the frontend POSTs all three
    to /api/push/subscribe. We upsert one row per (user, endpoint).
  • Reused on every brief send. The cron iterates active rows and
    fires VAPID-signed pushes via pywebpush.
  • Hard-deleted on two paths:
      1. Explicit /api/push/unsubscribe POST (owner toggled off)
      2. fail_count hits >= 3 OR provider returns 410 Gone (the device
         uninstalled the PWA / browser cleared its registration).

Multi-tenant safety:
  • UNIQUE(user_id, endpoint) — re-subscribing the same device is an
    upsert, not a duplicate row.
  • Same user can have multiple devices (iPhone + Android + laptop) —
    each device gets its own endpoint, all under the same user_id.
  • Cross-tenant deletes are 404'd at the router layer.

Privacy posture (GDPR-regulated data):
  Endpoint URLs are PII (~ like email addresses — they uniquely
  identify a device + push provider). NEVER log them at INFO; redact
  in error logs by hashing or truncating.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    String, DateTime, Integer, Text, ForeignKey, Index, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    __table_args__ = (
        # Re-subscribing the same device (same endpoint) is an upsert,
        # not a duplicate row. The endpoint is globally unique already
        # (it's a long, opaque URL from the push provider), but we
        # scope on (user_id, endpoint) for an extra layer of defense:
        # if a malicious actor ever guessed another user's endpoint
        # and tried to call /subscribe with it, we'd refuse to attach
        # it to the wrong tenant.
        UniqueConstraint(
            "user_id", "endpoint",
            name="uq_push_subscription_user_endpoint",
        ),
        # The morning cron iterates "all active subscriptions for
        # user X" → indexed lookup.
        Index(
            "ix_push_subscriptions_user_id",
            "user_id",
        ),
        # The cron sweep also walks fail_count to prune stale rows.
        Index(
            "ix_push_subscriptions_fail_count",
            "fail_count",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        GUID(), primary_key=True, default=uuid.uuid4,
    )

    # Tenant scope — every read/write filters here.  Index is
    # declared in __table_args__ above; setting index=True here as
    # well caused a duplicate-index collision in SQLite test runs.
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False,
    )

    # Staff v2 (2026-05-28) — discriminator for owner vs. staff devices.
    # NULL  → owner subscription (the existing daily-brief / shift-change
    #         push path; tenant-scoped under user_id).
    # set   → staff member's device subscribed via the magic-link portal.
    #         user_id still points to the tenant owner so the morning
    #         cron can list (user_id, staff_id IS NULL) for owner pushes
    #         and (user_id, staff_id = X) for staff pushes without a
    #         table-spanning join.
    # Privacy: the staff member never gets visibility into the owner's
    # subscription — every read filters BOTH columns, and the portal
    # endpoint only inserts rows with the resolved staff_id from the
    # token.
    staff_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("staff_members.id"), nullable=True,
    )

    # The endpoint URL from PushManager.subscribe(). Long opaque string
    # provided by the push service (FCM for Chrome / Apple Push for
    # Safari / Mozilla autopush for Firefox). Stored as Text — these
    # can be > 500 chars in some implementations.
    endpoint: Mapped[str] = mapped_column(Text, nullable=False, unique=True)

    # P-256 ECDH public key (base64url-encoded). Used by pywebpush to
    # encrypt the payload to a key only the device's private key can
    # decrypt. Without this, push provider would refuse to deliver.
    p256dh: Mapped[str] = mapped_column(Text, nullable=False)

    # Authentication secret (base64url-encoded). Used by pywebpush for
    # an additional HMAC-based integrity check on the encrypted body.
    auth: Mapped[str] = mapped_column(Text, nullable=False)

    # User-agent string at subscription time. Optional — helps the
    # owner identify "which device is this?" in a future device-mgmt
    # screen. Truncated to 500 chars to keep rows compact.
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)

    # Bookkeeping: when did we create this row, when did we last send
    # to it successfully, when did we last get a failure back?
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False,
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )
    last_failed_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )

    # Counts consecutive 5xx / network failures. Reset to 0 on success.
    # When >= 3 we prune the row at the next cron tick — the device
    # is almost certainly gone.
    fail_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0,
    )

    def __repr__(self) -> str:
        # NEVER include the endpoint in __repr__ — endpoints are PII.
        # Just enough to identify the row in a log line.
        return (
            f"<PushSubscription id={self.id} user={self.user_id} "
            f"fails={self.fail_count}>"
        )
