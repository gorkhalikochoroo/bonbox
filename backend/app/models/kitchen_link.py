"""
KitchenLink — a device credential for the kitchen iPad (Egenkontrol R1a).

The same shape as StandLink (app/models/stand_link.py), plus `branch_id`:
a long token in the URL, a short single-use join code a cook types on the
iPad, and one `active` flag as the revocation switch.

SCOPE IS STRUCTURAL, as for the stand. The only operations a KitchenLink can
reach are the ones wrapped in routers/kitchen_link.py: today's list, the
staff names, saving and undoing a reading, the read-only Kontrolmappe and
unpairing itself. No config, no devices, no settings, no money, no
reservations, no PDF. Adding reach means adding a wrapper there.

`branch_id` (NULL = the whole venue) scopes which checks the device shows and
may write to: its own branch plus the venue-wide checks.
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class KitchenLink(Base):
    __tablename__ = "kitchen_links"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # The venue this device belongs to. Every read and write through the link
    # is re-derived from THIS column, never from anything the client sends.
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), index=True)
    branch_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("branches.id"), nullable=True
    )
    # 192 bits (secrets.token_urlsafe(24)), like StandLink and StaffLink.
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # Codes are unique across stand_links AND kitchen_links (both are redeemed
    # at POST /api/stand/join), checked at mint time in both routers.
    join_code: Mapped[Optional[str]] = mapped_column(
        String(12), nullable=True, unique=True, index=True
    )
    code_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    code_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    label: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
