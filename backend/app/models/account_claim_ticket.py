"""
AccountClaimTicket — the answer to "did you create this account yourself?".

WHY (Manoj, 8 Oct). An e-mail login link (or the legacy Apple sign-in) can
land in an account whose address was NEVER confirmed: somebody signed up with
a password and never typed the code — the inbox owner themselves, or someone
who pre-registered their address. The link proves the inbox, so the address
is confirmed and this browser is signed in, but the password, the other
devices and the revisor / host-stand access are NOT silently replaced: the
inbox owner is asked (services/claim_decision.py).

A ticket is the only thing that can answer. Two kinds:
    page   30 minutes, handed only to the browser that just opened the login
           link (in the verify answer's body — never in a URL), bound to that
           sign-in (sign_in_ref = the magic_link_tokens row it consumed)
    mail   7 days, in the notice mail to the inbox, for old app builds and
           anyone who closed the page (a new one is mailed, at most once a
           day, while the question stays open — services/claim_decision.py)

Only the sha256 of the raw ticket is stored. A ticket is single-use; the first
answer for an account voids every other open ticket of that account. The
question is OPEN while the account has a ticket that is neither used nor
voided — expiry does not close it, so an unanswered question is asked again on
the next login link.

No PII: the row holds the account id and timestamps only (the answer's IP
lives in the audit row). user_id → users.id, so the metadata-driven GDPR
erasure and export include it (token_hash is never exported).
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class AccountClaimTicket(Base):
    __tablename__ = "account_claim_tickets"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False, index=True,
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(8), nullable=False)        # page | mail
    via: Mapped[str] = mapped_column(String(20), nullable=False)        # magic_link | apple_legacy | password_reset
    # The magic_link_tokens row whose sign-in got this page ticket (soft link,
    # no FK). NULL for mail tickets and the legacy Apple path.
    sign_in_ref: Mapped[Optional[uuid.UUID]] = mapped_column(GUID(), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    answer: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)  # keep | secure
    voided_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
