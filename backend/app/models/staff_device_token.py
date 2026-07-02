"""
StaffDeviceToken — APNs device tokens for the native BonBox Scheduler app.

Web push (PushSubscription) is dead inside a WKWebView, so the App Store
staff app registers a NATIVE token here instead. Same trust model as the
portal itself: the row binds to the staff MAGIC LINK (link_id), not to an
account — deactivating or rotating the link orphans the token, and the
portal "Frakobl denne telefon" action deletes it explicitly.

Erasure: user_id carries a users-FK so the metadata-driven delete_account
sweep removes these rows automatically.
"""

import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class StaffDeviceToken(Base):
    __tablename__ = "staff_device_tokens"
    __table_args__ = (
        # A physical device has ONE APNs token. If that phone changes
        # workplace (new link), registration REBINDS the row rather than
        # duplicating it — otherwise the old workplace keeps pushing to a
        # phone that left.
        UniqueConstraint("token", name="uq_staff_device_token"),
        # Fan-out reads "all devices for (tenant, staffer)".
        Index("ix_staff_device_tokens_user_staff", "user_id", "staff_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        GUID(), primary_key=True, default=uuid.uuid4,
    )

    # Tenant scope — every read/write filters here (mirrors PushSubscription).
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False,
    )

    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), nullable=False)

    # The magic link this device authenticated with. Revocation doctrine:
    # link rotated/deactivated → sends stop (fan-out joins on active links).
    link_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("staff_links.id"), nullable=False,
    )

    platform: Mapped[str] = mapped_column(
        String(16), nullable=False, default="ios",
    )

    # APNs tokens are opaque hex, ~64 chars today; Apple says treat the
    # length as variable. Bounded at the endpoint (16..200).
    token: Mapped[str] = mapped_column(String(200), nullable=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utc_now,
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, default=utc_now,
    )
