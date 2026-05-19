"""
AccountantGrant — many-to-many access bridge between accountants and the
business owners whose books they keep.

Why this exists (Task #49):
  Today, when a Danish café owner wants their revisor (accountant) to see
  their books, they share their BonBox password. That's a GDPR + security
  problem AND the revisor has no skin in BonBox — making it easy for the
  owner to churn to a different tool. Giving the revisor their own
  read-only login solves both:

    • One revisor handles 20–100 client businesses → many-to-many.
      User.owner_id (single FK) can't model this; we need a separate
      grants table.
    • Each grant is per-(accountant, owner) so revoking access for one
      client never touches the others.
    • Read-only semantics enforced at the middleware layer (every mutation
      method is blocked unless the path is on an accountant allowlist).

Lifecycle:
  invite → pending     (owner sends invite, magic-link token issued)
  signup → active      (revisor sets password via the token; first login)
  revoke → revoked     (either side can sever — soft state change, audit
                        trail preserved)

The accountant User row itself has role='accountant' and owner_id=NULL —
they are not "owned by" any single business owner. When they log in we
look up active grants and let them switch between clients via the
session-attached current_client_id.

Bogføringsloven note: every grant CREATE / REVOKE writes an audit_logs
row (action: accountant.invited / accountant.signup / accountant.revoked
/ accountant.login / accountant.switch_client) so the owner can later
prove who had access to which books at which time.
"""
import uuid
import secrets
from datetime import datetime

from sqlalchemy import (
    String, DateTime, ForeignKey, Index, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


def _make_invite_token() -> str:
    """Cryptographically-random URL-safe token for the magic-link signup.
    32 bytes → 43 base64url chars. Single-use (consumed at signup) and
    7-day TTL (invite_token_expires_at). Stored unhashed because we look
    it up by exact match — same approach as reset_token on the User model.
    """
    return secrets.token_urlsafe(32)


class AccountantGrant(Base):
    __tablename__ = "accountant_grants"
    __table_args__ = (
        # One grant per (accountant, owner) pair. Stops the owner from
        # spamming the same revisor with duplicate invites — the second
        # call returns 409. Revoked grants stay in the table but the
        # unique constraint still applies; a re-invite of a revoked
        # pair updates the existing row rather than inserting a dupe.
        UniqueConstraint(
            "accountant_user_id", "owner_user_id",
            name="uq_accountant_grant_pair",
        ),
        # Most common query at request time: "give me all active grants
        # for accountant X" — drives the client picker and the per-
        # request tenant check.
        Index(
            "ix_accountant_grant_accountant_status",
            "accountant_user_id", "status",
        ),
        # "Give me all revisors who have access to owner Y" — drives the
        # Profile → Revisor access list for the owner.
        Index(
            "ix_accountant_grant_owner_status",
            "owner_user_id", "status",
        ),
        # Invite-token lookup at signup time — public endpoint, must be
        # fast and single-row.
        Index("ix_accountant_grant_invite_token", "invite_token"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        GUID(), primary_key=True, default=uuid.uuid4,
    )

    # The accountant — a User row with role='accountant' and owner_id=NULL.
    # At invite time this can be NULL (the accountant hasn't signed up yet);
    # we resolve / create the User on signup and back-patch this FK.
    accountant_user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=True, index=True,
    )

    # Email of the accountant — captured at invite time. This is the
    # field we match on at signup if the accountant didn't already have
    # a BonBox account. Stored separately from User.email so the invite
    # row is meaningful even before the accountant User row exists.
    accountant_email: Mapped[str] = mapped_column(String(255), nullable=False)

    # Optional display name for the revisor, pulled into the UI list.
    accountant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # The owner whose books are being granted access to. Always a User
    # row with role='owner' (or NULL owner_id and any role).
    owner_user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False, index=True,
    )

    # Whose action created this grant. Almost always == owner_user_id;
    # the column exists for future admin-issued grants (super_admin
    # provisioning a customer support visit, etc.).
    granted_by: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False,
    )

    # pending | active | revoked. "expired" not modelled separately —
    # an expired pending grant just stays pending until cleaned up; the
    # signup endpoint refuses to accept it via the invite_token_expires_at
    # check.
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)

    # Single-use magic-link token sent to the accountant via email at
    # invite time. Set NULL when the grant becomes "active" or "revoked"
    # — the token is single-use, never re-issued for the same grant.
    invite_token: Mapped[str | None] = mapped_column(
        String(128), nullable=True, default=_make_invite_token, unique=True,
    )

    # 7-day TTL. Read at signup time — expired tokens 410 with a "ask
    # for a new invite" message.
    invite_token_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True,
    )

    invited_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False,
    )
    activated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Updated on every accountant.login + accountant.switch_client event.
    # Surfaces in the UI as "Last accessed: 3 days ago".
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"<AccountantGrant id={self.id} acct={self.accountant_email} "
            f"owner={self.owner_user_id} status={self.status}>"
        )
