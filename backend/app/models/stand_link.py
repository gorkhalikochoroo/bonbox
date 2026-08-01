"""
StandLink — a device credential for the host stand.

WHY. The host stand (/reservations/stand) is a screen that lives on a tablet at
a restaurant's door, or on a phone in a host's hand. Until now the only way to
open it was a FULL OWNER SESSION: the same credential that reaches the owner's
bank balance, tax overview, payroll and settings. PR #205 closed three one-tap
exits out of the stand into that app, but the credential underneath was still
an owner credential on an unlocked device in a public room.

A StandLink is the fix, and it is deliberately the SAME SHAPE as StaffLink
(app/models/staff.py) — the staff-portal join code is already hardened and in
production, so this mirrors it rather than inventing a second scheme:

    token       long, unguessable, lives in the URL path (as /s/<token> does)
    join_code   short, human-typeable, what you read aloud in a restaurant
    active      the revocation switch — one flag, one place

The SCOPE is not carried on this row. It is structural: the only operations a
StandLink can reach are the ones explicitly wrapped in routers/stand_link.py.
Nothing else in the API accepts this credential, so there is no scope column to
get wrong and no allow-list to drift out of sync with the code.
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class StandLink(Base):
    __tablename__ = "stand_links"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # The venue whose book this device shows. Every read and write made through
    # this link is re-derived from THIS column — never from anything the client
    # sends.
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)

    # 192 bits, same as StaffLink. Lives in the URL, so it must be unguessable
    # even though it is also somewhat exposed (browser history, screenshots) —
    # which is exactly why `active` exists.
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)

    # The short code someone types on the device. Separate from the token so a
    # code can be short enough to read aloud without weakening the credential
    # that actually authenticates requests.
    join_code: Mapped[Optional[str]] = mapped_column(
        String(12), nullable=True, unique=True, index=True
    )
    # A short code is a weaker secret than the token, so it is not a standing
    # credential: it stops resolving once redeemed or once this passes.
    code_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    code_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Which device this is, so the owner's revoke list is readable ("Door iPad")
    # rather than a wall of identical rows.
    label: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)

    # THE revocation switch. Checked on every request through this link.
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    # Lets the owner tell a device that is running a service from one that was
    # paired once on a visit and never used again.
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
