"""
MagicLinkToken — single-use, time-bounded sign-in tokens.

Why this exists (Task #61):
  Owners hate remembering passwords. Magic-link login is the friction-killer
  used by Substack, Notion, Linear, Slack: enter email → tap link in inbox →
  logged in. No password, no reset cycle, no "is my caps lock on?".

Lifecycle:
  request   → row created with token_hash + email + 15-min TTL
  email     → raw token mailed to the user (link to /login/magic?token=…)
  verify    → look up by sha256 hash, validate not expired + not used,
              mark used_at + used_ip, issue JWT, redirect to dashboard
  expired   → automatic — verify endpoint refuses past expires_at
  used      → single-use — used_at gates re-use

Multi-layer defense:
  L1 input validation — token must be 43-128 chars (base64url of 32 random
                         bytes is 43 chars; allow some upward slack)
  L2 storage           — only the SHA-256 hash of the token is stored.
                         Anyone with read access to the DB still can't
                         forge a valid token. Tokens are 256-bit random
                         so unsalted SHA-256 is sufficient.
  L3 rate limit        — max 3 unused tokens per email in last 10 minutes
                         (service layer). 10 requests/hour per IP at the
                         router. Prevents enumeration spam + email bombing.
  L4 expiry            — 15-min window. Long enough for slow inboxes (Apple
                         Mail can take 30-60s); short enough that an
                         exfiltrated link is mostly already useless.
  L5 single-use        — used_at marks the token consumed. A second verify
                         with the same token 410s.
  L6 audit trail       — every request + every verify (success or failure)
                         writes an audit_logs row.

Indexes:
  • (email, created_at DESC)  — rate-limiting lookup
  • (token_hash)              — verify lookup (UNIQUE — sha256 collisions
                                aren't a concern but the constraint also
                                prevents accidental duplicate inserts)

Privacy:
  Tokens reveal nothing about the user; we keep the email column for
  rate-limiting (max-3-per-email window) and audit. user_id is NULLABLE
  on creation so the rate limit + token issuance can run BEFORE we
  resolve the user — that ordering also stops enumeration via timing
  ("did this email exist?" — same code path, same time, either way).
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class MagicLinkToken(Base):
    __tablename__ = "magic_link_tokens"

    id: Mapped[uuid.UUID] = mapped_column(
        GUID(), primary_key=True, default=uuid.uuid4,
    )

    # NULLABLE on purpose. The request flow stamps the row BEFORE we
    # know if the email maps to a real user — that's how we keep the
    # response shape identical for "unknown email" vs "known email"
    # (enumeration defence). On verify we resolve or self-create the
    # user, then back-patch this FK.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=True, index=True,
    )

    # Lowercased + stripped at creation time so rate-limit windows
    # don't get split across casing variants ("Owner@bonbox.dk" and
    # "owner@bonbox.dk" hit the same bucket).
    email: Mapped[str] = mapped_column(String(255), nullable=False)

    # sha256 hex digest of the public token. Tokens are 32 random
    # bytes → 43 base64url chars; sha256 of that → 64 hex chars.
    # UNIQUE prevents duplicate-insert races + lets a single index
    # serve verify lookups.
    token_hash: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False,
    )
    # created_at + 15 min. Stored explicitly (rather than computed at
    # query time) so we can change the TTL without rewriting issued
    # tokens — and so an index on expires_at could be added later for
    # cleanup sweeps without restructuring the row.
    expires_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False,
    )

    # NULL until consumed. A second verify with the same raw token
    # finds this set and 410s.
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )

    # Captured at request time. Useful for forensics: spike of magic-
    # link requests from a single IP → throttle or block.
    request_ip: Mapped[str | None] = mapped_column(
        String(45), nullable=True,
    )
    # Captured on verify. If request_ip != used_ip we don't reject
    # (legit case: user requests from desktop, clicks from phone) but
    # the field is logged for later review.
    used_ip: Mapped[str | None] = mapped_column(
        String(45), nullable=True,
    )

    __table_args__ = (
        # Rate-limit query: "how many unused tokens did this email
        # request in the last 10 minutes?" — covered by (email, created_at).
        Index("ix_magic_link_email_created", "email", "created_at"),
        # Verify lookup is by sha256 hash — already UNIQUE-indexed via
        # the column constraint, but an explicit name keeps the SQL
        # migration symmetric with the model.
        Index("ix_magic_link_token_hash", "token_hash"),
    )

    def __repr__(self) -> str:
        return (
            f"<MagicLinkToken email={self.email} "
            f"used={self.used_at is not None} "
            f"expires={self.expires_at}>"
        )
